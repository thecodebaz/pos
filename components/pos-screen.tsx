"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Banknote, CreditCard, Minus, PackageSearch, Plus, Search, ShoppingCart, Smartphone, Trash2, UserRound, X } from "lucide-react";
import { cn } from "cn";
import { useApp, errorMessage } from "@/lib/app-context";
import type { CartItemInput, Customer, PagedResult, PaymentMethod, Product, Quote, Sale, SaleUnit } from "@/lib/db/protocol";
import { PAYMENT_LABELS } from "@/lib/db/protocol";
import { formatMzn, formatMznPlain, formatQty, formatSaleUnit, parseMzn, parseQty, qtyToInput } from "@/lib/format";
import { Badge, EmptyState, Field, LoadingPanel, MoneyInput, Note, Select } from "@/components/shared";
import { ReceiptDialog } from "@/components/receipt";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { PaginationControls } from "@/components/pagination-controls";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const PRODUCT_PAGE_SIZE = 24;

type CartLine = {
  product: Product;
  saleUnit: SaleUnit;
  qtyMilli: number;
  discountInput: string;
};

function saleOptions(product: Product): SaleUnit[] {
  const options: SaleUnit[] = [];
  if (product.sellByUnit) options.push("unit");
  if (product.sellByPackage) options.push("package");
  if (product.sellByHalfPackage) options.push("half_package");
  return options;
}

function defaultSaleUnit(product: Product): SaleUnit {
  return saleOptions(product)[0] ?? "unit";
}

function salePrice(product: Product, saleUnit: SaleUnit): number {
  if (saleUnit === "package") return product.packagePriceCents;
  if (saleUnit === "half_package") return product.halfPackagePriceCents;
  return product.priceCents;
}

