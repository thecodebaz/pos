import type { Metadata } from "next";
import { StockImportScreen } from "@/components/stock-import-screen";

export const metadata: Metadata = {
  title: "Importar stock · POS",
};

export default function StockImportPage() {
  return <StockImportScreen />;
}
