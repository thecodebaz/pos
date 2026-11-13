"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Delete, KeyRound, LockKeyhole, ShieldCheck } from "lucide-react";
import { cn } from "cn";
import { useApp, errorMessage } from "@/lib/app-context";
import { db } from "@/lib/db/client";
import type { SessionInfo, UserPublic } from "@/lib/db/protocol";
import { initials } from "@/lib/format";
import { BootScreen } from "@/components/boot-screen";
import { Field, Note } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { roleLabel } from "@/components/app-shell";

export function LoginScreen() {
  const { boot, status, session, enterSession, toast, refreshStatus } = useApp();
  const router = useRouter();
  const [users, setUsers] = useState<UserPublic[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [selected, setSelected] = useState<UserPublic | null>(null);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"users" | "recovery">("users");
  const [changing, setChanging] = useState<{ session: SessionInfo; currentPin: string } | null>(null);

  useEffect(() => {
    if (boot !== "ready") return;
    if (status?.setupRequired) {
      router.replace("/configuracao/");
      return;
    }
    if (session) {
      router.replace("/vendas/");
      return;
    }
    let cancelled = false;
    db.listLoginUsers()
      .then((list) => {
        if (!cancelled) setUsers(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoadingUsers(false);
      });
    return () => {
      cancelled = true;
    };
  }, [boot, status, session, router]);

  const submitPin = useCallback(
    async (value: string) => {
      if (!selected || value.length !== 6 || busy) return;
      setBusy(true);
      setError(null);
      try {
        const next = await db.login(selected.id, value);
        if (next.user.mustChangePin) {
          setChanging({ session: next, currentPin: value });
        } else {
          enterSession(next);
          toast(`Bem-vindo, ${next.user.displayName}.`, "success");
          router.replace("/vendas/");
        }
      } catch (err) {
        setError(errorMessage(err));
        setPin("");
      } finally {
        setBusy(false);
      }
    },
    [selected, busy, enterSession, toast, router],
  );

  useEffect(() => {
    if (!selected || changing) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key >= "0" && event.key <= "9") {
        event.preventDefault();
        setPin((current) => {
          const next = (current + event.key).slice(0, 6);
          if (next.length === 6) void submitPin(next);
          return next;
        });
      } else if (event.key === "Backspace") {
        event.preventDefault();
        setPin((current) => current.slice(0, -1));
      } else if (event.key === "Escape") {
        setSelected(null);
        setPin("");
        setError(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, changing, submitPin]);

  if (boot !== "ready") return <BootScreen />;

  if (changing) {
    return (
      <ChangePinScreen
        session={changing.session}
        currentPin={changing.currentPin}
        onDone={(updated) => {
          enterSession(updated);
          toast("PIN alterado.", "success");
          router.replace("/vendas/");
        }}
      />
    );
  }

  return (
    <div className="flex flex-1 items-center justify-center p-4">
      <div className="w-full max-w-3xl">
        <div className="mb-5 flex items-center justify-center gap-2">
          <div className="flex size-10 items-center justify-center rounded-xl bg-emerald-600 text-white">
            <KeyRound className="size-5" />
          </div>
          <div>
            <p className="text-lg font-semibold leading-tight">{status?.setupRequired ? "POS" : "Entrar no POS"}</p>
            <p className="text-xs text-muted-foreground">Dados guardados apenas neste dispositivo</p>
          </div>
        </div>

        {mode === "recovery" ? (
          <RecoveryCard
            onCancel={() => setMode("users")}
            onDone={async () => {
              await refreshStatus();
              setMode("users");
            }}
          />
        ) : selected ? (
          <Card className="mx-auto max-w-sm">
            <CardHeader className="text-center">
              <div className="mx-auto mb-2 flex size-14 items-center justify-center rounded-full bg-muted text-lg font-semibold">
                {initials(selected.displayName)}
              </div>
              <CardTitle>{selected.displayName}</CardTitle>
              <CardDescription>{roleLabel(selected.role)}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex justify-center gap-3" aria-label="PIN">
                {Array.from({ length: 6 }).map((_, index) => (
                  <span
                    key={index}
                    className={cn(
                      "flex size-9 items-center justify-center rounded-lg border text-lg font-semibold transition-colors",
                      index < pin.length ? "border-emerald-600 bg-emerald-50 dark:bg-emerald-950/40" : "border-input",
                      error && "border-red-500",
                    )}
                  >
                    {index < pin.length ? "•" : ""}
                  </span>
                ))}
              </div>
              {error ? <Note tone="danger">{error}</Note> : null}
              <div className="grid grid-cols-3 gap-2">
                {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit) => (
                  <PinButton
                    key={digit}
                    label={digit}
                    onClick={() => {
                      setError(null);
                      setPin((current) => {
                        const next = (current + digit).slice(0, 6);
                        if (next.length === 6) void submitPin(next);
                        return next;
                      });
                    }}
                    disabled={busy}
                  />
                ))}
                <PinButton
                  label="Limpar"
                  onClick={() => {
                    setPin("");
                    setError(null);
                  }}
                  disabled={busy}
                  text
                />
                <PinButton
                  label="0"
                  onClick={() => {
                    setError(null);
                    setPin((current) => {
                      const next = (current + "0").slice(0, 6);
                      if (next.length === 6) void submitPin(next);
                      return next;
                    });
                  }}
                  disabled={busy}
                />
                <PinButton
                  label={<Delete className="mx-auto size-5" />}
                  onClick={() => setPin((current) => current.slice(0, -1))}
                  disabled={busy}
                  aria-label="Apagar"
                />
              </div>
              <Button variant="ghost" className="w-full" onClick={() => { setSelected(null); setPin(""); setError(null); }}>
                <ArrowLeft className="size-4" /> Escolher outro utilizador
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {loadingUsers ? (
              <p className="text-center text-sm text-muted-foreground">A carregar utilizadores…</p>
            ) : users.length === 0 ? (
              <Note tone="warning">
                Não existem utilizadores activos. Use um backup ou o código de recuperação do proprietário.
              </Note>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {users.map((user) => (
                  <button
                    key={user.id}
                    type="button"
                    onClick={() => {
                      setSelected(user);
                      setPin("");
                      setError(null);
                    }}
                    className="flex items-center gap-3 rounded-xl bg-card p-4 text-left ring-1 ring-foreground/10 transition-colors hover:ring-emerald-500"
                  >
                    <span className="flex size-11 items-center justify-center rounded-full bg-emerald-600/10 text-sm font-semibold text-emerald-700 dark:text-emerald-400">
                      {initials(user.displayName)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{user.displayName}</span>
                      <span className="block text-xs text-muted-foreground">{roleLabel(user.role)}</span>
                    </span>
                    <LockKeyhole className="size-4 text-muted-foreground" />
                  </button>
                ))}
              </div>
            )}
            {error ? <Note tone="danger">{error}</Note> : null}
            <div className="pt-2 text-center">
              <Button variant="link" onClick={() => setMode("recovery")}>
                Esqueci-me do PIN de proprietário
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function PinButton({
  label,
  onClick,
  disabled,
  text,
  ...props
}: {
  label: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  text?: boolean;
} & React.AriaAttributes) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "h-14 rounded-xl border bg-card text-xl font-semibold transition-colors hover:bg-muted disabled:opacity-50",
        text && "text-sm",
      )}
      {...props}
    >
      {label}
    </button>
  );
}

function RecoveryCard({ onCancel, onDone }: { onCancel: () => void; onDone: () => Promise<void> }) {
  const [code, setCode] = useState("");
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newCode, setNewCode] = useState<string | null>(null);
  const firstInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstInput.current?.focus();
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (pin !== confirm) {
      setError("Os PINs não coincidem.");
      return;
    }
    setBusy(true);
    try {
      const result = await db.recoverOwner(code, pin);
      setNewCode(result.recoveryCode);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mx-auto max-w-md">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-5 text-emerald-600" /> Recuperar proprietário
        </CardTitle>
        <CardDescription>Use o código de recuperação que guardou na primeira configuração.</CardDescription>
      </CardHeader>
      <CardContent>
        {newCode ? (
          <div className="space-y-4">
            <Note tone="warning">Guarde o novo código de recuperação. O anterior já não funciona.</Note>
            <code className="block select-all rounded-xl border-2 border-dashed border-emerald-600/40 bg-emerald-50 px-4 py-4 text-center font-mono text-xl font-bold tracking-wider dark:bg-emerald-950/30">
              {newCode}
            </code>
            <Button className="w-full" onClick={() => void onDone()}>
              Voltar à entrada
            </Button>
          </div>
        ) : (
          <form className="space-y-4" onSubmit={submit}>
            <Field label="Código de recuperação" htmlFor="recoveryCode">
              <Input
                id="recoveryCode"
                ref={firstInput}
                required
                autoCapitalize="characters"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
                className="font-mono"
              />
            </Field>
            <Field label="Novo PIN (6 dígitos)" htmlFor="newPin">
              <Input
                id="newPin"
                type="password"
                inputMode="numeric"
                maxLength={6}
                required
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
              />
            </Field>
            <Field label="Confirmar novo PIN" htmlFor="newPinConfirm">
              <Input
                id="newPinConfirm"
                type="password"
                inputMode="numeric"
                maxLength={6}
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value.replace(/\D/g, "").slice(0, 6))}
              />
            </Field>
            {error ? <Note tone="danger">{error}</Note> : null}
            <div className="flex gap-2">
              <Button type="button" variant="outline" className="flex-1" onClick={onCancel}>
                Cancelar
              </Button>
              <Button type="submit" className="flex-1" disabled={busy}>
                {busy ? "A validar…" : "Recuperar acesso"}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

function ChangePinScreen({
  session,
  currentPin,
  onDone,
}: {
  session: SessionInfo;
  currentPin: string;
  onDone: (session: SessionInfo) => void;
}) {
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pin !== confirm) {
      setError("Os PINs não coincidem.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await db.changePin(session.token, currentPin, pin);
      onDone({ ...session, user: { ...session.user, mustChangePin: false } });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-1 items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Defina um novo PIN</CardTitle>
          <CardDescription>É necessário alterar o PIN antes de continuar.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={submit}>
            <Field label="Novo PIN" htmlFor="changePin">
              <Input
                id="changePin"
                type="password"
                inputMode="numeric"
                maxLength={6}
                required
                autoFocus
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
              />
            </Field>
            <Field label="Confirmar PIN" htmlFor="changePinConfirm">
              <Input
                id="changePinConfirm"
                type="password"
                inputMode="numeric"
                maxLength={6}
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value.replace(/\D/g, "").slice(0, 6))}
              />
            </Field>
            {error ? <Note tone="danger">{error}</Note> : null}
            <Button className="w-full" type="submit" disabled={busy}>
              {busy ? "A guardar…" : "Guardar PIN"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
