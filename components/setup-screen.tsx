"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ClipboardCopy, KeyRound, ShieldCheck } from "lucide-react";
import { useApp, errorMessage } from "@/lib/app-context";
import { db } from "@/lib/db/client";
import type { SessionInfo } from "@/lib/db/protocol";
import { BootScreen } from "@/components/boot-screen";
import { Field, Note } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function SetupScreen() {
  const { boot, status, enterSession, refreshStatus, toast } = useApp();
  const router = useRouter();
  const [form, setForm] = useState({
    storeName: "",
    nif: "",
    phone: "",
    address: "",
    ownerName: "",
    username: "proprietario",
    installationCode: "T01",
    pin: "",
    pinConfirm: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<(SessionInfo & { recoveryCode: string }) | null>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (boot !== "ready") return;
    if (!status?.setupRequired) router.replace("/entrar/");
  }, [boot, status, router]);

  if (boot !== "ready") return <BootScreen />;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (form.pin !== form.pinConfirm) {
      setError("Os PINs não coincidem.");
      return;
    }
    setBusy(true);
    try {
      const session = await db.setup({
        storeName: form.storeName,
        nif: form.nif,
        phone: form.phone,
        address: form.address,
        ownerName: form.ownerName,
        username: form.username,
        installationCode: form.installationCode,
        pin: form.pin,
      });
      setResult(session);
      await refreshStatus();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function finish() {
    if (!result) return;
    // A sessão só é activada depois de o código de recuperação ser guardado.
    enterSession(result);
    toast("Configuração concluída.", "success");
    router.replace("/vendas/");
  }

  if (result) {
    return (
      <div className="flex flex-1 items-center justify-center p-4">
        <Card className="w-full max-w-xl">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="size-5 text-emerald-600" /> Guarde o código de recuperação
            </CardTitle>
            <CardDescription>
              Este código permite recuperar o acesso de proprietário se o PIN for esquecido. É mostrado apenas uma vez.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-3 rounded-xl border-2 border-dashed border-emerald-600/40 bg-emerald-50 px-4 py-4 dark:bg-emerald-950/30">
              <code className="select-all font-mono text-lg font-bold tracking-wider sm:text-2xl">{result.recoveryCode}</code>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(result.recoveryCode);
                    setCopied(true);
                  } catch {
                    toast("Não foi possível copiar. Escreva o código à mão.", "error");
                  }
                }}
              >
                {copied ? <Check className="size-4" /> : <ClipboardCopy className="size-4" />}
                {copied ? "Copiado" : "Copiar"}
              </Button>
            </div>
            <Note tone="warning">
              Escreva o código num papel e guarde-o fora do dispositivo. Sem ele, e sem o PIN, não é possível recuperar o
              acesso.
            </Note>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5 size-4" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
              <span>Confirmo que guardei o código de recuperação num local seguro.</span>
            </label>
            <Button className="w-full" size="lg" disabled={!saved} onClick={finish}>
              Entrar no ponto de venda
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-1 items-center justify-center p-4">
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-5 text-emerald-600" /> Primeira configuração
          </CardTitle>
          <CardDescription>
            Crie a base local, a loja e o utilizador proprietário. Tudo fica guardado apenas neste dispositivo.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={submit}>
            <Field label="Nome da loja *" htmlFor="storeName" className="sm:col-span-2">
              <Input
                id="storeName"
                required
                autoFocus
                value={form.storeName}
                onChange={(e) => setForm({ ...form, storeName: e.target.value })}
                placeholder="Ex.: Mercearia Central"
              />
            </Field>
            <Field label="NUIT / NIF" htmlFor="nif">
              <Input id="nif" inputMode="numeric" maxLength={9} value={form.nif} onChange={(e) => setForm({ ...form, nif: e.target.value })} />
            </Field>
            <Field label="Telefone" htmlFor="phone">
              <Input id="phone" inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+258 84 000 0000" />
            </Field>
            <Field label="Endereço" htmlFor="address" className="sm:col-span-2">
              <Input id="address" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
            </Field>

            <div className="sm:col-span-2 border-t pt-3">
              <p className="text-sm font-medium">Proprietário</p>
            </div>
            <Field label="Nome do proprietário *" htmlFor="ownerName">
              <Input id="ownerName" required value={form.ownerName} onChange={(e) => setForm({ ...form, ownerName: e.target.value })} />
            </Field>
            <Field label="Utilizador *" htmlFor="username" hint="3 a 32 caracteres: letras minúsculas, números, ponto, hífen.">
              <Input
                id="username"
                required
                autoCapitalize="none"
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase() })}
              />
            </Field>
            <Field label="PIN (6 dígitos) *" htmlFor="pin">
              <Input
                id="pin"
                type="password"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                required
                value={form.pin}
                onChange={(e) => setForm({ ...form, pin: e.target.value.replace(/\D/g, "").slice(0, 6) })}
              />
            </Field>
            <Field label="Confirmar PIN *" htmlFor="pinConfirm">
              <Input
                id="pinConfirm"
                type="password"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                required
                value={form.pinConfirm}
                onChange={(e) => setForm({ ...form, pinConfirm: e.target.value.replace(/\D/g, "").slice(0, 6) })}
              />
            </Field>
            <Field label="Código da instalação" htmlFor="installationCode" hint="Aparece no número dos recibos (ex.: T01-000001).">
              <Input
                id="installationCode"
                maxLength={8}
                value={form.installationCode}
                onChange={(e) => setForm({ ...form, installationCode: e.target.value.toUpperCase() })}
              />
            </Field>

            {error ? <div className="sm:col-span-2"><Note tone="danger">{error}</Note></div> : null}

            <div className="sm:col-span-2">
              <Button type="submit" size="lg" className="w-full" disabled={busy}>
                {busy ? "A criar base local…" : "Criar aplicação"}
              </Button>
              <p className="mt-2 text-center text-xs text-muted-foreground">
                Versão 1 · IVA 16% · Moeda MZN · Dados 100% offline neste dispositivo
              </p>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
