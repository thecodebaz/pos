"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, Pencil, Plus, RefreshCw, Search, Trash2, Wallet } from "lucide-react";
import { useApp, errorMessage } from "@/lib/app-context";
import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  PAYMENT_LABELS,
  type Expense,
  type ExpenseCategory,
  type ExpensePageResult,
  type PaymentMethod,
} from "@/lib/db/protocol";
import { formatDate, formatMzn, formatMznPlain, maputoDayFromInput, parseMzn, todayInput } from "@/lib/format";
import { getDateRangePreset, type DateRange } from "@/lib/date-range";
import { Badge, EmptyState, Field, MoneyInput, Note, PageHeader, Select, StatCard } from "@/components/shared";
import { DateRangeFilter } from "@/components/date-range-filter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PaginationControls } from "@/components/pagination-controls";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const PAGE_SIZE = 15;

type FormState = {
  id?: string;
  category: ExpenseCategory;
  description: string;
  amount: string;
  method: PaymentMethod;
  reference: string;
  note: string;
  spentOn: string;
};

function emptyForm(): FormState {
  return {
    category: "outros",
    description: "",
    amount: "",
    method: "cash",
    reference: "",
    note: "",
    spentOn: todayInput(),
  };
}

function csvCell(value: unknown): string {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

export function ExpensesScreen() {
  const { session, call, toast } = useApp();
  const canEdit = session?.user.role === "owner" || session?.user.role === "manager";

  const [range, setRange] = useState<DateRange>(() => getDateRangePreset("thisWeek"));
  const [category, setCategory] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<Expense[]>([]);
  const [total, setTotal] = useState(0);
  const [totalCents, setTotalCents] = useState(0);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await call<ExpensePageResult>("expense.page", {
        from: maputoDayFromInput(range.from),
        to: maputoDayFromInput(range.to, true),
        category: category || null,
        query,
        page,
        pageSize: PAGE_SIZE,
      });
      setItems(result.items);
      setTotal(result.total);
      setTotalCents(result.totalCents);
      if (result.page !== page) setPage(result.page);
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setLoading(false);
    }
  }, [call, category, page, query, range.from, range.to, toast]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), query ? 200 : 0);
    return () => window.clearTimeout(timer);
  }, [load, query]);

  function openNew() {
    setForm(emptyForm());
    setError(null);
    setFormOpen(true);
  }

  function openEdit(expense: Expense) {
    // spentAt é o início do dia em Maputo (22:00 UTC do dia anterior).
    const date = new Date(new Date(expense.spentAt).getTime() + 2 * 60 * 60 * 1000);
    const spentOn = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
    setForm({
      id: expense.id,
      category: expense.category,
      description: expense.description,
      amount: formatMznPlain(expense.amountCents),
      method: expense.method,
      reference: expense.reference ?? "",
      note: expense.note ?? "",
      spentOn,
    });
    setError(null);
    setFormOpen(true);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const amountCents = parseMzn(form.amount);
    if (amountCents <= 0) {
      setError("Indique um valor superior a zero.");
      return;
    }
    if (!form.description.trim()) {
      setError("Indique a descrição da saída.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await call("expense.upsert", {
        ...(form.id ? { id: form.id } : {}),
        category: form.category,
        description: form.description.trim(),
        amountCents,
        method: form.method,
        reference: form.reference.trim(),
        note: form.note.trim(),
        spentAt: maputoDayFromInput(form.spentOn),
      });
      toast(form.id ? "Saída actualizada." : "Saída registada.", "success");
      setFormOpen(false);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(expense: Expense) {
    if (!window.confirm(`Eliminar a saída "${expense.description}" de ${formatMzn(expense.amountCents)}?`)) return;
    try {
      await call("expense.delete", { id: expense.id });
      toast("Saída eliminada.", "success");
      await load();
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  }

  async function exportCsv() {
    try {
      const rows: Expense[] = [];
      const pageSize = 100;
      for (let current = 1; current <= 100; current += 1) {
        const result = await call<ExpensePageResult>("expense.page", {
          from: maputoDayFromInput(range.from),
          to: maputoDayFromInput(range.to, true),
          category: category || null,
          query,
          page: current,
          pageSize,
        });
        rows.push(...result.items);
        if (result.items.length === 0 || rows.length >= result.total) break;
      }
      const lines = [
        ["Data", "Categoria", "Descrição", "Referência", "Método", "Valor MZN", "Registado por", "Notas"],
        ...rows.map((expense) => [
          formatDate(expense.spentAt),
          EXPENSE_CATEGORY_LABELS[expense.category],
          expense.description,
          expense.reference ?? "",
          PAYMENT_LABELS[expense.method],
          (expense.amountCents / 100).toFixed(2),
          expense.userName ?? "",
          expense.note ?? "",
        ]),
      ];
      const csv = "\uFEFF" + lines.map((line) => line.map(csvCell).join(";")).join("\r\n");
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `despesas-${range.from}-a-${range.to}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  }

  const currentPage = Math.min(page, Math.max(1, Math.ceil(total / PAGE_SIZE)));

  return (
    <div>
      <PageHeader
        title="Saídas de dinheiro"
        description="Registe despesas ou qualquer outra finalidade. Os valores descontam do resultado nos relatórios do mesmo período."
        actions={
          <>
            <Button variant="outline" onClick={() => void exportCsv()}>
              <Download className="size-4" /> CSV
            </Button>
            <Button variant="outline" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} /> Actualizar
            </Button>
            {canEdit ? (
              <Button onClick={openNew}>
                <Plus className="size-4" /> Nova saída
              </Button>
            ) : null}
          </>
        }
      />

      <div className="mb-4 grid gap-2 lg:grid-cols-[minmax(0,18rem)_minmax(0,14rem)_minmax(0,1fr)]">
        <Field label="Período">
          <DateRangeFilter value={range} onChange={(next) => { setRange(next); setPage(1); }} />
        </Field>
        <Field label="Categoria">
          <Select value={category} onChange={(event) => { setCategory(event.target.value); setPage(1); }}>
            <option value="">Todas as categorias</option>
            {EXPENSE_CATEGORIES.map((item) => (
              <option key={item} value={item}>{EXPENSE_CATEGORY_LABELS[item]}</option>
            ))}
          </Select>
        </Field>
        <Field label="Pesquisar">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => { setQuery(event.target.value); setPage(1); }}
              placeholder="Descrição, referência… (ex.: transporte gasolina)"
              className="pl-8"
            />
          </div>
        </Field>
      </div>

      <div className="mb-4 grid gap-2 sm:grid-cols-3">
        <StatCard label="Total saído" value={formatMzn(totalCents)} hint="No período e filtros activos" />
        <StatCard label="Registos" value={total} hint="Saídas de dinheiro" />
        <StatCard
          label="Última categoria"
          value={items.length > 0 ? EXPENSE_CATEGORY_LABELS[items[0].category] : "—"}
          hint="Saída mais recente"
        />
      </div>

      <p className="mb-2 text-xs text-muted-foreground" aria-live="polite">
        {loading ? "A actualizar…" : `${total} saída(s)`}
      </p>

      {items.length === 0 ? (
        <EmptyState
          title="Sem saídas registadas"
          description="Registe o dinheiro gasto em compras, transporte, luz, salários ou qualquer outra finalidade."
          action={canEdit ? <Button onClick={openNew}><Plus className="size-4" /> Nova saída</Button> : undefined}
        />
      ) : (
        <div className="space-y-3">
          <div className="rounded-xl bg-card ring-1 ring-foreground/10">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data</TableHead>
                  <TableHead>Categoria</TableHead>
                  <TableHead>Descrição</TableHead>
                  <TableHead>Método</TableHead>
                  <TableHead className="text-right">Valor</TableHead>
                  {canEdit ? <TableHead className="w-20" /> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((expense) => (
                  <TableRow key={expense.id}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{formatDate(expense.spentAt)}</TableCell>
                    <TableCell>
                      <Badge tone="neutral">{EXPENSE_CATEGORY_LABELS[expense.category]}</Badge>
                    </TableCell>
                    <TableCell>
                      <p className="font-medium">{expense.description}</p>
                      {expense.reference || expense.userName ? (
                        <p className="text-xs text-muted-foreground">
                          {expense.reference ? `Ref.: ${expense.reference}` : ""}
                          {expense.reference && expense.userName ? " · " : ""}
                          {expense.userName ?? ""}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{PAYMENT_LABELS[expense.method]}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums text-amber-700 dark:text-amber-400">
                      − {formatMzn(expense.amountCents)}
                    </TableCell>
                    {canEdit ? (
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          <Button variant="ghost" size="icon-sm" aria-label="Editar" onClick={() => openEdit(expense)}>
                            <Pencil className="size-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon-sm" aria-label="Eliminar" onClick={() => void remove(expense)}>
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <PaginationControls page={currentPage} pageSize={PAGE_SIZE} total={total} itemLabel="saídas" onPageChange={setPage} />
        </div>
      )}

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{form.id ? "Editar saída" : "Registar saída de dinheiro"}</DialogTitle>
            <DialogDescription>
              Escolha a finalidade e indique o valor. A saída é descontada do resultado do período correspondente.
            </DialogDescription>
          </DialogHeader>
          <form className="grid gap-3 sm:grid-cols-2" onSubmit={(event) => void save(event)}>
            <Field label="Categoria" htmlFor="expenseCategory" className="sm:col-span-2">
              <Select
                id="expenseCategory"
                value={form.category}
                onChange={(event) => setForm({ ...form, category: event.target.value as ExpenseCategory })}
              >
                {EXPENSE_CATEGORIES.map((item) => (
                  <option key={item} value={item}>{EXPENSE_CATEGORY_LABELS[item]}</option>
                ))}
              </Select>
            </Field>
            <Field label="Descrição *" htmlFor="expenseDescription" className="sm:col-span-2">
              <Input
                id="expenseDescription"
                required
                autoFocus
                value={form.description}
                onChange={(event) => setForm({ ...form, description: event.target.value })}
                placeholder="Ex.: Gasolina para entrega"
              />
            </Field>
            <Field label="Valor *" htmlFor="expenseAmount">
              <MoneyInput
                id="expenseAmount"
                required
                value={form.amount}
                onValueChange={(value) => setForm({ ...form, amount: value })}
                placeholder="0,00"
              />
            </Field>
            <Field label="Data da saída" htmlFor="expenseDate">
              <Input
                id="expenseDate"
                type="date"
                required
                value={form.spentOn}
                onChange={(event) => setForm({ ...form, spentOn: event.target.value })}
              />
            </Field>
            <Field label="Método" htmlFor="expenseMethod">
              <Select
                id="expenseMethod"
                value={form.method}
                onChange={(event) => setForm({ ...form, method: event.target.value as PaymentMethod })}
              >
                {(Object.keys(PAYMENT_LABELS) as PaymentMethod[]).map((method) => (
                  <option key={method} value={method}>{PAYMENT_LABELS[method]}</option>
                ))}
              </Select>
            </Field>
            <Field label="Referência" htmlFor="expenseReference" hint="Factura, recibo ou código da operação (opcional).">
              <Input
                id="expenseReference"
                value={form.reference}
                onChange={(event) => setForm({ ...form, reference: event.target.value })}
                placeholder="Ex.: FACT-0123"
              />
            </Field>
            <Field label="Notas" htmlFor="expenseNote" className="sm:col-span-2">
              <Input
                id="expenseNote"
                value={form.note}
                onChange={(event) => setForm({ ...form, note: event.target.value })}
                placeholder="Detalhes adicionais (opcional)"
              />
            </Field>
            {error ? <div className="sm:col-span-2"><Note tone="danger">{error}</Note></div> : null}
            <DialogFooter className="sm:col-span-2">
              <Button type="button" variant="ghost" onClick={() => setFormOpen(false)} disabled={busy}>
                Cancelar
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "A guardar…" : form.id ? "Guardar alterações" : "Registar saída"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <div className="mt-4">
        <Note>
          <Wallet className="mr-1 inline size-3.5" /> As saídas não alteram o stock. Para comprar mercadorias, registe também a entrada de stock no ecrã Stock.
        </Note>
      </div>
    </div>
  );
}
