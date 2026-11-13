// Contrato único entre a UI e o sqlite.worker.ts.
// Este ficheiro não contém código de persistência: apenas tipos e constantes.

export type Role = "owner" | "manager" | "cashier";
export type PaymentMethod = "cash" | "card" | "pos" | "mpesa" | "emola" | "transfer" | "other";
export type SaleUnit = "unit" | "package" | "half_package";
export type StockEntryUnit = "unit" | "package";

export type Unit = "un" | "kg" | "g" | "l" | "ml" | "cx" | "pct" ;

export const UNIT_LABELS: Record<Unit, string> = {
  un: "Unidade",
  kg: "Quilograma",
  g: "Grama",
  l: "Litro",
  ml: "Mililitro",
  cx: "Caixa",
  pct: "Pacote",
};

export const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  cash: "Dinheiro",
  card: "Cartão",
  pos: "POS",
  mpesa: "M-Pesa",
  emola: "e-Mola",
  transfer: "Transferência",
  other: "Outro",
};

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Proprietário",
  manager: "Gerente",
  cashier: "Caixa",
};

export interface AppStatus {
  setupRequired: boolean;
  schemaVersion: number;
  storagePersisted: boolean | null;
  storageUsage: number | null;
  storageQuota: number | null;
  lastBackupAt: string | null;
  opfsAvailable: boolean;
  crossOriginIsolated: boolean;
}

export interface UserPublic {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  active: boolean;
  mustChangePin: boolean;
  lastLoginAt: string | null;
}

export interface Settings {
  storeName: string;
  nif: string;
  address: string;
  phone: string;
  currency: string;
  taxRateBp: number;
  receiptFooter: string;
  installationCode: string;
  allowNegativeStock: boolean;
  maxCashierDiscountBp: number;
  idleLockSeconds: number;
}

export interface SessionInfo {
  token: string;
  user: UserPublic;
  settings: Settings;
}

export interface Category {
  id: string;
  name: string;
  sortOrder: number;
}

export interface Product {
  id: string;
  sku: string;
  name: string;
  color: string;
  categoryId: string | null;
  categoryName: string | null;
  unit: Unit;
  priceCents: number;
  packageQtyMilli: number;
  packagePriceCents: number;
  halfPackagePriceCents: number;
  sellByUnit: boolean;
  sellByPackage: boolean;
  sellByHalfPackage: boolean;
  costCents: number;
  taxRateBp: number;
  trackStock: boolean;
  stockOnHandMilli: number;
  lowStockThresholdMilli: number;
  active: boolean;
  barcodes: string[];
}

export interface StockImportItem {
  sku: string;
  name: string;
  color: string;
  qtyMilli: number;
  purchaseCostMinor: number;
  valueMinor: number;
  lineCount: number;
  salePriceCents: number | null;
}

export interface StockImportMatch {
  productId: string | null;
  active: boolean | null;
  trackStock: boolean | null;
  unit: Unit | null;
  priceCents: number | null;
}

export interface PagedResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface SalePageResult extends PagedResult<SaleSummary> {
  completedTotalCents: number;
}

export interface StockMovement {
  id: string;
  productId: string;
  productName: string;
  type: string;
  qtyMilli: number;
  balanceAfterMilli: number;
  unitCostCents: number | null;
  supplierName: string | null;
  documentRef: string | null;
  reason: string | null;
  createdAt: string;
  userName: string | null;
}

export interface Customer {
  id: string;
  name: string;
  phone: string;
  nif: string;
  email: string;
  address: string;
  notes: string;
}

export interface Supplier {
  id: string;
  name: string;
  contactName: string;
  phone: string;
  nif: string;
  email: string;
  address: string;
  notes: string;
  active: boolean;
}

export interface CartItemInput {
  productId: string;
  saleUnit?: SaleUnit;
  qtyMilli: number;
  lineDiscountCents?: number;
}

export interface PaymentInput {
  method: PaymentMethod;
  amountCents: number;
  tenderedCents?: number;
  reference?: string;
}

export interface QuoteInput {
  items: CartItemInput[];
  orderDiscountCents?: number;
  applyTax?: boolean;
}

