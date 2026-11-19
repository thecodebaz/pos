"use client";

import type {
  AppStatus,
  AuditEntry,
  BackupInfo,
  Category,
  Customer,
  Expense,
  ExpensePageResult,
  PaymentMethod,
  Product,
  Quote,
  QuoteInput,
  ReportSummary,
  RequestType,
  Sale,
  SaleInput,
  SaleSummary,
  StockEntryUnit,
  SessionInfo,
  Settings,
  StockMovement,
  Supplier,
  UserPublic,
  WorkerResponse,
} from "./protocol";

export class ApiError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: ApiError) => void;
  timer: ReturnType<typeof setTimeout>;
};

const WORKER_URL = "/workers/sqlite.worker.js";
const DEFAULT_TIMEOUT = 60_000;

class DbClient {
  private worker: Worker | null = null;
  private pending = new Map<string, Pending>();

  private async withStorageStatus(status: AppStatus): Promise<AppStatus> {
    if (typeof navigator === "undefined" || !navigator.storage?.persisted) {
      return { ...status, storagePersisted: null };
    }

    try {
      return { ...status, storagePersisted: await navigator.storage.persisted() };
    } catch {
      return { ...status, storagePersisted: null };
    }
  }

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(WORKER_URL, { type: "module" });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (!message || typeof message.id !== "string") return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.data);
      else pending.reject(new ApiError(message.error.code, message.error.message));
    };
    worker.onerror = () => {
      this.failAll(new ApiError("WORKER_ERROR", "O motor da base de dados falhou. Recarregue a aplicação."));
    };
    worker.onmessageerror = () => {
      this.failAll(new ApiError("WORKER_ERROR", "Não foi possível ler a resposta da base de dados."));
    };
    this.worker = worker;
    return worker;
  }

  private failAll(error: ApiError) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.worker = null;
  }

  request<T>(type: RequestType, payload?: unknown, token?: string | null, timeout = DEFAULT_TIMEOUT): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let worker: Worker;
      try {
        worker = this.ensure();
      } catch {
        reject(new ApiError("WORKER_UNAVAILABLE", "Este browser não suporta Web Workers."));
        return;
      }
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ApiError("TIMEOUT", "A operação demorou demasiado tempo. Tente novamente."));
      }, timeout);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      worker.postMessage({ id, type, token: token ?? null, payload: payload ?? {} });
    });
  }

  // ---- App / sessão -------------------------------------------------------

  async init(): Promise<AppStatus> {
    const status = await this.request<AppStatus>("app.init", {}, null, 120_000);
    return this.withStorageStatus(status);
  }

  async status(): Promise<AppStatus> {
    const status = await this.request<AppStatus>("app.status");
    return this.withStorageStatus(status);
  }

  setup(payload: {
    storeName: string;
    nif?: string;
    address?: string;
    phone?: string;
    receiptFooter?: string;
    installationCode?: string;
    ownerName: string;
    username: string;
    pin: string;
  }): Promise<SessionInfo & { recoveryCode: string }> {
    return this.request("setup.create", payload, null, 120_000);
  }

  listLoginUsers(): Promise<UserPublic[]> {
    return this.request<UserPublic[]>("auth.users");
  }

  login(userId: string, pin: string): Promise<SessionInfo> {
    return this.request<SessionInfo>("auth.login", { userId, pin }, null, 120_000);
  }

  logout(token: string): Promise<{ ok: boolean }> {
    return this.request("auth.logout", {}, token);
  }

  lock(token: string): Promise<{ ok: boolean }> {
    return this.request("auth.lock", {}, token);
  }

  recoverOwner(code: string, newPin: string): Promise<{ recoveryCode: string }> {
    return this.request("auth.recoverOwner", { code, newPin }, null, 120_000);
  }

  changePin(token: string, currentPin: string, newPin: string): Promise<{ ok: boolean }> {
    return this.request("auth.changePin", { currentPin, newPin }, token, 120_000);
  }

  requestApproval(
    token: string,
    payload: { username: string; pin: string; action: string; amountCents?: number; entityType?: string; entityId?: string },
  ): Promise<{ token: string; approverName: string; expiresAt: string }> {
    return this.request("approval.request", payload, token, 120_000);
  }

  updateSettings(token: string, payload: Partial<Settings>): Promise<Settings> {
    return this.request("settings.update", payload, token);
  }

  // ---- Utilizadores -------------------------------------------------------

  listUsers(token: string): Promise<UserPublic[]> {
    return this.request<UserPublic[]>("user.list", {}, token);
  }

  createUser(
    token: string,
    payload: { username: string; displayName: string; role: string; pin: string; loginShortcut?: number | null },
  ): Promise<UserPublic> {
    return this.request("user.create", payload, token, 120_000);
  }

  updateUser(
    token: string,
    payload: { id: string; displayName?: string; role?: string; active?: boolean; loginShortcut?: number | null },
  ): Promise<UserPublic> {
    return this.request("user.update", payload, token);
  }

  resetPin(token: string, id: string, pin: string): Promise<{ ok: boolean }> {
    return this.request("user.resetPin", { id, pin }, token, 120_000);
  }

  // ---- Catálogo -----------------------------------------------------------

  listCategories(token: string): Promise<Category[]> {
    return this.request<Category[]>("category.list", {}, token);
  }

  upsertCategory(token: string, payload: { id?: string; name: string; sortOrder?: number }): Promise<Category> {
    return this.request("category.upsert", payload, token);
  }

  listProducts(
    token: string,
    payload: { query?: string; categoryId?: string | null; activeOnly?: boolean } = {},
  ): Promise<Product[]> {
    return this.request<Product[]>("product.list", payload, token);
  }

  upsertProduct(token: string, payload: Record<string, unknown>): Promise<Product> {
    return this.request("product.upsert", payload, token);
  }

  deleteProduct(token: string, id: string): Promise<{ ok: boolean }> {
    return this.request("product.delete", { id }, token);
  }

  // ---- Stock --------------------------------------------------------------

  stockEntry(
    token: string,
    payload: { productId: string; qtyMilli: number; inputUnit?: StockEntryUnit; unitCostCents?: number; supplierId?: string | null; documentRef?: string; note?: string },
  ): Promise<{ stockOnHandMilli: number }> {
    return this.request("stock.entry", payload, token);
  }

  stockAdjust(token: string, payload: { productId: string; qtyMilli: number; reason: string }): Promise<{ stockOnHandMilli: number }> {
    return this.request("stock.adjust", payload, token);
  }

  stockHistory(token: string, productId: string): Promise<StockMovement[]> {
    return this.request<StockMovement[]>("stock.history", { productId }, token);
  }

  lowStock(token: string): Promise<Product[]> {
    return this.request<Product[]>("stock.low", {}, token);
  }

  // ---- Clientes / fornecedores -------------------------------------------

  listCustomers(token: string, query?: string): Promise<Customer[]> {
    return this.request<Customer[]>("customer.list", { query }, token);
  }

  upsertCustomer(token: string, payload: Record<string, unknown>): Promise<{ id: string }> {
    return this.request("customer.upsert", payload, token);
  }

  deleteCustomer(token: string, id: string): Promise<{ ok: boolean }> {
    return this.request("customer.delete", { id }, token);
  }

  listSuppliers(token: string, query?: string): Promise<Supplier[]> {
    return this.request<Supplier[]>("supplier.list", { query }, token);
  }

  upsertSupplier(token: string, payload: Record<string, unknown>): Promise<{ id: string }> {
    return this.request("supplier.upsert", payload, token);
  }

  deleteSupplier(token: string, id: string): Promise<{ ok: boolean }> {
    return this.request("supplier.delete", { id }, token);
  }

  // ---- Vendas -------------------------------------------------------------

  quote(token: string, payload: QuoteInput): Promise<Quote> {
    return this.request<Quote>("sale.quote", payload, token);
  }

  completeSale(token: string, payload: SaleInput): Promise<Sale> {
    return this.request<Sale>("sale.complete", payload, token, 120_000);
  }

  listSales(
    token: string,
    payload: { query?: string; from?: string; to?: string; limit?: number } = {},
  ): Promise<SaleSummary[]> {
    return this.request<SaleSummary[]>("sale.list", payload, token);
  }

  getSale(token: string, id: string): Promise<Sale> {
    return this.request<Sale>("sale.get", { id }, token);
  }

  voidSale(token: string, id: string, reason: string, approvalToken?: string | null): Promise<Sale> {
    return this.request<Sale>("sale.void", { id, reason, approvalToken }, token, 120_000);
  }

  settleSale(
    token: string,
    payload: {
      id: string;
      amountCents: number;
      method: PaymentMethod;
      reference?: string | null;
      note?: string | null;
    },
  ): Promise<Sale> {
    return this.request<Sale>("sale.settle", payload, token, 120_000);
  }

  // ---- Relatórios / auditoria / backup -----------------------------------

  reportSummary(token: string, from: string, to: string): Promise<ReportSummary> {
    return this.request<ReportSummary>("report.summary", { from, to }, token);
  }

  listExpenses(
    token: string,
    payload: {
      from?: string;
      to?: string;
      category?: string;
      query?: string;
      page?: number;
      pageSize?: number;
    } = {},
  ): Promise<ExpensePageResult> {
    return this.request<ExpensePageResult>("expense.page", payload, token);
  }

  upsertExpense(token: string, payload: Record<string, unknown>): Promise<Expense> {
    return this.request<Expense>("expense.upsert", payload, token);
  }

  deleteExpense(token: string, id: string): Promise<{ id: string }> {
    return this.request<{ id: string }>("expense.delete", { id }, token);
  }

  listAudit(token: string, limit = 200): Promise<AuditEntry[]> {
    return this.request<AuditEntry[]>("audit.list", { limit }, token);
  }

  backupInfo(token: string): Promise<BackupInfo> {
    return this.request<BackupInfo>("backup.info", {}, token);
  }

  exportBackup(token: string): Promise<{ bytes: ArrayBuffer; filename: string; size: number }> {
    return this.request("backup.export", {}, token, 120_000);
  }

  importBackup(token: string, bytes: ArrayBuffer, pin: string): Promise<{ reload: boolean }> {
    return this.request("backup.import", { bytes, pin }, token, 300_000);
  }
}

export const db = new DbClient();
