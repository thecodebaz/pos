import type { Metadata } from "next";
import { SetupScreen } from "@/components/setup-screen";

export const metadata: Metadata = {
  title: "Configuração inicial · POS",
};

export default function SetupPage() {
  return <SetupScreen />;
}
