import { NextResponse } from "next/server";
import { authenticate, serviceClient } from "../../../../lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function adminIds(): string[] {
  return (process.env.ADMIN_USER_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

/**
 * Aggregierte Kennzahlen für Administratoren.
 *
 * Bewusst ohne Personenbezug: keine Nutzer-IDs, keine E-Mails, keine
 * IP-Adressen — nur Zähler je Status und Knoten. Zugriff über eine
 * Allowlist aus `ADMIN_USER_IDS`, nicht über eine neue Auth-Rolle.
 */
export async function GET(request: Request) {
  const auth = await authenticate(request);
  if (auth.kind === "unconfigured") {
    return NextResponse.json(
      { persisted: false, reason: "SUPABASE_NOT_CONFIGURED" },
      { status: 202 },
    );
  }
  if (auth.kind === "unauthenticated") {
    return NextResponse.json({ code: auth.code }, { status: 401 });
  }

  if (!adminIds().includes(auth.userId)) {
    return NextResponse.json(
      { code: "ADMIN_REQUIRED", message: "Kein Zugriff auf Admin-Kennzahlen." },
      { status: 403 },
    );
  }

  const admin = serviceClient();
  if (!admin) {
    return NextResponse.json(
      { persisted: false, reason: "SUPABASE_NOT_CONFIGURED" },
      { status: 202 },
    );
  }

  const { data, error } = await admin.rpc("admin_metrics");
  if (error) {
    return NextResponse.json({ code: "METRICS_FAILED" }, { status: 502 });
  }

  return NextResponse.json(
    { metrics: data },
    { headers: { "cache-control": "no-store, private" } },
  );
}
