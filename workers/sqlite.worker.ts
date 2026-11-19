/// <reference lib="webworker" />

/*
 * sqlite.worker.ts
 *
 * Único ponto do projeto que abre/consulta a base SQLite WASM em OPFS.
 * A UI nunca importa sqlite-wasm nem recebe o handle da base.
 *
 * Compilado para public/workers/sqlite.worker.js por `tsc -p workers/tsconfig.json`.
 * O módulo sqlite-wasm é servido em /sqlite/index.mjs (copiado de node_modules).
 */

import type {
  AppStatus,
  AuditEntry,
  BackupInfo,
  CartItemInput,
  Category,
  Customer,
  Expense,
  ExpenseCategory,
  ExpensePageResult,
  PaymentInput,
  PaymentMethod,
  PagedResult,
  Product,
  Quote,
  QuoteInput,
  QuoteLine,
  ReportSummary,
  Role,
  Sale,
  SaleInput,
  SaleItem,
  SalePayment,
  SalePageResult,
  SaleSettlement,
  SaleSummary,
  SaleUnit,
  SessionInfo,
  Settings,
  StockImportCommitItem,
  StockImportCommitResult,
  StockImportDocumentCheck,
  StockImportMatch,
  StockMovement,
  Supplier,
  Unit,
  UserPublic,
  WorkerRequest,
} from "../lib/db/protocol";

const SCHEMA_VERSION = 9;
// Espelho de EXPENSE_CATEGORIES em lib/db/protocol.ts. O worker é um script
// isolado e não pode importar módulos da aplicação em tempo de execução.
const EXPENSE_CATEGORIES: readonly string[] = [
  "compras", "transporte", "utilidades", "salarios", "aluguer", "manutencao", "impostos", "marketing", "outros",
];
const PIN_ITERATIONS = 600_000;
const MAX_IMPORT_BYTES = 512 * 1024 * 1024;
const AUTO_BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const AUTO_BACKUP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const APPROVAL_TTL_MS = 2 * 60 * 1000;

type Row = Record<string, any>;
type Sqlite = any;

const self_ = self as unknown as DedicatedWorkerGlobalScope;

let sqlite3: Sqlite | null = null;
let db: any = null;
let session: { token: string; userId: string; role: Role; username: string; displayName: string; lastActivity: number } | null = null;

class AppError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new AppError(code, message);
}

function uuid(): string {
  return crypto.randomUUID();
}

function nowIso(): string {
  return new Date().toISOString();
}

const MAPUTO_OFFSET_MS = 2 * 60 * 60 * 1000;

/** Segunda-feira até hoje (ISO, hora de Maputo). Usado quando a UI não envia datas. */
function thisWeekRange(): { from: string; to: string } {
  const local = new Date(Date.now() + MAPUTO_OFFSET_MS);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  const day = local.getUTCDate();
  const mondayOffset = (local.getUTCDay() + 6) % 7;
  return {
    from: new Date(Date.UTC(year, month, day - mondayOffset) - MAPUTO_OFFSET_MS).toISOString(),
    to: new Date(Date.UTC(year, month, day + 1) - MAPUTO_OFFSET_MS).toISOString(),
  };
}

