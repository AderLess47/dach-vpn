import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DACH VPN — Sprint 0",
  description:
    "Zero-Knowledge-Schlüsselerzeugung im Browser, Public-Key-only-Registrierung.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="de">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
