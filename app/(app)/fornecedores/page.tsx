import type { Metadata } from "next";
import { SuppliersScreen } from "@/components/suppliers-screen";

export const metadata: Metadata = {
  title: "Fornecedores · POS",
};

export default function SuppliersPage() {
  return <SuppliersScreen />;
}