function toBool(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function norm(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function digits(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "");
}

function normalizePhone(value: unknown): string {
  const d = digits(value);
  if (!d) return "";
  if (d.startsWith("258")) return `+${d}`;
  if (d.length === 9 && (d.startsWith("8") || d.startsWith("2"))) return `+258${d}`;
  return String(value).trim();
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function rows(sql: string, bind: unknown[] = []): Row[] {
  if (!db) fail("DB_NOT_READY", "A base de dados não está aberta.");
  return db.exec({ sql, bind, rowMode: "object", returnValue: "resultRows" }) as Row[];
}

function one(sql: string, bind: unknown[] = []): Row | null {
  return rows(sql, bind)[0] ?? null;
}

function run(sql: string, bind: unknown[] = []): void {
  if (!db) fail("DB_NOT_READY", "A base de dados não está aberta.");
  db.exec({ sql, bind });
}

function meta(key: string): string | null {
  const row = one("SELECT value FROM app_meta WHERE key = ?", [key]);
  return row ? String(row.value) : null;
}

function setMeta(key: string, value: string): void {
  run("INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]);
}

async function hashPin(pin: string, saltHex?: string, iterations = PIN_ITERATIONS): Promise<{ hash: string; salt: string; iterations: number }> {
  const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256);
  return { hash: bytesToHex(new Uint8Array(bits)), salt: bytesToHex(salt), iterations };
}

function validatePin(pin: unknown): string {
  const value = String(pin ?? "");
  if (!/^\d{6}$/.test(value)) fail("PIN_INVALID", "O PIN deve ter exactamente 6 dígitos.");
  if (/^(\d)\1{5}$/.test(value)) fail("PIN_WEAK", "Escolha um PIN menos óbvio.");
  if (["123456", "654321", "111111", "000000", "121212", "112233"].includes(value)) {
    fail("PIN_WEAK", "Escolha um PIN menos óbvio.");
  }
  return value;
}

function generateRecoveryCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out.match(/.{1,5}/g)?.join("-") ?? out;
}

function validateRecoveryCode(code: unknown): string {
  return String(code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function settingsRow(): Row | null {
  return one("SELECT * FROM settings WHERE id = 'default'");
}

function toSettings(row: Row | null): Settings | null {
  if (!row) return null;
  return {
    storeName: String(row.store_name ?? ""),
    nif: String(row.nif ?? ""),
    address: String(row.address ?? ""),
    phone: String(row.phone ?? ""),
    currency: String(row.currency ?? "MZN"),
    taxRateBp: Number(row.tax_rate_bp ?? 1600),
    receiptFooter: String(row.receipt_footer ?? ""),
    installationCode: String(row.installation_code ?? "T01"),
    allowNegativeStock: toBool(row.allow_negative_stock),
    maxCashierDiscountBp: Number(row.max_cashier_discount_bp ?? 500),
    discountApprovalMode: (["never", "above_limit", "always"].includes(String(row.discount_approval_mode))
      ? String(row.discount_approval_mode)
      : "above_limit") as Settings["discountApprovalMode"],
    idleLockSeconds: Number(row.idle_lock_seconds ?? 300),
  };
}

function getSettings(): Settings {
  const settings = toSettings(settingsRow());
  if (!settings) fail("NOT_SETUP", "A aplicação ainda não foi configurada.");
  return settings;
}

function toUser(row: Row): UserPublic {
  return {
    id: String(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    role: row.role as Role,
    active: toBool(row.active),
    mustChangePin: toBool(row.must_change_pin),
    lastLoginAt: row.last_login_at ? String(row.last_login_at) : null,
    loginShortcut: row.login_shortcut === null || row.login_shortcut === undefined ? null : Number(row.login_shortcut),
  };
}

/** Normaliza a tecla de atalho de entrada (1-9), garantindo que é única. */
function parseLoginShortcut(value: unknown, excludeId?: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  const shortcut = Math.trunc(Number(value));
  if (!Number.isFinite(shortcut) || shortcut < 1 || shortcut > 9) {
    fail("VALIDATION", "O atalho de entrada deve ser um número entre 1 e 9.");
  }
  const taken = excludeId
    ? one("SELECT id FROM users WHERE login_shortcut = ? AND id <> ?", [shortcut, excludeId])
    : one("SELECT id FROM users WHERE login_shortcut = ?", [shortcut]);
  if (taken) fail("VALIDATION", `A tecla ${shortcut} já está atribuída a outro utilizador.`);
  return shortcut;
}

/** Primeira tecla livre para atribuição automática. */
function nextFreeLoginShortcut(): number | null {
  for (let shortcut = 1; shortcut <= 9; shortcut += 1) {
    if (!one("SELECT id FROM users WHERE login_shortcut = ?", [shortcut])) return shortcut;
  }
  return null;
}

/** Atribui teclas em falta a utilizadores criados antes do atalho existir. */
function ensureLoginShortcuts(): void {
  const users = rows(
    `SELECT id, login_shortcut FROM users
     ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, display_name, created_at`,
  );
  // Reservar primeiro todas as teclas já usadas; só depois preencher as faltas.
  const used = new Set<number>();
  for (const user of users) {
    const current = user.login_shortcut === null || user.login_shortcut === undefined
      ? null
      : Number(user.login_shortcut);
    if (current !== null && Number.isFinite(current)) used.add(current);
  }
  for (const user of users) {
    const current = user.login_shortcut === null || user.login_shortcut === undefined
      ? null
      : Number(user.login_shortcut);
    if (current !== null && Number.isFinite(current)) continue;
    for (let shortcut = 1; shortcut <= 9; shortcut += 1) {
      if (used.has(shortcut)) continue;
      run("UPDATE users SET login_shortcut = ?, updated_at = ? WHERE id = ?", [shortcut, nowIso(), user.id]);
      used.add(shortcut);
      break;
    }
  }
}

function isSetupRequired(): boolean {
  const hasSettings = one("SELECT id FROM settings WHERE id = 'default'");
  const hasOwner = one("SELECT id FROM users WHERE role = 'owner' AND active = 1 LIMIT 1");
  return !hasSettings || !hasOwner;
}

async function storageStatus(): Promise<{ usage: number | null; quota: number | null }> {
  const storage = navigator.storage as any;
  let usage: number | null = null;
  let quota: number | null = null;
  try {
    if (storage?.estimate) {
      const estimate = await storage.estimate();
      usage = typeof estimate.usage === "number" ? estimate.usage : null;
      quota = typeof estimate.quota === "number" ? estimate.quota : null;
    }
  } catch {
    /* ignore */
  }
  return { usage, quota };
}

async function status(): Promise<AppStatus> {
  const storage = await storageStatus();
  return {
    setupRequired: isSetupRequired(),
    schemaVersion: Number(one("PRAGMA user_version")?.user_version ?? 0),
    storagePersisted: null,
    storageUsage: storage.usage,
    storageQuota: storage.quota,
    lastBackupAt: meta("last_backup_at"),
    opfsAvailable: Boolean(sqlite3 && typeof (sqlite3 as any).oo1?.OpfsDb === "function"),
    crossOriginIsolated: Boolean((self_ as any).crossOriginIsolated),
  };
}

function audit(action: string, entityType: string, entityId: string | null, before: unknown, after: unknown, actorId?: string | null): void {
  run(
    "INSERT INTO audit_log (id, actor_id, action, entity_type, entity_id, before_json, after_json, created_at, device_info) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      uuid(),
      actorId === undefined ? session?.userId ?? null : actorId,
      action,
      entityType,
      entityId,
      before === null || before === undefined ? null : JSON.stringify(before),
      after === null || after === undefined ? null : JSON.stringify(after),
      nowIso(),
      String((self_ as any).navigator?.userAgent ?? "").slice(0, 250),
    ],
  );
}

function requireSession(roles?: Role[]): NonNullable<typeof session> {
  if (!session) fail("UNAUTHENTICATED", "A sessão terminou. Introduza o PIN novamente.");
  const settings = getSettings();
  if (Date.now() - session.lastActivity > settings.idleLockSeconds * 1000) {
    session = null;
    fail("SESSION_LOCKED", "A sessão foi bloqueada por inatividade.");
  }
  if (roles && !roles.includes(session.role)) fail("FORBIDDEN", "Não tem permissão para esta operação.");
  session.lastActivity = Date.now();
  return session;
}

const EXPENSE_SELECT = `SELECT e.*, u.display_name AS user_name FROM expenses e LEFT JOIN users u ON u.id = e.user_id`;

function toExpense(row: Row): Expense {
  return {
    id: String(row.id),
    category: String(row.category) as ExpenseCategory,
    description: String(row.description),
    amountCents: Number(row.amount_cents),
    method: String(row.method) as PaymentMethod,
    reference: row.reference ? String(row.reference) : null,
    note: row.note ? String(row.note) : null,
    spentAt: String(row.spent_at),
    createdAt: String(row.created_at),
    userName: row.user_name ? String(row.user_name) : null,
  };
}

function expenseValues(payload: Row, before: Row | null) {
  const category = String(payload.category ?? before?.category ?? "");
  if (!(EXPENSE_CATEGORIES as readonly string[]).includes(category)) {
    fail("VALIDATION", "Escolha uma categoria válida para a saída.");
  }
  const description = String(payload.description ?? before?.description ?? "").trim();
  if (!description) fail("VALIDATION", "Indique a descrição da saída.");
  const amountCents = Math.trunc(Number(payload.amountCents ?? before?.amount_cents ?? 0));
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) fail("VALIDATION", "Indique um valor superior a zero.");
  const method = String(payload.method ?? before?.method ?? "cash") as PaymentMethod;
  if (!PAYMENT_METHODS.includes(method)) fail("PAYMENT_INVALID", "Método de pagamento inválido.");
  const reference = String(payload.reference ?? before?.reference ?? "").trim() || null;
  const note = String(payload.note ?? before?.note ?? "").trim() || null;
  const rawSpentAt = payload.spentAt ?? before?.spent_at;
  const parsedSpentAt = rawSpentAt ? new Date(String(rawSpentAt)) : null;
  if (!parsedSpentAt || Number.isNaN(parsedSpentAt.getTime())) fail("VALIDATION", "Indique a data da saída.");
  return {
    category,
    description,
    searchText: norm(`${description} ${reference ?? ""} ${note ?? ""}`),
    amountCents,
    method,
    reference,
    note,
    spentAt: parsedSpentAt.toISOString(),
  };
}

function upsertExpense(payload: Row): Expense {
  const current = requireSession(["owner", "manager"]);
  const id = payload.id ? String(payload.id) : uuid();
  const before = payload.id ? one(`${EXPENSE_SELECT} WHERE e.id = ? AND e.deleted_at IS NULL`, [id]) : null;
  if (payload.id && !before) fail("NOT_FOUND", "Saída de dinheiro não encontrada.");
  const values = expenseValues(payload, before);
  const now = nowIso();
  if (before) {
    run(
      `UPDATE expenses SET category = ?, description = ?, search_text = ?, amount_cents = ?, method = ?, reference = ?, note = ?, spent_at = ?, updated_at = ? WHERE id = ?`,
      [values.category, values.description, values.searchText, values.amountCents, values.method, values.reference, values.note, values.spentAt, now, id],
    );
  } else {
    run(
      `INSERT INTO expenses (id, category, description, search_text, amount_cents, method, reference, note, spent_at, user_id, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [id, values.category, values.description, values.searchText, values.amountCents, values.method, values.reference, values.note, values.spentAt, current.userId, now, now],
    );
  }
  const after = one(`${EXPENSE_SELECT} WHERE e.id = ?`, [id])!;
  audit(before ? "expense.updated" : "expense.created", "expense", id, before ? toExpense(before) : null, toExpense(after));
  return toExpense(after);
}

function deleteExpense(payload: Row): { id: string } {
  requireSession(["owner", "manager"]);
  const id = String(payload.id ?? "");
  const before = one(`${EXPENSE_SELECT} WHERE e.id = ? AND e.deleted_at IS NULL`, [id]);
  if (!before) fail("NOT_FOUND", "Saída de dinheiro não encontrada.");
  const now = nowIso();
  run("UPDATE expenses SET deleted_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
  audit("expense.deleted", "expense", id, toExpense(before), null);
  return { id };
}

function toProduct(row: Row): Product {
  return {
    id: String(row.id),
    sku: String(row.sku),
    name: String(row.name),
    color: String(row.color ?? ""),
    categoryId: row.category_id ? String(row.category_id) : null,
    categoryName: row.category_name ? String(row.category_name) : null,
    unit: String(row.unit) as Unit,
    priceCents: Number(row.price_cents ?? 0),
    packageQtyMilli: Number(row.package_qty_milli ?? 0),
    packagePriceCents: Number(row.package_price_cents ?? 0),
    halfPackagePriceCents: Number(row.half_package_price_cents ?? 0),
    sellByUnit: row.sell_by_unit === undefined ? true : toBool(row.sell_by_unit),
    sellByPackage: toBool(row.sell_by_package),
    sellByHalfPackage: toBool(row.sell_by_half_package),
    costCents: Number(row.cost_cents ?? 0),
    taxRateBp: Number(row.tax_rate_bp ?? 1600),
    trackStock: toBool(row.track_stock),
    stockOnHandMilli: Number(row.stock_on_hand_milli ?? 0),
    lowStockThresholdMilli: Number(row.low_stock_threshold_milli ?? 0),
    active: toBool(row.active),
    barcodes: row.barcodes ? String(row.barcodes).split(",").filter(Boolean) : [],
  };
}

function findStockImportProduct(sku: string, name: string, color: string): Row | null {
  const matches = rows(
    `SELECT id, active, track_stock, unit, price_cents, package_qty_milli,
            package_price_cents, half_package_price_cents, sell_by_unit,
            sell_by_package, sell_by_half_package
     FROM products
     WHERE deleted_at IS NULL
       AND sku = ? COLLATE NOCASE
       AND lower(trim(name)) = lower(trim(?))
       AND upper(trim(color)) = upper(trim(?))
     LIMIT 2`,
    [sku, name, color],
  );
  if (matches.length > 1) fail("IMPORT_AMBIGUOUS", `Há mais de um produto registado para ${sku} · ${name} · ${color}.`);
  return matches[0] ?? null;
}

/** Chave estável da factura: sem acentos, minúsculas e espaços colapsados. */
function normalizeDocumentRef(value: unknown): string {
  return norm(value).replace(/\s+/g, " ");
}

function findStockImportDocument(documentRef: unknown): Row | null {
  const key = normalizeDocumentRef(documentRef);
  if (!key) return null;
  return one("SELECT id, document_ref, created_at FROM stock_imports WHERE document_key = ? LIMIT 1", [key]) ?? null;
}

function checkStockImportDocument(documentRef: unknown): StockImportDocumentCheck {
  requireSession(["owner", "manager"]);
  const ref = String(documentRef ?? "").trim();
  if (!ref) return { exists: false, documentRef: null, createdAt: null };
  if (ref.length > 100) fail("VALIDATION", "O número da factura não pode exceder 100 caracteres.");
  const existing = findStockImportDocument(ref);
  return existing
    ? {
        exists: true,
        documentRef: String(existing.document_ref),
        createdAt: String(existing.created_at),
      }
    : { exists: false, documentRef: ref, createdAt: null };
}

function previewStockImport(rawItems: unknown): StockImportMatch[] {
  requireSession(["owner", "manager"]);
  if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > 500) {
    fail("IMPORT_INVALID", "O ficheiro deve conter entre 1 e 500 produtos.");
  }
  return (rawItems as Row[]).map((item) => {
    const sku = String(item.sku ?? "").trim();
    const name = String(item.name ?? "").trim();
    const color = String(item.color ?? "").trim();
    if (!sku || !name || !color) fail("IMPORT_INVALID", "Cada linha precisa de SKU, nome e cor.");
    const product = findStockImportProduct(sku, name, color);
    return product
      ? {
          productId: String(product.id),
          active: toBool(product.active),
          trackStock: toBool(product.track_stock),
          unit: String(product.unit) as Unit,
          priceCents: Number(product.price_cents),
          packageQtyMilli: Number(product.package_qty_milli ?? 0),
          packagePriceCents: Number(product.package_price_cents ?? 0),
          halfPackagePriceCents: Number(product.half_package_price_cents ?? 0),
          sellByUnit: toBool(product.sell_by_unit),
          sellByPackage: toBool(product.sell_by_package),
          sellByHalfPackage: toBool(product.sell_by_half_package),
        }
      : {
          productId: null,
          active: null,
          trackStock: null,
          unit: null,
          priceCents: null,
          packageQtyMilli: 0,
          packagePriceCents: 0,
          halfPackagePriceCents: 0,
          sellByUnit: false,
          sellByPackage: false,
          sellByHalfPackage: false,
        };
  });
}

function commitStockImport(payload: Row): StockImportCommitResult {
  const current = requireSession(["owner", "manager"]);
  const items = payload.items as StockImportCommitItem[];
  const exchangeRate = Number(payload.exchangeRate);
  if (!Array.isArray(items) || items.length === 0 || items.length > 500) {
    fail("IMPORT_INVALID", "O ficheiro deve conter entre 1 e 500 produtos.");
  }
  if (!Number.isFinite(exchangeRate) || exchangeRate <= 0 || exchangeRate > 100_000) {
    fail("VALIDATION", "Indique uma taxa de conversão Rand → MZN válida.");
  }

  const documentCheck = checkStockImportDocument(payload.documentRef);
  if (!documentCheck.documentRef) {
    fail("VALIDATION", "Indique o número da factura antes de confirmar a importação.");
  }
  if (documentCheck.exists) {
    fail(
      "DUPLICATE_DOCUMENT",
      `A factura ${documentCheck.documentRef} já foi importada a ${String(documentCheck.createdAt).slice(0, 10)}. Nenhum movimento foi gravado.`,
    );
  }
  const documentRef = documentCheck.documentRef;
  const seen = new Set<string>();
  const now = nowIso();
  let createdCount = 0;
  let totalQuantityMilli = 0;
  let totalCostCents = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    // Segunda barreira, agora dentro da transação: a factura não pode entrar
    // duas vezes mesmo que outro processo tenha gravado entretanto.
    if (findStockImportDocument(documentRef)) {
      fail("DUPLICATE_DOCUMENT", `A factura ${documentRef} já foi importada. Nenhum movimento foi gravado.`);
    }
    for (const raw of items) {
      const sku = String(raw.sku ?? "").trim();
      const name = String(raw.name ?? "").trim();
      const color = String(raw.color ?? "").trim();
      const qtyMilli = Math.trunc(Number(raw.qtyMilli));
      const purchaseCostMinor = Math.trunc(Number(raw.purchaseCostMinor));
      const valueMinor = Math.trunc(Number(raw.valueMinor));
      const lineCount = Math.trunc(Number(raw.lineCount));
      const salePriceCents = raw.salePriceCents === null || raw.salePriceCents === undefined
        ? null
        : Math.trunc(Number(raw.salePriceCents));
      const packageQtyMilli = Math.trunc(Number(raw.packageQtyMilli ?? 0));
      const packagePriceCents = Math.trunc(Number(raw.packagePriceCents ?? 0));
      const halfPackagePriceCents = Math.trunc(Number(raw.halfPackagePriceCents ?? 0));
      const hasPackageConfig = packageQtyMilli > 0 || packagePriceCents > 0 || halfPackagePriceCents > 0;
      const sellByUnit = raw.sellByUnit === undefined ? true : raw.sellByUnit === true;
      const sellByPackage = raw.sellByPackage === undefined ? hasPackageConfig : raw.sellByPackage === true;
      const sellByHalfPackage = raw.sellByHalfPackage === undefined ? hasPackageConfig : raw.sellByHalfPackage === true;
      if (!sku || sku.length > 100 || !name || name.length > 160 || !color || color.length > 60) {
        fail("IMPORT_INVALID", "Todos os produtos precisam de SKU, nome e cor válidos.");
      }
      if (!Number.isSafeInteger(qtyMilli) || qtyMilli <= 0 || qtyMilli % 1000 !== 0) {
        fail("IMPORT_INVALID", `A quantidade de ${sku} deve ser um número inteiro positivo.`);
      }
      if (!Number.isSafeInteger(purchaseCostMinor) || purchaseCostMinor < 0
        || !Number.isSafeInteger(valueMinor) || valueMinor < 0
        || !Number.isSafeInteger(lineCount) || lineCount < 1) {
        fail("IMPORT_INVALID", `Os valores da factura para ${sku} são inválidos.`);
      }
      if (salePriceCents !== null && (!Number.isSafeInteger(salePriceCents) || salePriceCents < 0)) {
        fail("IMPORT_INVALID", `O preço de venda de ${sku} é inválido.`);
      }
      if (![packageQtyMilli, packagePriceCents, halfPackagePriceCents].every(Number.isSafeInteger)
        || packageQtyMilli < 0 || packagePriceCents < 0 || halfPackagePriceCents < 0) {
        fail("IMPORT_INVALID", `A configuração de pacote para ${sku} é inválida.`);
      }
      if (!sellByUnit && !sellByPackage && !sellByHalfPackage) {
        fail("VALIDATION", `Seleccione pelo menos um formato de venda para ${sku}.`);
      }
      if (sellByPackage || sellByHalfPackage) {
        if (packageQtyMilli <= 0 || packageQtyMilli % 1000 !== 0) {
          fail("VALIDATION", `Indique um número inteiro positivo de unidades por pacote para ${sku}.`);
        }
        if (sellByHalfPackage && packageQtyMilli % 2000 !== 0) {
          fail("VALIDATION", `O pacote de ${sku} deve conter um número par de unidades para vender metade.`);
        }
        if (sellByPackage && packagePriceCents <= 0) {
          fail("VALIDATION", `Indique o preço do pacote para ${sku}.`);
        }
        if (sellByHalfPackage && halfPackagePriceCents <= 0) {
          fail("VALIDATION", `Indique o preço da meia embalagem para ${sku}.`);
        }
      }
      const key = `${norm(sku)}|${norm(name)}|${norm(color)}`;
      if (seen.has(key)) fail("IMPORT_INVALID", `O produto ${sku} · ${name} · ${color} aparece mais de uma vez na importação.`);
      seen.add(key);

      const purchaseTotalCents = Math.round(purchaseCostMinor * exchangeRate);
      const unitCostCents = Math.round((purchaseTotalCents * 1000) / qtyMilli);
      if (!Number.isSafeInteger(purchaseTotalCents) || !Number.isSafeInteger(unitCostCents)) {
        fail("IMPORT_INVALID", `O custo convertido para ${sku} excede o limite permitido.`);
      }
      const product = findStockImportProduct(sku, name, color);
      // Produto inactivo ou sem controlo de stock é reactivado mais abaixo: o
      // facto de existir não pode impedir a entrada de uma nova factura.
      // A unidade, por outro lado, não é convertida sem confirmação explícita.
      if (product && String(product.unit) !== "un") {
        fail(
          "IMPORT_CONFLICT",
          `O produto ${sku} · ${color} existe com a unidade ${String(product.unit)}. A importação Excel só aceita produtos em unidades; crie uma variante própria ou corrija o produto.`,
        );
      }
      const unitPriceCents = Number(product?.price_cents ?? 0) > 0 ? Number(product?.price_cents) : salePriceCents ?? 0;
      if (sellByUnit && unitPriceCents <= 0) {
        fail("VALIDATION", `Indique o preço por unidade para ${sku} · ${color}, ou desactive a venda por unidade.`);
      }

      let productId: string;
      let stockBefore: number;
      if (product) {
        productId = String(product.id);
        const stored = one("SELECT stock_on_hand_milli FROM products WHERE id = ?", [productId]);
        stockBefore = Number(stored?.stock_on_hand_milli ?? 0);
        const beforeConfig = {
          priceCents: Number(product.price_cents),
          packageQtyMilli: Number(product.package_qty_milli ?? 0),
          packagePriceCents: Number(product.package_price_cents ?? 0),
          halfPackagePriceCents: Number(product.half_package_price_cents ?? 0),
          sellByUnit: toBool(product.sell_by_unit),
          sellByPackage: toBool(product.sell_by_package),
          sellByHalfPackage: toBool(product.sell_by_half_package),
        };
        const afterConfig = {
          priceCents: beforeConfig.priceCents > 0 ? beforeConfig.priceCents : sellByUnit ? salePriceCents ?? 0 : 0,
          packageQtyMilli,
          packagePriceCents,
          halfPackagePriceCents,
          sellByUnit,
          sellByPackage,
          sellByHalfPackage,
        };
        run(
          `UPDATE products SET cost_cents = ?, price_cents = CASE WHEN price_cents <= 0 AND ? = 1 THEN ? ELSE price_cents END,
             package_qty_milli = ?, package_price_cents = ?, half_package_price_cents = ?,
             sell_by_unit = ?, sell_by_package = ?, sell_by_half_package = ?,
             active = 1, track_stock = 1,
             stock_on_hand_milli = ?, updated_at = ? WHERE id = ?`,
          [
            unitCostCents,
            sellByUnit ? 1 : 0,
            salePriceCents ?? 0,
            packageQtyMilli,
            packagePriceCents,
            halfPackagePriceCents,
            sellByUnit ? 1 : 0,
            sellByPackage ? 1 : 0,
            sellByHalfPackage ? 1 : 0,
            stockBefore + qtyMilli,
            now,
            productId,
          ],
        );
        const wasActive = toBool(product.active);
        const wasTracking = toBool(product.track_stock);
        if (!wasActive || !wasTracking) {
          audit(
            "product.reactivated",
            "product",
            productId,
            { active: wasActive, trackStock: wasTracking },
            { active: true, trackStock: true, documentRef },
            current.userId,
          );
        }
        const packageConfigChanged = beforeConfig.priceCents !== afterConfig.priceCents
          || beforeConfig.packageQtyMilli !== afterConfig.packageQtyMilli
          || beforeConfig.packagePriceCents !== afterConfig.packagePriceCents
          || beforeConfig.halfPackagePriceCents !== afterConfig.halfPackagePriceCents
          || beforeConfig.sellByUnit !== afterConfig.sellByUnit
          || beforeConfig.sellByPackage !== afterConfig.sellByPackage
          || beforeConfig.sellByHalfPackage !== afterConfig.sellByHalfPackage;
        if (packageConfigChanged) {
          audit("product.updated", "product", productId, beforeConfig, afterConfig, current.userId);
        }
      } else {
        productId = uuid();
        stockBefore = 0;
        const searchText = norm(`${name} ${sku} ${color}`);
        run(
          `INSERT INTO products (
            id, sku, name, color, search_text, category_id, unit, price_cents,
            package_qty_milli, package_price_cents, half_package_price_cents,
            sell_by_unit, sell_by_package, sell_by_half_package, cost_cents, tax_rate_bp,
            track_stock, stock_on_hand_milli, low_stock_threshold_milli, active, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, NULL, 'un', ?, ?, ?, ?, ?, ?, ?, ?, 1600, 1, ?, 0, 1, ?, ?)`,
          [
            productId,
            sku,
            name,
            color,
            searchText,
            sellByUnit ? salePriceCents ?? 0 : 0,
            packageQtyMilli,
            packagePriceCents,
            halfPackagePriceCents,
            sellByUnit ? 1 : 0,
            sellByPackage ? 1 : 0,
            sellByHalfPackage ? 1 : 0,
            unitCostCents,
            qtyMilli,
            now,
            now,
          ],
        );
        createdCount += 1;
        audit(
          "product.created",
          "product",
          productId,
          null,
          {
            sku,
            name,
            color,
            unit: "un",
            packageQtyMilli,
            packagePriceCents,
            halfPackagePriceCents,
            sellByUnit,
            sellByPackage,
            sellByHalfPackage,
          },
          current.userId,
        );
      }

      run(
        `INSERT INTO stock_movements (
          id, product_id, type, qty_milli, balance_after_milli, unit_cost_cents, supplier_id,
          supplier_name_snapshot, document_ref, reason, sale_id, user_id, created_at
        ) VALUES (?, ?, 'purchase_in', ?, ?, ?, NULL, NULL, ?, ?, NULL, ?, ?)`,
        [
          uuid(),
          productId,
          qtyMilli,
          stockBefore + qtyMilli,
          unitCostCents,
          documentRef,
          `Importação Excel (${lineCount} linha(s); câmbio R→MZN ${exchangeRate})`,
          current.userId,
          now,
        ],
      );
      audit(
        "stock.imported",
        "product",
        productId,
        { stock: stockBefore },
        { stock: stockBefore + qtyMilli, qtyMilli, unitCostCents, purchaseCostMinor, valueMinor, exchangeRate, documentRef },
        current.userId,
      );
      totalQuantityMilli += qtyMilli;
      totalCostCents += purchaseTotalCents;
      if (!Number.isSafeInteger(totalQuantityMilli) || !Number.isSafeInteger(totalCostCents)) {
        fail("IMPORT_INVALID", "Os totais da importação excedem o limite permitido.");
      }
    }
    const importId = uuid();
    run(
      `INSERT INTO stock_imports (
         id, document_ref, document_key, product_count, quantity_milli,
         total_cost_cents, exchange_rate, user_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        importId,
        documentRef,
        normalizeDocumentRef(documentRef),
        items.length,
        totalQuantityMilli,
        totalCostCents,
        exchangeRate,
        current.userId,
        now,
      ],
    );
    audit(
      "stock.import.document",
      "stock_import",
      importId,
      null,
      { documentRef, productCount: items.length, quantityMilli: totalQuantityMilli, totalCostCents, exchangeRate },
      current.userId,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    if (String(error).includes("UNIQUE")) {
      if (String(error).includes("stock_imports")) {
        fail("DUPLICATE_DOCUMENT", `A factura ${documentRef} já foi importada. Nenhum movimento foi gravado.`);
      }
      fail("DUPLICATE", "Já existe um produto com o mesmo SKU, nome e cor.");
    }
    throw error;
  }
  return {
    documentRef,
    productCount: items.length,
    createdCount,
    quantityMilli: totalQuantityMilli,
    totalCostCents,
  };
}

function productRows(where = "", bind: unknown[] = []): Row[] {
  return rows(
    `SELECT p.*, c.name AS category_name,
       (SELECT group_concat(barcode, ',') FROM product_barcodes WHERE product_id = p.id) AS barcodes
     FROM products p LEFT JOIN categories c ON c.id = p.category_id
     ${where}`,
    bind,
  );
}

function productFilter(payload: Row): { where: string; bind: unknown[]; query: string } {
  const query = norm(payload.query);
  const categoryId = payload.categoryId ? String(payload.categoryId) : null;
  const bind: unknown[] = [];
  let where = "WHERE p.deleted_at IS NULL";
  if (payload.activeOnly !== false) where += " AND p.active = 1";
  if (categoryId) {
    where += " AND p.category_id = ?";
    bind.push(categoryId);
  }
  if (payload.trackStockOnly === true) where += " AND p.track_stock = 1";
  if (query) {
    // Cada termo da pesquisa pode corresponder a um atributo diferente.
    // Assim "rose red" encontra um produto com nome "Rose" e cor "Red".
    const terms = query.split(/\s+/).filter(Boolean);
    for (const term of terms) {
      where += " AND (p.search_text LIKE ? OR p.sku LIKE ? OR lower(p.color) LIKE ? OR lower(c.name) LIKE ? OR EXISTS (SELECT 1 FROM product_barcodes b WHERE b.product_id = p.id AND b.barcode LIKE ?))";
      bind.push(`%${term}%`, `%${term}%`, `%${term}%`, `%${term}%`, `%${term}%`);
    }
  }
  return { where, bind, query };
}

function paginationInput(payload: Row, defaultPageSize = 25): { page: number; pageSize: number } {
  const requestedPage = Math.trunc(Number(payload.page ?? 1));
  const requestedPageSize = Math.trunc(Number(payload.pageSize ?? defaultPageSize));
  return {
    page: Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1,
    pageSize: Number.isSafeInteger(requestedPageSize)
      ? Math.min(100, Math.max(1, requestedPageSize))
      : defaultPageSize,
  };
}

function resolvePage(page: number, pageSize: number, total: number): number {
  return Math.min(page, Math.max(1, Math.ceil(total / pageSize)));
}

function lowStockProducts(): Product[] {
  return productRows(
    "WHERE p.deleted_at IS NULL AND p.active = 1 AND p.track_stock = 1 AND p.low_stock_threshold_milli > 0 AND p.stock_on_hand_milli <= p.low_stock_threshold_milli ORDER BY p.name LIMIT 100",
  ).map(toProduct);
}

function roundHalfUp(value: number): number {
  return Math.round(value);
}

function distribute(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (total <= 0 || sum <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const base = raw.map((v) => Math.floor(v));
  const remainder = total - base.reduce((a, b) => a + b, 0);
  const order = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < remainder; k += 1) base[order[k % order.length].i] += 1;
  return base;
}

function buildQuote(payload: QuoteInput, currentSession: NonNullable<typeof session>): Quote {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (items.length === 0) fail("CART_EMPTY", "O carrinho está vazio.");
  const settings = getSettings();
  const taxApplied = payload.applyTax === true;

  const ids = [...new Set(items.map((item) => String(item.productId)))];
  const placeholders = ids.map(() => "?").join(",");
  const map = new Map<string, Row>();
  for (const row of rows(`SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id IN (${placeholders}) AND p.deleted_at IS NULL`, ids)) {
    map.set(String(row.id), row);
  }

  const gross: number[] = [];
  const netBefore: number[] = [];
  const lineDiscounts: number[] = [];
  const baseLines: QuoteLine[] = [];
  const warnings: string[] = [];
  let approvalReason: string | null = null;

  for (const raw of items) {
    const item = raw as CartItemInput;
    const row = map.get(String(item.productId));
    if (!row) fail("PRODUCT_NOT_FOUND", "Um dos produtos já não existe.");
    if (!toBool(row.active)) fail("PRODUCT_INACTIVE", `O produto ${row.name} está inactivo.`);
    const saleQtyMilli = Math.trunc(Number(item.qtyMilli));
    if (!Number.isSafeInteger(saleQtyMilli) || saleQtyMilli <= 0) fail("QTY_INVALID", "As quantidades têm de ser positivas.");
    const saleUnit = (item.saleUnit ?? "unit") as SaleUnit;
    if (saleUnit !== "unit" && saleQtyMilli % 1000 !== 0) {
      fail("QTY_INVALID", "A quantidade de pacotes tem de ser um número inteiro.");
    }
    if (saleUnit === "unit" && ["un", "cx", "pct"].includes(String(row.unit)) && saleQtyMilli % 1000 !== 0) {
      fail("QTY_INVALID", "A quantidade tem de ser um número inteiro para esta unidade.");
    }
    const packageQtyMilli = Number(row.package_qty_milli ?? 0);
    let stockQtyMilli = saleQtyMilli;
    let unitPrice: number;
    if (saleUnit === "unit") {
      if (row.package_qty_milli && !toBool(row.sell_by_unit)) fail("SALE_UNIT_INVALID", `A venda por unidade não está activa para ${row.name}.`);
      unitPrice = Number(row.price_cents ?? 0);
    } else {
      if (packageQtyMilli <= 0) fail("SALE_UNIT_INVALID", `O produto ${row.name} não tem um pacote configurado.`);
      const factorMilli = saleUnit === "package" ? packageQtyMilli : saleUnit === "half_package" ? packageQtyMilli / 2 : 0;
      if (factorMilli <= 0 || !Number.isInteger(factorMilli)) {
        fail("SALE_UNIT_INVALID", `A conversão de ${row.name} não permite esta quantidade de venda.`);
      }
      if (saleUnit === "package" && !toBool(row.sell_by_package)) fail("SALE_UNIT_INVALID", `A venda por pacote não está activa para ${row.name}.`);
      if (saleUnit === "half_package" && !toBool(row.sell_by_half_package)) fail("SALE_UNIT_INVALID", `A venda por meia embalagem não está activa para ${row.name}.`);
      const stockQty = (saleQtyMilli * factorMilli) / 1000;
      if (!Number.isSafeInteger(stockQty) || stockQty <= 0) fail("QTY_INVALID", "A quantidade convertida para stock é inválida.");
      stockQtyMilli = stockQty;
      unitPrice = Number(saleUnit === "package" ? row.package_price_cents : row.half_package_price_cents);
    }
    if (!Number.isSafeInteger(unitPrice) || unitPrice <= 0) {
      fail("PRICE_INVALID", `O preço do formato seleccionado para ${row.name} não está configurado.`);
    }
    const grossLine = roundHalfUp((unitPrice * saleQtyMilli) / 1000);
    const lineDiscount = Math.min(Math.max(0, Math.trunc(Number(item.lineDiscountCents ?? 0))), grossLine);
    const net = grossLine - lineDiscount;
    gross.push(grossLine);
    netBefore.push(net);
    lineDiscounts.push(lineDiscount);
    baseLines.push({
      productId: String(row.id),
      name: row.color ? `${row.name} · ${row.color}` : String(row.name),
      sku: String(row.sku),
      unit: String(row.unit) as Unit,
      saleUnit,
      unitPriceCents: unitPrice,
      saleQtyMilli,
      qtyMilli: stockQtyMilli,
      grossCents: grossLine,
      lineDiscountCents: lineDiscount,
      orderDiscountCents: 0,
      baseCents: 0,
      taxCents: 0,
      totalCents: net,
      taxRateBp: Number(row.tax_rate_bp ?? 1600),
      trackStock: toBool(row.track_stock),
      stockOnHandMilli: Number(row.stock_on_hand_milli ?? 0),
    });

    if (toBool(row.track_stock) && Number(row.stock_on_hand_milli ?? 0) < stockQtyMilli) {
      if (!settings.allowNegativeStock) {
        approvalReason = approvalReason ?? `Stock insuficiente para ${row.name}.`;
      } else {
        warnings.push(`${row.name} vai ficar com stock negativo.`);
      }
    }
  }

  const subtotal = gross.reduce((a, b) => a + b, 0);
  const netSum = netBefore.reduce((a, b) => a + b, 0);
  let orderDiscount = Math.max(0, Math.trunc(Number(payload.orderDiscountCents ?? 0)));
  orderDiscount = Math.min(orderDiscount, netSum);
  const allocated = distribute(orderDiscount, netBefore);

  const lines: QuoteLine[] = baseLines.map((line, index) => {
    const base = netBefore[index] - allocated[index];
    const tax = taxApplied ? roundHalfUp((base * line.taxRateBp) / 10000) : 0;
    return {
      ...line,
      orderDiscountCents: allocated[index],
      baseCents: base,
      taxCents: tax,
      totalCents: base + tax,
    };
  });

  const discount = lineDiscounts.reduce((a, b) => a + b, 0) + orderDiscount;
  const total = lines.reduce((a, b) => a + b.totalCents, 0);
  const tax = lines.reduce((a, b) => a + b.taxCents, 0);

  if (discount > 0) {
    if (settings.discountApprovalMode === "always") {
      approvalReason = approvalReason ?? "Desconto exige aprovação de um gerente ou proprietário.";
    } else if (
      settings.discountApprovalMode === "above_limit"
      && currentSession.role === "cashier"
      && subtotal > 0
    ) {
      const maxDiscount = roundHalfUp((subtotal * settings.maxCashierDiscountBp) / 10000);
      if (discount > maxDiscount) approvalReason = approvalReason ?? "Desconto acima do limite do caixa.";
    }
  }
  if (settings.discountApprovalMode !== "never") {
    if (subtotal > 0 && total === 0) approvalReason = approvalReason ?? "Venda com total zero.";
    if (lines.some((line) => line.grossCents > 0 && line.totalCents === 0)) {
      approvalReason = approvalReason ?? "Item gratuito.";
    }
  }

  return {
    lines,
    subtotalCents: subtotal,
    discountCents: discount,
    taxCents: tax,
    taxApplied,
    totalCents: total,
    requiresApproval: approvalReason !== null,
    approvalReason,
    warnings,
  };
}

const PAYMENT_METHODS: PaymentMethod[] = ["cash", "card", "pos", "mpesa", "emola", "transfer", "other"];

/** Saldo em dívida de uma venda, reutilizado em listagens e filtros. */
const SALE_OUTSTANDING_SQL = `CASE WHEN s.status = 'completed' AND s.is_credit = 1
  THEN MAX(0, s.total_cents - s.paid_cents - COALESCE((SELECT SUM(amount_cents) FROM sale_settlements WHERE sale_id = s.id), 0))
  ELSE 0 END`;

/** Colunas de crédito devolvidas nas listagens de clientes (alias `c`). */
const CUSTOMER_CREDIT_COLUMNS = `,
  COALESCE((SELECT SUM(MAX(0, s.total_cents - s.paid_cents - COALESCE((SELECT SUM(ss.amount_cents) FROM sale_settlements ss WHERE ss.sale_id = s.id), 0)))
            FROM sales s WHERE s.customer_id = c.id AND s.is_credit = 1 AND s.status = 'completed'), 0) AS credit_balance_cents,
  (SELECT COUNT(*) FROM sales s WHERE s.customer_id = c.id AND s.is_credit = 1 AND s.status = 'completed') AS credit_sale_count`;

function validatePayments(payments: PaymentInput[], total: number, isCredit = false): { payments: PaymentInput[]; paid: number; change: number } {
  if (!Array.isArray(payments)) fail("PAYMENT_INVALID", "Os pagamentos são inválidos.");
  if (!isCredit && payments.length === 0) fail("PAYMENT_REQUIRED", "Indique pelo menos um pagamento.");
  const cash = payments.filter((p) => p.method === "cash");
  if (cash.length > 1) fail("PAYMENT_INVALID", "Só pode existir uma linha de dinheiro.");
  let paid = 0;
  let change = 0;
  const normalized = payments.map((p) => {
    if (!PAYMENT_METHODS.includes(p.method)) fail("PAYMENT_INVALID", "Método de pagamento inválido.");
    const amount = Math.trunc(Number(p.amountCents));
    if (!Number.isFinite(amount) || amount <= 0) fail("PAYMENT_INVALID", "O valor do pagamento tem de ser positivo.");
    paid += amount;
    let tendered = amount;
    if (p.method === "cash") {
      tendered = Math.trunc(Number(p.tenderedCents ?? amount));
      if (!Number.isFinite(tendered) || tendered < amount) fail("PAYMENT_INVALID", "O valor entregue é inferior ao valor em dinheiro.");
      change += tendered - amount;
    }
    return { ...p, amountCents: amount, tenderedCents: tendered, reference: p.reference ? String(p.reference).slice(0, 100) : undefined };
  });
  if (isCredit) {
    if (paid > total) fail("PAYMENT_MISMATCH", `O valor pago agora (${(paid / 100).toFixed(2)} MZN) não pode ser superior ao total (${(total / 100).toFixed(2)} MZN).`);
  } else if (paid !== total) {
    fail("PAYMENT_MISMATCH", `Os pagamentos somam ${(paid / 100).toFixed(2)} MZN e o total é ${(total / 100).toFixed(2)} MZN.`);
  }
  return { payments: normalized, paid, change };
}

function consumeApproval(token: string | null | undefined, action: string, amountCents?: number): void {
  if (!token) fail("APPROVAL_REQUIRED", "Esta operação exige aprovação de gerente ou proprietário.");
  const row = one("SELECT * FROM approvals WHERE id = ? AND used_at IS NULL", [token]);
  if (!row) fail("APPROVAL_INVALID", "A aprovação é inválida ou já foi usada.");
  if (new Date(String(row.expires_at)).getTime() < Date.now()) fail("APPROVAL_EXPIRED", "A aprovação expirou. Peça novamente.");
  if (String(row.action) !== action) fail("APPROVAL_INVALID", "A aprovação não corresponde a esta acção.");
  if (typeof amountCents === "number" && row.amount_cents !== null && Number(row.amount_cents) < amountCents) {
    fail("APPROVAL_INVALID", "A aprovação não cobre este valor.");
  }
  run("UPDATE approvals SET used_at = ? WHERE id = ?", [nowIso(), token]);
}

function toSale(id: string): Sale | null {
  const sale = one("SELECT * FROM sales WHERE id = ?", [id]);
  if (!sale) return null;
  const items = rows("SELECT * FROM sale_items WHERE sale_id = ? ORDER BY rowid", [id]).map((row) => ({
    id: String(row.id),
    productId: String(row.product_id),
    nameSnapshot: String(row.name_snapshot),
    skuSnapshot: String(row.sku_snapshot ?? ""),
    unit: String(row.unit) as Unit,
    saleUnit: String(row.sale_unit ?? "unit") as SaleUnit,
    unitPriceCents: Number(row.unit_price_cents),
    saleQtyMilli: Number(row.sale_qty_milli ?? row.qty_milli),
    qtyMilli: Number(row.qty_milli),
    grossCents: Number(row.gross_cents),
    lineDiscountCents: Number(row.line_discount_cents),
    orderDiscountCents: Number(row.order_discount_cents),
    taxRateBp: Number(row.tax_rate_bp),
    baseCents: Number(row.base_cents),
    taxCents: Number(row.tax_cents),
    totalCents: Number(row.total_cents),
  })) satisfies SaleItem[];
  const payments = rows("SELECT * FROM sale_payments WHERE sale_id = ? ORDER BY rowid", [id]).map((row) => ({
    id: String(row.id),
    method: String(row.method) as PaymentMethod,
    amountCents: Number(row.amount_cents),
    tenderedCents: Number(row.tendered_cents),
    reference: row.reference ? String(row.reference) : null,
  })) satisfies SalePayment[];
  const settlements = rows(
    `SELECT ss.*, u.display_name AS user_name FROM sale_settlements ss
     LEFT JOIN users u ON u.id = ss.user_id WHERE ss.sale_id = ? ORDER BY ss.created_at, ss.rowid`,
    [id],
  ).map((row) => ({
    id: String(row.id),
    amountCents: Number(row.amount_cents),
    method: String(row.method) as PaymentMethod,
    reference: row.reference ? String(row.reference) : null,
    note: row.note ? String(row.note) : null,
    userName: row.user_name ? String(row.user_name) : null,
    createdAt: String(row.created_at),
  })) satisfies SaleSettlement[];
  const isCredit = toBool(sale.is_credit);
  const settledCents = Number(sale.paid_cents) + settlements.reduce((sum, item) => sum + item.amountCents, 0);
  const outstandingCents = isCredit && sale.status === "completed" ? Math.max(0, Number(sale.total_cents) - settledCents) : 0;
  return {
    id: String(sale.id),
    receiptNumber: String(sale.receipt_number),
    status: sale.status as "completed" | "voided",
    cashierName: String(sale.cashier_name_snapshot ?? ""),
    customerName: sale.customer_name_snapshot ? String(sale.customer_name_snapshot) : null,
    customerNif: sale.customer_nif_snapshot ? String(sale.customer_nif_snapshot) : null,
    subtotalCents: Number(sale.subtotal_cents),
    discountCents: Number(sale.discount_cents),
    taxCents: Number(sale.tax_cents),
    taxApplied: toBool(sale.tax_applied),
    totalCents: Number(sale.total_cents),
    paidCents: Number(sale.paid_cents),
    changeCents: Number(sale.change_cents),
    isCredit,
    settledCents,
    outstandingCents,
    settlements,
    note: sale.note ? String(sale.note) : null,
    createdAt: String(sale.created_at),
    voidedAt: sale.voided_at ? String(sale.voided_at) : null,
    voidReason: sale.void_reason ? String(sale.void_reason) : null,
    items,
    payments,
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','manager','cashier')),
  active INTEGER NOT NULL DEFAULT 1,
  pin_hash TEXT NOT NULL,
  pin_salt TEXT NOT NULL,
  pin_iterations INTEGER NOT NULL,
  pin_algo TEXT NOT NULL DEFAULT 'PBKDF2-SHA-256',
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  must_change_pin INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT,
  login_shortcut INTEGER CHECK (login_shortcut BETWEEN 1 AND 9),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  iterations INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT,
  rotated_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  store_name TEXT NOT NULL,
  nif TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT 'MZN',
  tax_rate_bp INTEGER NOT NULL DEFAULT 1600,
  receipt_footer TEXT NOT NULL DEFAULT '',
  installation_code TEXT NOT NULL,
  allow_negative_stock INTEGER NOT NULL DEFAULT 1,
  max_cashier_discount_bp INTEGER NOT NULL DEFAULT 500,
  discount_approval_mode TEXT NOT NULL DEFAULT 'above_limit' CHECK (discount_approval_mode IN ('never','above_limit','always')),
  idle_lock_seconds INTEGER NOT NULL DEFAULT 300,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '',
  search_text TEXT NOT NULL DEFAULT '',
  category_id TEXT,
  unit TEXT NOT NULL DEFAULT 'un',
  price_cents INTEGER NOT NULL DEFAULT 0,
  package_qty_milli INTEGER NOT NULL DEFAULT 0,
  package_price_cents INTEGER NOT NULL DEFAULT 0,
  half_package_price_cents INTEGER NOT NULL DEFAULT 0,
  sell_by_unit INTEGER NOT NULL DEFAULT 1,
  sell_by_package INTEGER NOT NULL DEFAULT 0,
  sell_by_half_package INTEGER NOT NULL DEFAULT 0,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  tax_rate_bp INTEGER NOT NULL DEFAULT 1600,
  track_stock INTEGER NOT NULL DEFAULT 1,
  stock_on_hand_milli INTEGER NOT NULL DEFAULT 0,
  low_stock_threshold_milli INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS product_barcodes (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  barcode TEXT NOT NULL UNIQUE,
  is_primary INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  phone_normalized TEXT NOT NULL DEFAULT '',
  alt_phone TEXT NOT NULL DEFAULT '',
  nif TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  contact_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  nif TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  type TEXT NOT NULL,
  qty_milli INTEGER NOT NULL,
  balance_after_milli INTEGER NOT NULL,
  unit_cost_cents INTEGER,
  supplier_id TEXT,
  supplier_name_snapshot TEXT,
  document_ref TEXT,
  reason TEXT,
  sale_id TEXT,
  user_id TEXT,
  created_at TEXT NOT NULL
);

-- Registo de facturas já importadas por Excel. document_key é a referência
-- normalizada (sem acentos, minúsculas, espaços colapsados) usada para bloquear
-- importações repetidas da mesma factura.
CREATE TABLE IF NOT EXISTS stock_imports (
  id TEXT PRIMARY KEY,
  document_ref TEXT NOT NULL,
  document_key TEXT NOT NULL UNIQUE,
  product_count INTEGER NOT NULL,
  quantity_milli INTEGER NOT NULL,
  total_cost_cents INTEGER NOT NULL,
  exchange_rate REAL NOT NULL,
  user_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY,
  receipt_number TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('completed','voided')),
  cashier_id TEXT NOT NULL,
  cashier_name_snapshot TEXT NOT NULL,
  customer_id TEXT,
  customer_name_snapshot TEXT,
  customer_nif_snapshot TEXT,
  subtotal_cents INTEGER NOT NULL,
  discount_cents INTEGER NOT NULL,
  tax_cents INTEGER NOT NULL,
  tax_applied INTEGER NOT NULL DEFAULT 0 CHECK (tax_applied IN (0,1)),
  total_cents INTEGER NOT NULL,
  paid_cents INTEGER NOT NULL,
  change_cents INTEGER NOT NULL,
  is_credit INTEGER NOT NULL DEFAULT 0 CHECK (is_credit IN (0,1)),
  note TEXT,
  created_at TEXT NOT NULL,
  voided_at TEXT,
  voided_by TEXT,
  void_reason TEXT
);

CREATE TABLE IF NOT EXISTS sale_items (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  name_snapshot TEXT NOT NULL,
  sku_snapshot TEXT NOT NULL DEFAULT '',
  barcode_snapshot TEXT,
  unit TEXT NOT NULL,
  sale_unit TEXT NOT NULL DEFAULT 'unit',
  unit_price_cents INTEGER NOT NULL,
  sale_qty_milli INTEGER NOT NULL DEFAULT 1000,
  qty_milli INTEGER NOT NULL,
  gross_cents INTEGER NOT NULL,
  line_discount_cents INTEGER NOT NULL DEFAULT 0,
  order_discount_cents INTEGER NOT NULL DEFAULT 0,
  tax_rate_bp INTEGER NOT NULL,
  base_cents INTEGER NOT NULL,
  tax_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sale_payments (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('cash','card','pos','mpesa','emola','transfer','other')),
  amount_cents INTEGER NOT NULL,
  tendered_cents INTEGER NOT NULL,
  reference TEXT,
  created_at TEXT NOT NULL
);

-- Regularizações posteriores de vendas a prazo. Os pagamentos iniciais
-- continuam em sale_payments para não inflacionar o mix de pagamentos.
CREATE TABLE IF NOT EXISTS sale_settlements (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('cash','card','pos','mpesa','emola','transfer','other')),
  reference TEXT,
  note TEXT,
  user_id TEXT,
  created_at TEXT NOT NULL
);

-- Saídas de dinheiro (despesas ou qualquer outra finalidade). Não alteram stock.
CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN ('compras','transporte','utilidades','salarios','aluguer','manutencao','impostos','marketing','outros')),
  description TEXT NOT NULL,
  search_text TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  method TEXT NOT NULL CHECK (method IN ('cash','card','pos','mpesa','emola','transfer','other')),
  reference TEXT,
  note TEXT,
  spent_at TEXT NOT NULL,
  user_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  amount_cents INTEGER,
  requested_by TEXT NOT NULL,
  approver_id TEXT NOT NULL,
  self_approved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL,
  device_info TEXT
);

CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS backup_log (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  method TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  note TEXT,
  schema_version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_login_shortcut ON users(login_shortcut) WHERE login_shortcut IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_variant ON products(sku COLLATE NOCASE, name COLLATE NOCASE, color COLLATE NOCASE) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_products_search ON products(search_text);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(active, deleted_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_barcodes_value ON product_barcodes(barcode);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone_normalized);
CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name);
CREATE INDEX IF NOT EXISTS idx_suppliers_name ON suppliers(name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_receipt ON sales(receipt_number);
CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);
CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_id);
CREATE INDEX IF NOT EXISTS idx_sales_status ON sales(status);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_product_date ON stock_movements(product_id, created_at);
CREATE INDEX IF NOT EXISTS idx_stock_sale ON stock_movements(sale_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_imports_key ON stock_imports(document_key);
CREATE INDEX IF NOT EXISTS idx_stock_imports_created ON stock_imports(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id);
CREATE INDEX IF NOT EXISTS idx_approvals_pending ON approvals(expires_at, used_at);
CREATE INDEX IF NOT EXISTS idx_sale_settlements_sale ON sale_settlements(sale_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sales_credit ON sales(is_credit, status, customer_id);
CREATE INDEX IF NOT EXISTS idx_expenses_spent ON expenses(spent_at);
CREATE INDEX IF NOT EXISTS idx_expenses_search ON expenses(search_text);
`;

async function migrate(): Promise<void> {
  const version = Number(one("PRAGMA user_version")?.user_version ?? 0);
  if (version > SCHEMA_VERSION) fail("SCHEMA_TOO_NEW", "A base foi criada por uma versão mais recente da aplicação.");
  if (version === 0) {
    db.exec(SCHEMA);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    run("INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?, ?)", [SCHEMA_VERSION, nowIso()]);
    return;
  }
  if (version === 1) {
    const backup = (sqlite3.capi.sqlite3_js_db_export(db.pointer) as Uint8Array).slice();
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
    await writeBackupFile(`pre-migrate-v${version}-${stamp}.db`, backup);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        ALTER TABLE products ADD COLUMN package_qty_milli INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE products ADD COLUMN package_price_cents INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE products ADD COLUMN half_package_price_cents INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE products ADD COLUMN sell_by_unit INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE products ADD COLUMN sell_by_package INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE products ADD COLUMN sell_by_half_package INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE sale_items ADD COLUMN sale_unit TEXT NOT NULL DEFAULT 'unit';
        ALTER TABLE sale_items ADD COLUMN sale_qty_milli INTEGER NOT NULL DEFAULT 1000;
        UPDATE sale_items SET sale_qty_milli = qty_milli;
      `);
      db.exec("PRAGMA user_version = 2");
      run("INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?, ?)", [2, nowIso()]);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  if (Number(one("PRAGMA user_version")?.user_version ?? 0) === 2) {
    const backup = (sqlite3.capi.sqlite3_js_db_export(db.pointer) as Uint8Array).slice();
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
    await writeBackupFile(`pre-migrate-v2-${stamp}.db`, backup);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        ALTER TABLE sales ADD COLUMN tax_applied INTEGER NOT NULL DEFAULT 1 CHECK (tax_applied IN (0,1));
        ALTER TABLE sale_payments RENAME TO sale_payments_v2;
        CREATE TABLE sale_payments (
          id TEXT PRIMARY KEY,
          sale_id TEXT NOT NULL,
          method TEXT NOT NULL CHECK (method IN ('cash','card','pos','mpesa','emola','transfer','other')),
          amount_cents INTEGER NOT NULL,
          tendered_cents INTEGER NOT NULL,
          reference TEXT,
          created_at TEXT NOT NULL
        );
        INSERT INTO sale_payments (id, sale_id, method, amount_cents, tendered_cents, reference, created_at)
          SELECT id, sale_id, method, amount_cents, tendered_cents, reference, created_at
          FROM sale_payments_v2 ORDER BY rowid;
        DROP TABLE sale_payments_v2;
      `);
      db.exec("PRAGMA user_version = 3");
      run("INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?, ?)", [3, nowIso()]);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  if (Number(one("PRAGMA user_version")?.user_version ?? 0) === 3) {
    const backup = (sqlite3.capi.sqlite3_js_db_export(db.pointer) as Uint8Array).slice();
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
    await writeBackupFile(`pre-migrate-v3-${stamp}.db`, backup);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        CREATE TABLE products_v4 (
          id TEXT PRIMARY KEY,
          sku TEXT NOT NULL,
          name TEXT NOT NULL,
          color TEXT NOT NULL DEFAULT '',
          search_text TEXT NOT NULL DEFAULT '',
          category_id TEXT,
          unit TEXT NOT NULL DEFAULT 'un',
          price_cents INTEGER NOT NULL DEFAULT 0,
          package_qty_milli INTEGER NOT NULL DEFAULT 0,
          package_price_cents INTEGER NOT NULL DEFAULT 0,
          half_package_price_cents INTEGER NOT NULL DEFAULT 0,
          sell_by_unit INTEGER NOT NULL DEFAULT 1,
          sell_by_package INTEGER NOT NULL DEFAULT 0,
          sell_by_half_package INTEGER NOT NULL DEFAULT 0,
          cost_cents INTEGER NOT NULL DEFAULT 0,
          tax_rate_bp INTEGER NOT NULL DEFAULT 1600,
          track_stock INTEGER NOT NULL DEFAULT 1,
          stock_on_hand_milli INTEGER NOT NULL DEFAULT 0,
          low_stock_threshold_milli INTEGER NOT NULL DEFAULT 0,
          active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT
        );
        INSERT INTO products_v4 (
          id, sku, name, color, search_text, category_id, unit, price_cents, package_qty_milli,
          package_price_cents, half_package_price_cents, sell_by_unit, sell_by_package,
          sell_by_half_package, cost_cents, tax_rate_bp, track_stock, stock_on_hand_milli,
          low_stock_threshold_milli, active, created_at, updated_at, deleted_at
        )
        SELECT
          id, sku, name, '', search_text, category_id, unit, price_cents, package_qty_milli,
          package_price_cents, half_package_price_cents, sell_by_unit, sell_by_package,
          sell_by_half_package, cost_cents, tax_rate_bp, track_stock, stock_on_hand_milli,
          low_stock_threshold_milli, active, created_at, updated_at, deleted_at
        FROM products;
        DROP TABLE products;
        ALTER TABLE products_v4 RENAME TO products;
        CREATE INDEX idx_products_sku ON products(sku);
        CREATE UNIQUE INDEX idx_products_variant ON products(sku COLLATE NOCASE, name COLLATE NOCASE, color COLLATE NOCASE) WHERE deleted_at IS NULL;
        CREATE INDEX idx_products_search ON products(search_text);
        CREATE INDEX idx_products_category ON products(category_id);
        CREATE INDEX idx_products_active ON products(active, deleted_at);
        PRAGMA user_version = 4;
      `);
      run("INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?, ?)", [4, nowIso()]);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  if (Number(one("PRAGMA user_version")?.user_version ?? 0) === 4) {
    const backup = (sqlite3.capi.sqlite3_js_db_export(db.pointer) as Uint8Array).slice();
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
    await writeBackupFile(`pre-migrate-v4-${stamp}.db`, backup);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        CREATE TABLE stock_imports (
          id TEXT PRIMARY KEY,
          document_ref TEXT NOT NULL,
          document_key TEXT NOT NULL UNIQUE,
          product_count INTEGER NOT NULL,
          quantity_milli INTEGER NOT NULL,
          total_cost_cents INTEGER NOT NULL,
          exchange_rate REAL NOT NULL,
          user_id TEXT,
          created_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX idx_stock_imports_key ON stock_imports(document_key);
        CREATE INDEX idx_stock_imports_created ON stock_imports(created_at);
        PRAGMA user_version = 5;
      `);
      // Reconhece imports anteriores a esta versão: a tabela de registo não
      // existia, pelo que as suas facturas têm de ser recuperadas dos movimentos.
      const legacyImports = rows(
        `SELECT document_ref,
                COUNT(DISTINCT product_id) AS product_count,
                SUM(qty_milli) AS quantity_milli,
                SUM(COALESCE(unit_cost_cents, 0)) AS total_cost_cents,
                MIN(user_id) AS user_id,
                MIN(created_at) AS created_at
         FROM stock_movements
         WHERE type = 'purchase_in'
           AND reason LIKE 'Importação Excel%'
           AND document_ref IS NOT NULL
           AND TRIM(document_ref) <> ''
         GROUP BY lower(trim(document_ref))`,
      );
      const seenRefs = new Set<string>();
      for (const legacy of legacyImports) {
        const ref = String(legacy.document_ref ?? "").trim();
        const key = normalizeDocumentRef(ref);
        if (!key || seenRefs.has(key)) continue;
        seenRefs.add(key);
        run(
          `INSERT INTO stock_imports (
             id, document_ref, document_key, product_count, quantity_milli,
             total_cost_cents, exchange_rate, user_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
          [
            uuid(),
            ref,
            key,
            Number(legacy.product_count ?? 0),
            Number(legacy.quantity_milli ?? 0),
            Number(legacy.total_cost_cents ?? 0),
            legacy.user_id ? String(legacy.user_id) : null,
            String(legacy.created_at ?? nowIso()),
          ],
        );
      }
      run("INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?, ?)", [5, nowIso()]);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  if (Number(one("PRAGMA user_version")?.user_version ?? 0) === 5) {
    const backup = (sqlite3.capi.sqlite3_js_db_export(db.pointer) as Uint8Array).slice();
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
    await writeBackupFile(`pre-migrate-v5-${stamp}.db`, backup);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        ALTER TABLE sales ADD COLUMN is_credit INTEGER NOT NULL DEFAULT 0;
        CREATE TABLE sale_settlements (
          id TEXT PRIMARY KEY,
          sale_id TEXT NOT NULL,
          amount_cents INTEGER NOT NULL,
          method TEXT NOT NULL CHECK (method IN ('cash','card','pos','mpesa','emola','transfer','other')),
          reference TEXT,
          note TEXT,
          user_id TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_sale_settlements_sale ON sale_settlements(sale_id, created_at);
        CREATE INDEX idx_sales_credit ON sales(is_credit, status, customer_id);
        PRAGMA user_version = 6;
      `);
      run("INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?, ?)", [6, nowIso()]);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  if (Number(one("PRAGMA user_version")?.user_version ?? 0) === 6) {
    const backup = (sqlite3.capi.sqlite3_js_db_export(db.pointer) as Uint8Array).slice();
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
    await writeBackupFile(`pre-migrate-v6-${stamp}.db`, backup);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        ALTER TABLE users ADD COLUMN login_shortcut INTEGER CHECK (login_shortcut BETWEEN 1 AND 9);
        CREATE UNIQUE INDEX idx_users_login_shortcut ON users(login_shortcut) WHERE login_shortcut IS NOT NULL;
        PRAGMA user_version = 7;
      `);
      run("INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?, ?)", [7, nowIso()]);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  if (Number(one("PRAGMA user_version")?.user_version ?? 0) === 7) {
    const backup = (sqlite3.capi.sqlite3_js_db_export(db.pointer) as Uint8Array).slice();
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
    await writeBackupFile(`pre-migrate-v7-${stamp}.db`, backup);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        ALTER TABLE settings ADD COLUMN discount_approval_mode TEXT NOT NULL DEFAULT 'above_limit'
          CHECK (discount_approval_mode IN ('never','above_limit','always'));
        PRAGMA user_version = 8;
      `);
      run("INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?, ?)", [8, nowIso()]);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  if (Number(one("PRAGMA user_version")?.user_version ?? 0) === 8) {
    const backup = (sqlite3.capi.sqlite3_js_db_export(db.pointer) as Uint8Array).slice();
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
    await writeBackupFile(`pre-migrate-v8-${stamp}.db`, backup);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS expenses (
          id TEXT PRIMARY KEY,
          category TEXT NOT NULL CHECK (category IN ('compras','transporte','utilidades','salarios','aluguer','manutencao','impostos','marketing','outros')),
          description TEXT NOT NULL,
          search_text TEXT NOT NULL DEFAULT '',
          amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
          method TEXT NOT NULL CHECK (method IN ('cash','card','pos','mpesa','emola','transfer','other')),
          reference TEXT,
          note TEXT,
          spent_at TEXT NOT NULL,
          user_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_expenses_spent ON expenses(spent_at);
        CREATE INDEX IF NOT EXISTS idx_expenses_search ON expenses(search_text);
        PRAGMA user_version = 9;
      `);
      run("INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?, ?)", [9, nowIso()]);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  // Bases migradas de versões anteriores podem ter utilizadores sem atalho
  // (criados antes dessa funcionalidade). Completar aqui é idempotente.
  ensureLoginShortcuts();
}

async function openOpfsDatabase() {
  // O OPFS usa um lock exclusivo por ficheiro. Ao recarregar ou abrir uma nova
  // instância, o worker anterior pode ainda não ter libertado o acesso; nestes
  // casos vale a pena esperar um pouco em vez de mostrar um erro definitivo.
  const delays = [0, 120, 250, 500, 1000, 2000];
  let lastError: unknown = null;

  for (const delay of delays) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      return new sqlite3.oo1.OpfsDb("/pos.sqlite3");
    } catch (error) {
      lastError = error;
    }
  }

  console.error("[sqlite] Não foi possível abrir /pos.sqlite3", lastError);
  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "");
  if (/NoModificationAllowed|locked|lock|busy/i.test(detail)) {
    fail(
      "DB_BUSY",
      "A base local já está aberta noutro separador ou janela. Feche as outras instâncias do POS e recarregue esta página.",
    );
  }
  fail(
    "OPFS_UNAVAILABLE",
    "Não foi possível abrir a base local. Use Chrome/Edge actualizado e confirme que a app tem isolamento cross-origin (COOP/COEP).",
  );
}

