"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { ApiError, db } from "@/lib/db/client";
import type { AppStatus, RequestType, SessionInfo, Settings } from "@/lib/db/protocol";

type ToastKind = "info" | "success" | "error";
type Toast = { id: string; message: string; kind: ToastKind };

type AppContextValue = {
  boot: "loading" | "ready" | "error";
  bootError: string | null;
  status: AppStatus | null;
  session: SessionInfo | null;
  online: boolean;
  updateReady: boolean;
  toast: (message: string, kind?: ToastKind) => void;
  refreshStatus: () => Promise<AppStatus | null>;
  enterSession: (session: SessionInfo) => void;
  updateSettings: (settings: SessionInfo["settings"]) => void;
  signOut: () => Promise<void>;
  lock: () => Promise<void>;
  applyUpdate: () => void;
  call: <T>(type: RequestType, payload?: unknown) => Promise<T>;
};

const AppContext = createContext<AppContextValue | null>(null);

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Ocorreu um erro inesperado.";
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [boot, setBoot] = useState<"loading" | "ready" | "error">("loading");
  const [bootError, setBootError] = useState<string | null>(null);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [updateReady, setUpdateReady] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const online = useSyncExternalStore(
    (onChange) => {
      window.addEventListener("online", onChange);
      window.addEventListener("offline", onChange);
      return () => {
        window.removeEventListener("online", onChange);
        window.removeEventListener("offline", onChange);
      };
    },
    () => navigator.onLine,
    () => true,
  );

  const sessionRef = useRef<SessionInfo | null>(null);
  const lastActivityRef = useRef(0);
  const lastWorkerActivityRef = useRef(0);
  const waitingWorkerRef = useRef<ServiceWorker | null>(null);
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const applyingUpdateRef = useRef(false);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  const toast = useCallback((message: string, kind: ToastKind = "info") => {
    const id = crypto.randomUUID();
    setToasts((current) => [...current.slice(-3), { id, message, kind }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((item) => item.id !== id));
    }, kind === "error" ? 6500 : 4000);
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await db.status();
      setStatus(next);
      return next;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    db.init()
      .then((next) => {
        if (cancelled) return;
        setStatus(next);
        setBoot("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setBootError(errorMessage(error));
        setBoot("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;

    let registration: ServiceWorkerRegistration | null = null;
    const onControllerChange = () => {
      if (applyingUpdateRef.current) window.location.reload();
    };
    const watch = (reg: ServiceWorkerRegistration) => {
      registration = reg;
      registrationRef.current = reg;
      if (reg.waiting) {
        waitingWorkerRef.current = reg.waiting;
        setUpdateReady(true);
      }
      reg.addEventListener("updatefound", () => {
        const installing = reg.installing;
        if (!installing) return;
        installing.addEventListener("statechange", () => {
          if (installing.state === "installed" && navigator.serviceWorker.controller) {
            // Neste instante `reg.waiting` pode ainda não estar preenchido; o
            // próprio worker instalado é a referência fiável para o SKIP_WAITING.
            waitingWorkerRef.current = reg.waiting ?? installing;
            setUpdateReady(true);
          }
        });
      });
    };

    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then(watch)
      .catch(() => {
        /* offline cache indisponível; a app continua a funcionar */
      });

    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      registration?.update().catch(() => undefined);
    };
  }, []);

  const applyUpdate = useCallback(() => {
    applyingUpdateRef.current = true;

    const send = (worker: ServiceWorker | null | undefined) => {
      worker?.postMessage({ type: "SKIP_WAITING" });
    };

    const known = waitingWorkerRef.current ?? registrationRef.current?.waiting;
    if (known) {
      send(known);
    } else {
      // O evento statechange pode ter corrido antes de `reg.waiting` existir.
      navigator.serviceWorker
        .getRegistration()
        .then((reg) => {
          const worker = reg?.waiting ?? null;
          waitingWorkerRef.current = worker;
          send(worker);
        })
        .catch(() => undefined);
    }

    // Rede de segurança: se `controllerchange` não disparar, recarrega na mesma.
    window.setTimeout(() => window.location.reload(), 2500);
  }, []);

  const touch = useCallback(() => {
    const now = Date.now();
    lastActivityRef.current = now;
    const current = sessionRef.current;
    if (!current || now - lastWorkerActivityRef.current < 20_000) return;

    lastWorkerActivityRef.current = now;
    void db.request("auth.touch", {}, current.token).catch((error: unknown) => {
      if (error instanceof ApiError && (error.code === "UNAUTHENTICATED" || error.code === "SESSION_LOCKED")) {
        sessionRef.current = null;
        setSession(null);
        toast("Sessão bloqueada por inactividade.", "info");
        return;
      }
      toast(errorMessage(error), "error");
    });
  }, [toast]);

  useEffect(() => {
    if (!session) return;
    lastActivityRef.current = Date.now();
    const events: (keyof WindowEventMap)[] = ["pointerdown", "keydown", "wheel", "touchstart"];
    for (const event of events) window.addEventListener(event, touch, { passive: true });
    const onVisibility = () => {
      if (document.visibilityState === "visible") touch();
    };
    document.addEventListener("visibilitychange", onVisibility);

    const interval = window.setInterval(() => {
      const current = sessionRef.current;
      if (!current) return;
      const limit = current.settings.idleLockSeconds * 1000;
      if (Date.now() - lastActivityRef.current > limit) {
        setSession(null);
        toast("Sessão bloqueada por inatividade.", "info");
        db.lock(current.token).catch(() => undefined);
      }
    }, 5000);

    return () => {
      for (const event of events) window.removeEventListener(event, touch);
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(interval);
    };
  }, [session, toast, touch]);

  const enterSession = useCallback((next: SessionInfo) => {
    const now = Date.now();
    lastActivityRef.current = now;
    lastWorkerActivityRef.current = now;
    sessionRef.current = next;
    setSession(next);
  }, []);

  const updateSettings = useCallback((next: Settings) => {
    setSession((current) => {
      const updated = current ? { ...current, settings: next } : current;
      sessionRef.current = updated;
      return updated;
    });
  }, []);

  const signOut = useCallback(async () => {
    const current = sessionRef.current;
    sessionRef.current = null;
    setSession(null);
    if (current) {
      try {
        await db.logout(current.token);
      } catch {
        /* a sessão local já terminou */
      }
    }
  }, []);

  const lock = useCallback(async () => {
    const current = sessionRef.current;
    sessionRef.current = null;
    setSession(null);
    if (current) {
      try {
        await db.lock(current.token);
      } catch {
        /* ignore */
      }
    }
  }, []);

  const call = useCallback(
    async <T,>(type: RequestType, payload?: unknown): Promise<T> => {
      const current = sessionRef.current;
      try {
        const timeout = type === "backup.import" || type === "data.purge" ? 300_000 : undefined;
        return await db.request<T>(type, payload, current?.token ?? null, timeout);
      } catch (error) {
        if (error instanceof ApiError && (error.code === "UNAUTHENTICATED" || error.code === "SESSION_LOCKED")) {
          setSession(null);
        }
        throw error;
      }
    },
    [],
  );

  useEffect(() => {
    if (boot !== "ready") return;
    let running = false;

    const runAutoBackup = async () => {
      if (running || document.visibilityState !== "visible") return;
      running = true;
      try {
        const execute = async () => {
          await call<{ created: boolean }>("backup.auto");
        };
        if (navigator.locks) {
          await navigator.locks.request("pos-auto-backup", execute);
        } else {
          await execute();
        }
      } catch (error) {
        toast(`O backup automático falhou: ${errorMessage(error)}`, "error");
      } finally {
        running = false;
      }
    };

    const interval = window.setInterval(() => void runAutoBackup(), 6 * 60 * 60 * 1000);
    document.addEventListener("visibilitychange", runAutoBackup);
    void runAutoBackup();
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", runAutoBackup);
    };
  }, [boot, call, toast]);

  const value = useMemo<AppContextValue>(
    () => ({
      boot,
      bootError,
      status,
      session,
      online,
      updateReady,
      toast,
      refreshStatus,
      enterSession,
      updateSettings,
      signOut,
      lock,
      applyUpdate,
      call,
    }),
    [boot, bootError, status, session, online, updateReady, toast, refreshStatus, enterSession, updateSettings, signOut, lock, applyUpdate, call],
  );

  return (
    <AppContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[100] flex flex-col items-center gap-2 px-4">
        {toasts.map((item) => (
          <div
            key={item.id}
            role="status"
            className={
              "pointer-events-auto w-full max-w-md rounded-lg px-4 py-3 text-sm shadow-lg ring-1 " +
              (item.kind === "error"
                ? "bg-destructive text-white ring-destructive"
                : item.kind === "success"
                  ? "bg-emerald-700 text-white ring-emerald-800"
                  : "bg-foreground text-background ring-foreground")
            }
          >
            {item.message}
          </div>
        ))}
      </div>
    </AppContext.Provider>
  );
}

export function useApp(): AppContextValue {
  const context = useContext(AppContext);
  if (!context) throw new Error("useApp tem de ser usado dentro de AppProvider.");
  return context;
}

export { errorMessage };
