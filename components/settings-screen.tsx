"use client";

import { useEffect, useState } from "react";
import { Database, KeyRound, Save, ShieldCheck, Trash2 } from "lucide-react";
import { useApp, errorMessage } from "@/lib/app-context";
import type { Settings } from "@/lib/db/protocol";
import { formatBytes, formatDateTime } from "@/lib/format";
import { Badge, Field, Note, PageHeader, Select } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function SettingsScreen() {
  const { session, status, call, toast, updateSettings, refreshStatus } = useApp();
  const settings = session?.settings;

  const [form, setForm] = useState(() => ({
    storeName: settings?.storeName ?? "",
    nif: settings?.nif ?? "",
    address: settings?.address ?? "",
    phone: settings?.phone ?? "",
    receiptFooter: settings?.receiptFooter ?? "",
    installationCode: settings?.installationCode ?? "T01",
    allowNegativeStock: settings?.allowNegativeStock ?? true,
    maxCashierDiscount: String(((settings?.maxCashierDiscountBp ?? 500) / 100).toFixed(1)).replace(".", ","),
    discountApprovalMode: settings?.discountApprovalMode ?? "above_limit",
    idleMinutes: String(Math.round((settings?.idleLockSeconds ?? 300) / 60)),
  }));
  const [saving, setSaving] = useState(false);

  const [pinForm, setPinForm] = useState({ current: "", next: "", confirm: "" });
  const [pinBusy, setPinBusy] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);

  const [purgePin, setPurgePin] = useState("");
  const [purgeConfirmation, setPurgeConfirmation] = useState("");
  const [purgeConfirmed, setPurgeConfirmed] = useState(false);
  const [purgeBusy, setPurgeBusy] = useState(false);
  const [purgeError, setPurgeError] = useState<string | null>(null);
  const [purgeResult, setPurgeResult] = useState<{
    backupName: string;
    deleted: { products: number; stockMovements: number; sales: number; auditEntries: number };
  } | null>(null);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  if (!settings) return null;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const percent = Number(form.maxCashierDiscount.replace(",", "."));
      const updated = await call<Settings>("settings.update", {
        storeName: form.storeName,
        nif: form.nif,
        address: form.address,
        phone: form.phone,
        receiptFooter: form.receiptFooter,
        installationCode: form.installationCode,
        allowNegativeStock: form.allowNegativeStock,
        maxCashierDiscountBp: Math.round((Number.isFinite(percent) ? percent : 5) * 100),
        discountApprovalMode: form.discountApprovalMode,
        idleLockSeconds: Math.max(1, Number(form.idleMinutes) || 5) * 60,
      });
      updateSettings(updated);
      await refreshStatus();
      toast("Definições guardadas.", "success");
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setSaving(false);
    }
  }

  async function changePin(event: React.FormEvent) {
    event.preventDefault();
    if (pinForm.next !== pinForm.confirm) {
      setPinError("Os PINs novos não coincidem.");
      return;
    }
    setPinBusy(true);
    setPinError(null);
    try {
      await call("auth.changePin", { currentPin: pinForm.current, newPin: pinForm.next });
      setPinForm({ current: "", next: "", confirm: "" });
      toast("PIN alterado.", "success");
    } catch (err) {
      setPinError(errorMessage(err));
    } finally {
      setPinBusy(false);
    }
  }

  async function purgeData(event: React.FormEvent) {
    event.preventDefault();
    if (session?.user.role !== "owner" || purgeConfirmation !== "ELIMINAR" || purgePin.length !== 6 || !purgeConfirmed) return;
    setPurgeBusy(true);
    setPurgeError(null);
    setPurgeResult(null);
    try {
      const result = await call<{
        backupName: string;
        deleted: { products: number; stockMovements: number; sales: number; auditEntries: number };
      }>("data.purge", { pin: purgePin, confirmation: purgeConfirmation });
      setPurgeResult(result);
      setPurgePin("");
      setPurgeConfirmation("");
      setPurgeConfirmed(false);
      await refreshStatus();
      toast("Dados operacionais eliminados. Foi criado um backup prévio.", "success");
    } catch (err) {
      setPurgeError(errorMessage(err));
    } finally {
      setPurgeBusy(false);
    }
  }

  async function requestPersist() {
    try {
      const granted = await navigator.storage?.persist?.();
      await refreshStatus();
      toast(granted ? "Armazenamento persistente concedido." : "O browser não concedeu persistência. Faça backups regulares.", granted ? "success" : "error");
    } catch {
      toast("Não foi possível pedir persistência ao browser.", "error");
    }
  }

  return (
    <div className="max-w-4xl">
      <PageHeader title="Definições" description="Identificação da loja, recibos, segurança e diagnóstico do dispositivo." />

      <div className="grid gap-4">
        <form className="rounded-xl bg-card p-4 ring-1 ring-foreground/10" onSubmit={save}>
          <p className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <ShieldCheck className="size-4 text-emerald-600" /> Loja e recibos
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Nome da loja *" htmlFor="settingsStore" className="sm:col-span-2">
              <Input id="settingsStore" required value={form.storeName} onChange={(event) => setForm({ ...form, storeName: event.target.value })} />
            </Field>
            <Field label="NUIT" htmlFor="settingsNif">
              <Input id="settingsNif" inputMode="numeric" maxLength={9} value={form.nif} onChange={(event) => setForm({ ...form, nif: event.target.value })} />
            </Field>
            <Field label="Telefone" htmlFor="settingsPhone">
              <Input id="settingsPhone" value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} />
            </Field>
            <Field label="Endereço" htmlFor="settingsAddress" className="sm:col-span-2">
              <Input id="settingsAddress" value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })} />
            </Field>
            <Field label="Rodapé do recibo" htmlFor="settingsFooter" className="sm:col-span-2">
              <Input id="settingsFooter" value={form.receiptFooter} onChange={(event) => setForm({ ...form, receiptFooter: event.target.value })} />
            </Field>
            <Field label="Código da instalação" htmlFor="settingsInstallation" hint="Prefixo do número de recibo (ex.: T01-000001).">
              <Input
                id="settingsInstallation"
                maxLength={8}
                value={form.installationCode}
                onChange={(event) => setForm({ ...form, installationCode: event.target.value.toUpperCase() })}
              />
            </Field>
            <Field label="Bloqueio por inatividade" htmlFor="settingsIdle" hint="Entre 1 e 30 minutos.">
              <Select id="settingsIdle" value={form.idleMinutes} onChange={(event) => setForm({ ...form, idleMinutes: event.target.value })}>
                {["1", "2", "3", "5", "10", "15", "20", "30"].map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {minutes} minutos
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Aprovação de descontos"
              htmlFor="settingsDiscountApproval"
              hint="Quando exigida, outro utilizador gerente ou proprietário tem de autorizar com o PIN."
            >
              <Select
                id="settingsDiscountApproval"
                value={form.discountApprovalMode}
                onChange={(event) => setForm({ ...form, discountApprovalMode: event.target.value as typeof form.discountApprovalMode })}
              >
                <option value="never">Nunca — sem aprovação</option>
                <option value="above_limit">Acima do limite do caixa</option>
                <option value="always">Sempre — qualquer desconto</option>
              </Select>
            </Field>
            <Field
              label="Desconto máximo do caixa"
              htmlFor="settingsDiscount"
              hint="Percentagem sobre o subtotal. Usado apenas no modo “Acima do limite do caixa”."
            >
              <div className="relative">
                <Input
                  id="settingsDiscount"
                  inputMode="decimal"
                  value={form.maxCashierDiscount}
                  onChange={(event) => setForm({ ...form, maxCashierDiscount: event.target.value })}
                  className="pr-8 text-right"
                />
                <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-xs text-muted-foreground">%</span>
              </div>
            </Field>
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input type="checkbox" className="size-4" checked={form.allowNegativeStock} onChange={(event) => setForm({ ...form, allowNegativeStock: event.target.checked })} />
              Permitir vendas com stock negativo (sujeitas a aviso)
            </label>
          </div>
          <div className="mt-3 flex justify-end">
            <Button type="submit" disabled={saving}>
              <Save className="size-4" /> {saving ? "A guardar…" : "Guardar definições"}
            </Button>
          </div>
        </form>

        <form className="rounded-xl bg-card p-4 ring-1 ring-foreground/10" onSubmit={changePin}>
          <p className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <KeyRound className="size-4 text-emerald-600" /> Alterar o meu PIN
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="PIN actual" htmlFor="pinCurrent">
              <Input id="pinCurrent" type="password" inputMode="numeric" maxLength={6} required value={pinForm.current} onChange={(event) => setPinForm({ ...pinForm, current: event.target.value.replace(/\D/g, "").slice(0, 6) })} />
            </Field>
            <Field label="Novo PIN" htmlFor="pinNext">
              <Input id="pinNext" type="password" inputMode="numeric" maxLength={6} required value={pinForm.next} onChange={(event) => setPinForm({ ...pinForm, next: event.target.value.replace(/\D/g, "").slice(0, 6) })} />
            </Field>
            <Field label="Confirmar novo PIN" htmlFor="pinConfirmSettings">
              <Input id="pinConfirmSettings" type="password" inputMode="numeric" maxLength={6} required value={pinForm.confirm} onChange={(event) => setPinForm({ ...pinForm, confirm: event.target.value.replace(/\D/g, "").slice(0, 6) })} />
            </Field>
          </div>
          {pinError ? <div className="mt-3"><Note tone="danger">{pinError}</Note></div> : null}
          <div className="mt-3 flex justify-end">
            <Button type="submit" variant="outline" disabled={pinBusy}>
              {pinBusy ? "A alterar…" : "Alterar PIN"}
            </Button>
          </div>
        </form>

        <div className="rounded-xl bg-card p-4 ring-1 ring-foreground/10">
          <p className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <Database className="size-4 text-emerald-600" /> Diagnóstico do dispositivo
          </p>
          <div className="grid gap-2 text-sm sm:grid-cols-2">
            <InfoRow label="Versão do esquema" value={String(status?.schemaVersion ?? "—")} />
            <InfoRow label="OPFS disponível" value={status?.opfsAvailable ? "Sim" : "Não"} />
            <InfoRow label="Isolamento cross-origin" value={status?.crossOriginIsolated ? "Activo" : "Inactivo"} />
            <InfoRow label="Armazenamento persistente" value={status?.storagePersisted === true ? "Sim" : status?.storagePersisted === false ? "Não" : "Desconhecido"} />
            <InfoRow label="Utilização" value={formatBytes(status?.storageUsage)} />
            <InfoRow label="Quota" value={formatBytes(status?.storageQuota)} />
            <InfoRow label="Último backup" value={status?.lastBackupAt ? formatDateTime(status.lastBackupAt) : "Nunca"} />
            <InfoRow label="Instalação" value={settings.installationCode} />
          </div>
          {status?.storagePersisted !== true ? (
            <div className="mt-3 space-y-2">
              <Note tone="warning">
                O browser pode apagar os dados se o armazenamento não for persistente. Peça persistência e faça backups regulares.
              </Note>
              <Button variant="outline" onClick={() => void requestPersist()}>
                Pedir armazenamento persistente
              </Button>
            </div>
          ) : (
            <div className="mt-3"><Badge tone="success">Dados protegidos contra limpeza automática</Badge></div>
          )}
        </div>

        {session?.user.role === "owner" ? (
          <form className="rounded-xl border border-destructive/40 bg-card p-4" onSubmit={purgeData}>
            <p className="mb-3 flex items-center gap-2 text-sm font-semibold text-destructive">
              <Trash2 className="size-4" /> Eliminar dados operacionais
            </p>
            <Note tone="danger">
              Esta acção elimina todos os produtos, códigos de barras, stock actual e movimentos, vendas, auditoria e aprovações pendentes.
              Definições, utilizadores, categorias, clientes, fornecedores e a sequência de recibos serão mantidos. Será criado um backup interno
              antes da eliminação; essa cópia e os backups existentes continuam a conter os dados e podem ser restaurados.
            </Note>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="PIN actual do proprietário" htmlFor="purgePin">
                <Input
                  id="purgePin"
                  type="password"
                  inputMode="numeric"
                  maxLength={6}
                  required
                  value={purgePin}
                  onChange={(event) => setPurgePin(event.target.value.replace(/\D/g, "").slice(0, 6))}
                />
              </Field>
              <Field label={'Escreva "ELIMINAR" para confirmar'} htmlFor="purgeConfirmation">
                <Input
                  id="purgeConfirmation"
                  required
                  value={purgeConfirmation}
                  onChange={(event) => setPurgeConfirmation(event.target.value.trim().toUpperCase())}
                />
              </Field>
              <label className="flex items-start gap-2 text-sm sm:col-span-2">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4"
                  checked={purgeConfirmed}
                  onChange={(event) => setPurgeConfirmed(event.target.checked)}
                />
                Confirmo que pretendo eliminar estes dados da base activa.
              </label>
            </div>
            {purgeError ? <div className="mt-3"><Note tone="danger">{purgeError}</Note></div> : null}
            {purgeResult ? (
              <div className="mt-3 space-y-2 text-sm">
                <Badge tone="success">Limpeza concluída</Badge>
                <p>
                  Removidos: {purgeResult.deleted.products} produtos, {purgeResult.deleted.stockMovements} movimentos,
                  {" "}{purgeResult.deleted.sales} vendas e {purgeResult.deleted.auditEntries} registos de auditoria.
                  Backup: {purgeResult.backupName}
                </p>
              </div>
            ) : null}
            <div className="mt-3 flex justify-end">
              <Button
                type="submit"
                variant="destructive"
                disabled={purgeBusy || !purgeConfirmed || purgeConfirmation !== "ELIMINAR" || purgePin.length !== 6}
              >
                <Trash2 className="size-4" /> {purgeBusy ? "A eliminar…" : "Eliminar dados"}
              </Button>
            </div>
          </form>
        ) : null}
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b py-1.5 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}
