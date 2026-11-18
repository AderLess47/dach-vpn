import { NextResponse } from "next/server";
import { authenticate, authUnavailableResponse, serviceClient } from "../../../../lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Widerruft ein Gerät des angemeldeten Nutzers.
 *
 * Die Eigentümerschaft wird vor dem Aufruf geprüft, obwohl `revoke_device`
 * nur mit Service-Role läuft — der Endpunkt nimmt keine fremden IDs an.
 * `revoke_device` gibt die IP-Adresse in derselben Transaktion frei.
 */
export async function POST(request: Request) {
  const auth = await authenticate(request);
  if (auth.kind === "unconfigured") {
    return NextResponse.json(
      { persisted: false, reason: "SUPABASE_NOT_CONFIGURED" },
      { status: 202 },
    );
  }
  if (auth.kind === "unavailable") return authUnavailableResponse();
  if (auth.kind === "unauthenticated") {
    return NextResponse.json(
      { code: auth.code, message: "Für den Widerruf ist eine Anmeldung erforderlich." },
      { status: 401 },
    );
  }

  let deviceId: unknown;
  try {
    const body = (await request.json()) as { deviceId?: unknown };
    deviceId = body?.deviceId;
  } catch {
    return NextResponse.json({ code: "INVALID_JSON" }, { status: 400 });
  }

  if (typeof deviceId !== "string" || !UUID_RE.test(deviceId)) {
    return NextResponse.json(
      { code: "INVALID_DEVICE_ID", message: "deviceId muss eine UUID sein." },
      { status: 400 },
    );
  }

  const admin = serviceClient();
  if (!admin) {
    return NextResponse.json(
      { persisted: false, reason: "SUPABASE_NOT_CONFIGURED" },
      { status: 202 },
    );
  }

  const { data: device, error: readError } = await admin
    .from("devices")
    .select("id, status")
    .eq("id", deviceId)
    .eq("user_id", auth.userId)
    .maybeSingle();

  if (readError) {
    return NextResponse.json({ code: "LOOKUP_FAILED" }, { status: 502 });
  }
  if (!device) {
    return NextResponse.json(
      { code: "DEVICE_NOT_FOUND", message: "Gerät nicht gefunden." },
      { status: 404 },
    );
  }
  if (device.status === "revoked") {
    return NextResponse.json({ revoked: true, alreadyRevoked: true, releasedIp: 0 }, { status: 200 });
  }

  const { data, error } = await admin.rpc("revoke_device", { p_device_id: deviceId });
  if (error) {
    return NextResponse.json(
      { code: "REVOKE_FAILED", message: "Gerät konnte nicht widerrufen werden." },
      { status: 502 },
    );
  }

  return NextResponse.json(
    { revoked: true, alreadyRevoked: false, releasedIp: Number(data ?? 0) },
    { status: 200 },
  );
}
