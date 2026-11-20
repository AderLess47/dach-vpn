import type { Metadata } from "next";
import { getRequestBrand } from "../lib/brand";
import "./globals.css";

// Pro Request, weil die Marke vom Host abhängt (White-Label-Mandanten).
export async function generateMetadata(): Promise<Metadata> {
  const brand = await getRequestBrand();
  return {
    title: `${brand.name} — Dashboard`,
    description: `${brand.name}: ${brand.tagline}. Zero-Knowledge-Schlüsselerzeugung im Browser, Public-Key-only-Registrierung.`,
  };
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="de">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
