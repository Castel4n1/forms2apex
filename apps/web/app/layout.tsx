import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "forms2apex · Migrador Oracle Forms para APEX",
  description: "Migração de Oracle Forms para Oracle APEX com regras, RAG e IA, e relatório de regras pendentes.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
