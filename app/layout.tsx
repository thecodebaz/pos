import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AppProvider } from "@/lib/app-context";
import { PwaBanner } from "@/components/pwa-banner";

export const metadata: Metadata = {
  title: {
    default: "POS — Ponto de Venda",
    template: "%s · POS",
  },
  description: "Ponto de venda offline com stock, clientes, fornecedores e relatórios. IVA 16% · MZN.",
  applicationName: "POS",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "POS",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [{ url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" }],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: "#18181b",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-MZ" className="h-full">
      <body className="min-h-full flex flex-col bg-background text-foreground antialiased">
        <AppProvider>
          <PwaBanner />
          {children}
        </AppProvider>
      </body>
    </html>
  );
}
