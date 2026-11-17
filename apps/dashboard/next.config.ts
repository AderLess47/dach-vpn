import type { NextConfig } from "next";

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
              "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
