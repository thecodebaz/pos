import type { Metadata } from "next";
import { ExpensesScreen } from "@/components/expenses-screen";

export const metadata: Metadata = {
  title: "Saídas de dinheiro · POS",
};

export default function ExpensesPage() {
  return <ExpensesScreen />;
}
