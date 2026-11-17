"use client";

import { Printer, X } from "lucide-react";
import type { Sale, Settings } from "@/lib/db/protocol";
import { PAYMENT_LABELS } from "@/lib/db/protocol";
import { formatDateTime, formatMzn, formatQty, formatSaleUnit } from "@/lib/format";
import { Button } from "@/components/ui/button";

export function ReceiptDialog({
  sale,
  settings,
  open,
  onClose,
}: {
  sale: Sale | null;
  settings: Settings;
  open: boolean;
  onClose: () => void;
}) {
  if (!open || !sale) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 print:static print:block print:bg-transparent print:p-0">
      <div className="my-4 w-full max-w-sm rounded-xl bg-white p-5 text-zinc-900 shadow-xl print:my-0 print:max-w-none print:rounded-none print:shadow-none">
        <div className="receipt-print font-mono text-[12px] leading-snug">
          <div className="text-center">
            <p className="text-sm font-bold uppercase">{settings.storeName}</p>
            {settings.nif ? <p>NUIT: {settings.nif}</p> : null}
            {settings.address ? <p>{settings.address}</p> : null}
            {settings.phone ? <p>Tel: {settings.phone}</p> : null}
            <p className="mt-1">Instalação {settings.installationCode}</p>
          </div>
          <div className="my-2 border-t border-dashed border-zinc-400" />
          <div className="flex justify-between">
            <span>Recibo</span>
            <span className="font-bold">{sale.receiptNumber}</span>
          </div>
          <div className="flex justify-between">
            <span>Data</span>
            <span>{formatDateTime(sale.createdAt)}</span>
          </div>
          <div className="flex justify-between">
            <span>Operador</span>
            <span>{sale.cashierName}</span>
          </div>
          {sale.customerName ? (
            <div className="flex justify-between gap-4">
              <span>Cliente</span>
              <span className="text-right">
                {sale.customerName}
                {sale.customerNif ? ` (${sale.customerNif})` : ""}
              </span>
            </div>
          ) : null}
          <div className="my-2 border-t border-dashed border-zinc-400" />
          <table className="w-full">
            <thead>
              <tr className="text-left">
                <th className="font-normal">Artigo</th>
                <th className="text-right font-normal">Qtd</th>
                <th className="text-right font-normal">Total</th>
              </tr>
            </thead>
            <tbody>
              {sale.items.map((item) => (
                <tr key={item.id} className="align-top">
                  <td className="py-0.5 pr-1">
                    {item.nameSnapshot}
                    <span className="block text-[10px] text-zinc-500">
                      {formatMzn(item.unitPriceCents)} / {formatSaleUnit(item.saleUnit, item.unit)}
                      {item.lineDiscountCents + item.orderDiscountCents > 0
                        ? ` · desc. ${formatMzn(item.lineDiscountCents + item.orderDiscountCents)}`
                        : ""}
                    </span>
                  </td>
                  <td className="py-0.5 text-right">{formatQty(item.saleQtyMilli)}</td>
                  <td className="py-0.5 text-right">{formatMzn(item.totalCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="my-2 border-t border-dashed border-zinc-400" />
          <div className="space-y-0.5">
            <Line label="Subtotal" value={formatMzn(sale.subtotalCents)} />
            {sale.discountCents > 0 ? <Line label="Desconto" value={`- ${formatMzn(sale.discountCents)}`} /> : null}
            <Line label={sale.taxApplied ? "IVA aplicado" : "IVA não aplicado"} value={formatMzn(sale.taxCents)} />
            <div className="flex justify-between text-sm font-bold">
              <span>TOTAL</span>
              <span>{formatMzn(sale.totalCents)}</span>
            </div>
          </div>
          <div className="my-2 border-t border-dashed border-zinc-400" />
          {sale.payments.map((payment) => (
            <div key={payment.id} className="flex justify-between">
              <span>{sale.isCredit ? `${PAYMENT_LABELS[payment.method]} (agora)` : PAYMENT_LABELS[payment.method]}</span>
              <span>{formatMzn(payment.amountCents)}</span>
            </div>
          ))}
          {sale.changeCents > 0 ? <Line label="Troco" value={formatMzn(sale.changeCents)} /> : null}
          {sale.isCredit ? (
            <>
              <div className="my-2 border-t border-dashed border-zinc-400" />
              <p className="font-bold uppercase">Venda a prazo</p>
              <Line label="Pago até agora" value={formatMzn(sale.settledCents)} />
              {sale.settlements.map((settlement) => (
                <Line
                  key={settlement.id}
                  label={`${formatDateTime(settlement.createdAt)} · ${PAYMENT_LABELS[settlement.method]}`}
                  value={formatMzn(settlement.amountCents)}
                />
              ))}
              <Line
                label={sale.status === "voided" ? "ANULADA" : sale.outstandingCents > 0 ? "FALTA PAGAR" : "LIQUIDADA"}
                value={formatMzn(sale.outstandingCents)}
              />
            </>
          ) : null}
          {sale.status === "voided" ? (
            <p className="mt-2 border border-zinc-900 py-1 text-center font-bold uppercase">Venda anulada</p>
          ) : null}
          <div className="my-2 border-t border-dashed border-zinc-400" />
          <p className="text-center text-[10px]">
            {settings.receiptFooter || "Obrigado pela preferência!"}
          </p>
          <p className="mt-2 text-center text-[10px] font-bold uppercase">Documento não fiscal</p>
          <p className="text-center text-[9px]">Não serve de factura para efeitos fiscais.</p>
        </div>

        <div className="mt-4 flex gap-2 print:hidden">
          <Button variant="outline" className="flex-1" onClick={onClose}>
            <X className="size-4" /> Fechar
          </Button>
          <Button className="flex-1" onClick={() => window.print()}>
            <Printer className="size-4" /> Imprimir
          </Button>
        </div>
      </div>
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}
