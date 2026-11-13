"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useApp } from "@/lib/app-context";
import { BootScreen } from "@/components/boot-screen";

export default function HomePage() {
  const { boot, status, session } = useApp();
  const router = useRouter();

  useEffect(() => {
    if (boot !== "ready") return;
    if (status?.setupRequired) router.replace("/configuracao/");
    else if (!session) router.replace("/entrar/");
    else router.replace("/vendas/");
  }, [boot, status, session, router]);

  return (
    <div className="flex flex-1 items-center justify-center">
      <BootScreen />
    </div>
  );
}
