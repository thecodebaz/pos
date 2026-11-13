"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, FileSpreadsheet } from "lucide-react";
import { useApp, errorMessage } from "@/lib/app-context";
import type { StockImportDraft } from "@/lib/stock-import";
import { STOCK_IMPORT_DRAFT_KEY } from "@/lib/stock-import";
import type { StockImportItem, StockImportMatch } from "@/lib/db/protocol";
import { formatMzn, formatMznPlain, formatQty, parseMzn } from "@/lib/format";
import { EmptyState, Field, LoadingPanel, MoneyInput, Note, PageHeader } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type ReviewRow = {
  item: StockImportItem;
  match: StockImportMatch;
  salePrice: string;
};

const randFormatter = new Intl.NumberFormat("pt-MZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const formatRand = (minor: number) => `R ${randFormatter.format(minor / 100)}`;

function parseRate(value: string): number {
  const parsed = Number(value.trim().replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 100_000 ? parsed : 0;
}

function rowProblem(row: ReviewRow): string | null {
  if (row.match.productId && !row.match.active) return "Produto inactivo";
  if (row.match.productId && !row.match.trackStock) return "Produto sem controlo de stock";
  if (row.match.productId && row.match.unit !== "un") return "A unidade existente não é unidade";
  if ((!row.match.productId || row.match.priceCents === 0) && parseMzn(row.salePrice) <= 0) return "Indique o preço de venda";
  return null;
}

export function StockImportScreen() {
  const { call, toast } = useApp();
  const router = useRouter();
  const [documentRef, setDocumentRef] = useState("");
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [rate, setRate] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmedMismatches, setConfirmedMismatches] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const serialized = sessionStorage.getItem(STOCK_IMPORT_DRAFT_KEY);
          if (!serialized) {
            setError("Não foi encontrado um ficheiro processado. Volte ao stock e seleccione o Excel.");
            return;
          }
          const draft = JSON.parse(serialized) as StockImportDraft;
          if (!Array.isArray(draft.items) || draft.items.length === 0) {
            throw new Error("O ficheiro processado não contém produtos.");
          }
          const matches = await call<StockImportMatch[]>(
            "stock.import.preview",
            { items: draft.items.map(({ sku, name, color }) => ({ sku, name, color })) },
          );
          if (matches.length !== draft.items.length) throw new Error("Não foi possível validar todos os produtos.");
          if (cancelled) return;
          setDocumentRef(String(draft.documentRef ?? ""));
          setRows(draft.items.map((item, index) => ({
            item,
            match: matches[index],
            salePrice: matches[index].priceCents && matches[index].priceCents > 0
              ? formatMznPlain(matches[index].priceCents)
              : "",
          })));
        } catch (err) {
          if (!cancelled) setError(errorMessage(err));
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [call]);

  const exchangeRate = parseRate(rate);
  const rowErrors = rows.map(rowProblem);
  const totalQuantity = rows.reduce((total, row) => total + row.item.qtyMilli, 0);
  const totalMznCents = rows.reduce(
    (total, row) => total + Math.round(row.item.purchaseCostMinor * exchangeRate),
    0,
  );
  const mismatchCount = rows.filter((row) => Math.abs(row.item.purchaseCostMinor - row.item.valueMinor) > 2).length;
  const canConfirm = rows.length > 0
    && exchangeRate > 0
    && rowErrors.every((problem) => problem === null)
    && (mismatchCount === 0 || confirmedMismatches);

  async function confirmImport() {
    if (!canConfirm) return;
    setBusy(true);
    setError(null);
    try {
      const items = rows.map(({ item, match, salePrice }) => ({
        ...item,
        salePriceCents: match.priceCents && match.priceCents > 0 ? null : parseMzn(salePrice),
      }));
      const result = await call<{ productCount: number; createdCount: number; quantityMilli: number; totalCostCents: number }>(
        "stock.import.commit",
        { documentRef, exchangeRate, items },
      );
      sessionStorage.removeItem(STOCK_IMPORT_DRAFT_KEY);
      toast(
        `Importação concluída: ${result.productCount} produtos, ${formatQty(result.quantityMilli)} unidades em stock.`,
        "success",
      );
      router.push("/stock/");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const summary = useMemo(() => ({
    newProducts: rows.filter((row) => row.match.productId === null).length,
    existingProducts: rows.filter((row) => row.match.productId !== null).length,
  }), [rows]);

  if (loading) return <LoadingPanel label="A validar produtos e variantes…" />;

  if (rows.length === 0) {
    return (
      <div>
        <PageHeader title="Importação de stock" />
        <EmptyState
          title="Sem dados para rever"
          description={error ?? "Seleccione um ficheiro Excel para começar."}
          action={<Button variant="outline" onClick={() => router.push("/stock/")}><ArrowLeft className="size-4" /> Voltar ao stock</Button>}
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Rever importação de stock"
        description="Confirme a taxa Rand → MZN e complete os preços de venda dos novos produtos. Nenhum dado será gravado antes da confirmação."
        actions={<Button variant="outline" onClick={() => router.push("/stock/")} disabled={busy}><ArrowLeft className="size-4" /> Cancelar</Button>}
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl bg-card p-3 ring-1 ring-foreground/10">
          <p className="text-xs text-muted-foreground">Produtos novos</p>
          <p className="text-lg font-semibold tabular-nums">{summary.newProducts}</p>
        </div>
        <div className="rounded-xl bg-card p-3 ring-1 ring-foreground/10">
          <p className="text-xs text-muted-foreground">Produtos existentes</p>
          <p className="text-lg font-semibold tabular-nums">{summary.existingProducts}</p>
        </div>
        <div className="rounded-xl bg-card p-3 ring-1 ring-foreground/10">
          <p className="text-xs text-muted-foreground">Quantidade total</p>
          <p className="text-lg font-semibold tabular-nums">{formatQty(totalQuantity)} un</p>
        </div>
      </div>

      <Note>
        As linhas repetidas com o mesmo SKU, nome e cor foram agrupadas. Variantes com o mesmo SKU permanecem produtos distintos pela cor/nome. O preço K é tratado como custo em rand; o preço de venda dos produtos existentes não será alterado.
      </Note>

      <div className="my-4 grid gap-3 sm:grid-cols-2">
        <Field label="Taxa de conversão (1 R = quantos MZN?)" htmlFor="stockImportRate" hint="Ex.: 4,10. A taxa é aplicada ao custo de compra, não aos preços de venda.">
          <Input
            id="stockImportRate"
            required
            inputMode="decimal"
            value={rate}
            onChange={(event) => setRate(event.target.value)}
            placeholder="Introduza a taxa"
          />
        </Field>
        <div className="flex items-end rounded-xl bg-muted/50 p-3">
          <div>
            <p className="text-xs text-muted-foreground">Custo de compra convertido</p>
            <p className="text-lg font-semibold tabular-nums">{exchangeRate ? formatMzn(totalMznCents) : "—"}</p>
            <p className="text-xs text-muted-foreground">Valor calculado a partir da quantidade × preço unitário da coluna K.</p>
          </div>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl bg-card ring-1 ring-foreground/10">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>SKU</TableHead>
              <TableHead>Produto / cor</TableHead>
              <TableHead className="text-right">Qtd.</TableHead>
              <TableHead className="text-right">Custo unitário (R)</TableHead>
              <TableHead className="text-right">Valor factura (R)</TableHead>
              <TableHead>Registo</TableHead>
              <TableHead>Preço de venda (MZN)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, index) => {
              const mismatch = Math.abs(row.item.purchaseCostMinor - row.item.valueMinor) > 2;
              const purchaseTotalMznCents = Math.round(row.item.purchaseCostMinor * exchangeRate);
              const unitCostMznCents = Math.round((purchaseTotalMznCents * 1000) / row.item.qtyMilli);
              const needsSalePrice = !row.match.productId || !row.match.priceCents;
              const problem = rowErrors[index];
              return (
                <TableRow key={`${row.item.sku}-${row.item.name}-${row.item.color}`}>
                  <TableCell className="font-mono text-xs">{row.item.sku}</TableCell>
                  <TableCell>
                    <p className="font-medium">{row.item.name}</p>
                    <p className="text-xs text-muted-foreground">Cor: {row.item.color} · {row.item.lineCount} linha(s)</p>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatQty(row.item.qtyMilli)} un</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatRand(row.item.purchaseCostMinor / (row.item.qtyMilli / 1000))}
                    {exchangeRate ? <p className="text-xs text-muted-foreground">{formatMzn(unitCostMznCents)}/un</p> : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatRand(row.item.valueMinor)}
                    {mismatch ? <p className="text-xs text-amber-700">Difere de qtd. × preço</p> : null}
                  </TableCell>
                  <TableCell>
                    <span className={row.match.productId ? "text-xs text-emerald-700" : "text-xs text-blue-700"}>
                      {row.match.productId ? "Existente" : "Novo produto"}
                    </span>
                    {problem ? <p className="text-xs text-destructive">{problem}</p> : null}
                  </TableCell>
                  <TableCell className="min-w-40">
                    {needsSalePrice ? (
                      <MoneyInput
                        aria-label={`Preço de venda para ${row.item.name} ${row.item.color}`}
                        value={row.salePrice}
                        onValueChange={(salePrice) => setRows((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, salePrice } : item))}
                        disabled={busy}
                      />
                    ) : (
                      <span className="text-sm tabular-nums">{formatMzn(row.match.priceCents ?? 0)}</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {mismatchCount > 0 ? (
        <label className="mt-3 flex items-start gap-2 text-sm text-amber-800">
          <input
            type="checkbox"
            className="mt-0.5 size-4"
            checked={confirmedMismatches}
            onChange={(event) => setConfirmedMismatches(event.target.checked)}
            disabled={busy}
          />
          <span>Revisei {mismatchCount} produto(s) em que o valor da coluna L difere da quantidade × preço da coluna K.</span>
        </label>
      ) : null}

      {error ? <div className="mt-4"><Note tone="danger">{error}</Note></div> : null}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          <FileSpreadsheet className="mr-1 inline size-3.5" />
          Factura {documentRef || "sem referência"} · as entradas serão registadas como movimentos de compra.
        </p>
        <Button onClick={() => void confirmImport()} disabled={!canConfirm || busy}>
          <Check className="size-4" /> {busy ? "A importar…" : "Confirmar e actualizar stock"}
        </Button>
      </div>
    </div>
  );
}
