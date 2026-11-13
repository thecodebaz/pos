import type { Metadata } from "next";
import { PosScreen } from "@/components/pos-screen";

export const metadata: Metadata = {
  title: "Vendas · POS",
};

export default function SalesPage() {
  return <PosScreen />;
}