async function ensureDb(): Promise<void> {
  if (db) return;
  if (!self_.crossOriginIsolated || typeof SharedArrayBuffer === "undefined") {
    fail(
      "CROSS_ORIGIN_ISOLATION_REQUIRED",
      "A base local requer isolamento cross-origin. Confirme os cabeçalhos COOP/COEP no alojamento e recarregue a aplicação.",
    );
  }
  if (!sqlite3) {
    const url = new URL("../sqlite/index.mjs", self_.location.href).href;
    const sqliteModule = await import(/* webpackIgnore: true */ url);
    sqlite3 = await sqliteModule.default();
  }
  db = await openOpfsDatabase();
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = DELETE;");
  db.exec("PRAGMA synchronous = FULL;");
  db.exec("PRAGMA temp_store = MEMORY;");
  try {
    await migrate();
    const check = one("PRAGMA quick_check");
    const result = check ? Object.values(check)[0] : "ok";
    if (result !== "ok") fail("DB_CORRUPT", "A base local está corrompida. Importe um backup ou exporte os dados actuais.");
    const fk = rows("PRAGMA foreign_key_check");
    if (fk.length > 0) fail("DB_CORRUPT", "Foram encontradas referências inválidas na base local.");
  } catch (error) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    db = null;
    throw error;
  }
}

