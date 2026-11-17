"use client";

import { useCallback, useEffect, useState } from "react";
import { KeyRound, Pencil, Plus, ShieldCheck } from "lucide-react";
import { useApp, errorMessage } from "@/lib/app-context";
import type { Role, UserPublic } from "@/lib/db/protocol";
import { formatDateTime, initials } from "@/lib/format";
import { Badge, EmptyState, Field, LoadingPanel, Note, PageHeader, Select } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { roleLabel } from "@/components/app-shell";

export function UsersScreen() {
  const { session, call, toast } = useApp();
  const [users, setUsers] = useState<UserPublic[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<UserPublic | null>(null);
  const [form, setForm] = useState({ username: "", displayName: "", role: "cashier" as Role, pin: "", loginShortcut: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetUser, setResetUser] = useState<UserPublic | null>(null);
  const [resetPin, setResetPin] = useState("");

  const load = useCallback(async () => {
    try {
      setUsers(await call<UserPublic[]>("user.list", {}));
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setLoading(false);
    }
  }, [call, toast]);

  useEffect(() => {
    // Carga inicial assíncrona: o estado só é alterado depois do primeiro await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  function openNew() {
    setEditing(null);
    setForm({ username: "", displayName: "", role: "cashier", pin: "", loginShortcut: "" });
    setError(null);
    setFormOpen(true);
  }

  function openEdit(user: UserPublic) {
    setEditing(user);
    setForm({
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      pin: "",
      loginShortcut: user.loginShortcut === null ? "" : String(user.loginShortcut),
    });
    setError(null);
    setFormOpen(true);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const loginShortcut = form.loginShortcut ? Number(form.loginShortcut) : null;
      if (editing) {
        await call("user.update", {
          id: editing.id,
          displayName: form.displayName,
          role: form.role,
          loginShortcut,
        });
        toast("Utilizador actualizado.", "success");
      } else {
        await call("user.create", {
          username: form.username,
          displayName: form.displayName,
          role: form.role,
          pin: form.pin,
          // Vazio = atribuir automaticamente a primeira tecla livre.
          ...(form.loginShortcut ? { loginShortcut } : {}),
        });
        toast("Utilizador criado. Terá de alterar o PIN no primeiro acesso.", "success");
      }
      setFormOpen(false);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(user: UserPublic) {
    try {
      await call("user.update", { id: user.id, active: !user.active });
      toast(user.active ? "Utilizador desactivado." : "Utilizador activado.", "success");
      await load();
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  }

  async function confirmReset(event: React.FormEvent) {
    event.preventDefault();
    if (!resetUser) return;
    setBusy(true);
    setError(null);
    try {
      await call("user.resetPin", { id: resetUser.id, pin: resetPin });
      toast("PIN redefinido. O utilizador terá de o alterar no próximo acesso.", "success");
      setResetUser(null);
      setResetPin("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <LoadingPanel label="A carregar utilizadores…" />;

  return (
    <div>
      <PageHeader
        title="Utilizadores"
        description="Caixas, gerentes e proprietários com PIN local. Um gerente aprova descontos e anulações."
        actions={
          <Button onClick={openNew}>
            <Plus className="size-4" /> Novo utilizador
          </Button>
        }
      />

      {users.length === 0 ? (
        <EmptyState title="Sem utilizadores" />
      ) : (
        <div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Utilizador</TableHead>
                <TableHead>Atalho</TableHead>
                <TableHead>Perfil</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>Último acesso</TableHead>
                <TableHead className="text-right">Acções</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((user) => (
                <TableRow key={user.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className="flex size-8 items-center justify-center rounded-full bg-muted text-xs font-semibold">{initials(user.displayName)}</span>
                      <div>
                        <p className="font-medium">
                          {user.displayName} {user.id === session?.user.id ? <span className="text-xs text-muted-foreground">(você)</span> : null}
                        </p>
                        <p className="text-xs text-muted-foreground">@{user.username}</p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    {user.loginShortcut !== null ? (
                      <span title="Tecla para seleccionar no login">
                        <Badge tone="info">{user.loginShortcut}</Badge>
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge tone={user.role === "owner" ? "info" : user.role === "manager" ? "success" : "neutral"}>{roleLabel(user.role)}</Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {user.active ? <Badge tone="success">Activo</Badge> : <Badge tone="danger">Inactivo</Badge>}
                      {user.mustChangePin ? <Badge tone="warning">Trocar PIN</Badge> : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatDateTime(user.lastLoginAt)}</TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon-sm" aria-label="Editar" onClick={() => openEdit(user)}>
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon-sm" aria-label="Redefinir PIN" onClick={() => { setResetUser(user); setResetPin(""); setError(null); }}>
                        <KeyRound className="size-3.5" />
                      </Button>
                      {user.id !== session?.user.id ? (
                        <Button variant="outline" size="xs" onClick={() => void toggleActive(user)}>
                          {user.active ? "Desactivar" : "Activar"}
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Note tone="warning">
        <span className="flex items-center gap-1 font-medium"><ShieldCheck className="size-4" /> Segurança do PIN</span>
        Os PINs são guardados com PBKDF2-SHA-256 e nunca saem deste dispositivo. Utilize PINs diferentes por utilizador.
      </Note>

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? "Editar utilizador" : "Novo utilizador"}</DialogTitle>
            <DialogDescription>{editing ? "O nome de utilizador não pode ser alterado." : "O utilizador terá de definir um novo PIN no primeiro acesso."}</DialogDescription>
          </DialogHeader>
          <form className="space-y-3" onSubmit={save}>
            {!editing ? (
              <Field label="Nome de utilizador *" htmlFor="userUsername" hint="Minúsculas, números, ponto ou hífen.">
                <Input id="userUsername" required value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value.toLowerCase() })} />
              </Field>
            ) : null}
            <Field label="Nome apresentado *" htmlFor="userDisplayName">
              <Input id="userDisplayName" required autoFocus value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} />
            </Field>
            <Field label="Perfil" htmlFor="userRole">
              <Select id="userRole" value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value as Role })}>
                <option value="cashier">Caixa — vende e consulta</option>
                <option value="manager">Gerente — aprova, gere stock e relatórios</option>
                <option value="owner">Proprietário — acesso total</option>
              </Select>
            </Field>
            <Field
              label="Atalho de entrada"
              htmlFor="userShortcut"
              hint={editing ? "Número de 1 a 9 para seleccionar este utilizador com o teclado." : "Deixe em branco para atribuir a primeira tecla livre."}
            >
              <Select
                id="userShortcut"
                value={form.loginShortcut}
                onChange={(event) => setForm({ ...form, loginShortcut: event.target.value })}
              >
                <option value="">{editing ? "Sem atalho" : "Automático (primeira tecla livre)"}</option>
                {Array.from({ length: 9 }, (_, index) => String(index + 1)).map((key) => (
                  <option key={key} value={key}>Tecla {key}</option>
                ))}
              </Select>
            </Field>
            {!editing ? (
              <Field label="PIN inicial (6 dígitos) *" htmlFor="userPin">
                <Input id="userPin" type="password" inputMode="numeric" maxLength={6} required value={form.pin} onChange={(event) => setForm({ ...form, pin: event.target.value.replace(/\D/g, "").slice(0, 6) })} />
              </Field>
            ) : null}
            {error ? <Note tone="danger">{error}</Note> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setFormOpen(false)} disabled={busy}>
                Cancelar
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "A guardar…" : "Guardar"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={resetUser !== null} onOpenChange={(open) => !open && setResetUser(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Redefinir PIN</DialogTitle>
            <DialogDescription>{resetUser ? `${resetUser.displayName} terá de alterar o PIN no próximo acesso.` : ""}</DialogDescription>
          </DialogHeader>
          <form className="space-y-3" onSubmit={confirmReset}>
            <Field label="Novo PIN (6 dígitos)" htmlFor="resetPin">
              <Input id="resetPin" type="password" inputMode="numeric" maxLength={6} required autoFocus value={resetPin} onChange={(event) => setResetPin(event.target.value.replace(/\D/g, "").slice(0, 6))} />
            </Field>
            {error ? <Note tone="danger">{error}</Note> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setResetUser(null)} disabled={busy}>
                Cancelar
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "A guardar…" : "Redefinir PIN"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
