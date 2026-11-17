"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FileSpreadsheet, Package, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useApp, errorMessage } from "@/lib/app-context";
import type { Category, PagedResult, Product, Unit } from "@/lib/db/protocol";
import { UNIT_LABELS } from "@/lib/db/protocol";
import { formatMzn, formatQty, parseMzn, parseQty, qtyToInput } from "@/lib/format";
import { Badge, EmptyState, Field, MoneyInput, Note, PageHeader, Select } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PaginationControls } from "@/components/pagination-controls";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const PAGE_SIZE = 25;

type FormState = {
  id?: string;
  name: string;
  color: string;
  sku: string;
  barcodes: string;
  categoryId: string;
  unit: Unit;
  price: string;
  packageEnabled: boolean;
  packageQty: string;
  packagePrice: string;
  halfPackagePrice: string;
  sellByUnit: boolean;
  sellByPackage: boolean;
  sellByHalfPackage: boolean;
  cost: string;
  taxRateBp: string;
  trackStock: boolean;
  lowStock: string;
  active: boolean;
};

const emptyForm: FormState = {
  name: "",
  color: "",
  sku: "",
  barcodes: "",
  categoryId: "",
  unit: "un",
  price: "",
  packageEnabled: false,
  packageQty: "",
  packagePrice: "",
  halfPackagePrice: "",
  sellByUnit: true,
  sellByPackage: true,
  sellByHalfPackage: false,
  cost: "",
  taxRateBp: "1600",
  trackStock: true,
  lowStock: "",
  active: true,
};