export interface QuoteLine {
  productId: string;
  name: string;
  sku: string;
  unit: Unit;
  saleUnit: SaleUnit;
  unitPriceCents: number;
  saleQtyMilli: number;
  qtyMilli: number;
  grossCents: number;
  lineDiscountCents: number;
  orderDiscountCents: number;
  baseCents: number;
  taxCents: number;
  totalCents: number;
  taxRateBp: number;
  trackStock: boolean;
  stockOnHandMilli: number;
}

export interface Quote {
  lines: QuoteLine[];
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  taxApplied: boolean;
  totalCents: number;
  requiresApproval: boolean;
  approvalReason: string | null;
  warnings: string[];
}

export interface SaleInput extends QuoteInput {
  customerId: string | null;
  note: string;
  payments: PaymentInput[];
  approvalToken?: string | null;
}

export interface SaleItem {
  id: string;
  productId: string;
  nameSnapshot: string;
  skuSnapshot: string;
  unit: Unit;
  saleUnit: SaleUnit;
  unitPriceCents: number;
  saleQtyMilli: number;
  qtyMilli: number;
  grossCents: number;
  lineDiscountCents: number;
  orderDiscountCents: number;
  taxRateBp: number;
  baseCents: number;
  taxCents: number;
  totalCents: number;
}

export interface SalePayment {
  id: string;
  method: PaymentMethod;
  amountCents: number;
  tenderedCents: number;
  reference: string | null;
}

export interface Sale {
  id: string;
  receiptNumber: string;
  status: "completed" | "voided";
  cashierName: string;
  customerName: string | null;
  customerNif: string | null;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  taxApplied: boolean;
  totalCents: number;
  paidCents: number;
  changeCents: number;
  note: string | null;
  createdAt: string;
  voidedAt: string | null;
  voidReason: string | null;
  items: SaleItem[];
  payments: SalePayment[];
}

export interface SaleSummary {
  id: string;
  receiptNumber: string;
  status: "completed" | "voided";
  cashierName: string;
  customerName: string | null;
  totalCents: number;
  createdAt: string;
  itemCount: number;
}

export interface ReportSummary {
  from: string;
  to: string;
  salesCount: number;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  averageCents: number;
  byMethod: { method: PaymentMethod; amountCents: number; count: number }[];
  topProducts: { name: string; qtyMilli: number; totalCents: number }[];
  lowStock: Product[];
}

export interface AuditEntry {
  id: string;
  actorName: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  createdAt: string;
  beforeJson: string | null;
  afterJson: string | null;
}

export interface BackupInfo {
  lastBackupAt: string | null;
  lastAutoBackupAt: string | null;
  backups: { name: string; sizeBytes: number }[];
}

export type RequestType =
  | "app.init"
  | "app.status"
  | "setup.create"
  | "auth.users"
  | "auth.login"
  | "auth.logout"
  | "auth.lock"
  | "auth.recoverOwner"
  | "auth.changePin"
  | "approval.request"
  | "settings.update"
  | "user.list"
  | "user.create"
  | "user.update"
  | "user.resetPin"
  | "category.list"
  | "category.upsert"
  | "product.list"
  | "product.page"
  | "product.upsert"
  | "product.delete"
  | "stock.entry"
  | "stock.adjust"
  | "stock.history"
  | "stock.history.page"
  | "stock.low"
  | "stock.import.preview"
  | "stock.import.commit"
  | "customer.list"
  | "customer.page"
  | "customer.upsert"
  | "customer.delete"
  | "supplier.list"
  | "supplier.page"
  | "supplier.upsert"
  | "supplier.delete"
  | "sale.quote"
  | "sale.complete"
  | "sale.list"
  | "sale.page"
  | "sale.get"
  | "sale.void"
  | "report.summary"
  | "audit.list"
  | "audit.page"
  | "backup.export"
  | "backup.auto"
  | "backup.import"
  | "backup.info";

export interface WorkerRequest {
  id: string;
  type: RequestType;
  token?: string | null;
  payload?: unknown;
}

export interface WorkerError {
  code: string;
  message: string;
}

export type WorkerResponse =
  | { id: string; ok: true; data: unknown }
  | { id: string; ok: false; error: WorkerError };

export function isWorkerResponse(value: unknown): value is WorkerResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as WorkerResponse).id === "string" &&
    typeof (value as WorkerResponse).ok === "boolean"
  );
}
