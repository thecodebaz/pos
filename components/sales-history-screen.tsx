"use client";

import { useCallback, useEffect, useState } from "react";
import { Ban, Eye, Printer, RefreshCw, Search } from "lucide-react";
import { useApp, errorMessage } from "@/lib/app-context";
import type { Sale, SalePageResult, SaleSummary } from "@/lib/db/protocol";
import { PAYMENT_LABELS } from "@/lib/db/protocol";
import { formatDateTime, formatMzn, formatQty, formatSaleUnit, maputoDayFromInput, todayInput } from "@/lib/format";
import { Badge, EmptyState, Field, LoadingPanel, Note, PageHeader } from "@/components/shared";
import { ReceiptDialog } from "@/components/receipt";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PaginationControls } from "@/components/pagination-controls";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const PAGE_SIZE = 25;

export function SalesHistoryScreen() {
  const { session, call, toast } = useApp();
  const [from, setFrom] = useState(todayInput());
  const [to, setTo] = useState(todayInput());
  const [query, setQuery] = useState("");
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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await call<SalePageResult>("sale.page", {
        query,
        from: maputoDayFromInput(from),
        to: maputoDayFromInput(to, true),
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
  }, [call, from, to, page, query, toast]);

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

      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="De" htmlFor="historyFrom">
          <Input id="historyFrom" type="date" value={from} onChange={(event) => { setFrom(event.target.value); setPage(1); }} />
        </Field>
        <Field label="Até" htmlFor="historyTo">
          <Input id="historyTo" type="date" value={to} onChange={(event) => { setTo(event.target.value); setPage(1); }} />
        </Field>
        <Field label="Pesquisar" htmlFor="historyQuery" className="sm:col-span-2">
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
        <EmptyState title="Sem vendas no período" description="Ajuste as datas ou conclua uma venda no ponto de venda." />
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
                      {sale.status === "voided" ? <Badge tone="danger">Anulada</Badge> : <Badge tone="success">Concluída</Badge>}
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
