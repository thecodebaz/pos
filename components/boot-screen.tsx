"use client";

import { useApp } from "@/lib/app-context";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Note } from "@/components/shared";

export function BootScreen() {
  const { boot, bootError } = useApp();

  if (boot === "ready") return null;

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      {boot === "loading" ? (
        <div className="flex flex-col items-center gap-3 text-sm text-muted-foreground">
          <Spinner className="size-6" />
          <p>A preparar a base de dados local…</p>
        </div>
      ) : (
        <div className="w-full max-w-xl space-y-4">
          <Note tone="danger">
            <p className="font-semibold">Não foi possível abrir a base de dados local.</p>
            <p className="mt-1">{bootError}</p>
          </Note>
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>Verifique se está a usar Chrome ou Edge actualizado e se a aplicação está a ser servida com os cabeçalhos:</p>
            <ul className="list-disc pl-5">
              <li>Cross-Origin-Opener-Policy: same-origin</li>
              <li>Cross-Origin-Embedder-Policy: require-corp</li>
            </ul>
            <p>Os dados existentes não foram apagados. Não limpe o armazenamento do browser.</p>
          </div>
          <Button onClick={() => window.location.reload()}>Recarregar aplicação</Button>
        </div>
      )}
    </div>
  );
}
