"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDownUp, Boxes, FileSpreadsheet, Plus, Search } from "lucide-react";
import { useApp, errorMessage } from "@/lib/app-context";
import type { PagedResult, Product, StockEntryUnit, StockMovement, Supplier } from "@/lib/db/protocol";
import { parseStockImportWorkbook, STOCK_IMPORT_DRAFT_KEY } from "@/lib/stock-import";
import { formatDateTime, formatMzn, formatMznPlain, formatQty, maputoDayFromInput, parseMzn, parseQty } from "@/lib/format";
import { getDateRangePreset, type DateRange } from "@/lib/date-range";
import { Badge, EmptyState, Field, LoadingPanel, MoneyInput, Note, PageHeader, Select } from "@/components/shared";
import { DateRangeFilter } from "@/components/date-range-filter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PaginationControls } from "@/components/pagination-controls";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const PRODUCT_PAGE_SIZE = 15;
const HISTORY_PAGE_SIZE = 25;

const MOVEMENT_LABELS: Record<string, string> = {
  purchase_in: "Entrada",
  sale: "Venda",
  sale_void: "Anulação de venda",
  adjustment_in: "Ajuste (+)",
  adjustment_out: "Ajuste (−)",
};

export function StockScreen() {
  const { session, call, toast } = useApp();
  const router = useRouter();
  const importFileRef = useRef<HTMLInputElement>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [lowProducts, setLowProducts] = useState<Product[]>([]);
  const [productTotal, setProductTotal] = useState(0);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [history, setHistory] = useState<StockMovement[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [productPage, setProductPage] = useState(1);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyRange, setHistoryRange] = useState<DateRange>(() => getDateRangePreset("thisWeek"));
  const [loading, setLoading] = useState(true);
  const [importingFile, setImportingFile] = useState(false);
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<"entry" | "adjust" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    qty: "",
    cost: "",
    supplierId: "",
    documentRef: "",
    note: "",
    direction: "in" as "in" | "out",
    inputUnit: "unit" as StockEntryUnit,
    reason: "",
  });

  const canImport = session?.user.role === "owner" || session?.user.role === "manager";

  async function processStockWorkbook(file: File) {
    setImportingFile(true);
    try {
      const draft = await parseStockImportWorkbook(file);
      sessionStorage.setItem(STOCK_IMPORT_DRAFT_KEY, JSON.stringify(draft));
      router.push("/stock/import/");
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setImportingFile(false);
    }
  }

  const load = useCallback(async () => {
    try {
      const [productResult, lowProductList, supplierList] = await Promise.all([
        call<PagedResult<Product>>("product.page", { activeOnly: true, trackStockOnly: true, query, page: productPage, pageSize: PRODUCT_PAGE_SIZE }),
        call<Product[]>("stock.low"),
        call<Supplier[]>("supplier.list"),
      ]);
      setProducts(productResult.items);
      setProductTotal(productResult.total);
      setLowProducts(lowProductList);
      if (productResult.page !== productPage) setProductPage(productResult.page);
      setSuppliers(supplierList);
      setSelectedId((current) => productResult.items.some((product) => product.id === current)
        ? current
        : productResult.items[0]?.id || "");
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setLoading(false);
    }
  }, [call, productPage, query, toast]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const loadHistory = useCallback(async (productId: string, requestedPage: number) => {
    if (!productId) {
      setHistory([]);
      setHistoryTotal(0);
      setHistoryPage(1);
      return;
    }
    setHistoryLoading(true);
    try {
      const result = await call<PagedResult<StockMovement>>("stock.history.page", {
        productId,
        page: requestedPage,
        pageSize: HISTORY_PAGE_SIZE,
        from: maputoDayFromInput(historyRange.from),
        to: maputoDayFromInput(historyRange.to, true),
      });
      setHistory(result.items);
      setHistoryTotal(result.total);
      setHistoryPage(result.page);
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setHistoryLoading(false);
    }
  }, [call, historyRange.from, historyRange.to, toast]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadHistory(selectedId, historyPage), 0);
    return () => window.clearTimeout(timer);
  }, [selectedId, historyPage, loadHistory]);

  const selected = products.find((product) => product.id === selectedId) ?? null;
  const currentProductPage = Math.min(productPage, Math.max(1, Math.ceil(productTotal / PRODUCT_PAGE_SIZE)));
  const historyPageCount = Math.max(1, Math.ceil(historyTotal / HISTORY_PAGE_SIZE));
  const currentHistoryPage = Math.min(historyPage, historyPageCount);

  function selectProduct(productId: string) {
    setSelectedId(productId);
    setHistoryPage(1);
  }
  const low = lowProducts;

  function openDialog(kind: "entry" | "adjust") {
    setForm({ qty: "", cost: selected ? formatMznPlain(selected.costCents) : "", supplierId: "", documentRef: "", note: "", direction: "in", inputUnit: "unit", reason: "" });
    setError(null);
    setDialog(kind);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const qty = parseQty(form.qty);
      if (qty <= 0) {
        setError("Indique uma quantidade superior a zero.");
        return;
      }
      if (dialog === "entry") {
        await call("stock.entry", {
          productId: selected.id,
          qtyMilli: qty,
          inputUnit: form.inputUnit,
          unitCostCents: parseMzn(form.cost),
          supplierId: form.supplierId || null,
          documentRef: form.documentRef,
          note: form.note,
        });
        toast("Entrada de stock registada.", "success");
      } else {
        await call("stock.adjust", {
          productId: selected.id,
          qtyMilli: form.direction === "in" ? qty : -qty,
          reason: form.reason,
        });
        toast("Ajuste de stock registado.", "success");
      }
      setDialog(null);
      await load();
      await loadHistory(selected.id, 1);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <LoadingPanel label="A carregar stock…" />;

  return (
    <div>
      <PageHeader
        title="Stock"
        description="Entradas de compra, ajustes e movimentos. As vendas e anulações actualizam o stock automaticamente."
        actions={
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(event) => { setQuery(event.target.value); setProductPage(1); }} placeholder="Filtrar produtos…" className="pl-8" />
            </div>
            {canImport ? (
              <>
                <input
                  ref={importFileRef}
                  type="file"
                  accept=".xlsx,.xls"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void processStockWorkbook(file);
                  }}
                />
                <Button variant="outline" onClick={() => importFileRef.current?.click()} disabled={importingFile}>
                  <FileSpreadsheet className="size-4" /> {importingFile ? "A processar…" : "Importar Excel"}
                </Button>
              </>
            ) : null}
            <Button variant="outline" onClick={() => openDialog("adjust")} disabled={!selected}>
              <ArrowDownUp className="size-4" /> Ajuste
            </Button>
            <Button onClick={() => openDialog("entry")} disabled={!selected}>
              <Plus className="size-4" /> Entrada
            </Button>
          </>
        }
      />

      {low.length > 0 ? (
        <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30">
          <p className="mb-2 text-sm font-medium text-amber-900 dark:text-amber-200">Produtos com stock baixo</p>
          <div className="flex flex-wrap gap-1.5">
            {low.map((product) => (
              <button
                key={product.id}
                type="button"
                onClick={() => {
                  setQuery(product.sku);
                  setProductPage(1);
                  selectProduct(product.id);
                }}
                className="rounded-md bg-white px-2 py-1 text-xs ring-1 ring-amber-300 dark:bg-amber-900/40 dark:ring-amber-800"
              >
                {product.name} · {formatQty(product.stockOnHandMilli)} {product.unit}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <div className="rounded-xl bg-card ring-1 ring-foreground/10 lg:sticky lg:top-4 lg:self-start">
          <p className="border-b px-3 py-2 text-sm font-medium">Produtos ({productTotal})</p>
          <div className="max-h-[60vh] overflow-y-auto p-1">
            {products.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">Sem produtos com controlo de stock.</p>
            ) : (
              products.map((product) => {
                const isLow = product.lowStockThresholdMilli > 0 && product.stockOnHandMilli <= product.lowStockThresholdMilli;
                return (
                  <button
                    key={product.id}
                    type="button"
                    onClick={() => selectProduct(product.id)}
                    className={
                      "flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-left text-sm " +
                      (product.id === selectedId ? "bg-emerald-600 text-white" : "hover:bg-muted")
                    }
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{product.name}</span>
                      <span className={"block text-[11px] " + (product.id === selectedId ? "text-emerald-100" : "text-muted-foreground")}>{product.sku}</span>
                      {product.color ? <span className="block text-[11px] opacity-80">Cor: {product.color}</span> : null}
                    </span>
                    <span className={"shrink-0 tabular-nums " + (isLow && product.id !== selectedId ? "text-amber-600" : "")}>
                      {formatQty(product.stockOnHandMilli)}
                    </span>
                  </button>
                );
              })
            )}
          </div>
          <div className="border-t p-2">
            <PaginationControls page={currentProductPage} pageSize={PRODUCT_PAGE_SIZE} total={productTotal} itemLabel="produtos" onPageChange={setProductPage} />
          </div>
        </div>

        <div className="space-y-4">
          {selected ? (
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl bg-card p-4 ring-1 ring-foreground/10 sm:col-span-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-lg font-semibold">{selected.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {[selected.sku, selected.color, selected.unit, `custo ${formatMzn(selected.costCents)}`].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-3xl font-bold tabular-nums">{formatQty(selected.stockOnHandMilli)}</p>
                    <p className="text-xs text-muted-foreground">
                      {selected.unit} em stock · alerta {formatQty(selected.lowStockThresholdMilli)}
                    </p>
                  </div>
                </div>
              </div>

              <div className="rounded-xl bg-card ring-1 ring-foreground/10 lg:col-span-3">
                <div className="flex flex-col gap-2 border-b px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-sm font-medium">Movimentos recentes</p>
                  <DateRangeFilter
                    value={historyRange}
                    onChange={(next) => { setHistoryRange(next); setHistoryPage(1); }}
                    className="sm:w-56"
                  />
                </div>
                {historyLoading ? (
                  <LoadingPanel label="A carregar movimentos…" />
                ) : historyTotal === 0 ? (
                  <EmptyState title="Sem movimentos" description="Ajuste o período ou registe uma entrada de stock para começar." />
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Data</TableHead>
                        <TableHead>Tipo</TableHead>
                        <TableHead>Factura</TableHead>
                        <TableHead className="text-right">Qtd</TableHead>
                        <TableHead className="text-right">Saldo</TableHead>
                        <TableHead>Detalhe</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {history.map((movement) => (
                        <TableRow key={movement.id}>
                          <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(movement.createdAt)}</TableCell>
                          <TableCell>
                            <Badge tone={movement.qtyMilli >= 0 ? "success" : "warning"}>
                              {MOVEMENT_LABELS[movement.type] ?? movement.type}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            {movement.documentRef
                              ? <Badge tone="info">{movement.documentRef}</Badge>
                              : <span className="text-xs text-muted-foreground">—</span>}
                          </TableCell>
                          <TableCell className={"text-right tabular-nums " + (movement.qtyMilli < 0 ? "text-red-600" : "")}>
                            {movement.qtyMilli > 0 ? "+" : ""}
                            {formatQty(movement.qtyMilli)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{formatQty(movement.balanceAfterMilli)}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {[movement.supplierName, movement.reason, movement.userName].filter(Boolean).join(" · ") || "—"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
                <div className="border-t p-3">
                  <PaginationControls page={currentHistoryPage} pageSize={HISTORY_PAGE_SIZE} total={historyTotal} itemLabel="movimentos" onPageChange={setHistoryPage} />
                </div>
              </div>
            </div>
          ) : (
            <EmptyState
              title="Escolha um produto"
              description="Seleccione um produto na lista para ver o stock e os movimentos."
              action={<Button onClick={() => { router.push("/produtos/"); }}><Boxes className="size-4" /> Abrir catálogo</Button>}
            />
          )}
        </div>
      </div>

      <Dialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{dialog === "entry" ? "Entrada de stock" : "Ajuste de stock"}</DialogTitle>
            <DialogDescription>
              {selected ? `${selected.name} · stock actual ${formatQty(selected.stockOnHandMilli)} ${selected.unit}` : ""}
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-3" onSubmit={submit}>
            {dialog === "entry" && selected?.packageQtyMilli ? (
              <Field label="Formato de entrada" htmlFor="stockInputUnit">
                <Select
                  id="stockInputUnit"
                  value={form.inputUnit}
                  onChange={(event) => {
                    const inputUnit = event.target.value as StockEntryUnit;
                    const costCents = inputUnit === "package"
                      ? Math.round((selected.costCents * selected.packageQtyMilli) / 1000)
                      : selected.costCents;
                    setForm({ ...form, inputUnit, cost: formatMznPlain(costCents) });
                  }}
                >
                  <option value="unit">{selected.unit} (unidade-base)</option>
                  <option value="package">Pacote ({formatQty(selected.packageQtyMilli)} {selected.unit})</option>
                </Select>
              </Field>
            ) : null}
            {dialog === "adjust" ? (
              <Field label="Tipo de ajuste" htmlFor="direction">
                <Select id="direction" value={form.direction} onChange={(event) => setForm({ ...form, direction: event.target.value as "in" | "out" })}>
                  <option value="in">Acrescentar ao stock</option>
                  <option value="out">Retirar do stock</option>
                </Select>
              </Field>
            ) : null}
            <Field
              label={dialog === "entry" && form.inputUnit === "package" ? "Quantidade de pacotes *" : "Quantidade *"}
              htmlFor="stockQty"
              hint={dialog === "entry" && form.inputUnit === "package"
                ? `Cada pacote adiciona ${formatQty(selected?.packageQtyMilli ?? 0)} ${selected?.unit ?? ""} ao stock.`
                : "Pode usar decimais, ex.: 1,5 kg."}
            >
              <Input id="stockQty" required autoFocus inputMode="decimal" value={form.qty} onChange={(event) => setForm({ ...form, qty: event.target.value })} />
            </Field>
            {dialog === "entry" ? (
              <>
                <Field label={`Custo por ${form.inputUnit === "package" ? "pacote" : "unidade-base"} (MZN)`} htmlFor="stockCost">
                  <MoneyInput id="stockCost" value={form.cost} onValueChange={(cost) => setForm({ ...form, cost })} />
                </Field>
                <Field label="Fornecedor" htmlFor="stockSupplier">
                  <Select id="stockSupplier" value={form.supplierId} onChange={(event) => setForm({ ...form, supplierId: event.target.value })}>
                    <option value="">Sem fornecedor</option>
                    {suppliers.map((supplier) => (
                      <option key={supplier.id} value={supplier.id}>
                        {supplier.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Documento / factura" htmlFor="stockDoc">
                  <Input id="stockDoc" value={form.documentRef} onChange={(event) => setForm({ ...form, documentRef: event.target.value })} />
                </Field>
                <Field label="Nota" htmlFor="stockNote">
                  <Input id="stockNote" value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} />
                </Field>
              </>
            ) : (
              <Field label="Motivo do ajuste *" htmlFor="stockReason" hint="Mínimo 3 caracteres. Fica registado na auditoria.">
                <Input id="stockReason" required value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} placeholder="Ex.: quebra, contagem física…" />
              </Field>
            )}
            {error ? <Note tone="danger">{error}</Note> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDialog(null)} disabled={busy}>
                Cancelar
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "A guardar…" : "Guardar"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