async function opfsFile(name: string): Promise<FileSystemFileHandle> {
  const root = await (navigator.storage as any).getDirectory();
  return root.getFileHandle(name, { create: true });
}

async function writeOpfsFile(name: string, bytes: Uint8Array): Promise<void> {
  const handle = await opfsFile(name);
  const writable = await (handle as any).createWritable();
  await writable.write(bytes);
  await writable.close();
}

async function removeOpfsFile(name: string): Promise<void> {
  const root = await (navigator.storage as any).getDirectory();
  try {
    await root.removeEntry(name);
  } catch {
    /* ignore */
  }
}

async function writeBackupFile(name: string, bytes: Uint8Array): Promise<void> {
  const root = await (navigator.storage as any).getDirectory();
  const dir = await root.getDirectoryHandle("backups", { create: true });
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await (handle as any).createWritable();
  await writable.write(bytes);
  await writable.close();
}

async function pruneAutoBackups(now: number): Promise<void> {
  const root = await (navigator.storage as any).getDirectory();
  const dir = await root.getDirectoryHandle("backups", { create: true });
  const autoBackups: { name: string; lastModified: number }[] = [];
  for await (const [name, handle] of (dir as any).entries()) {
    if (handle.kind !== "file" || !String(name).startsWith("auto-") || !String(name).endsWith(".db")) continue;
    const file = await handle.getFile();
    autoBackups.push({ name: String(name), lastModified: Number(file.lastModified) });
  }
  autoBackups.sort((a, b) => b.lastModified - a.lastModified);

  const keep = new Set(
    autoBackups
      .filter((backup) => backup.lastModified >= now - AUTO_BACKUP_RETENTION_MS)
      .slice(0, 28)
      .map((backup) => backup.name),
  );
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  for (let week = 1; week <= 4; week += 1) {
    const upperBound = now - week * weekMs;
    const lowerBound = now - (week + 1) * weekMs;
    const weekly = autoBackups.find((backup) => backup.lastModified < upperBound && backup.lastModified >= lowerBound);
    if (weekly) keep.add(weekly.name);
  }

  for (const backup of autoBackups) {
    if (!keep.has(backup.name)) await dir.removeEntry(backup.name);
  }
}

async function listBackups(): Promise<{ name: string; sizeBytes: number }[]> {
  try {
    const root = await (navigator.storage as any).getDirectory();
    const dir = await root.getDirectoryHandle("backups", { create: true });
    const out: { name: string; sizeBytes: number }[] = [];
    for await (const [name, handle] of (dir as any).entries()) {
      if (handle.kind !== "file") continue;
      const file = await handle.getFile();
      out.push({ name: String(name), sizeBytes: Number(file.size) });
    }
    return out.sort((a, b) => b.name.localeCompare(a.name)).slice(0, 20);
  } catch {
    return [];
  }
}

