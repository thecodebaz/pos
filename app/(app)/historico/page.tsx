import type { Metadata } from "next";
import { SalesHistoryScreen } from "@/components/sales-history-screen";

export const metadata: Metadata = {
  title: "Histórico de vendas · POS",
};

export default function HistoryPage() {
  return <SalesHistoryScreen />;
}
