import type { Metadata } from "next";
import { UsersScreen } from "@/components/users-screen";

export const metadata: Metadata = {
  title: "Utilizadores · POS",
};

export default function UsersPage() {
  return <UsersScreen />;
}