async function createSetup(payload: any): Promise<SessionInfo & { recoveryCode: string }> {
  await ensureDb();
  if (!isSetupRequired()) fail("ALREADY_SETUP", "A aplicação já está configurada.");
  const storeName = String(payload?.storeName ?? "").trim();
  const ownerName = String(payload?.ownerName ?? "").trim();
  const username = String(payload?.username ?? "").trim().toLowerCase();
  const pin = validatePin(payload?.pin);
  if (!storeName) fail("VALIDATION", "Indique o nome da loja.");
  if (!ownerName) fail("VALIDATION", "Indique o nome do proprietário.");
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) fail("VALIDATION", "O utilizador deve ter 3 a 32 caracteres (letras, números, ponto, hífen).");

  const pinData = await hashPin(pin);
  const recovery = generateRecoveryCode();
  const recoveryData = await hashPin(recovery);
  const now = nowIso();
  const ownerId = uuid();
  const installationCode = String(payload?.installationCode ?? "T01").trim().toUpperCase().slice(0, 8) || "T01";

  db.exec("BEGIN IMMEDIATE");
  try {
    run(
      `INSERT INTO settings (id, store_name, nif, address, phone, currency, tax_rate_bp, receipt_footer, installation_code, allow_negative_stock, max_cashier_discount_bp, idle_lock_seconds, created_at, updated_at)
       VALUES ('default', ?, ?, ?, ?, 'MZN', 1600, ?, ?, 1, 500, 300, ?, ?)`,
      [
        storeName,
        String(payload?.nif ?? "").trim(),
        String(payload?.address ?? "").trim(),
        String(payload?.phone ?? "").trim(),
        String(payload?.receiptFooter ?? "Obrigado pela preferência!").trim(),
        installationCode,
        now,
        now,
      ],
    );
    run(
      `INSERT INTO users (id, username, display_name, role, active, pin_hash, pin_salt, pin_iterations, pin_algo, failed_attempts, must_change_pin, login_shortcut, created_at, updated_at)
       VALUES (?, ?, ?, 'owner', 1, ?, ?, ?, 'PBKDF2-SHA-256', 0, 0, 1, ?, ?)`,
      [ownerId, username, ownerName, pinData.hash, pinData.salt, pinData.iterations, now, now],
    );
    run("INSERT INTO recovery_codes (id, user_id, hash, salt, iterations, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
      uuid(),
      ownerId,
      recoveryData.hash,
      recoveryData.salt,
      recoveryData.iterations,
      now,
    ]);
    run("INSERT INTO counters (name, value) VALUES ('receipt_seq', 0)");
    setMeta("installation_id", uuid());
    setMeta("created_at", now);
    audit("setup.completed", "settings", "default", null, { storeName, username }, ownerId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  session = { token: uuid(), userId: ownerId, role: "owner", username, displayName: ownerName, lastActivity: Date.now() };
  return {
    token: session.token,
    user: { id: ownerId, username, displayName: ownerName, role: "owner", active: true, mustChangePin: false, lastLoginAt: null, loginShortcut: 1 },
    settings: getSettings(),
    recoveryCode: recovery,
  };
}

async function login(userId: string, pin: string): Promise<SessionInfo> {
  await ensureDb();
  const user = one("SELECT * FROM users WHERE id = ? AND active = 1", [userId]);
  if (!user) fail("USER_NOT_FOUND", "Utilizador não encontrado ou inactivo.");
  if (user.locked_until && new Date(String(user.locked_until)).getTime() > Date.now()) {
    fail("PIN_LOCKED", `Demasiadas tentativas. Tente novamente após ${new Date(String(user.locked_until)).toLocaleTimeString("pt-MZ")}.`);
  }
  const candidate = await hashPin(pin, String(user.pin_salt), Number(user.pin_iterations));
  if (!timingSafeEqual(candidate.hash, String(user.pin_hash))) {
    const attempts = Number(user.failed_attempts ?? 0) + 1;
    let lockedUntil: string | null = null;
    if (attempts >= 10) lockedUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    else if (attempts >= 5) lockedUntil = new Date(Date.now() + 60 * 1000).toISOString();
    run("UPDATE users SET failed_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?", [attempts, lockedUntil, nowIso(), user.id]);
    audit("auth.login_failed", "user", String(user.id), null, { attempts, lockedUntil }, String(user.id));
    const remaining = 5 - (attempts % 5 || 5);
    fail("PIN_INVALID", lockedUntil ? "Demasiadas tentativas. Conta bloqueada temporariamente." : `PIN incorrecto. Tentativas restantes: ${remaining}.`);
  }
  const now = nowIso();
  run("UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?", [now, now, user.id]);
  session = {
    token: uuid(),
    userId: String(user.id),
    role: user.role as Role,
    username: String(user.username),
    displayName: String(user.display_name),
    lastActivity: Date.now(),
  };
  audit("auth.login", "user", String(user.id), null, null);
  return { token: session.token, user: toUser({ ...user, last_login_at: now }), settings: getSettings() };
}

async function requestApproval(payload: any): Promise<{ token: string; approverName: string; expiresAt: string }> {
  const current = requireSession();
  const user = one("SELECT * FROM users WHERE username = ? AND active = 1", [String(payload?.username ?? "").trim().toLowerCase()]);
  if (!user || (user.role !== "manager" && user.role !== "owner")) fail("FORBIDDEN", "A aprovação exige um gerente ou proprietário activo.");
  const candidate = await hashPin(String(payload?.pin ?? ""), String(user.pin_salt), Number(user.pin_iterations));
  if (!timingSafeEqual(candidate.hash, String(user.pin_hash))) fail("PIN_INVALID", "PIN do aprovador incorrecto.");
  const selfApproved = String(user.id) === current.userId;
  if (selfApproved && user.role !== "owner") fail("FORBIDDEN", "Um gerente não pode aprovar a própria acção.");
  const token = uuid();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
  run(
    "INSERT INTO approvals (id, action, entity_type, entity_id, amount_cents, requested_by, approver_id, self_approved, created_at, expires_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      token,
      String(payload?.action ?? "sale.exception"),
      String(payload?.entityType ?? "sale"),
      payload?.entityId ? String(payload.entityId) : null,
      Number.isFinite(Number(payload?.amountCents)) ? Math.trunc(Number(payload.amountCents)) : null,
      current.userId,
      String(user.id),
      selfApproved ? 1 : 0,
      createdAt,
      expiresAt,
      null,
    ],
  );
  audit("approval.granted", "approval", token, null, { action: payload?.action, approver: user.username, selfApproved }, current.userId);
  return { token, approverName: String(user.display_name), expiresAt };
}

async function completeSale(payload: SaleInput): Promise<Sale> {
  const current = requireSession(["owner", "manager", "cashier"]);
  const application = getSettings();
  db.exec("BEGIN IMMEDIATE");
  try {
    const quote = buildQuote(payload, current);
    const isCredit = payload.isCredit === true;
    if (isCredit && !payload.customerId) fail("CUSTOMER_REQUIRED", "As vendas a prazo exigem um cliente identificado.");
    const { payments, paid, change } = validatePayments(payload.payments ?? [], quote.totalCents, isCredit);
    if (quote.requiresApproval) consumeApproval(payload.approvalToken, "sale.exception", quote.discountCents);
    else if (payload.approvalToken) consumeApproval(payload.approvalToken, "sale.exception", quote.discountCents);

    const customer = payload.customerId ? one("SELECT * FROM customers WHERE id = ? AND deleted_at IS NULL", [payload.customerId]) : null;
    if (payload.customerId && !customer) fail("CUSTOMER_NOT_FOUND", "Cliente não encontrado.");

    const counter = one("SELECT value FROM counters WHERE name = 'receipt_seq'");
    const seq = Number(counter?.value ?? 0) + 1;
    run("UPDATE counters SET value = ? WHERE name = 'receipt_seq'", [seq]);
    const receiptNumber = `${application.installationCode}-${String(seq).padStart(6, "0")}`;
    const saleId = uuid();
    const now = nowIso();

    run(
      `INSERT INTO sales (id, receipt_number, status, cashier_id, cashier_name_snapshot, customer_id, customer_name_snapshot, customer_nif_snapshot, subtotal_cents, discount_cents, tax_cents, tax_applied, total_cents, paid_cents, change_cents, is_credit, note, created_at)
       VALUES (?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        saleId,
        receiptNumber,
        current.userId,
        current.displayName,
        payload.customerId ?? null,
        customer ? String(customer.name) : null,
        customer ? String(customer.nif ?? "") || null : null,
        quote.subtotalCents,
        quote.discountCents,
        quote.taxCents,
        quote.taxApplied ? 1 : 0,
        quote.totalCents,
        paid,
        change,
        isCredit ? 1 : 0,
        payload.note ? String(payload.note).slice(0, 500) : null,
        now,
      ],
    );

    for (const line of quote.lines) {
      run(
        `INSERT INTO sale_items (id, sale_id, product_id, name_snapshot, sku_snapshot, barcode_snapshot, unit, sale_unit, unit_price_cents, sale_qty_milli, qty_milli, gross_cents, line_discount_cents, order_discount_cents, tax_rate_bp, base_cents, tax_cents, total_cents)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uuid(),
          saleId,
          line.productId,
          line.name,
          line.sku,
          line.unit,
          line.saleUnit,
          line.unitPriceCents,
          line.saleQtyMilli,
          line.qtyMilli,
          line.grossCents,
          line.lineDiscountCents,
          line.orderDiscountCents,
          line.taxRateBp,
          line.baseCents,
          line.taxCents,
          line.totalCents,
        ],
      );
      if (line.trackStock) {
        const product = one("SELECT stock_on_hand_milli FROM products WHERE id = ?", [line.productId]);
        const after = Number(product?.stock_on_hand_milli ?? 0) - line.qtyMilli;
        run("UPDATE products SET stock_on_hand_milli = ?, updated_at = ? WHERE id = ?", [after, now, line.productId]);
        run(
          `INSERT INTO stock_movements (id, product_id, type, qty_milli, balance_after_milli, unit_cost_cents, supplier_id, supplier_name_snapshot, document_ref, reason, sale_id, user_id, created_at)
           VALUES (?, ?, 'sale', ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
          [uuid(), line.productId, -line.qtyMilli, after, `Venda ${receiptNumber}`, saleId, current.userId, now],
        );
      }
    }

    for (const payment of payments) {
      run(
        "INSERT INTO sale_payments (id, sale_id, method, amount_cents, tendered_cents, reference, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [uuid(), saleId, payment.method, payment.amountCents, payment.tenderedCents ?? payment.amountCents, payment.reference ?? null, now],
      );
    }

    audit("sale.completed", "sale", saleId, null, {
      receiptNumber,
      totalCents: quote.totalCents,
      itemCount: quote.lines.length,
      discountCents: quote.discountCents,
      paymentMethods: payments.map((p) => p.method),
      isCredit,
      paidCents: paid,
    });
    if (isCredit) {
      audit("sale.credit", "sale", saleId, null, {
        receiptNumber,
        customerName: customer ? String(customer.name) : null,
        totalCents: quote.totalCents,
        paidCents: paid,
        outstandingCents: Math.max(0, quote.totalCents - paid),
      });
    }
    db.exec("COMMIT");
    const sale = toSale(saleId);
    if (!sale) fail("INTERNAL", "A venda foi gravada mas não pôde ser lida.");
    return sale;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw error;
  }
}

type SettleSalePayload = {
  id?: string;
  amountCents?: number;
  method?: PaymentMethod;
  reference?: string | null;
  note?: string | null;
};

async function settleSale(payload: SettleSalePayload): Promise<Sale> {
  const current = requireSession(["owner", "manager", "cashier"]);
  const saleId = String(payload.id ?? "");
  const sale = one("SELECT * FROM sales WHERE id = ?", [saleId]);
  if (!sale) fail("SALE_NOT_FOUND", "Venda não encontrada.");
  if (sale.status !== "completed") fail("SALE_INVALID", "Não é possível regularizar uma venda anulada.");
  if (!toBool(sale.is_credit)) fail("SALE_INVALID", "Esta venda não é a prazo.");

  const amountCents = Math.trunc(Number(payload.amountCents));
  if (!Number.isFinite(amountCents) || amountCents <= 0) fail("PAYMENT_INVALID", "Indique um valor superior a zero.");
  const method = String(payload.method ?? "") as PaymentMethod;
  if (!PAYMENT_METHODS.includes(method)) fail("PAYMENT_INVALID", "Método de pagamento inválido.");

  const alreadySettled = Number(
    one("SELECT COALESCE(SUM(amount_cents), 0) AS total FROM sale_settlements WHERE sale_id = ?", [saleId])?.total ?? 0,
  );
  const outstandingCents = Math.max(0, Number(sale.total_cents) - Number(sale.paid_cents) - alreadySettled);
  if (outstandingCents <= 0) fail("SALE_SETTLED", "Esta venda já está liquidada.");
  if (amountCents > outstandingCents) {
    fail("PAYMENT_MISMATCH", `Só falta ${(outstandingCents / 100).toFixed(2)} MZN para liquidar esta venda.`);
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    run(
      `INSERT INTO sale_settlements (id, sale_id, amount_cents, method, reference, note, user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuid(),
        saleId,
        amountCents,
        method,
        payload.reference ? String(payload.reference).trim().slice(0, 100) || null : null,
        payload.note ? String(payload.note).trim().slice(0, 300) || null : null,
        current.userId,
        nowIso(),
      ],
    );
    audit("sale.settlement", "sale", saleId, { outstandingCents }, {
      receiptNumber: String(sale.receipt_number),
      amountCents,
      method,
      outstandingCents: outstandingCents - amountCents,
    });
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw error;
  }
  const updated = toSale(saleId);
  if (!updated) fail("INTERNAL", "A regularização foi gravada mas a venda não pôde ser lida.");
  return updated;
}

