"use client";

import { useCallback, useEffect, useState } from "react";
import { Pencil, Plus, Search, Trash2, Truck } from "lucide-react";
import { useApp, errorMessage } from "@/lib/app-context";
import type { Supplier } from "@/lib/db/protocol";
import { Badge, EmptyState, Field, LoadingPanel, Note, PageHeader } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PaginationControls } from "@/components/pagination-controls";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const PAGE_SIZE = 12;

type FormState = {
  id?: string;
  name: string;
  contactName: string;
  phone: string;
  nif: string;
  email: string;
  address: string;
  notes: string;
  active: boolean;
};

const emptyForm: FormState = { name: "", contactName: "", phone: "", nif: "", email: "", address: "", notes: "", active: true };

export function SuppliersScreen() {
  const { call, toast } = useApp();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSuppliers(await call<Supplier[]>("supplier.list", { query }));
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
  const pageCount = Math.max(1, Math.ceil(suppliers.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visibleSuppliers = suppliers.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await call("supplier.upsert", form);
      toast(form.id ? "Fornecedor actualizado." : "Fornecedor criado.", "success");
      setFormOpen(false);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(supplier: Supplier) {
    if (!window.confirm(`Desactivar o fornecedor "${supplier.name}"?`)) return;
    try {
      await call("supplier.delete", { id: supplier.id });
      toast("Fornecedor desactivado.", "success");
      await load();
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  }

  return (
    <div>
      <PageHeader
        title="Fornecedores"
        description="Fornecedores usados nas entradas de stock. O histórico é preservado mesmo que o fornecedor seja desactivado."
        actions={
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Pesquisar…" className="pl-8" />
            </div>
            <Button
              onClick={() => {
                setForm(emptyForm);
                setError(null);
                setFormOpen(true);
              }}
            >
              <Plus className="size-4" /> Novo fornecedor
            </Button>
          </>
        }
      />

      {loading ? (
        <LoadingPanel />
      ) : suppliers.length === 0 ? (
        <EmptyState title="Sem fornecedores" description="Adicione fornecedores para registar compras de stock." />
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {visibleSuppliers.map((supplier) => (
              <div key={supplier.id} className="rounded-xl bg-card p-4 ring-1 ring-foreground/10">
                <div className="flex items-start gap-3">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted">
                    <Truck className="size-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <p className="truncate font-medium">{supplier.name}</p>
                      {!supplier.active ? <Badge tone="danger">Inactivo</Badge> : null}
                    </div>
                    {supplier.contactName ? <p className="text-xs text-muted-foreground">{supplier.contactName}</p> : null}
                    {supplier.phone ? <p className="text-xs text-muted-foreground">{supplier.phone}</p> : null}
                    {supplier.nif ? <p className="text-xs text-muted-foreground">NUIT: {supplier.nif}</p> : null}
                  </div>
                  <div className="flex gap-0.5">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Editar"
                      onClick={() => {
                        setForm({ ...supplier });
                        setError(null);
                        setFormOpen(true);
                      }}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon-sm" aria-label="Desactivar" onClick={() => void remove(supplier)}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3">
            <PaginationControls page={currentPage} pageSize={PAGE_SIZE} total={suppliers.length} itemLabel="fornecedores" onPageChange={setPage} />
          </div>
        </>
      )}

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{form.id ? "Editar fornecedor" : "Novo fornecedor"}</DialogTitle>
            <DialogDescription>Dados usados nas entradas de stock.</DialogDescription>
          </DialogHeader>
          <form className="grid gap-3 sm:grid-cols-2" onSubmit={save}>
            <Field label="Nome *" htmlFor="supplierName" className="sm:col-span-2">
              <Input id="supplierName" required autoFocus value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
            </Field>
            <Field label="Pessoa de contacto" htmlFor="supplierContact">
              <Input id="supplierContact" value={form.contactName} onChange={(event) => setForm({ ...form, contactName: event.target.value })} />
            </Field>
            <Field label="Telefone" htmlFor="supplierPhone">
              <Input id="supplierPhone" inputMode="tel" value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} />
            </Field>
            <Field label="NUIT / NIF" htmlFor="supplierNif" hint="9 dígitos, opcional.">
              <Input id="supplierNif" inputMode="numeric" maxLength={9} value={form.nif} onChange={(event) => setForm({ ...form, nif: event.target.value })} />
            </Field>
            <Field label="Email" htmlFor="supplierEmail">
              <Input id="supplierEmail" type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
            </Field>
            <Field label="Endereço" htmlFor="supplierAddress" className="sm:col-span-2">
              <Input id="supplierAddress" value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })} />
            </Field>
            <Field label="Notas" htmlFor="supplierNotes" className="sm:col-span-2">
              <Input id="supplierNotes" value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} />
            </Field>
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input type="checkbox" className="size-4" checked={form.active} onChange={(event) => setForm({ ...form, active: event.target.checked })} />
              Fornecedor activo
            </label>
            {error ? <div className="sm:col-span-2"><Note tone="danger">{error}</Note></div> : null}
            <DialogFooter className="sm:col-span-2">
              <Button type="button" variant="outline" onClick={() => setFormOpen(false)} disabled={busy}>
                Cancelar
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "A guardar…" : "Guardar fornecedor"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
