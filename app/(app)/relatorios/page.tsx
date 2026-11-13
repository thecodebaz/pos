import type { Metadata } from "next";
import { ReportsScreen } from "@/components/reports-screen";

export const metadata: Metadata = {
  title: "Relatórios · POS",
};

export default function ReportsPage() {
  return <ReportsScreen />;
}
