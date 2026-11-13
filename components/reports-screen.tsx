"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { useApp, errorMessage } from "@/lib/app-context";
import type { Product, ReportSummary, SaleSummary } from "@/lib/db/protocol";
import { PAYMENT_LABELS } from "@/lib/db/protocol";
import { formatDate, formatMzn, formatQty, maputoDayFromInput, todayInput } from "@/lib/format";
import { Badge, EmptyState, Field, LoadingPanel, Note, PageHeader, StatCard } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export function ReportsScreen() {
  const { call, toast } = useApp();
  const [from, setFrom] = useState(todayInput());
  const [to, setTo] = useState(todayInput());
  const [summary, setSummary] = useState<ReportSummary | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [report, list] = await Promise.all([
        call<ReportSummary>("report.summary", { from: maputoDayFromInput(from), to: maputoDayFromInput(to, true) }),
        call<Product[]>("product.list", { activeOnly: true }),
      ]);
      setSummary(report);
      setProducts(list);
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setLoading(false);
    }
  }, [call, from, to, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function exportCsv() {
    try {
      const sales = await call<SaleSummary[]>("sale.list", {
        from: maputoDayFromInput(from),
        to: maputoDayFromInput(to, true),
        limit: 500,
      });
      const rows = [
        ["Recibo", "Data", "Cliente", "Operador", "Estado", "Artigos", "Total MZN"],
        ...sales.map((sale) => [
          sale.receiptNumber,
          sale.createdAt,
          sale.customerName ?? "Consumidor final",
          sale.cashierName,
          sale.status === "voided" ? "Anulada" : "Concluída",
          String(sale.itemCount),
          (sale.totalCents / 100).toFixed(2),
        ]),
      ];
      const csv = "\uFEFF" + rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(";")).join("\r\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `vendas-${from}-a-${to}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  }

  const stockValue = products
    .filter((product) => product.trackStock)
    .reduce((sum, product) => sum + Math.round((product.costCents * product.stockOnHandMilli) / 1000), 0);
  const retailValue = products
    .filter((product) => product.trackStock)
    .reduce((sum, product) => sum + Math.round((product.priceCents * product.stockOnHandMilli) / 1000), 0);

  return (
    <div>
      <PageHeader
        title="Relatórios"
        description="Resumo do período, meios de pagamento, produtos mais vendidos e stock."
        actions={
          <>
            <Button variant="outline" onClick={() => void exportCsv()}>
              <Download className="size-4" /> CSV
            </Button>
            <Button variant="outline" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} /> Actualizar
            </Button>
          </>
        }
      />

      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="De" htmlFor="reportFrom">
          <Input id="reportFrom" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
        </Field>
        <Field label="Até" htmlFor="reportTo">
          <Input id="reportTo" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
        </Field>
        <div className="flex items-end sm:col-span-2">
          <p className="text-xs text-muted-foreground">
            Período em hora de Maputo · {formatDate(maputoDayFromInput(from))} a {formatDate(maputoDayFromInput(to, true))}
          </p>
        </div>
      </div>

      {loading && !summary ? (
        <LoadingPanel />
      ) : !summary ? (
        <EmptyState title="Sem dados" description="Ajuste o período para calcular o resumo." />
      ) : (
        <div className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Vendas" value={summary.salesCount} hint="Vendas concluídas no período" />
            <StatCard label="Total vendido" value={formatMzn(summary.totalCents)} hint={`Média ${formatMzn(summary.averageCents)}`} />
            <StatCard label="IVA aplicado" value={formatMzn(summary.taxCents)} hint="Total de IVA nas vendas do período" />
            <StatCard label="Descontos" value={formatMzn(summary.discountCents)} hint="Linha e venda" />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl bg-card ring-1 ring-foreground/10">
              <p className="border-b px-3 py-2 text-sm font-medium">Meios de pagamento</p>
              {summary.byMethod.length === 0 ? (
                <p className="px-3 py-6 text-sm text-muted-foreground">Sem pagamentos no período.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Método</TableHead>
                      <TableHead className="text-right">Operações</TableHead>
                      <TableHead className="text-right">Valor</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {summary.byMethod.map((row) => (
                      <TableRow key={row.method}>
                        <TableCell>{PAYMENT_LABELS[row.method]}</TableCell>
                        <TableCell className="text-right tabular-nums">{row.count}</TableCell>
                        <TableCell className="text-right font-medium tabular-nums">{formatMzn(row.amountCents)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>

            <div className="rounded-xl bg-card ring-1 ring-foreground/10">
              <p className="border-b px-3 py-2 text-sm font-medium">Produtos mais vendidos</p>
              {summary.topProducts.length === 0 ? (
                <p className="px-3 py-6 text-sm text-muted-foreground">Sem vendas no período.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Produto</TableHead>
                      <TableHead className="text-right">Qtd</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {summary.topProducts.map((row) => (
                      <TableRow key={row.name}>
                        <TableCell className="max-w-56 truncate">{row.name}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatQty(row.qtyMilli)}</TableCell>
                        <TableCell className="text-right font-medium tabular-nums">{formatMzn(row.totalCents)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <StatCard label="Valor do stock a custo" value={formatMzn(stockValue)} hint="Produtos com controlo de stock" />
            <StatCard label="Valor do stock a preço de venda" value={formatMzn(retailValue)} hint="Margem potencial incluída" />
          </div>

          <div className="rounded-xl bg-card ring-1 ring-foreground/10">
            <div className="flex items-center justify-between border-b px-3 py-2">
              <p className="text-sm font-medium">Stock baixo</p>
              <Badge tone={summary.lowStock.length > 0 ? "warning" : "success"}>{summary.lowStock.length} produtos</Badge>
            </div>
            {summary.lowStock.length === 0 ? (
              <p className="px-3 py-6 text-sm text-muted-foreground">Nenhum produto abaixo do limite definido.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Produto</TableHead>
                    <TableHead className="text-right">Stock</TableHead>
                    <TableHead className="text-right">Limite</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {summary.lowStock.map((product) => (
                    <TableRow key={product.id}>
                      <TableCell>
                        {product.name}
                        <span className="ml-1 text-xs text-muted-foreground">{product.sku}</span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-amber-600">{formatQty(product.stockOnHandMilli)} {product.unit}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{formatQty(product.lowStockThresholdMilli)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>

          <Note>O IVA é opcional e acrescentado ao preço de acordo com a taxa de cada produto. Os recibos são documentos não fiscais.</Note>
        </div>
      )}
    </div>
  );
}
