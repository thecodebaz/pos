"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Pencil, Plus, Search, Trash2, UserRound, Phone } from "lucide-react";
import { useApp, errorMessage } from "@/lib/app-context";
import type { Customer } from "@/lib/db/protocol";
import { EmptyState, Field, LoadingPanel, Note, PageHeader } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PaginationControls } from "@/components/pagination-controls";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const PAGE_SIZE = 12;

type FormState = {
  id?: string;
  name: string;
  phone: string;
  altPhone: string;
  nif: string;
  email: string;
  address: string;
  notes: string;
};

const emptyForm: FormState = { name: "", phone: "", altPhone: "", nif: "", email: "", address: "", notes: "" };

export function CustomersScreen() {
  const { session, call, toast } = useApp();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canDelete = session?.user.role === "owner" || session?.user.role === "manager";

  const load = useCallback(async () => {
    try {
      setCustomers(await call<Customer[]>("customer.list", { query }));
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setLoading(false);
    }
  }, [call, query, toast]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 200);
    return () => window.clearTimeout(timer);
  }, [load]);

  const filtered = useMemo(() => {
    const text = query.toLowerCase().trim();
    if (!text) return customers;
    return customers.filter((customer) => `${customer.name} ${customer.phone} ${customer.nif}`.toLowerCase().includes(text));
  }, [customers, query]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visibleCustomers = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await call("customer.upsert", form);
      toast(form.id ? "Cliente actualizado." : "Cliente criado.", "success");
      setFormOpen(false);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(customer: Customer) {
    if (!window.confirm(`Eliminar o cliente "${customer.name}"?`)) return;
    try {
      await call("customer.delete", { id: customer.id });
      toast("Cliente eliminado.", "success");
      await load();
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  }

  return (
    <div>
      <PageHeader
        title="Clientes"
        description="Registo local de clientes. O NIF é opcional e pode ser impresso no recibo."
        actions={
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Nome, telefone ou NIF…" className="pl-8" />
            </div>
            <Button
              onClick={() => {
                setForm(emptyForm);
                setError(null);
                setFormOpen(true);
              }}
            >
              <Plus className="size-4" /> Novo cliente
            </Button>
          </>
        }
      />

      {loading ? (
        <LoadingPanel />
      ) : filtered.length === 0 ? (
        <EmptyState title="Sem clientes" description="Adicione clientes para associar vendas e histórico." />
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {visibleCustomers.map((customer) => (
              <div key={customer.id} className="rounded-xl bg-card p-4 ring-1 ring-foreground/10">
                <div className="flex items-start gap-3">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted">
                    <UserRound className="size-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{customer.name}</p>
                    {customer.phone ? (
                      <p className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Phone className="size-3" /> {customer.phone}
                      </p>
                    ) : null}
                    {customer.nif ? <p className="text-xs text-muted-foreground">NUIT: {customer.nif}</p> : null}
                    {customer.address ? <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{customer.address}</p> : null}
                  </div>
                  <div className="flex gap-0.5">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Editar"
                      onClick={() => {
                        setForm({ ...emptyForm, ...customer, altPhone: "" });
                        setError(null);
                        setFormOpen(true);
                      }}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    {canDelete ? (
                      <Button variant="ghost" size="icon-sm" aria-label="Eliminar" onClick={() => void remove(customer)}>
                        <Trash2 className="size-3.5" />
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3">
            <PaginationControls page={currentPage} pageSize={PAGE_SIZE} total={filtered.length} itemLabel="clientes" onPageChange={setPage} />
          </div>
        </>
      )}

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{form.id ? "Editar cliente" : "Novo cliente"}</DialogTitle>
            <DialogDescription>Guardado apenas neste dispositivo.</DialogDescription>
          </DialogHeader>
          <form className="grid gap-3 sm:grid-cols-2" onSubmit={save}>
            <Field label="Nome *" htmlFor="customerName" className="sm:col-span-2">
              <Input id="customerName" required autoFocus value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
            </Field>
            <Field label="Telefone" htmlFor="customerPhone">
              <Input id="customerPhone" inputMode="tel" value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} placeholder="+258 84 000 0000" />
            </Field>
            <Field label="Telefone alternativo" htmlFor="customerAltPhone">
              <Input id="customerAltPhone" inputMode="tel" value={form.altPhone} onChange={(event) => setForm({ ...form, altPhone: event.target.value })} />
            </Field>
            <Field label="NUIT / NIF" htmlFor="customerNif" hint="9 dígitos, opcional.">
              <Input id="customerNif" inputMode="numeric" maxLength={9} value={form.nif} onChange={(event) => setForm({ ...form, nif: event.target.value })} />
            </Field>
            <Field label="Email" htmlFor="customerEmail">
              <Input id="customerEmail" type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
            </Field>
            <Field label="Endereço" htmlFor="customerAddress" className="sm:col-span-2">
              <Input id="customerAddress" value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })} />
            </Field>
            <Field label="Notas" htmlFor="customerNotes" className="sm:col-span-2">
              <Input id="customerNotes" value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} />
            </Field>
            {error ? <div className="sm:col-span-2"><Note tone="danger">{error}</Note></div> : null}
            <DialogFooter className="sm:col-span-2">
              <Button type="button" variant="outline" onClick={() => setFormOpen(false)} disabled={busy}>
                Cancelar
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "A guardar…" : "Guardar cliente"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
