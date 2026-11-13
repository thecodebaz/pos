"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, HardDriveDownload, RefreshCw, Upload } from "lucide-react";
import { useApp, errorMessage } from "@/lib/app-context";
import type { BackupInfo } from "@/lib/db/protocol";
import { formatBytes, formatDateTime } from "@/lib/format";
import { Badge, Field, LoadingPanel, Note, PageHeader } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export function BackupScreen() {
  const { call, toast, refreshStatus } = useApp();
  const [info, setInfo] = useState<BackupInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [pin, setPin] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setInfo(await call<BackupInfo>("backup.info", {}));
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setLoading(false);
    }
  }, [call, toast]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function exportBackup() {
    setExporting(true);
    try {
      const result = await call<{ bytes: ArrayBuffer; filename: string; size: number }>("backup.export", {});
      const blob = new Blob([result.bytes], { type: "application/vnd.sqlite3" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = result.filename;
      link.click();
      URL.revokeObjectURL(url);
      toast(`Backup exportado (${formatBytes(result.size)}).`, "success");
      await load();
      await refreshStatus();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setExporting(false);
    }
  }

  async function importBackup(event: React.FormEvent) {
    event.preventDefault();
    if (!file || !confirmed) return;
    setImporting(true);
    setError(null);
    try {
      const bytes = await file.arrayBuffer();
      await call("backup.import", { bytes, pin, filename: file.name });
      toast("Backup importado. A recarregar…", "success");
      window.setTimeout(() => window.location.reload(), 1200);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setImporting(false);
    }
  }

  if (loading) return <LoadingPanel label="A carregar informação de backup…" />;

  return (
    <div className="max-w-4xl">
      <PageHeader
        title="Backup e restauro"
        description="Exporte a base SQLite completa e restaure-a noutro dispositivo. Faça backups regulares."
        actions={
          <Button variant="outline" onClick={() => void load()}>
            <RefreshCw className="size-4" /> Actualizar
          </Button>
        }
      />

      <div className="grid gap-4">
        <Note tone="warning">
          O ficheiro exportado contém todos os dados da loja, incluindo hashes de PIN. Guarde-o num local seguro. Não é um
          backup encriptado; recomenda-se disco encriptado e cópia offline.
        </Note>
        <Note>
          A aplicação cria uma cópia automática local a cada 6 horas enquanto estiver aberta. As cópias ficam no OPFS deste
          browser e não substituem a exportação para outro dispositivo ou suporte.
        </Note>

        <div className="rounded-xl bg-card p-4 ring-1 ring-foreground/10">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="flex items-center gap-2 text-sm font-semibold">
                <HardDriveDownload className="size-4 text-emerald-600" /> Exportar base actual
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Último backup exportado: {info?.lastBackupAt ? formatDateTime(info.lastBackupAt) : "nunca"}
                <br />
                Último backup automático local: {info?.lastAutoBackupAt ? formatDateTime(info.lastAutoBackupAt) : "pendente"}
              </p>
            </div>
            <Button onClick={() => void exportBackup()} disabled={exporting}>
              <Download className="size-4" /> {exporting ? "A exportar…" : "Exportar .db"}
            </Button>
          </div>
        </div>

        <div className="rounded-xl bg-card p-4 ring-1 ring-foreground/10">
          <p className="flex items-center gap-2 text-sm font-semibold">
            <Upload className="size-4 text-emerald-600" /> Restaurar de um ficheiro
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            A base actual é substituída. Antes disso é criada uma cópia automática em OPFS (backups/pre-import-…).
          </p>
          <form className="mt-3 space-y-3" onSubmit={importBackup}>
            <Field label="Ficheiro SQLite (.db)" htmlFor="backupFile">
              <Input
                id="backupFile"
                ref={fileRef}
                type="file"
                accept=".db,.sqlite,.sqlite3,application/vnd.sqlite3,application/octet-stream"
                onChange={(event) => {
                  setFile(event.target.files?.[0] ?? null);
                  setConfirmed(false);
                  setError(null);
                }}
              />
            </Field>
            <Field label="PIN do proprietário" htmlFor="backupPin" hint="Confirma que é uma operação autorizada.">
              <Input
                id="backupPin"
                type="password"
                inputMode="numeric"
                maxLength={6}
                value={pin}
                onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
              />
            </Field>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5 size-4" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
              <span>Compreendo que a base actual será substituída e que a aplicação será recarregada.</span>
            </label>
            {error ? <Note tone="danger">{error}</Note> : null}
            <Button type="submit" variant="destructive" disabled={!file || !confirmed || pin.length !== 6 || importing}>
              {importing ? "A importar e validar…" : "Importar e substituir base"}
            </Button>
          </form>
        </div>

        <div className="rounded-xl bg-card ring-1 ring-foreground/10">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <p className="text-sm font-semibold">Cópias em OPFS</p>
            <Badge tone="neutral">{info?.backups.length ?? 0}</Badge>
          </div>
          {!info || info.backups.length === 0 ? (
            <p className="px-3 py-6 text-sm text-muted-foreground">Ainda não existem cópias internas.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ficheiro</TableHead>
                  <TableHead className="text-right">Tamanho</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {info.backups.map((backup) => (
                  <TableRow key={backup.name}>
                    <TableCell className="font-mono text-xs">{backup.name}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatBytes(backup.sizeBytes)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>
    </div>
  );
}
