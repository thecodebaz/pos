import type { Metadata } from "next";
import { CustomersScreen } from "@/components/customers-screen";

export const metadata: Metadata = {
  title: "Clientes · POS",
};

export default function CustomersPage() {
  return <CustomersScreen />;
}
