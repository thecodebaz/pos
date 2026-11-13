"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, RefreshCw, Search } from "lucide-react";
import { useApp, errorMessage } from "@/lib/app-context";
import type { AuditEntry, PagedResult } from "@/lib/db/protocol";
import { formatDateTime } from "@/lib/format";
import { Badge, EmptyState, Field, LoadingPanel, Note, PageHeader, Select } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PaginationControls } from "@/components/pagination-controls";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const DEFAULT_PAGE_SIZE = 25;

const ACTION_LABELS: Record<string, string> = {
  "setup.completed": "Instalação criada",
  "auth.login": "Entrada",
  "auth.login_failed": "Entrada falhada",
  "auth.logout": "Saída",
  "auth.pin_changed": "PIN alterado",
  "auth.recovery_failed": "Recuperação falhada",
  "auth.recovery_used": "Recuperação do proprietário",
  "approval.granted": "Aprovação concedida",
  "settings.updated": "Definições alteradas",
  "user.created": "Utilizador criado",
  "user.updated": "Utilizador actualizado",
  "user.pin_reset": "PIN redefinido",
  "category.created": "Categoria criada",
  "category.updated": "Categoria actualizada",
  "product.created": "Produto criado",
  "product.updated": "Produto actualizado",
  "product.deleted": "Produto desactivado",
  "stock.entry": "Entrada de stock",
  "stock.adjusted": "Ajuste de stock",
  "customer.created": "Cliente criado",
  "customer.updated": "Cliente actualizado",
  "customer.deleted": "Cliente eliminado",
  "supplier.created": "Fornecedor criado",
  "supplier.updated": "Fornecedor actualizado",
  "supplier.deleted": "Fornecedor eliminado",
  "sale.completed": "Venda concluída",
  "sale.voided": "Venda anulada",
  "backup.exported": "Backup exportado",
  "backup.imported": "Backup importado",
};

function actionLabel(action: string) {
  return ACTION_LABELS[action] ?? action;
}

function actionTone(action: string): "neutral" | "success" | "warning" | "danger" | "info" {
  if (action.endsWith("_failed") || action.includes("voided") || action.includes("deleted")) return "danger";
  if (action.includes("recovery") || action.includes("imported")) return "warning";
  if (action.includes("created") || action.includes("completed")) return "success";
  if (action.startsWith("stock.") || action.startsWith("auth.") || action.startsWith("approval.")) return "info";
  return "neutral";
}

function pretty(value: string | null) {
  if (!value) return null;
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

export function AuditScreen() {
  const { call, toast } = useApp();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pageSize, setPageSize] = useState(String(DEFAULT_PAGE_SIZE));
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);

  const actionMatches = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return [];
    return Object.entries(ACTION_LABELS)
      .filter(([, label]) => label.toLowerCase().includes(term))
      .map(([action]) => action);
  }, [query]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await call<PagedResult<AuditEntry>>("audit.page", {
        page,
        pageSize: Number(pageSize),
        query,
        actionMatches,
      });
      setEntries(result.items);
      setTotal(result.total);
      if (result.page !== page) setPage(result.page);
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setLoading(false);
    }
  }, [actionMatches, call, page, pageSize, query, toast]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), query ? 200 : 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const pageCount = Math.max(1, Math.ceil(total / Number(pageSize)));
  const currentPage = Math.min(page, pageCount);

  return (
    <div>
      <PageHeader
        title="Auditoria"
        description="Registo imutável das operações: vendas, anulações, stock, utilizadores e alterações de configuração."
        actions={
          <Button variant="outline" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="size-4" /> Actualizar
          </Button>
        }
      />

      <div className="mb-3 grid gap-2 sm:grid-cols-[1fr_10rem]">
        <Field label="Pesquisar" htmlFor="auditSearch">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="auditSearch"
              value={query}
              onChange={(event) => { setQuery(event.target.value); setPage(1); }}
              placeholder="Acção, utilizador, entidade…"
              className="pl-8"
            />
          </div>
        </Field>
        <Field label="Registos por página" htmlFor="auditPageSize">
          <Select id="auditPageSize" value={pageSize} onChange={(event) => { setPageSize(event.target.value); setPage(1); }}>
            <option value="25">25</option>
            <option value="50">50</option>
            <option value="100">100</option>
          </Select>
        </Field>
      </div>

      {loading ? (
        <LoadingPanel label="A carregar auditoria…" />
      ) : entries.length === 0 ? (
        <EmptyState title="Sem registos" description="As operações realizadas na aplicação aparecem aqui." />
      ) : (
        <>
          <div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>Data</TableHead>
                  <TableHead>Acção</TableHead>
                  <TableHead>Entidade</TableHead>
                  <TableHead>Utilizador</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry) => {
                  const open = expanded === entry.id;
                  const before = pretty(entry.beforeJson);
                  const after = pretty(entry.afterJson);
                  return (
                    <Fragment key={entry.id}>
                      <TableRow
                        className="cursor-pointer"
                        onClick={() => setExpanded(open ? null : entry.id)}
                      >
                        <TableCell className="text-muted-foreground">
                          {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                        </TableCell>
                        <TableCell className="text-xs whitespace-nowrap text-muted-foreground">{formatDateTime(entry.createdAt)}</TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-0.5">
                            <Badge tone={actionTone(entry.action)}>{actionLabel(entry.action)}</Badge>
                            <span className="font-mono text-[10px] text-muted-foreground">{entry.action}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <p className="text-sm">{entry.entityType}</p>
                          {entry.entityId ? <p className="font-mono text-[10px] text-muted-foreground">{entry.entityId.slice(0, 8)}</p> : null}
                        </TableCell>
                        <TableCell className="text-sm">{entry.actorName ?? "Sistema"}</TableCell>
                      </TableRow>
                      {open ? (
                        <TableRow>
                          <TableCell colSpan={5} className="bg-muted/40">
                            {before || after ? (
                              <div className="grid gap-2 lg:grid-cols-2">
                                {before ? <JsonBlock title="Antes" value={before} /> : null}
                                {after ? <JsonBlock title="Depois" value={after} /> : null}
                              </div>
                            ) : (
                              <Note tone="info">Este registo não contém dados adicionais.</Note>
                            )}
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <PaginationControls page={currentPage} pageSize={Number(pageSize)} total={total} itemLabel="registos" onPageChange={(nextPage) => { setPage(nextPage); setExpanded(null); }} />
        </>
      )}
    </div>
  );
}

function JsonBlock({ title, value }: { title: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="mb-1 text-xs font-semibold text-muted-foreground">{title}</p>
      <pre className="max-h-64 overflow-auto rounded-lg bg-background p-2 font-mono text-[11px] leading-relaxed ring-1 ring-foreground/10">
        {value}
      </pre>
    </div>
  );
}
