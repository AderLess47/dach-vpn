import type { NextConfig } from "next";

/**
 * Die Supabase-Origin muss in `connect-src` stehen, sonst blockiert die CSP
 * Anmeldung und alle Client-Abfragen (`Failed to fetch`). Sie wird aus der
 * öffentlichen Env-Variable abgeleitet, damit kein Host fest verdrahtet ist.
 */
function supabaseOrigin(): string | null {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

const connectSrc = ["'self'", supabaseOrigin()].filter(Boolean).join(" ");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Workspace-Packages liefern TypeScript-Quellen, keine Build-Artefakte.
  transpilePackages: ["@dachvpn/shared", "@dachvpn/crypto"],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
          // Dashboard verarbeitet Schlüsselmaterial: keine Fremd-Skripte.
          {
            key: "Content-Security-Policy",
            value:
              `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src ${connectSrc}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
          },
        ],
      },
    ];
  },
};

export default nextConfig;