function normalize(value: string): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export function PosScreen() {
  const { session, call, toast } = useApp();
  const token = session?.token ?? "";

  const [products, setProducts] = useState<Product[]>([]);
  const [totalProducts, setTotalProducts] = useState(0);
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [productPage, setProductPage] = useState(1);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [orderDiscountInput, setOrderDiscountInput] = useState("");
  const [applyTax, setApplyTax] = useState(false);
  const [customerId, setCustomerId] = useState("");
  const [note, setNote] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  const [payOpen, setPayOpen] = useState(false);
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [tenderedInput, setTenderedInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [approvalToken, setApprovalToken] = useState<string | null>(null);

  const [approvalOpen, setApprovalOpen] = useState(false);
  const [approvalUser, setApprovalUser] = useState("");
  const [approvalPin, setApprovalPin] = useState("");
  const [approvalError, setApprovalError] = useState<string | null>(null);

  const [sale, setSale] = useState<Sale | null>(null);
  const [receiptOpen, setReceiptOpen] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);
  const quoteSeq = useRef(0);
  const catalogSeq = useRef(0);

  const loadCatalog = useCallback(async () => {
    const seq = ++catalogSeq.current;
    try {
      const result = await call<PagedResult<Product>>("product.page", {
        activeOnly: true,
        query: search,
        categoryId: categoryId || null,
        page: productPage,
        pageSize: PRODUCT_PAGE_SIZE,
      });
      if (seq !== catalogSeq.current) return;
      setProducts(result.items);
      setTotalProducts(result.total);
      if (result.page !== productPage) setProductPage(result.page);
    } catch (error) {
      if (seq === catalogSeq.current) toast(errorMessage(error), "error");
    } finally {
      if (seq === catalogSeq.current) setLoading(false);
    }
  }, [call, categoryId, productPage, search, toast]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadCatalog(), search ? 150 : 0);
    return () => window.clearTimeout(timer);
  }, [loadCatalog, search]);

  useEffect(() => {
    call<{ id: string; name: string }[]>("category.list")
      .then(setCategories)
      .catch((error: unknown) => toast(errorMessage(error), "error"));
    call<Customer[]>("customer.list", {})
      .then(setCustomers)
      .catch(() => undefined);
  }, [call, toast]);

  const searchText = normalize(search);
  const productPageCount = Math.max(1, Math.ceil(totalProducts / PRODUCT_PAGE_SIZE));
  const currentProductPage = Math.min(productPage, productPageCount);
  const visibleProducts = products;

  const items = useMemo<CartItemInput[]>(
    () => cart.map((line) => ({
      productId: line.product.id,
      saleUnit: line.saleUnit,
      qtyMilli: line.qtyMilli,
      lineDiscountCents: parseMzn(line.discountInput),
    })),
    [cart],
  );
  const orderDiscountCents = parseMzn(orderDiscountInput);
  const cartKey = JSON.stringify(items) + `|${orderDiscountCents}|${applyTax}`;

  useEffect(() => {
    if (items.length === 0) {
      setQuote(null);
      setQuoteError(null);
      return;
    }
    const seq = ++quoteSeq.current;
    setQuoting(true);
    const timer = window.setTimeout(() => {
      call<Quote>("sale.quote", { items, orderDiscountCents, applyTax })
        .then((result) => {
          if (seq !== quoteSeq.current) return;
          setQuote(result);
          setQuoteError(null);
        })
        .catch((error: unknown) => {
          if (seq !== quoteSeq.current) return;
          setQuote(null);
          setQuoteError(errorMessage(error));
        })
        .finally(() => {
          if (seq === quoteSeq.current) setQuoting(false);
        });
    }, 150);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cartKey, call]);

  const totalCents = quote?.totalCents ?? 0;
  const itemCount = cart.length;

  const addProduct = useCallback((product: Product, saleUnit = defaultSaleUnit(product)) => {
    if (!product.active) {
      toast("Produto inactivo.", "error");
      return;
    }
    if (!saleOptions(product).includes(saleUnit)) {
      toast("Este formato de venda não está activo para o produto.", "error");
      return;
    }
    setCart((current) => {
      const index = current.findIndex((line) => line.product.id === product.id && line.saleUnit === saleUnit);
      if (index >= 0) {
        const next = [...current];
        next[index] = { ...next[index], qtyMilli: next[index].qtyMilli + 1000 };
        return next;
      }
      return [...current, { product, saleUnit, qtyMilli: 1000, discountInput: "" }];
    });
  }, [toast]);

  const updateLine = useCallback((productId: string, saleUnit: SaleUnit, updater: (line: CartLine) => CartLine) => {
    setCart((current) => current.map((line) => (
      line.product.id === productId && line.saleUnit === saleUnit ? updater(line) : line
    )));
  }, []);

  function removeLine(line: CartLine) {
    if (cart.length === 1) setApplyTax(false);
    setCart((current) => current.filter((item) => item !== line));
  }

  function changeSaleUnit(line: CartLine, nextSaleUnit: SaleUnit) {
    setCart((current) => {
      const existing = current.find((item) => item !== line && item.product.id === line.product.id && item.saleUnit === nextSaleUnit);
      if (existing) {
        return current
          .filter((item) => item !== line)
          .map((item) => item === existing
            ? {
                ...item,
                qtyMilli: item.qtyMilli + line.qtyMilli,
                discountInput: formatMznPlain(parseMzn(item.discountInput) + parseMzn(line.discountInput)),
              }
            : item);
      }
      return current.map((item) => item === line ? { ...item, saleUnit: nextSaleUnit, qtyMilli: 1000, discountInput: "" } : item);
    });
  }

  async function onSearchSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!searchText) return;
    const seq = ++catalogSeq.current;
    try {
      const result = await call<PagedResult<Product>>("product.page", {
        activeOnly: true,
        query: search,
        categoryId: categoryId || null,
        page: 1,
        pageSize: PRODUCT_PAGE_SIZE,
      });
      if (seq !== catalogSeq.current) return;
      setProducts(result.items);
      setTotalProducts(result.total);
      setProductPage(1);
      const exact = result.items.find((product) => product.barcodes.some((barcode) => normalize(barcode) === searchText));
      const target = exact ?? result.items[0];
      if (target) {
        addProduct(target);
        setSearch("");
      }
    } catch (error) {
      if (seq === catalogSeq.current) toast(errorMessage(error), "error");
    }
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "F2") {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (event.key === "F9") {
        event.preventDefault();
        if (cart.length > 0 && !payOpen) void startPayment();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart.length, payOpen, quote, approvalToken]);

  async function startPayment() {
    if (cart.length === 0) return;
    if (quoting) return;
    if (quoteError || !quote) {
      toast(quoteError ?? "Calcule o total antes de cobrar.", "error");
      return;
    }
    if (quote.requiresApproval && !approvalToken) {
      setApprovalUser("");
      setApprovalPin("");
      setApprovalError(quote.approvalReason ?? "Esta venda exige aprovação.");
      setApprovalOpen(true);
      return;
    }
    if (totalCents <= 0) {
      toast("O total da venda tem de ser superior a zero.", "error");
      return;
    }
    setMethod("cash");
    setTenderedInput(formatMznPlain(totalCents));
    setPaymentError(null);
    setPayOpen(true);
  }

  async function requestApproval(event: React.FormEvent) {
    event.preventDefault();
    if (!quote) return;
    setBusy(true);
    setApprovalError(null);
    try {
      const result = await call<{ token: string }>("approval.request", {
        username: approvalUser,
        pin: approvalPin,
        action: "sale.exception",
        amountCents: quote.discountCents,
        entityType: "sale",
      });
      setApprovalToken(result.token);
      setApprovalOpen(false);
      setMethod("cash");
      setTenderedInput(formatMznPlain(quote.totalCents));
      setPaymentError(null);
      setPayOpen(true);
    } catch (error) {
      setApprovalError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function completeSale() {
    if (!quote) return;
    setBusy(true);
    setPaymentError(null);
    try {
      const tendered = method === "cash" ? parseMzn(tenderedInput) : quote.totalCents;
      const finished = await call<Sale>("sale.complete", {
        items,
        orderDiscountCents,
        applyTax,
        customerId: customerId || null,
        note,
        payments: [
          {
            method,
            amountCents: quote.totalCents,
            tenderedCents: method === "cash" ? tendered : quote.totalCents,
          },
        ],
        approvalToken,
      });
      setPayOpen(false);
      setSale(finished);
      setReceiptOpen(true);
      setCart([]);
      setOrderDiscountInput("");
      setApplyTax(false);
      setNote("");
      setCustomerId("");
      setQuote(null);
      setApprovalToken(null);
      toast(`Venda ${finished.receiptNumber} concluída.`, "success");
      void loadCatalog();
    } catch (error) {
      setPaymentError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <LoadingPanel label="A carregar produtos…" />;

  const changeCents = method === "cash" ? Math.max(0, parseMzn(tenderedInput) - totalCents) : 0;

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
      <section className="min-w-0">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <form className="relative min-w-[220px] flex-1" onSubmit={onSearchSubmit}>
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              autoFocus
              value={search}
              onChange={(event) => { setSearch(event.target.value); setProductPage(1); }}
              placeholder="Pesquisar produto, código ou código de barras (F2)"
              className="h-10 pl-8"
            />
          </form>
          <Select value={categoryId} onChange={(event) => { setCategoryId(event.target.value); setProductPage(1); }} className="h-10 w-auto min-w-[150px]">
            <option value="">Todas as categorias</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </Select>
        </div>

        {products.length === 0 ? (
          <EmptyState
            title="Sem produtos"
            description="Crie produtos no catálogo para começar a vender. Também pode importar um backup."
            action={<Button onClick={() => { window.location.href = "/produtos/"; }}>Abrir catálogo</Button>}
          />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 2xl:grid-cols-4">
              {visibleProducts.map((product) => {
                const low = product.trackStock && product.lowStockThresholdMilli > 0 && product.stockOnHandMilli <= product.lowStockThresholdMilli;
                return (
                  <button
                    key={product.id}
                    type="button"
                    onClick={() => addProduct(product)}
                    className="flex flex-col items-start gap-1 rounded-xl bg-card p-3 text-left ring-1 ring-foreground/10 transition-all hover:ring-emerald-500 active:translate-y-px"
                  >
                    <span className="line-clamp-2 min-h-10 text-sm font-medium">{product.name}</span>
                    {product.color ? <span className="text-xs text-muted-foreground">Cor: {product.color}</span> : null}
                    <span className="text-base font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
                      {formatMzn(salePrice(product, defaultSaleUnit(product)))}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {formatSaleUnit(defaultSaleUnit(product), product.unit)}
                      {product.sellByPackage && defaultSaleUnit(product) !== "package" ? ` · pacote ${formatMzn(product.packagePriceCents)}` : ""}
                    </span>
                    <span className="flex w-full items-center justify-between gap-1 text-[11px] text-muted-foreground">
                      <span className="truncate">{product.sku}</span>
                      {product.trackStock ? (
                        <span className={cn(low && "font-medium text-amber-600")}>{formatQty(product.stockOnHandMilli)}</span>
                      ) : (
                        <Badge tone="neutral">Serviço</Badge>
                      )}
                    </span>
                    {!product.active ? <Badge tone="danger">Inactivo</Badge> : null}
                  </button>
                );
              })}
            </div>
            <div className="mt-3">
              <PaginationControls page={currentProductPage} pageSize={PRODUCT_PAGE_SIZE} total={totalProducts} itemLabel="produtos" onPageChange={setProductPage} />
            </div>
          </>
        )}
      </section>

      <aside className="xl:sticky xl:top-4 xl:self-start">
        <div className="flex flex-col rounded-xl bg-card ring-1 ring-foreground/10">
          <div className="flex items-center justify-between border-b px-4 py-2.5">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <ShoppingCart className="size-4" /> Venda actual
            </h2>
            <div className="flex items-center gap-2">
              <Badge tone="neutral">{itemCount} linha(s)</Badge>
              {cart.length > 0 ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Limpar carrinho"
                  onClick={() => {
                    setCart([]);
                    setOrderDiscountInput("");
                    setApplyTax(false);
                    setQuote(null);
                    setApprovalToken(null);
                  }}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              ) : null}
            </div>
          </div>

          {cart.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-12 text-center text-sm text-muted-foreground">
              <PackageSearch className="size-8" />
              <p>Toque num produto para adicionar à venda.</p>
              <p className="text-xs">F2 pesquisa · F9 cobra</p>
            </div>
          ) : (
            <div className="max-h-[42vh] overflow-y-auto px-2 py-2 xl:max-h-[45vh]">
              {cart.map((line) => {
                const quoteLine = quote?.lines.find((item) => item.productId === line.product.id && item.saleUnit === line.saleUnit);
                const total = quoteLine?.totalCents ?? Math.round((salePrice(line.product, line.saleUnit) * line.qtyMilli) / 1000);
                return (
                  <div key={`${line.product.id}:${line.saleUnit}`} className="rounded-lg px-2 py-2 hover:bg-muted/50">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{line.product.name}</p>
                        {line.product.color ? <p className="text-xs text-muted-foreground">Cor: {line.product.color}</p> : null}
                        <p className="text-[11px] text-muted-foreground">
                          {formatMzn(quoteLine?.unitPriceCents ?? salePrice(line.product, line.saleUnit))} / {formatSaleUnit(line.saleUnit, line.product.unit)} · {line.product.sku}
                        </p>
                      </div>
                      <div className="flex items-center gap-0.5">
                        <Button variant="outline" size="icon-xs" aria-label="Diminuir" onClick={() => updateLine(line.product.id, line.saleUnit, (current) => ({ ...current, qtyMilli: current.qtyMilli - 1000 }))}>
                          <Minus className="size-3" />
                        </Button>
                        <Input
                          aria-label={`Quantidade de ${line.product.name}`}
                          className="h-7 w-16 text-center text-xs tabular-nums"
                          inputMode="decimal"
                          value={qtyToInput(line.qtyMilli)}
                          onChange={(event) => {
                            const qty = parseQty(event.target.value);
                            updateLine(line.product.id, line.saleUnit, (current) => ({ ...current, qtyMilli: qty }));
                          }}
                          onBlur={(event) => {
                            if (parseQty(event.target.value) <= 0) {
                              removeLine(line);
                            }
                          }}
                        />
                        <Button variant="outline" size="icon-xs" aria-label="Aumentar" onClick={() => updateLine(line.product.id, line.saleUnit, (current) => ({ ...current, qtyMilli: current.qtyMilli + 1000 }))}>
                          <Plus className="size-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label="Remover"
                          onClick={() => removeLine(line)}
                        >
                          <X className="size-3.5" />
                        </Button>
                      </div>
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-2">
                      <Select
                        aria-label={`Formato de venda de ${line.product.name}`}
                        className="h-7 min-w-32 text-xs"
                        value={line.saleUnit}
                        onChange={(event) => changeSaleUnit(line, event.target.value as SaleUnit)}
                      >
                        {saleOptions(line.product).map((option) => (
                          <option key={option} value={option}>
                            {formatSaleUnit(option, line.product.unit)} — {formatMzn(salePrice(line.product, option))}
                          </option>
                        ))}
                      </Select>
                      <Input
                        aria-label={`Desconto de ${line.product.name}`}
                        className="h-6 w-24 text-right text-[11px] tabular-nums"
                        inputMode="decimal"
                        placeholder="Desconto MZN"
                        value={line.discountInput}
                        onChange={(event) => updateLine(line.product.id, line.saleUnit, (current) => ({ ...current, discountInput: event.target.value }))}
                      />
                      <span className="text-sm font-semibold tabular-nums">{formatMzn(total)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {cart.length > 0 ? (
            <div className="space-y-2 border-t px-4 py-3">
              <div className="grid grid-cols-2 gap-2">
                <Field label="Cliente">
                  <Select value={customerId} onChange={(event) => setCustomerId(event.target.value)}>
                    <option value="">Consumidor final</option>
                    {customers.map((customer) => (
                      <option key={customer.id} value={customer.id}>
                        {customer.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Desconto da venda">
                  <MoneyInput value={orderDiscountInput} onValueChange={setOrderDiscountInput} placeholder="0,00" />
                </Field>
              </div>
              <Field label="Nota (opcional)">
                <Input value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} placeholder="Ex.: entrega ao balcão 2" />
              </Field>

              <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
                <div>
                  <p className="text-sm font-medium">Aplicar IVA</p>
                  <p className="text-xs text-muted-foreground">Acrescentar a taxa definida em cada produto.</p>
                </div>
                <Switch checked={applyTax} onCheckedChange={setApplyTax} aria-label="Aplicar IVA nesta venda" />
              </div>

              <div className="space-y-0.5 border-t pt-2 text-sm">
                <Row label="Subtotal" value={formatMzn(quote?.subtotalCents ?? 0)} />
                {(quote?.discountCents ?? 0) > 0 ? <Row label="Desconto" value={`- ${formatMzn(quote?.discountCents ?? 0)}`} /> : null}
                <Row label="IVA aplicado" value={formatMzn(quote?.taxCents ?? 0)} muted />
                <div className="flex items-baseline justify-between pt-1">
                  <span className="text-sm font-medium">Total</span>
                  <span className={cn("text-2xl font-bold tabular-nums", quoting && "opacity-50")}>{formatMzn(totalCents)}</span>
                </div>
              </div>

              {quoteError ? <Note tone="danger">{quoteError}</Note> : null}
              {quote && quote.warnings.length > 0 ? <Note tone="warning">{quote.warnings.join(" ")}</Note> : null}
              {quote?.requiresApproval ? (
                <Note tone="warning">
                  {quote.approvalReason} É necessária aprovação de gerente ou proprietário.
                </Note>
              ) : null}

              <Button
                size="lg"
                className="h-12 w-full bg-emerald-600 text-base text-white hover:bg-emerald-700"
                disabled={quoting || !!quoteError || cart.length === 0}
                onClick={() => void startPayment()}
              >
                <Banknote className="size-5" />
                Cobrar {formatMzn(totalCents)} (F9)
              </Button>
            </div>
          ) : null}
        </div>
      </aside>

      <Dialog open={payOpen} onOpenChange={setPayOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Cobrar venda</DialogTitle>
            <DialogDescription>Total a pagar: {formatMzn(totalCents)}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Field label="Método de pagamento">
              <div className="grid grid-cols-2 gap-2">
                {(Object.keys(PAYMENT_LABELS) as PaymentMethod[]).map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      setMethod(key);
                      setPaymentError(null);
                      if (key !== "cash") setTenderedInput(formatMznPlain(totalCents));
                    }}
                    className={cn(
                      "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm",
                      method === key ? "border-emerald-600 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200" : "hover:bg-muted",
                    )}
                  >
                    {key === "cash" ? <Banknote className="size-4" /> : key === "mpesa" || key === "emola" ? <Smartphone className="size-4" /> : <CreditCard className="size-4" />}
                    {PAYMENT_LABELS[key]}
                  </button>
                ))}
              </div>
            </Field>
            {method === "cash" ? (
              <>
                <Field label="Valor entregue" htmlFor="tendered">
                  <MoneyInput id="tendered" value={tenderedInput} onValueChange={setTenderedInput} autoFocus />
                </Field>
                <div className="flex items-center justify-between rounded-lg bg-muted px-3 py-2 text-sm">
                  <span>Troco</span>
                  <span className="text-lg font-semibold tabular-nums">{formatMzn(changeCents)}</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {[totalCents, 50000, 100000, 200000, 500000, 1000000].map((value, index) => (
                    <Button key={`${value}-${index}`} variant="outline" size="xs" onClick={() => setTenderedInput(formatMznPlain(Math.max(totalCents, value)))}>
                      {formatMzn(value)}
                    </Button>
                  ))}
                </div>
              </>
            ) : (
              <Note>Confirme o recebimento no meio de pagamento seleccionado antes de concluir.</Note>
            )}
            {paymentError ? <Note tone="danger">{paymentError}</Note> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPayOpen(false)} disabled={busy}>
              Cancelar
            </Button>
            <Button className="bg-emerald-600 text-white hover:bg-emerald-700" onClick={() => void completeSale()} disabled={busy || (method === "cash" && parseMzn(tenderedInput) < totalCents)}>
              {busy ? "A guardar…" : "Concluir venda"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={approvalOpen} onOpenChange={setApprovalOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Aprovação necessária</DialogTitle>
            <DialogDescription>{quote?.approvalReason ?? "Peça a um gerente ou proprietário para autorizar."}</DialogDescription>
          </DialogHeader>
          <form className="space-y-3" onSubmit={requestApproval}>
            <Field label="Utilizador do aprovador" htmlFor="approvalUser">
              <Input id="approvalUser" autoFocus value={approvalUser} onChange={(event) => setApprovalUser(event.target.value.toLowerCase())} placeholder="gerente" />
            </Field>
            <Field label="PIN do aprovador" htmlFor="approvalPin">
              <Input
                id="approvalPin"
                type="password"
                inputMode="numeric"
                maxLength={6}
                value={approvalPin}
                onChange={(event) => setApprovalPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
              />
            </Field>
            {approvalError ? <Note tone="warning">{approvalError}</Note> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setApprovalOpen(false)} disabled={busy}>
                Cancelar
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "A validar…" : "Autorizar"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ReceiptDialog
        sale={sale}
        settings={session?.settings ?? defaultSettings}
        open={receiptOpen}
        onClose={() => setReceiptOpen(false)}
      />
    </div>
  );
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className={cn("flex justify-between", muted && "text-muted-foreground")}>
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

const defaultSettings = {
  storeName: "POS",
  nif: "",
  address: "",
  phone: "",
  currency: "MZN",
  taxRateBp: 1600,
  receiptFooter: "",
  installationCode: "T01",
  allowNegativeStock: true,
  maxCashierDiscountBp: 500,
  idleLockSeconds: 300,
};