async function voidSale(id: string, reason: string, approvalToken?: string | null): Promise<Sale> {
  const current = requireSession(["owner", "manager", "cashier"]);
  const sale = one("SELECT * FROM sales WHERE id = ?", [id]);
  if (!sale) fail("SALE_NOT_FOUND", "Venda não encontrada.");
  if (sale.status !== "completed") fail("SALE_INVALID", "Esta venda já foi anulada.");
  const motive = String(reason ?? "").trim();
  if (motive.length < 3) fail("VALIDATION", "Indique o motivo da anulação.");

  db.exec("BEGIN IMMEDIATE");
  try {
    if (current.role === "cashier") consumeApproval(approvalToken, "sale.void");
    const now = nowIso();
    run("UPDATE sales SET status = 'voided', voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ?", [now, current.userId, motive, id]);
    const items = rows("SELECT si.*, p.track_stock FROM sale_items si JOIN products p ON p.id = si.product_id WHERE si.sale_id = ?", [id]);
    for (const item of items) {
      if (!toBool(item.track_stock)) continue;
      const product = one("SELECT stock_on_hand_milli FROM products WHERE id = ?", [item.product_id]);
      const after = Number(product?.stock_on_hand_milli ?? 0) + Number(item.qty_milli);
      run("UPDATE products SET stock_on_hand_milli = ?, updated_at = ? WHERE id = ?", [after, now, item.product_id]);
      run(
        `INSERT INTO stock_movements (id, product_id, type, qty_milli, balance_after_milli, unit_cost_cents, supplier_id, supplier_name_snapshot, document_ref, reason, sale_id, user_id, created_at)
         VALUES (?, ?, 'sale_void', ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
        [uuid(), item.product_id, Number(item.qty_milli), after, `Anulação ${sale.receipt_number}: ${motive}`, id, current.userId, now],
      );
    }
    audit("sale.voided", "sale", id, { status: "completed" }, { status: "voided", reason: motive });
    db.exec("COMMIT");
    const result = toSale(id);
    if (!result) fail("INTERNAL", "A venda anulada não pôde ser lida.");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw error;
  }
}

async function recoverOwner(payload: any): Promise<{ recoveryCode: string }> {
  await ensureDb();
  const code = validateRecoveryCode(payload?.code);
  const newPin = validatePin(payload?.newPin);
  const owner = one("SELECT * FROM users WHERE role = 'owner' AND active = 1 ORDER BY created_at LIMIT 1");
  if (!owner) fail("NOT_SETUP", "Não existe proprietário configurado.");
  const recovery = one("SELECT * FROM recovery_codes WHERE user_id = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1", [owner.id]);
  if (!recovery) fail("RECOVERY_INVALID", "Não existe código de recuperação válido.");
  const candidate = await hashPin(code, String(recovery.salt), Number(recovery.iterations));
  if (!timingSafeEqual(candidate.hash, String(recovery.hash))) {
    audit("auth.recovery_failed", "user", String(owner.id), null, null, String(owner.id));
    fail("RECOVERY_INVALID", "Código de recuperação incorrecto.");
  }
  const pinData = await hashPin(newPin);
  const newRecovery = generateRecoveryCode();
  const recoveryData = await hashPin(newRecovery);
  const now = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    run("UPDATE users SET pin_hash = ?, pin_salt = ?, pin_iterations = ?, failed_attempts = 0, locked_until = NULL, must_change_pin = 0, updated_at = ? WHERE id = ?", [
      pinData.hash,
      pinData.salt,
      pinData.iterations,
      now,
      owner.id,
    ]);
    run("UPDATE recovery_codes SET used_at = ?, rotated_at = ? WHERE id = ?", [now, now, recovery.id]);
    run("INSERT INTO recovery_codes (id, user_id, hash, salt, iterations, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
      uuid(),
      owner.id,
      recoveryData.hash,
      recoveryData.salt,
      recoveryData.iterations,
      now,
    ]);
    audit("auth.recovery_used", "user", String(owner.id), null, null, String(owner.id));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { recoveryCode: newRecovery };
}

async function exportBackup(): Promise<{ bytes: ArrayBuffer; filename: string; size: number }> {
  const current = requireSession(["owner", "manager"]);
  if (!db) fail("DB_NOT_READY", "A base não está aberta.");
  const exported = sqlite3.capi.sqlite3_js_db_export(db.pointer) as Uint8Array;
  const copy = exported.slice();
  const settings = getSettings();
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  const slug = norm(settings.storeName).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "pos";
  const filename = `${slug}-backup-${stamp}.db`;
  const now = nowIso();
  setMeta("last_backup_at", now);
  run("INSERT INTO backup_log (id, created_at, method, size_bytes, note, schema_version) VALUES (?, ?, 'manual', ?, ?, ?)", [
    uuid(),
    now,
    copy.byteLength,
    filename,
    Number(one("PRAGMA user_version")?.user_version ?? 0),
  ]);
  audit("backup.exported", "backup", null, null, { filename, size: copy.byteLength, user: current.username });
  return { bytes: copy.buffer as ArrayBuffer, filename, size: copy.byteLength };
}

async function createAutoBackup(): Promise<{ created: boolean; lastAutoBackupAt: string | null }> {
  await ensureDb();
  if (isSetupRequired()) return { created: false, lastAutoBackupAt: null };

  const previous = meta("last_auto_backup_at");
  const previousTime = previous ? Date.parse(previous) : Number.NaN;
  const now = Date.now();
  if (Number.isFinite(previousTime) && now >= previousTime && now - previousTime < AUTO_BACKUP_INTERVAL_MS) {
    return { created: false, lastAutoBackupAt: previous };
  }
  if (!db) fail("DB_NOT_READY", "A base não está aberta.");

  const timestamp = new Date(now);
  const stamp = timestamp.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("T", "-");
  const filename = `auto-${stamp}.db`;
  const copy = (sqlite3.capi.sqlite3_js_db_export(db.pointer) as Uint8Array).slice();
  await writeBackupFile(filename, copy);
  await pruneAutoBackups(now);

  const createdAt = timestamp.toISOString();
  setMeta("last_auto_backup_at", createdAt);
  run("INSERT INTO backup_log (id, created_at, method, size_bytes, note, schema_version) VALUES (?, ?, 'auto', ?, ?, ?)", [
    uuid(),
    createdAt,
    copy.byteLength,
    filename,
    Number(one("PRAGMA user_version")?.user_version ?? 0),
  ]);
  audit("backup.auto_created", "backup", null, null, { filename, size: copy.byteLength });
  return { created: true, lastAutoBackupAt: createdAt };
}

async function purgeOperationalData(payload: Record<string, unknown>): Promise<{
  backupName: string;
  deleted: { products: number; stockMovements: number; sales: number; auditEntries: number };
}> {
  const current = requireSession(["owner"]);
  await ensureDb();
  if (payload.confirmation !== "ELIMINAR") fail("CONFIRMATION_REQUIRED", "Escreva ELIMINAR para confirmar a operação.");

  const pin = String(payload.pin ?? "");
  if (!/^\d{6}$/.test(pin)) fail("VALIDATION", "Introduza o PIN actual do proprietário.");
  const owner = one("SELECT * FROM users WHERE id = ?", [current.userId]);
  if (!owner) fail("UNAUTHENTICATED", "Sessão inválida.");
  const candidate = await hashPin(pin, String(owner.pin_salt), Number(owner.pin_iterations));
  if (!timingSafeEqual(candidate.hash, String(owner.pin_hash))) fail("PIN_INVALID", "PIN do proprietário incorrecto.");
  if (!db) fail("DB_NOT_READY", "A base não está aberta.");

  const backup = (sqlite3.capi.sqlite3_js_db_export(db.pointer) as Uint8Array).slice();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupName = `pre-purge-${stamp}.db`;
  await writeBackupFile(backupName, backup);

  const now = nowIso();
  const schemaVersion = Number(one("PRAGMA user_version")?.user_version ?? 0);
  db.exec("BEGIN IMMEDIATE");
  try {
    const deleted = {
      products: Number(one("SELECT COUNT(*) AS count FROM products")?.count ?? 0),
      stockMovements: Number(one("SELECT COUNT(*) AS count FROM stock_movements")?.count ?? 0),
      sales: Number(one("SELECT COUNT(*) AS count FROM sales")?.count ?? 0),
      auditEntries: Number(one("SELECT COUNT(*) AS count FROM audit_log")?.count ?? 0),
    };

    run("INSERT INTO backup_log (id, created_at, method, size_bytes, note, schema_version) VALUES (?, ?, 'pre-purge', ?, ?, ?)", [
      uuid(),
      now,
      backup.byteLength,
      backupName,
      schemaVersion,
    ]);
    setMeta("last_backup_at", now);
    run("DELETE FROM approvals");
    run("DELETE FROM product_barcodes");
    run("DELETE FROM stock_movements");
    run("DELETE FROM sale_settlements");
    run("DELETE FROM expenses");
    run("DELETE FROM sale_payments");
    run("DELETE FROM sale_items");
    run("DELETE FROM sales");
    run("DELETE FROM products");
    run("DELETE FROM audit_log");
    db.exec("COMMIT");
    return { backupName, deleted };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function importBackup(payload: any): Promise<{ reload: boolean }> {
  const current = requireSession(["owner"]);
  await ensureDb();
  const bytes = new Uint8Array(payload?.bytes instanceof ArrayBuffer ? payload.bytes : []);
  if (bytes.byteLength === 0) fail("IMPORT_INVALID", "O ficheiro está vazio.");
  if (bytes.byteLength > MAX_IMPORT_BYTES) fail("IMPORT_INVALID", "O ficheiro é demasiado grande.");
  const header = new TextDecoder().decode(bytes.slice(0, 16));
  if (header !== "SQLite format 3\u0000") fail("IMPORT_INVALID", "O ficheiro não é uma base SQLite válida.");
  const pin = String(payload?.pin ?? "");
  const owner = one("SELECT * FROM users WHERE id = ?", [current.userId]);
  if (!owner) fail("UNAUTHENTICATED", "Sessão inválida.");
  const candidate = await hashPin(pin, String(owner.pin_salt), Number(owner.pin_iterations));
  if (!timingSafeEqual(candidate.hash, String(owner.pin_hash))) fail("PIN_INVALID", "PIN do proprietário incorrecto.");

  if (!db) fail("DB_NOT_READY", "A base não está aberta.");
  const before = (sqlite3.capi.sqlite3_js_db_export(db.pointer) as Uint8Array).slice();
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
  db.close();
  db = null;

  try {
    await writeBackupFile(`pre-import-${stamp}.db`, before);
    await writeOpfsFile("import-candidate.sqlite3", bytes);
    const checkDb = new sqlite3.oo1.OpfsDb("/import-candidate.sqlite3");
    try {
      const integrity = checkDb.exec({ sql: "PRAGMA integrity_check", rowMode: "object", returnValue: "resultRows" }) as Row[];
      if (!integrity[0] || Object.values(integrity[0])[0] !== "ok") fail("IMPORT_INVALID", "A base importada está corrompida.");
      const version = Number((checkDb.exec({ sql: "PRAGMA user_version", rowMode: "object", returnValue: "resultRows" }) as Row[])[0]?.user_version ?? 0);
      if (version > SCHEMA_VERSION) fail("IMPORT_INVALID", "A base foi criada por uma versão mais recente da aplicação.");
      const tables = checkDb.exec({ sql: "SELECT name FROM sqlite_master WHERE type = 'table'", rowMode: "object", returnValue: "resultRows" }) as Row[];
      const names = new Set(tables.map((t) => String(t.name)));
      for (const required of ["settings", "users", "products", "sales", "sale_items", "sale_payments", "counters"]) {
        if (!names.has(required)) fail("IMPORT_INVALID", `A base importada não contém a tabela ${required}.`);
      }
      const ownerCount = Number((checkDb.exec({ sql: "SELECT COUNT(*) AS c FROM users WHERE role = 'owner' AND active = 1", rowMode: "object", returnValue: "resultRows" }) as Row[])[0]?.c ?? 0);
      if (ownerCount < 1) fail("IMPORT_INVALID", "A base importada não tem proprietário activo.");
    } finally {
      checkDb.close();
    }
    await removeOpfsFile("import-candidate.sqlite3");
    await writeOpfsFile("pos.sqlite3", bytes);
    await ensureDb();
    session = null;
    return { reload: true };
  } catch (error) {
    try {
      await removeOpfsFile("import-candidate.sqlite3");
      await writeOpfsFile("pos.sqlite3", before);
      await ensureDb();
    } catch {
      /* ignore */
    }
    throw error;
  }
}

async function handleRequest(req: WorkerRequest): Promise<{ data: unknown; transfer?: Transferable[] }> {
  const payload: any = req.payload ?? {};
  switch (req.type) {
    case "app.init": {
      await ensureDb();
      return { data: await status() };
    }
    case "app.status":
      await ensureDb();
      return { data: await status() };
    case "setup.create":
      return { data: await createSetup(payload) };
    case "auth.users": {
      await ensureDb();
      return {
        data: rows("SELECT id, username, display_name, role, active, must_change_pin, last_login_at, login_shortcut FROM users WHERE active = 1 ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, display_name").map(toUser),
      };
    }
    case "auth.login": {
      if (session?.token && req.token === session.token) session = null;
      return { data: await login(String(payload.userId ?? ""), String(payload.pin ?? "")) };
    }
    case "auth.logout": {
      if (session) {
        audit("auth.logout", "user", session.userId, null, null);
        session = null;
      }
      return { data: { ok: true } };
    }
    case "auth.lock":
      session = null;
      return { data: { ok: true } };
    case "auth.touch":
      requireSession();
      return { data: { ok: true } };
    case "auth.recoverOwner":
      return { data: await recoverOwner(payload) };
    case "auth.changePin": {
      const current = requireSession();
      const newPin = validatePin(payload.newPin);
      const user = one("SELECT * FROM users WHERE id = ?", [current.userId]);
      if (!user) fail("UNAUTHENTICATED", "Sessão inválida.");
      const candidate = await hashPin(String(payload.currentPin ?? ""), String(user.pin_salt), Number(user.pin_iterations));
      if (!timingSafeEqual(candidate.hash, String(user.pin_hash))) fail("PIN_INVALID", "PIN actual incorrecto.");
      const data = await hashPin(newPin);
      run("UPDATE users SET pin_hash = ?, pin_salt = ?, pin_iterations = ?, must_change_pin = 0, updated_at = ? WHERE id = ?", [
        data.hash,
        data.salt,
        data.iterations,
        nowIso(),
        current.userId,
      ]);
      audit("auth.pin_changed", "user", current.userId, null, null);
      return { data: { ok: true } };
    }
    case "approval.request":
      return { data: await requestApproval(payload) };
    case "settings.update": {
      const current = requireSession(["owner"]);
      const before = getSettings();
      const now = nowIso();
      const discountApprovalMode = String(payload.discountApprovalMode ?? before.discountApprovalMode);
      if (!["never", "above_limit", "always"].includes(discountApprovalMode)) {
        fail("VALIDATION", "Regra de aprovação de descontos inválida.");
      }
      run(
        `UPDATE settings SET store_name = ?, nif = ?, address = ?, phone = ?, receipt_footer = ?, installation_code = ?, allow_negative_stock = ?, max_cashier_discount_bp = ?, discount_approval_mode = ?, idle_lock_seconds = ?, updated_at = ? WHERE id = 'default'`,
        [
          String(payload.storeName ?? before.storeName).trim(),
          String(payload.nif ?? before.nif).trim(),
          String(payload.address ?? before.address).trim(),
          String(payload.phone ?? before.phone).trim(),
          String(payload.receiptFooter ?? before.receiptFooter).trim(),
          String(payload.installationCode ?? before.installationCode).trim().toUpperCase().slice(0, 8),
          toBool(payload.allowNegativeStock ?? before.allowNegativeStock) ? 1 : 0,
          Math.max(0, Math.min(10000, Math.trunc(Number(payload.maxCashierDiscountBp ?? before.maxCashierDiscountBp)))),
          discountApprovalMode,
          Math.max(60, Math.min(1800, Math.trunc(Number(payload.idleLockSeconds ?? before.idleLockSeconds)))),
          now,
        ],
      );
      const after = getSettings();
      audit("settings.updated", "settings", "default", before, after, current.userId);
      return { data: after };
    }
    case "data.purge":
      return { data: await purgeOperationalData(payload) };
    case "user.list": {
      requireSession(["owner"]);
      return { data: rows("SELECT id, username, display_name, role, active, must_change_pin, last_login_at, login_shortcut FROM users ORDER BY created_at").map(toUser) };
    }
    case "user.create": {
      const current = requireSession(["owner"]);
      const pin = validatePin(payload.pin);
      const username = String(payload.username ?? "").trim().toLowerCase();
      const displayName = String(payload.displayName ?? "").trim();
      const role = String(payload.role ?? "cashier") as Role;
      if (!/^[a-z0-9._-]{3,32}$/.test(username)) fail("VALIDATION", "Utilizador inválido.");
      if (!displayName) fail("VALIDATION", "Indique o nome do utilizador.");
      if (!["owner", "manager", "cashier"].includes(role)) fail("VALIDATION", "Perfil inválido.");
      const loginShortcut = payload.loginShortcut === undefined
        ? nextFreeLoginShortcut()
        : parseLoginShortcut(payload.loginShortcut);
      const data = await hashPin(pin);
      const now = nowIso();
      const id = uuid();
      run(
        "INSERT INTO users (id, username, display_name, role, active, pin_hash, pin_salt, pin_iterations, pin_algo, must_change_pin, login_shortcut, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, 'PBKDF2-SHA-256', 1, ?, ?, ?)",
        [id, username, displayName, role, data.hash, data.salt, data.iterations, loginShortcut, now, now],
      );
      audit("user.created", "user", id, null, { username, role, loginShortcut }, current.userId);
      return { data: toUser(one("SELECT * FROM users WHERE id = ?", [id]) as Row) };
    }
    case "user.update": {
      const current = requireSession(["owner"]);
      const user = one("SELECT * FROM users WHERE id = ?", [String(payload.id ?? "")]);
      if (!user) fail("USER_NOT_FOUND", "Utilizador não encontrado.");
      const active = payload.active === undefined ? toBool(user.active) : toBool(payload.active);
      if (String(user.role) === "owner" && !active) {
        const owners = Number(one("SELECT COUNT(*) AS c FROM users WHERE role = 'owner' AND active = 1")?.c ?? 0);
        if (owners <= 1) fail("FORBIDDEN", "Não pode desactivar o último proprietário.");
      }
      const role = String(payload.role ?? user.role);
      if (!["owner", "manager", "cashier"].includes(role)) fail("VALIDATION", "Perfil inválido.");
      const loginShortcut = payload.loginShortcut === undefined
        ? (user.login_shortcut === null ? null : Number(user.login_shortcut))
        : parseLoginShortcut(payload.loginShortcut, String(user.id));
      const before = toUser(user);
      run("UPDATE users SET display_name = ?, role = ?, active = ?, login_shortcut = ?, updated_at = ? WHERE id = ?", [
        String(payload.displayName ?? user.display_name).trim() || String(user.display_name),
        role,
        active ? 1 : 0,
        loginShortcut,
        nowIso(),
        user.id,
      ]);
      audit("user.updated", "user", String(user.id), before, { active, role, loginShortcut }, current.userId);
      return { data: toUser(one("SELECT * FROM users WHERE id = ?", [user.id]) as Row) };
    }
    case "user.resetPin": {
      const current = requireSession(["owner"]);
      const pin = validatePin(payload.pin);
      const user = one("SELECT * FROM users WHERE id = ?", [String(payload.id ?? "")]);
      if (!user) fail("USER_NOT_FOUND", "Utilizador não encontrado.");
      const data = await hashPin(pin);
      run("UPDATE users SET pin_hash = ?, pin_salt = ?, pin_iterations = ?, failed_attempts = 0, locked_until = NULL, must_change_pin = 1, updated_at = ? WHERE id = ?", [
        data.hash,
        data.salt,
        data.iterations,
        nowIso(),
        user.id,
      ]);
      audit("user.pin_reset", "user", String(user.id), null, null, current.userId);
      return { data: { ok: true } };
    }
    case "category.list":
      requireSession();
      return { data: rows("SELECT id, name, sort_order FROM categories WHERE deleted_at IS NULL ORDER BY sort_order, name").map((row) => ({ id: String(row.id), name: String(row.name), sortOrder: Number(row.sort_order) })) as Category[] };
    case "category.upsert": {
      const current = requireSession(["owner", "manager"]);
      const name = String(payload.name ?? "").trim();
      if (!name) fail("VALIDATION", "Indique o nome da categoria.");
      const now = nowIso();
      if (payload.id) {
        const before = one("SELECT * FROM categories WHERE id = ?", [payload.id]);
        if (!before) fail("NOT_FOUND", "Categoria não encontrada.");
        run("UPDATE categories SET name = ?, sort_order = ?, updated_at = ? WHERE id = ?", [name, Number(payload.sortOrder ?? before.sort_order), now, payload.id]);
        audit("category.updated", "category", String(payload.id), { name: before.name }, { name }, current.userId);
        return { data: { id: String(payload.id), name, sortOrder: Number(payload.sortOrder ?? before.sort_order) } };
      }
      const id = uuid();
      run("INSERT INTO categories (id, name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [id, name, Number(payload.sortOrder ?? 0), now, now]);
      audit("category.created", "category", id, null, { name }, current.userId);
      return { data: { id, name, sortOrder: Number(payload.sortOrder ?? 0) } };
    }
    case "product.list": {
      requireSession();
      const { where, bind } = productFilter(payload);
      return { data: productRows(`${where} ORDER BY p.name LIMIT 200`, bind).map(toProduct) };
    }
    case "product.page": {
      requireSession();
      const { where, bind, query } = productFilter(payload);
      const total = Number(one(`SELECT COUNT(*) AS total FROM products p LEFT JOIN categories c ON c.id = p.category_id ${where}`, bind)?.total ?? 0);
      const requested = paginationInput(payload);
      const page = resolvePage(requested.page, requested.pageSize, total);
      const barcodeSort = query
        ? "ORDER BY CASE WHEN EXISTS (SELECT 1 FROM product_barcodes exact_barcode WHERE exact_barcode.product_id = p.id AND exact_barcode.barcode = ?) THEN 0 ELSE 1 END, p.name, p.id"
        : "ORDER BY p.name, p.id";
      const pageBind = query ? [...bind, query, requested.pageSize, (page - 1) * requested.pageSize] : [...bind, requested.pageSize, (page - 1) * requested.pageSize];
      return {
        data: {
          items: productRows(`${where} ${barcodeSort} LIMIT ? OFFSET ?`, pageBind).map(toProduct),
          page,
          pageSize: requested.pageSize,
          total,
        },
      };
    }
    case "product.upsert": {
      const current = requireSession(["owner", "manager"]);
      const name = String(payload.name ?? "").trim();
      if (!name) fail("VALIDATION", "Indique o nome do produto.");
      const color = String(payload.color ?? "").trim();
      if (!color) fail("VALIDATION", "Indique a cor do produto.");
      if (color.length > 60) fail("VALIDATION", "A cor do produto deve ter no máximo 60 caracteres.");
      const price = Math.max(0, Math.trunc(Number(payload.priceCents ?? 0)));
      const cost = Math.max(0, Math.trunc(Number(payload.costCents ?? 0)));
      const unit = String(payload.unit ?? "un") as Unit;
      if (!["un", "kg", "g", "l", "ml", "cx", "pct"].includes(unit)) fail("VALIDATION", "Unidade inválida.");
      const packageQtyMilli = Math.max(0, Math.trunc(Number(payload.packageQtyMilli ?? 0)));
      const packagePrice = Math.max(0, Math.trunc(Number(payload.packagePriceCents ?? 0)));
      const halfPackagePrice = Math.max(0, Math.trunc(Number(payload.halfPackagePriceCents ?? 0)));
      const sellByUnit = payload.sellByUnit === false ? 0 : 1;
      const sellByPackage = payload.sellByPackage === true ? 1 : 0;
      const sellByHalfPackage = payload.sellByHalfPackage === true ? 1 : 0;
      if (![price, cost, packageQtyMilli, packagePrice, halfPackagePrice].every(Number.isSafeInteger)) {
        fail("VALIDATION", "Um dos preços ou quantidades do produto é inválido.");
      }
      if (sellByUnit && price <= 0) fail("VALIDATION", "Indique um preço por unidade válido para este formato de venda.");
      if (sellByPackage && packagePrice <= 0) fail("VALIDATION", "Indique um preço válido para o pacote.");
      if (sellByHalfPackage && halfPackagePrice <= 0) fail("VALIDATION", "Indique um preço válido para a meia embalagem.");
      if ((sellByPackage || sellByHalfPackage) && packageQtyMilli <= 0) {
        fail("VALIDATION", "Indique quantas unidades-base existem em cada pacote.");
      }
      if (["un", "cx", "pct"].includes(unit) && packageQtyMilli > 0 && packageQtyMilli % 1000 !== 0) {
        fail("VALIDATION", "A quantidade por pacote deve ser inteira para esta unidade.");
      }
      if (sellByHalfPackage && ["un", "cx", "pct"].includes(unit) && packageQtyMilli % 2000 !== 0) {
        fail("VALIDATION", "A meia embalagem deve corresponder a um número inteiro de unidades.");
      }
      if (!sellByUnit && !sellByPackage && !sellByHalfPackage) {
        fail("VALIDATION", "Active pelo menos um formato de venda.");
      }
      const barcodes = Array.isArray(payload.barcodes) ? payload.barcodes.map((b: string) => String(b).trim()).filter(Boolean) : [];
      const sku = String(payload.sku ?? "").trim() || `P-${uuid().slice(0, 6).toUpperCase()}`;
      const now = nowIso();
      const id = payload.id ? String(payload.id) : uuid();
      const searchText = norm(`${name} ${sku} ${color} ${barcodes.join(" ")} ${String(payload.categoryName ?? "")}`);
      db.exec("BEGIN IMMEDIATE");
      try {
        const before = payload.id ? one("SELECT * FROM products WHERE id = ?", [id]) : null;
        if (payload.id && !before) fail("NOT_FOUND", "Produto não encontrado.");
        if (before) {
          if (String(before.unit) !== unit) {
            const hasHistory = one(
              "SELECT id FROM stock_movements WHERE product_id = ? UNION ALL SELECT id FROM sale_items WHERE product_id = ? LIMIT 1",
              [id, id],
            );
            if (Number(before.stock_on_hand_milli ?? 0) !== 0 || hasHistory) {
              fail("UNIT_IMMUTABLE", "A unidade-base não pode ser alterada depois de registar stock ou vendas. Crie um produto novo.");
            }
          }
          run(
            `UPDATE products SET sku = ?, name = ?, color = ?, search_text = ?, category_id = ?, unit = ?, price_cents = ?, package_qty_milli = ?, package_price_cents = ?, half_package_price_cents = ?, sell_by_unit = ?, sell_by_package = ?, sell_by_half_package = ?, cost_cents = ?, tax_rate_bp = ?, track_stock = ?, low_stock_threshold_milli = ?, active = ?, updated_at = ? WHERE id = ?`,
            [
              sku,
              name,
              color,
              searchText,
              payload.categoryId || null,
              unit,
              price,
              packageQtyMilli,
              packagePrice,
              halfPackagePrice,
              sellByUnit,
              sellByPackage,
              sellByHalfPackage,
              cost,
              Number(payload.taxRateBp ?? 1600),
              payload.trackStock === false ? 0 : 1,
              Math.max(0, Math.trunc(Number(payload.lowStockThresholdMilli ?? 0))),
              payload.active === false ? 0 : 1,
              now,
              id,
            ],
          );
        } else {
          run(
            `INSERT INTO products (id, sku, name, color, search_text, category_id, unit, price_cents, package_qty_milli, package_price_cents, half_package_price_cents, sell_by_unit, sell_by_package, sell_by_half_package, cost_cents, tax_rate_bp, track_stock, stock_on_hand_milli, low_stock_threshold_milli, active, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
            [
              id,
              sku,
              name,
              color,
              searchText,
              payload.categoryId || null,
              unit,
              price,
              packageQtyMilli,
              packagePrice,
              halfPackagePrice,
              sellByUnit,
              sellByPackage,
              sellByHalfPackage,
              cost,
              Number(payload.taxRateBp ?? 1600),
              payload.trackStock === false ? 0 : 1,
              Math.max(0, Math.trunc(Number(payload.lowStockThresholdMilli ?? 0))),
              payload.active === false ? 0 : 1,
              now,
              now,
            ],
          );
        }
        run("DELETE FROM product_barcodes WHERE product_id = ?", [id]);
        for (const barcode of barcodes) {
          run("INSERT INTO product_barcodes (id, product_id, barcode, is_primary) VALUES (?, ?, ?, ?)", [uuid(), id, barcode, barcodes[0] === barcode ? 1 : 0]);
        }
        audit(
          before ? "product.updated" : "product.created",
          "product",
          id,
          before ? toProduct(before) : null,
          {
            name,
            sku,
            color,
            unit,
            priceCents: price,
            packageQtyMilli,
            packagePriceCents: packagePrice,
            halfPackagePriceCents: halfPackagePrice,
            costCents: cost,
            sellByUnit: Boolean(sellByUnit),
            sellByPackage: Boolean(sellByPackage),
            sellByHalfPackage: Boolean(sellByHalfPackage),
          },
          current.userId,
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        if (String(error).includes("UNIQUE")) fail("DUPLICATE", "Já existe um produto ou código de barras com esse valor.");
        throw error;
      }
      return { data: toProduct(productRows("WHERE p.id = ?", [id])[0]) };
    }
    case "product.delete": {
      const current = requireSession(["owner", "manager"]);
      const product = one("SELECT * FROM products WHERE id = ?", [String(payload.id ?? "")]);
      if (!product) fail("NOT_FOUND", "Produto não encontrado.");
      run("UPDATE products SET active = 0, deleted_at = ?, updated_at = ? WHERE id = ?", [nowIso(), nowIso(), product.id]);
      audit("product.deleted", "product", String(product.id), { active: true }, { active: false }, current.userId);
      return { data: { ok: true } };
    }
    case "stock.entry": {
      const current = requireSession(["owner", "manager"]);
      const product = one("SELECT * FROM products WHERE id = ? AND deleted_at IS NULL", [String(payload.productId ?? "")]);
      if (!product) fail("NOT_FOUND", "Produto não encontrado.");
      if (!toBool(product.track_stock)) fail("VALIDATION", "Este produto não controla stock.");
      const inputQtyMilli = Math.trunc(Number(payload.qtyMilli ?? 0));
      if (!Number.isSafeInteger(inputQtyMilli) || inputQtyMilli <= 0) fail("VALIDATION", "A quantidade tem de ser positiva.");
      const inputUnit = String(payload.inputUnit ?? "unit");
      if (inputUnit !== "unit" && inputUnit !== "package") fail("VALIDATION", "Formato de entrada inválido.");
      const packageQtyMilli = Number(product.package_qty_milli ?? 0);
      if (inputUnit === "package" && packageQtyMilli <= 0) fail("VALIDATION", "Este produto não tem conteúdo de pacote configurado.");
      const qty = inputUnit === "package" ? (inputQtyMilli * packageQtyMilli) / 1000 : inputQtyMilli;
      if (!Number.isSafeInteger(qty) || qty <= 0) fail("VALIDATION", "A quantidade convertida para stock é inválida.");
      if (["un", "cx", "pct"].includes(String(product.unit)) && qty % 1000 !== 0) {
        fail("VALIDATION", "A entrada deve corresponder a um número inteiro de unidades.");
      }
      const inputCost = Math.max(0, Math.trunc(Number(payload.unitCostCents ?? 0)));
      const cost = inputUnit === "package" ? Math.round((inputCost * 1000) / packageQtyMilli) : inputCost;
      const supplier = payload.supplierId ? one("SELECT * FROM suppliers WHERE id = ?", [payload.supplierId]) : null;
      const now = nowIso();
      db.exec("BEGIN IMMEDIATE");
      try {
        const before = Number(product.stock_on_hand_milli ?? 0);
        const after = before + qty;
        run("UPDATE products SET stock_on_hand_milli = ?, cost_cents = CASE WHEN ? > 0 THEN ? ELSE cost_cents END, updated_at = ? WHERE id = ?", [after, cost, cost, now, product.id]);
        run(
          `INSERT INTO stock_movements (id, product_id, type, qty_milli, balance_after_milli, unit_cost_cents, supplier_id, supplier_name_snapshot, document_ref, reason, sale_id, user_id, created_at)
           VALUES (?, ?, 'purchase_in', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
          [
            uuid(),
            product.id,
            qty,
            after,
            cost,
            supplier ? String(supplier.id) : null,
            supplier ? String(supplier.name) : null,
            payload.documentRef ? String(payload.documentRef).slice(0, 100) : null,
            `${inputUnit === "package" ? `Entrada de ${inputQtyMilli / 1000} pacote(s), convertida(s) para ${qty / 1000} ${product.unit}. ` : ""}${payload.note ? String(payload.note).slice(0, 220) : ""}`.trim() || null,
            current.userId,
            now,
          ],
        );
        audit("stock.entry", "product", String(product.id), { stock: before }, { stock: after, qty, cost }, current.userId);
        db.exec("COMMIT");
        return { data: { stockOnHandMilli: after } };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    case "stock.adjust": {
      const current = requireSession(["owner", "manager"]);
      const reason = String(payload.reason ?? "").trim();
      if (reason.length < 3) fail("VALIDATION", "Indique o motivo do ajuste.");
      const product = one("SELECT * FROM products WHERE id = ? AND deleted_at IS NULL", [String(payload.productId ?? "")]);
      if (!product) fail("NOT_FOUND", "Produto não encontrado.");
      const qty = Math.trunc(Number(payload.qtyMilli ?? 0));
      if (!Number.isFinite(qty) || qty === 0) fail("VALIDATION", "A quantidade do ajuste não pode ser zero.");
      const now = nowIso();
      db.exec("BEGIN IMMEDIATE");
      try {
        const before = Number(product.stock_on_hand_milli ?? 0);
        const after = before + qty;
        run("UPDATE products SET stock_on_hand_milli = ?, updated_at = ? WHERE id = ?", [after, now, product.id]);
        run(
          `INSERT INTO stock_movements (id, product_id, type, qty_milli, balance_after_milli, unit_cost_cents, supplier_id, supplier_name_snapshot, document_ref, reason, sale_id, user_id, created_at)
           VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, NULL, ?, ?)`,
          [uuid(), product.id, qty > 0 ? "adjustment_in" : "adjustment_out", qty, after, reason, current.userId, now],
        );
        audit("stock.adjusted", "product", String(product.id), { stock: before }, { stock: after, qty, reason }, current.userId);
        db.exec("COMMIT");
        return { data: { stockOnHandMilli: after } };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    case "stock.history": {
      requireSession();
      const productId = String(payload.productId ?? "");
      if (!productId) fail("VALIDATION", "Indique o produto.");
      return {
        data: rows(
          `SELECT m.*, p.name AS product_name, p.color AS product_color, u.display_name AS user_name FROM stock_movements m JOIN products p ON p.id = m.product_id LEFT JOIN users u ON u.id = m.user_id WHERE m.product_id = ? ORDER BY m.created_at DESC LIMIT 100`,
          [productId],
        ).map((row) => ({
          id: String(row.id),
          productId: String(row.product_id),
          productName: row.product_color ? `${row.product_name} · ${row.product_color}` : String(row.product_name),
          type: String(row.type),
          qtyMilli: Number(row.qty_milli),
          balanceAfterMilli: Number(row.balance_after_milli),
          unitCostCents: row.unit_cost_cents === null ? null : Number(row.unit_cost_cents),
          supplierName: row.supplier_name_snapshot ? String(row.supplier_name_snapshot) : null,
          documentRef: row.document_ref ? String(row.document_ref) : null,
          reason: row.reason ? String(row.reason) : null,
          createdAt: String(row.created_at),
          userName: row.user_name ? String(row.user_name) : null,
        })) as StockMovement[],
      };
    }
    case "stock.history.page": {
      requireSession();
      const productId = String(payload.productId ?? "");
      if (!productId) fail("VALIDATION", "Indique o produto.");
      const dateBinds: unknown[] = [];
      let dateWhere = "";
      if (payload.from) {
        dateWhere += " AND m.created_at >= ?";
        dateBinds.push(String(payload.from));
      }
      if (payload.to) {
        dateWhere += " AND m.created_at < ?";
        dateBinds.push(String(payload.to));
      }
      const total = Number(one(`SELECT COUNT(*) AS total FROM stock_movements m WHERE m.product_id = ?${dateWhere}`, [productId, ...dateBinds])?.total ?? 0);
      const requested = paginationInput(payload, 25);
      const page = resolvePage(requested.page, requested.pageSize, total);
      const movements = rows(
        `SELECT m.*, p.name AS product_name, p.color AS product_color, u.display_name AS user_name
         FROM stock_movements m JOIN products p ON p.id = m.product_id LEFT JOIN users u ON u.id = m.user_id
         WHERE m.product_id = ?${dateWhere} ORDER BY m.created_at DESC, m.rowid DESC LIMIT ? OFFSET ?`,
        [productId, ...dateBinds, requested.pageSize, (page - 1) * requested.pageSize],
      ).map((row) => ({
        id: String(row.id),
        productId: String(row.product_id),
        productName: row.product_color ? `${row.product_name} · ${row.product_color}` : String(row.product_name),
        type: String(row.type),
        qtyMilli: Number(row.qty_milli),
        balanceAfterMilli: Number(row.balance_after_milli),
        unitCostCents: row.unit_cost_cents === null ? null : Number(row.unit_cost_cents),
        supplierName: row.supplier_name_snapshot ? String(row.supplier_name_snapshot) : null,
        documentRef: row.document_ref ? String(row.document_ref) : null,
        reason: row.reason ? String(row.reason) : null,
        createdAt: String(row.created_at),
        userName: row.user_name ? String(row.user_name) : null,
      })) as StockMovement[];
      return {
        data: { items: movements, page, pageSize: requested.pageSize, total } satisfies PagedResult<StockMovement>,
      };
    }
    case "stock.low": {
      requireSession();
      return { data: lowStockProducts() };
    }
    case "stock.import.preview":
      return { data: previewStockImport(payload.items) };
    case "stock.import.check":
      return { data: checkStockImportDocument(payload.documentRef) };
    case "stock.import.commit":
      return { data: commitStockImport(payload) };
    case "customer.list": {
      requireSession();
      const query = norm(payload.query);
      const binds: unknown[] = [];
      let where = "WHERE c.deleted_at IS NULL";
      if (query) {
        where += " AND (lower(c.name) LIKE ? OR c.phone_normalized LIKE ? OR c.nif LIKE ?)";
        binds.push(`%${query}%`, `%${query}%`, `%${query}%`);
      }
      return {
        data: rows(`SELECT c.*${CUSTOMER_CREDIT_COLUMNS} FROM customers c ${where} ORDER BY c.name LIMIT 200`, binds).map((row) => ({
          id: String(row.id),
          name: String(row.name),
          phone: String(row.phone),
          nif: String(row.nif),
          email: String(row.email),
          address: String(row.address),
          notes: String(row.notes),
          creditBalanceCents: Number(row.credit_balance_cents ?? 0),
          creditSaleCount: Number(row.credit_sale_count ?? 0),
        })) as Customer[],
      };
    }
    case "customer.page": {
      requireSession();
      const query = norm(payload.query);
      const where = query
        ? "WHERE c.deleted_at IS NULL AND (lower(c.name) LIKE ? OR c.phone_normalized LIKE ? OR c.nif LIKE ?)"
        : "WHERE c.deleted_at IS NULL";
      const binds: unknown[] = query ? [`%${query}%`, `%${query}%`, `%${query}%`] : [];
      const total = Number(one(`SELECT COUNT(*) AS total FROM customers c ${where}`, binds)?.total ?? 0);
      const requested = paginationInput(payload, 12);
      const page = resolvePage(requested.page, requested.pageSize, total);
      const items = rows(
        `SELECT c.*${CUSTOMER_CREDIT_COLUMNS} FROM customers c ${where} ORDER BY c.name, c.id LIMIT ? OFFSET ?`,
        [...binds, requested.pageSize, (page - 1) * requested.pageSize],
      ).map((row) => ({
        id: String(row.id),
        name: String(row.name),
        phone: String(row.phone),
        nif: String(row.nif),
        email: String(row.email),
        address: String(row.address),
        notes: String(row.notes),
        creditBalanceCents: Number(row.credit_balance_cents ?? 0),
        creditSaleCount: Number(row.credit_sale_count ?? 0),
      })) as Customer[];
      return { data: { items, page, pageSize: requested.pageSize, total } satisfies PagedResult<Customer> };
    }
    case "customer.upsert": {
      const current = requireSession();
      const name = String(payload.name ?? "").trim();
      if (!name) fail("VALIDATION", "Indique o nome do cliente.");
      const nif = String(payload.nif ?? "").trim();
      if (nif && !/^\d{9}$/.test(nif)) fail("VALIDATION", "O NIF deve ter 9 dígitos.");
      const now = nowIso();
      const id = payload.id ? String(payload.id) : uuid();
      const before = payload.id ? one("SELECT * FROM customers WHERE id = ?", [id]) : null;
      if (payload.id && !before) fail("NOT_FOUND", "Cliente não encontrado.");
      if (before) {
        run("UPDATE customers SET name = ?, phone = ?, phone_normalized = ?, alt_phone = ?, nif = ?, email = ?, address = ?, notes = ?, updated_at = ? WHERE id = ?", [
          name,
          normalizePhone(payload.phone),
          digits(normalizePhone(payload.phone)),
          normalizePhone(payload.altPhone),
          nif,
          String(payload.email ?? "").trim(),
          String(payload.address ?? "").trim(),
          String(payload.notes ?? "").trim(),
          now,
          id,
        ]);
      } else {
        run("INSERT INTO customers (id, name, phone, phone_normalized, alt_phone, nif, email, address, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
          id,
          name,
          normalizePhone(payload.phone),
          digits(normalizePhone(payload.phone)),
          normalizePhone(payload.altPhone),
          nif,
          String(payload.email ?? "").trim(),
          String(payload.address ?? "").trim(),
          String(payload.notes ?? "").trim(),
          now,
          now,
        ]);
      }
      audit(before ? "customer.updated" : "customer.created", "customer", id, before ? { name: before.name } : null, { name }, current.userId);
      return { data: { id } };
    }
    case "customer.delete": {
      const current = requireSession(["owner", "manager"]);
      run("UPDATE customers SET deleted_at = ?, updated_at = ? WHERE id = ?", [nowIso(), nowIso(), String(payload.id ?? "")]);
      audit("customer.deleted", "customer", String(payload.id ?? ""), null, null, current.userId);
      return { data: { ok: true } };
    }
    case "supplier.list": {
      requireSession();
      const query = norm(payload.query);
      const binds: unknown[] = [];
      let where = "WHERE deleted_at IS NULL";
      if (query) {
        where += " AND (lower(name) LIKE ? OR lower(contact_name) LIKE ? OR nif LIKE ?)";
        binds.push(`%${query}%`, `%${query}%`, `%${query}%`);
      }
      return {
        data: rows(`SELECT * FROM suppliers ${where} ORDER BY name LIMIT 200`, binds).map((row) => ({
          id: String(row.id),
          name: String(row.name),
          contactName: String(row.contact_name),
          phone: String(row.phone),
          nif: String(row.nif),
          email: String(row.email),
          address: String(row.address),
          notes: String(row.notes),
          active: toBool(row.active),
        })) as Supplier[],
      };
    }
    case "supplier.page": {
      requireSession();
      const query = norm(payload.query);
      const where = query
        ? "WHERE deleted_at IS NULL AND (lower(name) LIKE ? OR lower(contact_name) LIKE ? OR nif LIKE ?)"
        : "WHERE deleted_at IS NULL";
      const binds: unknown[] = query ? [`%${query}%`, `%${query}%`, `%${query}%`] : [];
      const total = Number(one(`SELECT COUNT(*) AS total FROM suppliers ${where}`, binds)?.total ?? 0);
      const requested = paginationInput(payload, 12);
      const page = resolvePage(requested.page, requested.pageSize, total);
      const items = rows(
        `SELECT * FROM suppliers ${where} ORDER BY name, id LIMIT ? OFFSET ?`,
        [...binds, requested.pageSize, (page - 1) * requested.pageSize],
      ).map((row) => ({
        id: String(row.id),
        name: String(row.name),
        contactName: String(row.contact_name),
        phone: String(row.phone),
        nif: String(row.nif),
        email: String(row.email),
        address: String(row.address),
        notes: String(row.notes),
        active: toBool(row.active),
      })) as Supplier[];
      return { data: { items, page, pageSize: requested.pageSize, total } satisfies PagedResult<Supplier> };
    }
    case "supplier.upsert": {
      const current = requireSession(["owner", "manager"]);
      const name = String(payload.name ?? "").trim();
      if (!name) fail("VALIDATION", "Indique o nome do fornecedor.");
      const nif = String(payload.nif ?? "").trim();
      if (nif && !/^\d{9}$/.test(nif)) fail("VALIDATION", "O NIF deve ter 9 dígitos.");
      const now = nowIso();
      const id = payload.id ? String(payload.id) : uuid();
      const before = payload.id ? one("SELECT * FROM suppliers WHERE id = ?", [id]) : null;
      if (payload.id && !before) fail("NOT_FOUND", "Fornecedor não encontrado.");
      if (before) {
        run("UPDATE suppliers SET name = ?, contact_name = ?, phone = ?, nif = ?, email = ?, address = ?, notes = ?, active = ?, updated_at = ? WHERE id = ?", [
          name,
          String(payload.contactName ?? "").trim(),
          normalizePhone(payload.phone),
          nif,
          String(payload.email ?? "").trim(),
          String(payload.address ?? "").trim(),
          String(payload.notes ?? "").trim(),
          payload.active === false ? 0 : 1,
          now,
          id,
        ]);
      } else {
        run("INSERT INTO suppliers (id, name, contact_name, phone, nif, email, address, notes, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)", [
          id,
          name,
          String(payload.contactName ?? "").trim(),
          normalizePhone(payload.phone),
          nif,
          String(payload.email ?? "").trim(),
          String(payload.address ?? "").trim(),
          String(payload.notes ?? "").trim(),
          now,
          now,
        ]);
      }
      audit(before ? "supplier.updated" : "supplier.created", "supplier", id, before ? { name: before.name } : null, { name }, current.userId);
      return { data: { id } };
    }
    case "supplier.delete": {
      const current = requireSession(["owner", "manager"]);
      run("UPDATE suppliers SET active = 0, deleted_at = ?, updated_at = ? WHERE id = ?", [nowIso(), nowIso(), String(payload.id ?? "")]);
      audit("supplier.deleted", "supplier", String(payload.id ?? ""), null, null, current.userId);
      return { data: { ok: true } };
    }
    case "sale.quote": {
      const current = requireSession();
      return { data: buildQuote(payload, current) };
    }
    case "sale.complete":
      return { data: await completeSale(payload) };
    case "sale.page": {
      requireSession();
      const query = norm(payload.query);
      const binds: unknown[] = [];
      let where = "WHERE 1 = 1";
      if (query) {
        where += " AND (lower(s.receipt_number) LIKE ? OR lower(s.customer_name_snapshot) LIKE ?)";
        binds.push(`%${query}%`, `%${query}%`);
      }
      if (payload.from) {
        where += " AND s.created_at >= ?";
        binds.push(String(payload.from));
      }
      if (payload.to) {
        where += " AND s.created_at < ?";
        binds.push(String(payload.to));
      }
      if (payload.creditStatus === "pending") {
        where += ` AND ${SALE_OUTSTANDING_SQL} > 0`;
      } else if (payload.creditStatus === "settled") {
        where += ` AND s.is_credit = 1 AND s.status = 'completed' AND ${SALE_OUTSTANDING_SQL} = 0`;
      }
      const summary = one(
        `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN s.status = 'completed' THEN s.total_cents ELSE 0 END), 0) AS completed_total
         FROM sales s ${where}`,
        binds,
      );
      const total = Number(summary?.total ?? 0);
      const requested = paginationInput(payload, 25);
      const page = resolvePage(requested.page, requested.pageSize, total);
      const pageBinds = [...binds, requested.pageSize, (page - 1) * requested.pageSize];
      const items = rows(
        `SELECT s.id, s.receipt_number, s.status, s.cashier_name_snapshot, s.customer_name_snapshot, s.total_cents, s.created_at,
                s.is_credit, ${SALE_OUTSTANDING_SQL} AS outstanding_cents,
                (SELECT COUNT(*) FROM sale_items WHERE sale_id = s.id) AS item_count
         FROM sales s ${where} ORDER BY s.created_at DESC, s.rowid DESC LIMIT ? OFFSET ?`,
        pageBinds,
      ).map((row) => ({
        id: String(row.id),
        receiptNumber: String(row.receipt_number),
        status: row.status,
        cashierName: String(row.cashier_name_snapshot),
        customerName: row.customer_name_snapshot ? String(row.customer_name_snapshot) : null,
        totalCents: Number(row.total_cents),
        isCredit: toBool(row.is_credit),
        outstandingCents: Number(row.outstanding_cents),
        createdAt: String(row.created_at),
        itemCount: Number(row.item_count),
      })) as SaleSummary[];
      return {
        data: {
          items,
          page,
          pageSize: requested.pageSize,
          total,
          completedTotalCents: Number(summary?.completed_total ?? 0),
        } satisfies SalePageResult,
      };
    }
    case "sale.list": {
      requireSession();
      const query = norm(payload.query);
      const binds: unknown[] = [];
      let where = "WHERE 1 = 1";
      if (query) {
        where += " AND (lower(s.receipt_number) LIKE ? OR lower(s.customer_name_snapshot) LIKE ?)";
        binds.push(`%${query}%`, `%${query}%`);
      }
      if (payload.from) {
        where += " AND s.created_at >= ?";
        binds.push(String(payload.from));
      }
      if (payload.to) {
        where += " AND s.created_at < ?";
        binds.push(String(payload.to));
      }
      const limit = Math.min(500, Math.max(1, Math.trunc(Number(payload.limit ?? 100))));
      binds.push(limit);
      return {
        data: rows(
          `SELECT s.id, s.receipt_number, s.status, s.cashier_name_snapshot, s.customer_name_snapshot, s.total_cents, s.created_at,
                  s.is_credit, ${SALE_OUTSTANDING_SQL} AS outstanding_cents,
                  (SELECT COUNT(*) FROM sale_items WHERE sale_id = s.id) AS item_count
           FROM sales s ${where} ORDER BY s.created_at DESC LIMIT ?`,
          binds,
        ).map((row) => ({
          id: String(row.id),
          receiptNumber: String(row.receipt_number),
          status: row.status,
          cashierName: String(row.cashier_name_snapshot),
          customerName: row.customer_name_snapshot ? String(row.customer_name_snapshot) : null,
          totalCents: Number(row.total_cents),
          isCredit: toBool(row.is_credit),
          outstandingCents: Number(row.outstanding_cents),
          createdAt: String(row.created_at),
          itemCount: Number(row.item_count),
        })) as SaleSummary[],
      };
    }
    case "sale.get": {
      requireSession();
      const sale = toSale(String(payload.id ?? ""));
      if (!sale) fail("NOT_FOUND", "Venda não encontrada.");
      return { data: sale };
    }
    case "sale.void":
      return { data: await voidSale(String(payload.id ?? ""), String(payload.reason ?? ""), payload.approvalToken) };
    case "sale.settle":
      return { data: await settleSale(payload) };
    case "report.summary": {
      requireSession(["owner", "manager", "cashier"]);
      const fallbackRange = thisWeekRange();
      const from = String(payload.from ?? fallbackRange.from);
      const to = String(payload.to ?? fallbackRange.to);
      const totals = one(
        `SELECT COUNT(*) AS c, COALESCE(SUM(subtotal_cents),0) AS subtotal, COALESCE(SUM(discount_cents),0) AS discount, COALESCE(SUM(tax_cents),0) AS tax, COALESCE(SUM(total_cents),0) AS total
         FROM sales WHERE status = 'completed' AND created_at >= ? AND created_at < ?`,
        [from, to],
      );
      const count = Number(totals?.c ?? 0);
      const total = Number(totals?.total ?? 0);
      const byMethod = rows(
        `SELECT sp.method, COALESCE(SUM(sp.amount_cents),0) AS amount, COUNT(*) AS c FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id WHERE s.status = 'completed' AND s.created_at >= ? AND s.created_at < ? GROUP BY sp.method`,
        [from, to],
      ).map((row) => ({ method: String(row.method) as PaymentMethod, amountCents: Number(row.amount), count: Number(row.c) }));
      const expenseTotals = one(
        `SELECT COUNT(*) AS c, COALESCE(SUM(amount_cents),0) AS total FROM expenses WHERE deleted_at IS NULL AND spent_at >= ? AND spent_at < ?`,
        [from, to],
      );
      const expensesByCategory = rows(
        `SELECT category, COALESCE(SUM(amount_cents),0) AS amount, COUNT(*) AS c
         FROM expenses WHERE deleted_at IS NULL AND spent_at >= ? AND spent_at < ?
         GROUP BY category ORDER BY amount DESC`,
        [from, to],
      ).map((row) => ({ category: String(row.category) as ExpenseCategory, amountCents: Number(row.amount), count: Number(row.c) }));
      const dailyExpenses = rows(
        `SELECT strftime('%Y-%m-%d', datetime(spent_at, '+2 hours')) AS day, COUNT(*) AS c, COALESCE(SUM(amount_cents), 0) AS total
         FROM expenses WHERE deleted_at IS NULL AND spent_at >= ? AND spent_at < ?
         GROUP BY day ORDER BY day`,
        [from, to],
      ).map((row) => ({ date: String(row.day), totalCents: Number(row.total), count: Number(row.c) }));
      const expenseTotal = Number(expenseTotals?.total ?? 0);
      const topProducts = rows(
        `SELECT si.name_snapshot AS name, SUM(si.qty_milli) AS qty, SUM(si.total_cents) AS total FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.status = 'completed' AND s.created_at >= ? AND s.created_at < ? GROUP BY si.product_id, si.name_snapshot ORDER BY total DESC LIMIT 10`,
        [from, to],
      ).map((row) => ({ name: String(row.name), qtyMilli: Number(row.qty), totalCents: Number(row.total) }));
      const dailySales = rows(
        `SELECT strftime('%Y-%m-%d', datetime(created_at, '+2 hours')) AS day, COUNT(*) AS c, COALESCE(SUM(total_cents), 0) AS total
         FROM sales WHERE status = 'completed' AND created_at >= ? AND created_at < ?
         GROUP BY day ORDER BY day`,
        [from, to],
      ).map((row) => ({ date: String(row.day), totalCents: Number(row.total), count: Number(row.c) }));
      const credit = one(
        `SELECT COALESCE(SUM(CASE WHEN s.is_credit = 1 THEN 1 ELSE 0 END), 0) AS c,
                COALESCE(SUM(CASE WHEN s.is_credit = 1 THEN s.total_cents ELSE 0 END), 0) AS total,
                COALESCE(SUM(${SALE_OUTSTANDING_SQL}), 0) AS outstanding
         FROM sales s WHERE s.status = 'completed' AND s.created_at >= ? AND s.created_at < ?`,
        [from, to],
      );
      return {
        data: {
          from,
          to,
          salesCount: count,
          creditSalesCount: Number(credit?.c ?? 0),
          creditTotalCents: Number(credit?.total ?? 0),
          creditOutstandingCents: Number(credit?.outstanding ?? 0),
          subtotalCents: Number(totals?.subtotal ?? 0),
          discountCents: Number(totals?.discount ?? 0),
          taxCents: Number(totals?.tax ?? 0),
          totalCents: total,
          averageCents: count > 0 ? Math.round(total / count) : 0,
          byMethod,
          expenseCount: Number(expenseTotals?.c ?? 0),
          expenseTotalCents: expenseTotal,
          netResultCents: total - expenseTotal,
          expensesByCategory,
          dailyExpenses,
          topProducts,
          dailySales,
          lowStock: lowStockProducts(),
        } as ReportSummary,
      };
    }
    case "expense.page": {
      requireSession();
      const bind: unknown[] = [];
      let where = "WHERE e.deleted_at IS NULL";
      if (payload.from) {
        where += " AND e.spent_at >= ?";
        bind.push(String(payload.from));
      }
      if (payload.to) {
        where += " AND e.spent_at < ?";
        bind.push(String(payload.to));
      }
      const category = payload.category ? String(payload.category) : null;
      if (category && (EXPENSE_CATEGORIES as readonly string[]).includes(category)) {
        where += " AND e.category = ?";
        bind.push(category);
      }
      const query = norm(payload.query);
      for (const term of query.split(/\s+/).filter(Boolean)) {
        where += " AND e.search_text LIKE ?";
        bind.push(`%${term}%`);
      }
      const totals = one(`SELECT COUNT(*) AS c, COALESCE(SUM(e.amount_cents),0) AS total FROM expenses e ${where}`, bind);
      const total = Number(totals?.c ?? 0);
      const { page, pageSize } = paginationInput(payload);
      const current = resolvePage(page, pageSize, total);
      const items = rows(
        `${EXPENSE_SELECT} ${where} ORDER BY e.spent_at DESC, e.created_at DESC LIMIT ? OFFSET ?`,
        [...bind, pageSize, (current - 1) * pageSize],
      ).map(toExpense);
      return {
        data: { items, page: current, pageSize, total, totalCents: Number(totals?.total ?? 0) } as ExpensePageResult,
      };
    }
    case "expense.upsert":
      return { data: upsertExpense(payload) };
    case "expense.delete":
      return { data: deleteExpense(payload) };
    case "audit.list": {
      requireSession(["owner", "manager"]);
      const limit = Math.min(500, Math.max(1, Math.trunc(Number(payload.limit ?? 200))));
      return {
        data: rows(
          `SELECT a.*, u.display_name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.created_at DESC LIMIT ?`,
          [limit],
        ).map((row) => ({
          id: String(row.id),
          actorName: row.actor_name ? String(row.actor_name) : null,
          action: String(row.action),
          entityType: String(row.entity_type),
          entityId: row.entity_id ? String(row.entity_id) : null,
          createdAt: String(row.created_at),
          beforeJson: row.before_json ? String(row.before_json) : null,
          afterJson: row.after_json ? String(row.after_json) : null,
        })) as AuditEntry[],
      };
    }
    case "audit.page": {
      requireSession(["owner", "manager"]);
      const query = norm(payload.query);
      const actionMatches = Array.isArray(payload.actionMatches)
        ? payload.actionMatches.map((action: unknown) => String(action)).slice(0, 100)
        : [];
      const binds: unknown[] = [];
      const filters: string[] = [];
      if (query || actionMatches.length > 0) {
        const predicates = [
          "lower(a.action) LIKE ?",
          "lower(a.entity_type) LIKE ?",
          "lower(COALESCE(a.entity_id, '')) LIKE ?",
          "lower(COALESCE(u.display_name, '')) LIKE ?",
        ];
        binds.push(...Array(4).fill(`%${query}%`));
        if (actionMatches.length > 0) {
          predicates.push(`a.action IN (${actionMatches.map(() => "?").join(",")})`);
          binds.push(...actionMatches);
        }
        filters.push(`(${predicates.join(" OR ")})`);
      }
      if (payload.from) {
        filters.push("a.created_at >= ?");
        binds.push(String(payload.from));
      }
      if (payload.to) {
        filters.push("a.created_at < ?");
        binds.push(String(payload.to));
      }
      const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
      const joins = "FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id";
      const total = Number(one(`SELECT COUNT(*) AS total ${joins} ${where}`, binds)?.total ?? 0);
      const requested = paginationInput(payload, 25);
      const page = resolvePage(requested.page, requested.pageSize, total);
      const entries = rows(
        `SELECT a.*, u.display_name AS actor_name ${joins} ${where}
         ORDER BY a.created_at DESC, a.rowid DESC LIMIT ? OFFSET ?`,
        [...binds, requested.pageSize, (page - 1) * requested.pageSize],
      ).map((row) => ({
        id: String(row.id),
        actorName: row.actor_name ? String(row.actor_name) : null,
        action: String(row.action),
        entityType: String(row.entity_type),
        entityId: row.entity_id ? String(row.entity_id) : null,
        createdAt: String(row.created_at),
        beforeJson: row.before_json ? String(row.before_json) : null,
        afterJson: row.after_json ? String(row.after_json) : null,
      })) as AuditEntry[];
      return {
        data: { items: entries, page, pageSize: requested.pageSize, total } satisfies PagedResult<AuditEntry>,
      };
    }
    case "backup.info": {
      requireSession(["owner", "manager"]);
      const info: BackupInfo = {
        lastBackupAt: meta("last_backup_at"),
        lastAutoBackupAt: meta("last_auto_backup_at"),
        backups: await listBackups(),
      };
      return { data: info };
    }
    case "backup.export": {
      const result = await exportBackup();
      return { data: result, transfer: [result.bytes] };
    }
    case "backup.auto":
      return { data: await createAutoBackup() };
    case "backup.import":
      return { data: await importBackup(payload) };
    default:
      fail("UNKNOWN_COMMAND", `Comando desconhecido: ${(req as any).type}`);
  }
}

self_.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  if (!req || typeof req.id !== "string" || typeof req.type !== "string") return;
  try {
    const { data, transfer } = await handleRequest(req);
    self_.postMessage({ id: req.id, ok: true, data }, transfer ?? []);
  } catch (error) {
    const appError = error instanceof AppError ? error : null;
    const code = appError?.code ?? "INTERNAL";
    const message = appError?.message ?? (error instanceof Error ? error.message : "Erro inesperado no worker.");
    self_.postMessage({ id: req.id, ok: false, error: { code, message } });
  }
};

export {};
