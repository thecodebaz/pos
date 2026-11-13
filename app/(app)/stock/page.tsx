import type { Metadata } from "next";
import { StockScreen } from "@/components/stock-screen";

export const metadata: Metadata = {
  title: "Stock · POS",
};

export default function StockPage() {
  return <StockScreen />;
}
