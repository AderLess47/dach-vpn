import { NextResponse } from "next/server";
import {
  describeDeviceFailure,
  findPrivateKeyMaterial,
  PUBLIC_KEY_PATTERN,
} from "@dachvpn/shared";
import { authenticate, authUnavailableResponse, serviceClient } from "../../../../lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_FIELDS = ["deviceId", "publicKey"] as const;

interface RebindRow {
  device_id: string;
  assigned_ip: string | null;
}

/**
 * Bindet ein frisch erzeugtes Schlüsselpaar an ein BESTEHENDES Gerät.
 *
 * Hintergrund: Der private Schlüssel verlässt den Browser nie und wird nicht
 * gespeichert. Nach einem Reload gibt es also keinen Schlüssel mehr zum
 * bisherigen Gerät, und ein erneutes Registrieren würde ein zweites Gerät samt
 * zweiter Adresse anlegen. Hier bleibt die Zeile bestehen — nur der Public Key
 * wird ersetzt.
 *
 * Invariante 1: Die Nutzer-ID kommt ausschließlich aus dem serverseitig
 * verifizierten Token. Der Body enthält Geräte-ID und Public Key, niemals eine
 * user_id, und rebind_device_key() ist für `authenticated` gesperrt.
 *
 * Invariante 2: Nur Public Keys. Der geteilte Private-Key-Scan läuft wie bei
 * der Registrierung vor jeder weiteren Prüfung.
 */
export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { code: "INVALID_JSON", message: "Body ist kein gültiges JSON." },
      { status: 400 },
    );
  }

  const privateHits = findPrivateKeyMaterial(payload);
  if (privateHits.length > 0) {
    return NextResponse.json(
      {
        code: "PRIVATE_KEY_MATERIAL",
        message:
          "Der Payload enthält privates Schlüsselmaterial. Der Server akzeptiert ausschließlich Public Keys.",
        fields: privateHits,
      },
      { status: 422 },
    );
  }

  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return NextResponse.json(
      { code: "INVALID_PAYLOAD", message: "Erwartet wird ein JSON-Objekt." },
      { status: 400 },
    );
  }

  const body = payload as Record<string, unknown>;
  const unknownFields = Object.keys(body).filter(
    (key) => !(ALLOWED_FIELDS as readonly string[]).includes(key),
  );
  if (unknownFields.length > 0) {
    return NextResponse.json(
      {
        code: "UNKNOWN_FIELD",
        message: `Unbekannte Felder: ${unknownFields.join(", ")}. Erlaubt sind: ${ALLOWED_FIELDS.join(", ")}.`,
        fields: unknownFields,
      },
      { status: 400 },
    );
  }

  const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";
  const publicKey = typeof body.publicKey === "string" ? body.publicKey : "";
  const errors: string[] = [];
  if (!UUID_PATTERN.test(deviceId)) errors.push("deviceId: UUID");
  if (!PUBLIC_KEY_PATTERN.test(publicKey)) {
    errors.push("publicKey: 32 Byte Curve25519 als Base64 (44 Zeichen)");
  }
  if (errors.length > 0) {
    return NextResponse.json(
      { code: "INVALID_PAYLOAD", message: `Ungültiger Payload: ${errors.join("; ")}.` },
      { status: 400 },
    );
  }

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
      {
        code: auth.code,
        message:
          auth.code === "AUTH_REQUIRED"
            ? "Für den Schlüsselwechsel ist eine Anmeldung erforderlich."
            : "Sitzung ist ungültig oder abgelaufen.",
      },
      { status: 401 },
    );
  }

  const client = serviceClient();
  if (!client) {
    return NextResponse.json(
      { persisted: false, reason: "SUPABASE_NOT_CONFIGURED" },
      { status: 202 },
    );
  }

  const { data, error } = await client.rpc("rebind_device_key", {
    p_user_id: auth.userId,
    p_device_id: deviceId,
    p_public_key: publicKey,
  });

  if (error) {
    // Gemeinsame Abbildung mit der Registrierung; nur der Text unterscheidet
    // sich, weil die Operation eine andere ist.
    const failure = describeDeviceFailure(
      { message: error.message, code: error.code },
      "rebind",
    );

    return NextResponse.json(
      { code: failure.code, message: failure.message },
      { status: failure.status },
    );
  }

  const row = (Array.isArray(data) ? data[0] : data) as RebindRow | null;
  if (!row) {
    return NextResponse.json(
      { code: "PERSIST_FAILED", message: "Der Schlüsselwechsel lieferte kein Ergebnis." },
      { status: 502 },
    );
  }

  return NextResponse.json({
    persisted: true,
    device: { id: row.device_id, assignedIp: row.assigned_ip, reused: true },
  });
}
