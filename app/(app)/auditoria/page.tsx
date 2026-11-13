import type { Metadata } from "next";
import { AuditScreen } from "@/components/audit-screen";

export const metadata: Metadata = {
  title: "Auditoria · POS",
};

export default function AuditPage() {
  return <AuditScreen />;
}
