"use client";

import { useCallback, useEffect, useState } from "react";
import { Ban, Eye, Printer, RefreshCw, Search, Wallet } from "lucide-react";
import { useApp, errorMessage } from "@/lib/app-context";
import type { PaymentMethod, Sale, SalePageResult, SaleSummary } from "@/lib/db/protocol";
import { PAYMENT_LABELS } from "@/lib/db/protocol";
import { formatDateTime, formatMzn, formatMznPlain, formatQty, formatSaleUnit, maputoDayFromInput, parseMzn } from "@/lib/format";
import { getDateRangePreset, type DateRange } from "@/lib/date-range";
import { Badge, EmptyState, Field, LoadingPanel, MoneyInput, Note, PageHeader, Select } from "@/components/shared";
import { DateRangeFilter } from "@/components/date-range-filter";
import { ReceiptDialog } from "@/components/receipt";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PaginationControls } from "@/components/pagination-controls";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const PAGE_SIZE = 25;

export function SalesHistoryScreen() {
  const { session, call, toast } = useApp();
  const [range, setRange] = useState<DateRange>(() => getDateRangePreset("thisWeek"));
  const [query, setQuery] = useState("");
  const [creditStatus, setCreditStatus] = useState<"all" | "pending" | "settled">("all");
  const [sales, setSales] = useState<SaleSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [completedTotalCents, setCompletedTotalCents] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<Sale | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [approvalUser, setApprovalUser] = useState("");
  const [approvalPin, setApprovalPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settleOpen, setSettleOpen] = useState(false);
  const [settleAmountInput, setSettleAmountInput] = useState("");
  const [settleMethod, setSettleMethod] = useState<PaymentMethod>("cash");
  const [settleReference, setSettleReference] = useState("");
  const [settleNote, setSettleNote] = useState("");
  const [settleError, setSettleError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await call<SalePageResult>("sale.page", {
        query,
        from: maputoDayFromInput(range.from),
        to: maputoDayFromInput(range.to, true),
        creditStatus,
        page,
        pageSize: PAGE_SIZE,
      });
      setSales(result.items);
      setTotal(result.total);
      setCompletedTotalCents(result.completedTotalCents);
      if (result.page !== page) setPage(result.page);
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setLoading(false);
    }
  }, [call, creditStatus, range.from, range.to, page, query, toast]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 250);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function openSale(id: string) {
    try {
      const sale = await call<Sale>("sale.get", { id });
      setDetail(sale);
      setDetailOpen(true);
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  }

  async function voidSale() {
    if (!detail) return;
    setBusy(true);
    setError(null);
    try {
      let token: string | null = null;
      if (session?.user.role === "cashier") {
        const approval = await call<{ token: string }>("approval.request", {
          username: approvalUser,
          pin: approvalPin,
          action: "sale.void",
          entityType: "sale",
          entityId: detail.id,
        });
        token = approval.token;
      }
      const updated = await call<Sale>("sale.void", { id: detail.id, reason, approvalToken: token });
      setDetail(updated);
      setVoidOpen(false);
      setReason("");
      setApprovalPin("");
      toast("Venda anulada e stock reposto.", "success");
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function openSettleDialog() {
    if (!detail) return;
    setSettleAmountInput(formatMznPlain(detail.outstandingCents));
    setSettleMethod("cash");
    setSettleReference("");
    setSettleNote("");
    setSettleError(null);
    setSettleOpen(true);
  }

  async function settleSale() {
    if (!detail) return;
    const amountCents = parseMzn(settleAmountInput);
    if (amountCents <= 0 || amountCents > detail.outstandingCents) {
      setSettleError(`Indique um valor entre 0,01 e ${formatMzn(detail.outstandingCents)}.`);
      return;
    }
    setBusy(true);
    setSettleError(null);
    try {
      const updated = await call<Sale>("sale.settle", {
        id: detail.id,
        amountCents,
        method: settleMethod,
        reference: settleReference,
        note: settleNote,
      });
      setDetail(updated);
      setSettleOpen(false);
      setSettleAmountInput("");
      setSettleReference("");
      setSettleNote("");
      toast(
        updated.outstandingCents > 0
          ? `Recebido ${formatMzn(amountCents)}. Falta ${formatMzn(updated.outstandingCents)}.`
          : `Venda ${updated.receiptNumber} liquidada.`,
        "success",
      );
      await load();
    } catch (err) {
      setSettleError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);

  return (
    <div>
      <PageHeader
        title="Histórico de vendas"
        description="Consulte, reimprima e anule vendas. A anulação repõe o stock e fica registada na auditoria."
        actions={
          <Button variant="outline" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} /> Actualizar
          </Button>
        }
      />

      <div className="mb-4 grid gap-2 md:grid-cols-[minmax(0,16rem)_minmax(0,12rem)_minmax(0,1fr)]">
        <Field label="Período">
          <DateRangeFilter
            value={range}
            onChange={(next) => { setRange(next); setPage(1); }}
          />
        </Field>
        <Field label="Crédito" htmlFor="historyCredit">
          <Select
            id="historyCredit"
            value={creditStatus}
            onChange={(event) => { setCreditStatus(event.target.value as typeof creditStatus); setPage(1); }}
          >
            <option value="all">Todas as vendas</option>
            <option value="pending">A prazo pendente</option>
            <option value="settled">A prazo liquidada</option>
          </Select>
        </Field>
        <Field label="Pesquisar" htmlFor="historyQuery">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input id="historyQuery" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Nº do recibo ou cliente…" className="pl-8" />
          </div>
        </Field>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
        <Badge tone="neutral">{total} vendas</Badge>
        <Badge tone="success">Total concluído: {formatMzn(completedTotalCents)}</Badge>
      </div>

      {loading ? (
        <LoadingPanel />
      ) : sales.length === 0 ? (
        <EmptyState title="Sem vendas no período" description="Ajuste o período ou a pesquisa, ou conclua uma venda no ponto de venda." />
      ) : (
        <>
          <div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Recibo</TableHead>
                  <TableHead>Data</TableHead>
                  <TableHead>Cliente</TableHead>
                  <TableHead className="text-right">Artigos</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead className="w-20" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sales.map((sale) => (
                  <TableRow key={sale.id} className="cursor-pointer" onClick={() => void openSale(sale.id)}>
                    <TableCell className="font-mono text-xs font-medium">{sale.receiptNumber}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(sale.createdAt)}</TableCell>
                    <TableCell className="max-w-40 truncate">{sale.customerName ?? "Consumidor final"}</TableCell>
                    <TableCell className="text-right tabular-nums">{sale.itemCount}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{formatMzn(sale.totalCents)}</TableCell>
                    <TableCell>
                      {sale.status === "voided" ? (
                        <Badge tone="danger">Anulada</Badge>
                      ) : sale.isCredit ? (
                        sale.outstandingCents > 0
                          ? <Badge tone="warning">A prazo · {formatMzn(sale.outstandingCents)}</Badge>
                          : <Badge tone="success">Liquidada</Badge>
                      ) : (
                        <Badge tone="success">Concluída</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="icon-sm" aria-label="Ver venda">
                        <Eye className="size-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <PaginationControls page={currentPage} pageSize={PAGE_SIZE} total={total} itemLabel="vendas" onPageChange={setPage} />
        </>
      )}

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Venda {detail?.receiptNumber}</DialogTitle>
            <DialogDescription>
              {detail ? `${formatDateTime(detail.createdAt)} · ${detail.cashierName}` : ""}
              {detail?.status === "voided" ? " · anulada" : ""}
            </DialogDescription>
          </DialogHeader>
          {detail ? (
            <div className="space-y-3">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Artigo</TableHead>
                    <TableHead className="text-right">Qtd</TableHead>
                    <TableHead className="text-right">Preço</TableHead>
                    <TableHead className="text-right">Desc.</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.items.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>
                        <p className="font-medium">{item.nameSnapshot}</p>
                        <p className="text-xs text-muted-foreground">{item.skuSnapshot}</p>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatQty(item.saleQtyMilli)} {formatSaleUnit(item.saleUnit, item.unit)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatMzn(item.unitPriceCents)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatMzn(item.lineDiscountCents + item.orderDiscountCents)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatMzn(item.totalCents)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="grid gap-2 rounded-lg bg-muted px-3 py-2 text-sm sm:grid-cols-2">
                <div className="space-y-0.5">
                  <Row label="Subtotal" value={formatMzn(detail.subtotalCents)} />
                  <Row label="Desconto" value={formatMzn(detail.discountCents)} />
                  <Row label={detail.taxApplied ? "IVA aplicado" : "IVA não aplicado"} value={formatMzn(detail.taxCents)} />
                  <Row label="Total" value={formatMzn(detail.totalCents)} strong />
                </div>
                <div className="space-y-0.5">
                  {detail.payments.map((payment) => (
                    <Row key={payment.id} label={PAYMENT_LABELS[payment.method]} value={formatMzn(payment.amountCents)} />
                  ))}
                  <Row label="Troco" value={formatMzn(detail.changeCents)} />
                </div>
              </div>
              {detail.isCredit ? (
                <div className="rounded-lg border border-emerald-600/30 bg-emerald-50/50 p-3 text-sm dark:bg-emerald-950/20">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium">Venda a prazo</p>
                    <Badge tone={detail.outstandingCents > 0 ? "warning" : "success"}>
                      {detail.outstandingCents > 0 ? `Falta ${formatMzn(detail.outstandingCents)}` : "Liquidada"}
                    </Badge>
                  </div>
                  <Row label="Total da venda" value={formatMzn(detail.totalCents)} />
                  <Row label="Pago inicialmente" value={formatMzn(detail.paidCents)} />
                  <Row label="Regularizações" value={formatMzn(detail.settledCents - detail.paidCents)} />
                  {detail.settlements.map((settlement) => (
                    <Row
                      key={settlement.id}
                      label={`${formatDateTime(settlement.createdAt)} · ${PAYMENT_LABELS[settlement.method]}${settlement.userName ? ` · ${settlement.userName}` : ""}`}
                      value={formatMzn(settlement.amountCents)}
                    />
                  ))}
                  {detail.status === "completed" && detail.outstandingCents > 0 ? (
                    <Button className="mt-3 w-full bg-emerald-600 text-white hover:bg-emerald-700" onClick={openSettleDialog}>
                      <Wallet className="size-4" /> Regularizar pagamento
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {detail.note ? <Note>{detail.note}</Note> : null}
              {detail.status === "voided" ? (
                <Note tone="danger">
                  Anulada em {formatDateTime(detail.voidedAt)}. Motivo: {detail.voidReason}
                </Note>
              ) : null}
            </div>
          ) : null}
          <DialogFooter className="flex-wrap">
            <Button
              variant="outline"
              onClick={() => {
                setDetailOpen(false);
                setReceiptOpen(true);
              }}
            >
              <Printer className="size-4" /> Recibo
            </Button>
            {detail?.status === "completed" ? (
              <Button
                variant="destructive"
                onClick={() => {
                  setReason("");
                  setApprovalPin("");
                  setError(null);
                  setVoidOpen(true);
                }}
              >
                <Ban className="size-4" /> Anular venda
              </Button>
            ) : null}
            <Button onClick={() => setDetailOpen(false)}>Fechar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={voidOpen} onOpenChange={setVoidOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Anular venda {detail?.receiptNumber}</DialogTitle>
            <DialogDescription>O stock será reposto e a operação fica na auditoria. Não é possível reverter.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Field label="Motivo da anulação *" htmlFor="voidReason">
              <Input id="voidReason" required autoFocus value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Mínimo 3 caracteres" />
            </Field>
            {session?.user.role === "cashier" ? (
              <>
                <Field label="Aprovador" htmlFor="voidUser">
                  <Input id="voidUser" value={approvalUser} onChange={(event) => setApprovalUser(event.target.value.toLowerCase())} placeholder="gerente" />
                </Field>
                <Field label="PIN do aprovador" htmlFor="voidPin">
                  <Input id="voidPin" type="password" inputMode="numeric" maxLength={6} value={approvalPin} onChange={(event) => setApprovalPin(event.target.value.replace(/\D/g, "").slice(0, 6))} />
                </Field>
              </>
            ) : null}
            {error ? <Note tone="danger">{error}</Note> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setVoidOpen(false)} disabled={busy}>
              Cancelar
            </Button>
            <Button variant="destructive" onClick={() => void voidSale()} disabled={busy || reason.trim().length < 3}>
              {busy ? "A anular…" : "Confirmar anulação"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={settleOpen} onOpenChange={setSettleOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Regularizar pagamento</DialogTitle>
            <DialogDescription>
              Venda {detail?.receiptNumber} · falta {formatMzn(detail?.outstandingCents ?? 0)}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Field label="Valor a receber *" htmlFor="settleAmount" hint="Pode ser uma entrada parcial.">
              <MoneyInput id="settleAmount" value={settleAmountInput} onValueChange={setSettleAmountInput} autoFocus />
            </Field>
            <Field label="Método de pagamento" htmlFor="settleMethod">
              <Select
                id="settleMethod"
                value={settleMethod}
                onChange={(event) => setSettleMethod(event.target.value as PaymentMethod)}
              >
                {(Object.keys(PAYMENT_LABELS) as PaymentMethod[]).map((key) => (
                  <option key={key} value={key}>{PAYMENT_LABELS[key]}</option>
                ))}
              </Select>
            </Field>
            <Field label="Referência (opcional)" htmlFor="settleReference">
              <Input
                id="settleReference"
                value={settleReference}
                onChange={(event) => setSettleReference(event.target.value)}
                placeholder="Ex.: ID da transacção"
              />
            </Field>
            <Field label="Nota (opcional)" htmlFor="settleNote">
              <Input
                id="settleNote"
                value={settleNote}
                onChange={(event) => setSettleNote(event.target.value)}
                placeholder="Ex.: pagamento na loja"
              />
            </Field>
            {settleError ? <Note tone="danger">{settleError}</Note> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSettleOpen(false)} disabled={busy}>
              Cancelar
            </Button>
            <Button
              className="bg-emerald-600 text-white hover:bg-emerald-700"
              onClick={() => void settleSale()}
              disabled={busy || parseMzn(settleAmountInput) <= 0}
            >
              {busy ? "A guardar…" : "Registar pagamento"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {session ? (
        <ReceiptDialog sale={detail} settings={session.settings} open={receiptOpen} onClose={() => setReceiptOpen(false)} />
      ) : null}
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={"flex justify-between " + (strong ? "font-semibold" : "")}>
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
