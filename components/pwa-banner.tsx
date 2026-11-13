"use client";

import { useApp } from "@/lib/app-context";
import { Button } from "@/components/ui/button";

export function PwaBanner() {
  const { updateReady, applyUpdate, online, boot } = useApp();

  if (boot !== "ready") return null;

  if (updateReady) {
    return (
      <div className="no-print sticky top-0 z-50 flex flex-wrap items-center justify-center gap-3 bg-emerald-700 px-4 py-2 text-sm text-white">
        <span>Nova versão disponível. Guarde a venda em curso antes de actualizar.</span>
        <Button size="sm" variant="secondary" onClick={applyUpdate}>
          Actualizar agora
        </Button>
      </div>
    );
  }

  if (!online) {
    return (
      <div className="no-print sticky top-0 z-50 flex items-center justify-center gap-2 bg-amber-600 px-4 py-1.5 text-xs font-medium text-white">
        <span className="inline-block size-2 rounded-full bg-white" />
        Modo offline — a aplicação continua a funcionar com os dados locais.
      </div>
    );
  }

  return null;
}
