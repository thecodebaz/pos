"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  ChartColumn,
  DatabaseBackup,
  History,
  Lock,
  LogOut,
  Menu,
  Package,
  ReceiptText,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Truck,
  Users,
  UtensilsCrossed,
  Warehouse,
  X,
} from "lucide-react";
import { cn } from "cn";
import { useApp } from "@/lib/app-context";
import { initials } from "@/lib/format";
import { Badge } from "@/components/shared";
import { BootScreen } from "@/components/boot-screen";
import { Button } from "@/components/ui/button";

const navigation = [
  { href: "/vendas/", label: "Vendas", icon: ShoppingCart, roles: ["owner", "manager", "cashier"] },
  { href: "/historico/", label: "Histórico", icon: ReceiptText, roles: ["owner", "manager", "cashier"] },
  { href: "/produtos/", label: "Produtos", icon: Package, roles: ["owner", "manager", "cashier"] },
  { href: "/stock/", label: "Stock", icon: Warehouse, roles: ["owner", "manager"] },
  { href: "/clientes/", label: "Clientes", icon: Users, roles: ["owner", "manager", "cashier"] },
  { href: "/fornecedores/", label: "Fornecedores", icon: Truck, roles: ["owner", "manager"] },
  { href: "/relatorios/", label: "Relatórios", icon: ChartColumn, roles: ["owner", "manager"] },
  { href: "/auditoria/", label: "Auditoria", icon: History, roles: ["owner", "manager"] },
  { href: "/utilizadores/", label: "Utilizadores", icon: ShieldCheck, roles: ["owner"] },
  { href: "/backup/", label: "Backup", icon: DatabaseBackup, roles: ["owner", "manager"] },
  { href: "/definicoes/", label: "Definições", icon: Settings, roles: ["owner"] },
] as const;

export function AppShell({ children }: { children: React.ReactNode }) {
  const { boot, status, session, signOut, lock } = useApp();
  const router = useRouter();
  const pathname = usePathname();
  const [menuOpenAt, setMenuOpenAt] = useState<string | null>(null);
  // O menu fecha sozinho quando a rota muda: guardamos a rota em que foi aberto
  // em vez de sincronizar estado num efeito.
  const menuOpen = menuOpenAt === pathname;

  useEffect(() => {
    if (boot !== "ready") return;
    if (status?.setupRequired) router.replace("/configuracao/");
    else if (!session) router.replace("/entrar/");
  }, [boot, status, session, router]);

  if (boot !== "ready") return <BootScreen />;
  if (!session) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
        A redireccionar para a entrada…
      </div>
    );
  }

  const items = navigation.filter((item) => (item.roles as readonly string[]).includes(session.user.role));

  return (
    <div className="flex min-h-dvh flex-1 flex-col lg:flex-row">
      <aside className="no-print hidden w-60 shrink-0 flex-col border-r bg-sidebar px-3 py-4 lg:flex">
        <BrandBlock storeName={session.settings.storeName} />
        <nav className="mt-4 flex flex-1 flex-col gap-0.5">
          {items.map((item) => (
            <NavLink
              key={item.href}
              href={item.href}
              label={item.label}
              active={pathname === item.href || (item.href === "/stock/" && pathname.startsWith("/stock/"))}
            >
              <item.icon className="size-4" />
            </NavLink>
          ))}
        </nav>
        <UserBlock />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print sticky top-0 z-40 flex items-center justify-between gap-2 border-b bg-background/95 px-3 py-2 backdrop-blur lg:hidden">
          <div className="flex items-center gap-2">
            <UtensilsCrossed className="size-5 text-emerald-600" />
            <div className="leading-tight">
              <p className="text-sm font-semibold">{session.settings.storeName || "POS"}</p>
              <p className="text-[11px] text-muted-foreground">{session.user.displayName}</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" aria-label="Bloquear sessão" onClick={() => void lock()}>
              <Lock className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Abrir menu"
              onClick={() => setMenuOpenAt((open) => (open === pathname ? null : pathname))}
            >
              {menuOpen ? <X className="size-4" /> : <Menu className="size-4" />}
            </Button>
          </div>
        </header>

        {menuOpen ? (
          <nav className="no-print grid grid-cols-2 gap-1 border-b bg-sidebar p-2 sm:grid-cols-3 lg:hidden">
            {items.map((item) => (
              <NavLink
                key={item.href}
                href={item.href}
                label={item.label}
                active={pathname === item.href || (item.href === "/stock/" && pathname.startsWith("/stock/"))}
              >
                <item.icon className="size-4" />
              </NavLink>
            ))}
            <button
              type="button"
              onClick={() => void signOut()}
              className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted"
            >
              <LogOut className="size-4" /> Sair
            </button>
          </nav>
        ) : null}

        <main className="min-w-0 flex-1 p-3 sm:p-5">{children}</main>

        <footer className="no-print hidden items-center justify-between border-t px-4 py-2 text-[11px] text-muted-foreground lg:flex">
          <span>
            {session.settings.storeName || "POS"} · Instalação {session.settings.installationCode}
          </span>
          <span className="flex items-center gap-2">
            {status?.storagePersisted === false ? <Badge tone="warning">Armazenamento não persistido</Badge> : null}
            {status?.crossOriginIsolated ? <Badge tone="success">OPFS activo</Badge> : <Badge tone="danger">Sem OPFS</Badge>}
          </span>
        </footer>
      </div>
    </div>
  );
}

function BrandBlock({ storeName }: { storeName: string }) {
  return (
    <div className="flex items-center gap-2 px-2">
      <div className="flex size-9 items-center justify-center rounded-xl bg-emerald-600 text-white">
        <UtensilsCrossed className="size-5" />
      </div>
      <div className="min-w-0 leading-tight">
        <p className="truncate text-sm font-semibold">{storeName || "POS"}</p>
        <p className="text-[11px] text-muted-foreground">Ponto de venda</p>
      </div>
    </div>
  );
}

function UserBlock() {
  const { session, signOut, lock } = useApp();
  if (!session) return null;
  return (
    <div className="mt-3 border-t pt-3">
      <div className="flex items-center gap-2 px-1">
        <div className="flex size-8 items-center justify-center rounded-full bg-muted text-xs font-semibold">
          {initials(session.user.displayName)}
        </div>
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-sm font-medium">{session.user.displayName}</p>
          <p className="text-[11px] text-muted-foreground">{roleLabel(session.user.role)}</p>
        </div>
      </div>
      <div className="mt-2 flex gap-1">
        <Button variant="outline" size="sm" className="flex-1" onClick={() => void lock()}>
          <Lock className="size-3.5" /> Bloquear
        </Button>
        <Button variant="ghost" size="sm" className="flex-1" onClick={() => void signOut()}>
          <LogOut className="size-3.5" /> Sair
        </Button>
      </div>
    </div>
  );
}

function NavLink({
  href,
  label,
  active,
  children,
}: {
  href: string;
  label: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors",
        active ? "bg-emerald-600 text-white" : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {children}
      <span className="truncate">{label}</span>
    </Link>
  );
}

export function roleLabel(role: string): string {
  if (role === "owner") return "Proprietário";
  if (role === "manager") return "Gerente";
  return "Caixa";
}
