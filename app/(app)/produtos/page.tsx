import type { Metadata } from "next";
import { ProductsScreen } from "@/components/products-screen";

export const metadata: Metadata = {
  title: "Produtos · POS",
};

export default function ProductsPage() {
  return <ProductsScreen />;
}
