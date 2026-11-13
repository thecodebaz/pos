import type { Metadata } from "next";
import { SettingsScreen } from "@/components/settings-screen";

export const metadata: Metadata = {
  title: "Definições · POS",
};

export default function SettingsPage() {
  return <SettingsScreen />;
}