export function ProductsScreen() {
  const { session, call, toast } = useApp();
  const router = useRouter();
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [categoriesOpen, setCategoriesOpen] = useState(false);

  const canEdit = session?.user.role === "owner" || session?.user.role === "manager";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [pageResult, cats] = await Promise.all([
        call<PagedResult<Product>>("product.page", { activeOnly: false, query, page, pageSize: PAGE_SIZE }),
        call<Category[]>("category.list"),
      ]);
      setProducts(pageResult.items);
      setTotal(pageResult.total);
      if (pageResult.page !== page) setPage(pageResult.page);
      setCategories(cats);
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setLoading(false);
    }
  }, [call, page, query, toast]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), query ? 200 : 0);
    return () => window.clearTimeout(timer);
  }, [load, query]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visibleProducts = products;

  function openNew() {
    setForm(emptyForm);
    setError(null);
    setFormOpen(true);
  }

  function openEdit(product: Product) {
    setForm({
      id: product.id,
      name: product.name,
      color: product.color,
      sku: product.sku,
      barcodes: product.barcodes.join(", "),
      categoryId: product.categoryId ?? "",
      unit: product.unit,
      price: (product.priceCents / 100).toFixed(2).replace(".", ","),
      packageEnabled: product.packageQtyMilli > 0,
      packageQty: product.packageQtyMilli > 0 ? qtyToInput(product.packageQtyMilli) : "",
      packagePrice: (product.packagePriceCents / 100).toFixed(2).replace(".", ","),
      halfPackagePrice: (product.halfPackagePriceCents / 100).toFixed(2).replace(".", ","),
      sellByUnit: product.sellByUnit,
      sellByPackage: product.sellByPackage,
      sellByHalfPackage: product.sellByHalfPackage,
      cost: (product.costCents / 100).toFixed(2).replace(".", ","),
      taxRateBp: String(product.taxRateBp),
      trackStock: product.trackStock,
      lowStock: qtyToInput(product.lowStockThresholdMilli),
      active: product.active,
    });
    setError(null);
    setFormOpen(true);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await call("product.upsert", {
        id: form.id,
        name: form.name,
        color: form.color,
        sku: form.sku,
        barcodes: form.barcodes.split(",").map((value) => value.trim()).filter(Boolean),
        categoryId: form.categoryId || null,
        unit: form.unit,
        priceCents: !form.packageEnabled || form.sellByUnit ? parseMzn(form.price) : 0,
        packageQtyMilli: form.packageEnabled && (form.sellByPackage || form.sellByHalfPackage) ? parseQty(form.packageQty) : 0,
        packagePriceCents: form.packageEnabled && form.sellByPackage ? parseMzn(form.packagePrice) : 0,
        halfPackagePriceCents: form.packageEnabled && form.sellByHalfPackage ? parseMzn(form.halfPackagePrice) : 0,
        sellByUnit: form.packageEnabled ? form.sellByUnit : true,
        sellByPackage: form.packageEnabled && form.sellByPackage,
        sellByHalfPackage: form.packageEnabled && form.sellByHalfPackage,
        costCents: parseMzn(form.cost),
        taxRateBp: Number(form.taxRateBp),
        trackStock: form.trackStock,
        lowStockThresholdMilli: parseQty(form.lowStock),
        active: form.active,
      });
      toast(form.id ? "Produto actualizado." : "Produto criado.", "success");
      setFormOpen(false);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(product: Product) {
    if (!window.confirm(`Desactivar o produto "${product.name}"? O histórico de vendas é mantido.`)) return;
    try {
      await call("product.delete", { id: product.id });
      toast("Produto desactivado.", "success");
      await load();
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  }

  return (
    <div>
      <PageHeader
        title="Produtos"
        description="Catálogo local com preços de unidade, meia embalagem e pacote. O IVA é opcional e acrescentado na venda."
        actions={
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Nome, cor, código… (ex.: rose red)" className="pl-8" />
            </div>
            <Button variant="outline" onClick={() => setCategoriesOpen(true)}>
              Categorias
            </Button>
            {canEdit ? (
              <Button onClick={openNew}>
                <Plus className="size-4" /> Novo produto
              </Button>
            ) : null}
          </>
        }
      />

      <p className="mb-2 text-xs text-muted-foreground" aria-live="polite">
        {loading ? "A actualizar…" : `${total} produto(s)`}
      </p>

      {products.length === 0 ? (
        <EmptyState
          title="Ainda não há produtos"
          description="Crie o primeiro produto ou importe um Excel de stock. Produtos ainda não registados serão criados ao confirmar a importação."
          action={canEdit ? (
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={openNew}>Criar produto</Button>
              <Button variant="outline" onClick={() => router.push("/stock/")}>
                <FileSpreadsheet className="size-4" /> Importar Excel
              </Button>
            </div>
          ) : undefined}
        />
      ) : (
        <>
          <div className="rounded-xl bg-card ring-1 ring-foreground/10">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Produto</TableHead>
                  <TableHead>Categoria</TableHead>
                  <TableHead className="text-right">Preço</TableHead>
                  <TableHead className="text-right">Custo</TableHead>
                  <TableHead className="text-right">Stock</TableHead>
                  <TableHead>Estado</TableHead>
                  {canEdit ? <TableHead className="w-20" /> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleProducts.map((product) => {
                  const low = product.trackStock && product.lowStockThresholdMilli > 0 && product.stockOnHandMilli <= product.lowStockThresholdMilli;
                  return (
                    <TableRow key={product.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="flex size-8 items-center justify-center rounded-lg bg-muted">
                            <Package className="size-4" />
                          </span>
                          <div>
                            <p className="font-medium">{product.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {product.sku}
                              {product.barcodes.length > 0 ? ` · ${product.barcodes.join(", ")}` : ""}
                            </p>
                            <p className="text-xs text-muted-foreground">Cor: {product.color || "por indicar"}</p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{product.categoryName ?? "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {product.sellByUnit ? <p>{formatMzn(product.priceCents)} / {product.unit}</p> : null}
                        {product.sellByPackage ? <p className="text-xs text-muted-foreground">{formatMzn(product.packagePriceCents)} / pacote</p> : null}
                        {product.sellByHalfPackage ? <p className="text-xs text-muted-foreground">{formatMzn(product.halfPackagePriceCents)} / meia embalagem</p> : null}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{formatMzn(product.costCents)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {product.trackStock ? (
                          <span className={low ? "font-medium text-amber-600" : ""}>
                            {formatQty(product.stockOnHandMilli)} {product.unit}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {!product.active ? <Badge tone="danger">Inactivo</Badge> : null}
                          {low ? <Badge tone="warning">Stock baixo</Badge> : null}
                          {product.active && !low ? <Badge tone="success">Activo</Badge> : null}
                        </div>
                      </TableCell>
                      {canEdit ? (
                        <TableCell>
                          <div className="flex justify-end gap-1">
                            <Button variant="ghost" size="icon-sm" aria-label="Editar" onClick={() => openEdit(product)}>
                              <Pencil className="size-3.5" />
                            </Button>
                            <Button variant="ghost" size="icon-sm" aria-label="Desactivar" onClick={() => void remove(product)}>
                              <Trash2 className="size-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      ) : null}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <PaginationControls page={currentPage} pageSize={PAGE_SIZE} total={total} itemLabel="produtos" onPageChange={setPage} />
        </>
      )}

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{form.id ? "Editar produto" : "Novo produto"}</DialogTitle>
            <DialogDescription>Seleccione os formatos vendidos e indique apenas os respectivos preços. O IVA é acrescentado apenas quando activado na venda.</DialogDescription>
          </DialogHeader>
          <form className="grid gap-3 sm:grid-cols-2" onSubmit={save}>
            <Field label="Nome *" htmlFor="productName" className="sm:col-span-2">
              <Input id="productName" required autoFocus value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
            </Field>
            <Field label="Cor *" htmlFor="productColor">
              <Input id="productColor" required maxLength={60} value={form.color} onChange={(event) => setForm({ ...form, color: event.target.value })} />
            </Field>
            <Field label="SKU / referência" htmlFor="productSku" hint="Deixe vazio para gerar automaticamente.">
              <Input id="productSku" value={form.sku} onChange={(event) => setForm({ ...form, sku: event.target.value })} />
            </Field>
            <Field label="Códigos de barras" htmlFor="productBarcodes" hint="Separe vários códigos por vírgulas.">
              <Input id="productBarcodes" value={form.barcodes} onChange={(event) => setForm({ ...form, barcodes: event.target.value })} />
            </Field>
            <Field label="Categoria" htmlFor="productCategory">
              <Select id="productCategory" value={form.categoryId} onChange={(event) => setForm({ ...form, categoryId: event.target.value })}>
                <option value="">Sem categoria</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Unidade" htmlFor="productUnit">
              <Select id="productUnit" value={form.unit} onChange={(event) => setForm({ ...form, unit: event.target.value as Unit })}>
                {(Object.keys(UNIT_LABELS) as Unit[]).map((unit) => (
                  <option key={unit} value={unit}>
                    {UNIT_LABELS[unit]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label={`Preço por ${UNIT_LABELS[form.unit].toLowerCase()} (MZN)${form.packageEnabled && !form.sellByUnit ? " (opcional)" : " *"}`}
              htmlFor="productPrice"
            >
              <MoneyInput
                id="productPrice"
                required={!form.packageEnabled || form.sellByUnit}
                disabled={form.packageEnabled && !form.sellByUnit}
                value={form.price}
                onValueChange={(price) => setForm({ ...form, price })}
              />
            </Field>
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input
                type="checkbox"
                className="size-4"
                checked={form.packageEnabled}
                onChange={(event) => setForm({ ...form, packageEnabled: event.target.checked })}
              />
              Configurar venda por pacote ou meia embalagem
            </label>
            {form.packageEnabled ? (
              <>
                <Field
                  label={`Unidades-base por pacote (${UNIT_LABELS[form.unit]})${form.sellByPackage || form.sellByHalfPackage ? " *" : ""}`}
                  htmlFor="packageQty"
                  hint="Ex.: 12 unidades por pacote."
                >
                  <Input
                    id="packageQty"
                    required={form.sellByPackage || form.sellByHalfPackage}
                    disabled={!form.sellByPackage && !form.sellByHalfPackage}
                    inputMode="decimal"
                    value={form.packageQty}
                    onChange={(event) => setForm({ ...form, packageQty: event.target.value })}
                  />
                </Field>
                <div className="grid gap-3 sm:grid-cols-2 sm:col-span-2">
                  <Field label={`Preço do pacote (MZN)${form.sellByPackage ? " *" : " (opcional)"}`} htmlFor="packagePrice">
                    <MoneyInput
                      id="packagePrice"
                      required={form.sellByPackage}
                      disabled={!form.sellByPackage}
                      value={form.packagePrice}
                      onValueChange={(packagePrice) => setForm({ ...form, packagePrice })}
                    />
                  </Field>
                  <Field label={`Preço de meia embalagem (MZN)${form.sellByHalfPackage ? " *" : " (opcional)"}`} htmlFor="halfPackagePrice">
                    <MoneyInput
                      id="halfPackagePrice"
                      required={form.sellByHalfPackage}
                      disabled={!form.sellByHalfPackage}
                      value={form.halfPackagePrice}
                      onValueChange={(halfPackagePrice) => setForm({ ...form, halfPackagePrice })}
                    />
                  </Field>
                </div>
                <div className="flex flex-wrap gap-x-5 gap-y-2 sm:col-span-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" className="size-4" checked={form.sellByUnit} onChange={(event) => setForm({ ...form, sellByUnit: event.target.checked })} />
                    Vender por {UNIT_LABELS[form.unit].toLowerCase()}
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" className="size-4" checked={form.sellByPackage} onChange={(event) => setForm({ ...form, sellByPackage: event.target.checked })} />
                    Vender pacote
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" className="size-4" checked={form.sellByHalfPackage} onChange={(event) => setForm({ ...form, sellByHalfPackage: event.target.checked })} />
                    Vender meia embalagem
                  </label>
                </div>
              </>
            ) : null}
            <Field label={`Custo por ${UNIT_LABELS[form.unit].toLowerCase()} (MZN)`} htmlFor="productCost">
              <MoneyInput id="productCost" value={form.cost} onValueChange={(cost) => setForm({ ...form, cost })} />
            </Field>
            <Field label="Taxa de IVA" htmlFor="productTax">
              <Select id="productTax" value={form.taxRateBp} onChange={(event) => setForm({ ...form, taxRateBp: event.target.value })}>
                <option value="1600">16% (padrão)</option>
                <option value="0">Isento / 0%</option>
              </Select>
            </Field>
            <Field label="Limite de stock baixo" htmlFor="productLowStock" hint="Alerta quando o stock chegar a este valor.">
              <Input
                id="productLowStock"
                inputMode="decimal"
                value={form.lowStock}
                onChange={(event) => setForm({ ...form, lowStock: event.target.value })}
                disabled={!form.trackStock}
              />
            </Field>
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input type="checkbox" className="size-4" checked={form.trackStock} onChange={(event) => setForm({ ...form, trackStock: event.target.checked })} />
              Controlar stock deste produto
            </label>
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input type="checkbox" className="size-4" checked={form.active} onChange={(event) => setForm({ ...form, active: event.target.checked })} />
              Produto activo (visível no ponto de venda)
            </label>
            {error ? <div className="sm:col-span-2"><Note tone="danger">{error}</Note></div> : null}
            <DialogFooter className="sm:col-span-2">
              <Button type="button" variant="outline" onClick={() => setFormOpen(false)} disabled={busy}>
                Cancelar
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "A guardar…" : "Guardar produto"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <CategoriesDialog
        open={categoriesOpen}
        onClose={() => setCategoriesOpen(false)}
        categories={categories}
        canEdit={canEdit}
        onChanged={load}
      />
    </div>
  );
}

function CategoriesDialog({
  open,
  onClose,
  categories,
  canEdit,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  categories: Category[];
  canEdit: boolean;
  onChanged: () => Promise<void>;
}) {
  const { call, toast } = useApp();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await call("category.upsert", { name });
      setName("");
      await onChanged();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Categorias</DialogTitle>
          <DialogDescription>Agrupe produtos para facilitar a pesquisa no ponto de venda.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {categories.length === 0 ? <p className="text-sm text-muted-foreground">Ainda não existem categorias.</p> : null}
          <ul className="divide-y rounded-lg border">
            {categories.map((category) => (
              <li key={category.id} className="flex items-center justify-between px-3 py-2 text-sm">
                <span>{category.name}</span>
                <Badge tone="neutral">{category.sortOrder}</Badge>
              </li>
            ))}
          </ul>
          {canEdit ? (
            <form className="flex gap-2" onSubmit={add}>
              <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Nova categoria" />
              <Button type="submit" disabled={busy || !name.trim()}>
                <Plus className="size-4" /> Adicionar
              </Button>
            </form>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Fechar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
