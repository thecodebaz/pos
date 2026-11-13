import type { Metadata } from "next";
import { LoginScreen } from "@/components/login-screen";

export const metadata: Metadata = {
  title: "Entrar · POS",
};

export default function LoginPage() {
  return <LoginScreen />;
}
