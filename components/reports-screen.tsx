"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { useApp, errorMessage } from "@/lib/app-context";
import type { Product, ReportSummary, SaleSummary } from "@/lib/db/protocol";
import { PAYMENT_LABELS } from "@/lib/db/protocol";
import { formatDate, formatMzn, formatQty, maputoDayFromInput } from "@/lib/format";
import { getDateRangePreset, type DateRange } from "@/lib/date-range";
import {
  SALES_GRANULARITY_LABEL,
  bucketSales,
  salesGranularity,
} from "@/lib/report-charts";
import { Badge, EmptyState, Field, LoadingPanel, Note, PageHeader, StatCard } from "@/components/shared";
import { DateRangeFilter } from "@/components/date-range-filter";
import { Button } from "@/components/ui/button";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const salesChartConfig = {
  totalCents: { label: "Total vendido", color: "var(--color-brand)" },
} satisfies ChartConfig;

const paymentChartConfig = {
  amountCents: { label: "Valor", color: "var(--color-brand)" },
} satisfies ChartConfig;

const productChartConfig = {
  totalCents: { label: "Valor vendido", color: "var(--color-brand)" },
} satisfies ChartConfig;

function moneyTooltip(value: unknown, name: unknown) {
  return (
    <div className="flex w-full items-center justify-between gap-3">
      <span className="text-muted-foreground">{String(name)}</span>
      <span className="font-medium tabular-nums">{formatMzn(Number(value))}</span>
    </div>
  );
}

export function ReportsScreen() {
  const { call, toast } = useApp();
  const [range, setRange] = useState<DateRange>(() => getDateRangePreset("today"));
  const [summary, setSummary] = useState<ReportSummary | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [report, list] = await Promise.all([
        call<ReportSummary>("report.summary", {
          from: maputoDayFromInput(range.from),
          to: maputoDayFromInput(range.to, true),
        }),
        call<Product[]>("product.list", { activeOnly: true }),
      ]);
      setSummary(report);
      setProducts(list);
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setLoading(false);
    }
  }, [call, range.from, range.to, toast]);

  useEffect(() => {
    // Carga inicial assíncrona: o estado só é alterado depois do primeiro await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function exportCsv() {
    try {
      const sales = await call<SaleSummary[]>("sale.list", {
        from: maputoDayFromInput(range.from),
        to: maputoDayFromInput(range.to, true),
        limit: 500,
      });
      const rows = [
        ["Recibo", "Data", "Cliente", "Operador", "Estado", "Artigos", "Total MZN", "A prazo", "Falta pagar MZN"],
        ...sales.map((sale) => [
          sale.receiptNumber,
          sale.createdAt,
          sale.customerName ?? "Consumidor final",
          sale.cashierName,
          sale.status === "voided" ? "Anulada" : "Concluída",
          String(sale.itemCount),
          (sale.totalCents / 100).toFixed(2),
          sale.isCredit ? "Sim" : "Não",
          (sale.outstandingCents / 100).toFixed(2),
        ]),
      ];
      const csv = "\uFEFF" + rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(";")).join("\r\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `vendas-${range.from}-a-${range.to}.csv`;
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

  const salesData = useMemo(
    () => bucketSales(summary?.dailySales ?? [], range.from, range.to),
    [summary, range.from, range.to],
  );
  const methodData = (summary?.byMethod ?? []).map((row) => ({
    label: PAYMENT_LABELS[row.method],
    amountCents: row.amountCents,
    count: row.count,
  }));
  const productData = (summary?.topProducts ?? []).map((row) => ({
    label: row.name,
    totalCents: row.totalCents,
    qtyMilli: row.qtyMilli,
  }));
  const granularity = salesGranularity(range.from, range.to);

  return (
    <div>
      <PageHeader
        title="Relatórios"
        description="Resumo do período, gráficos de vendas, meios de pagamento, produtos mais vendidos e stock."
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

      <div className="mb-4 grid gap-2 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <Field label="Período">
          <DateRangeFilter value={range} onChange={setRange} />
        </Field>
        <div className="flex items-end">
          <p className="text-xs text-muted-foreground">
            Período em hora de Maputo · {formatDate(maputoDayFromInput(range.from))} a {formatDate(maputoDayFromInput(range.to))}
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

          <div className="grid gap-2 sm:grid-cols-2">
            <StatCard
              label="Vendas a prazo"
              value={summary.creditSalesCount}
              hint={`Total ${formatMzn(summary.creditTotalCents)}`}
            />
            <StatCard
              label="Crédito em aberto"
              value={formatMzn(summary.creditOutstandingCents)}
              hint="Por regularizar no período"
            />
          </div>

          {salesData.length > 0 ? (
            <div className="rounded-xl bg-card ring-1 ring-foreground/10">
              <div className="flex items-center justify-between border-b px-3 py-2">
                <p className="text-sm font-medium">Evolução de vendas</p>
                <Badge tone="neutral">{SALES_GRANULARITY_LABEL[granularity]}</Badge>
              </div>
              <ChartContainer config={salesChartConfig} className="h-64 w-full px-2 pb-2">
                <AreaChart data={salesData} margin={{ top: 12, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} />
                  <YAxis width={78} tickLine={false} axisLine={false} tickFormatter={(value: number) => formatMzn(value)} />
                  <ChartTooltip cursor={false} content={<ChartTooltipContent formatter={moneyTooltip} />} />
                  <Area
                    dataKey="totalCents"
                    type="monotone"
                    fill="var(--color-totalCents)"
                    fillOpacity={0.2}
                    stroke="var(--color-totalCents)"
                    strokeWidth={2}
                  />
                </AreaChart>
              </ChartContainer>
            </div>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl bg-card ring-1 ring-foreground/10">
              <p className="border-b px-3 py-2 text-sm font-medium">Meios de pagamento</p>
              {methodData.length === 0 ? (
                <p className="px-3 py-6 text-sm text-muted-foreground">Sem pagamentos no período.</p>
              ) : (
                <>
                  <ChartContainer config={paymentChartConfig} className="h-52 w-full px-2 pt-3">
                    <BarChart data={methodData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid vertical={false} />
                      <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} />
                      <YAxis width={70} tickLine={false} axisLine={false} tickFormatter={(value: number) => formatMzn(value)} />
                      <ChartTooltip cursor={false} content={<ChartTooltipContent formatter={moneyTooltip} />} />
                      <Bar dataKey="amountCents" fill="var(--color-amountCents)" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ChartContainer>
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
                </>
              )}
            </div>

            <div className="rounded-xl bg-card ring-1 ring-foreground/10">
              <p className="border-b px-3 py-2 text-sm font-medium">Produtos mais vendidos</p>
              {productData.length === 0 ? (
                <p className="px-3 py-6 text-sm text-muted-foreground">Sem vendas no período.</p>
              ) : (
                <>
                  <ChartContainer config={productChartConfig} className="h-64 w-full px-2 pt-3">
                    <BarChart data={productData} layout="vertical" margin={{ top: 8, right: 24, left: 8, bottom: 0 }}>
                      <CartesianGrid horizontal={false} />
                      <XAxis type="number" tickLine={false} axisLine={false} tickFormatter={(value: number) => formatMzn(value)} />
                      <YAxis type="category" dataKey="label" width={120} tickLine={false} axisLine={false} />
                      <ChartTooltip cursor={false} content={<ChartTooltipContent formatter={moneyTooltip} />} />
                      <Bar dataKey="totalCents" fill="var(--color-totalCents)" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ChartContainer>
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
                </>
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
