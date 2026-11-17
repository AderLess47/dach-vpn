import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { guardRegisterDevice, parseBearerToken } from "@dachvpn/shared";
import { publicKeyFingerprint } from "@dachvpn/crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RegisterDeviceRow {
  device_id: string;
  assigned_ip: string | null;
  reused: boolean;
}

/**
 * Registriert ein Gerät für den angemeldeten Nutzer.
 *
 * Invariante 1: Kein privater Schlüssel — der geteilte Guard prüft vor allem
 * anderen, Bodies werden nie geloggt.
 *
 * Invariante 2: Gerät und IP entstehen atomar in `register_device` (Migration
 * 0004), nicht in zwei Aufrufen.
 *
 * Invariante 3: Die Nutzer-ID kommt ausschließlich aus einem serverseitig
 * verifizierten Supabase-Token. Die Route akzeptiert keine user_id im Body, und
 * `register_device` ist für `authenticated` gesperrt — ein Client kann die RPC
 * also nicht direkt mit fremder ID aufrufen.
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

  const guarded = guardRegisterDevice(payload);
  if (!guarded.ok) {
    return NextResponse.json(
      {
        code: guarded.code,
        message: guarded.message,
        ...(guarded.fields ? { fields: guarded.fields } : {}),
      },
      { status: guarded.status },
    );
  }

  const { name, platform, publicKey, piholeEnabled } = guarded.data;
  const fingerprint = publicKeyFingerprint(publicKey);

  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const nodeId = process.env.DEFAULT_NODE_ID ?? process.env.NODE_ID;
  const maxDevices = Number.parseInt(process.env.MAX_DEVICES_PER_USER ?? "5", 10);

  if (!supabaseUrl || !anonKey || !serviceRoleKey || !nodeId) {
    return NextResponse.json(
      {
        persisted: false,
        reason: "SUPABASE_NOT_CONFIGURED",
        fingerprint,
        accepted: { name, platform, publicKey },
      },
      { status: 202 },
    );
  }

  const accessToken = parseBearerToken(request.headers.get("authorization"));
  if (!accessToken) {
    return NextResponse.json(
      {
        code: "AUTH_REQUIRED",
        message: "Für die Registrierung ist eine Anmeldung erforderlich.",
      },
      { status: 401 },
    );
  }

  // Token gegen Supabase verifizieren — nicht selbst dekodieren.
  const authClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await authClient.auth.getUser(accessToken);

  if (userError || !userData.user) {
    return NextResponse.json(
      { code: "INVALID_TOKEN", message: "Sitzung ist ungültig oder abgelaufen." },
      { status: 401 },
    );
  }

  const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await serviceClient.rpc("register_device", {
    p_user_id: userData.user.id,
    p_name: name,
    p_platform: platform,
    p_public_key: publicKey,
    p_node_id: nodeId,
    p_pihole_enabled: piholeEnabled ?? false,
    p_max_devices: Number.isFinite(maxDevices) ? maxDevices : 5,
  });

  if (error) {
    const message = error.message ?? "";

    if (message.includes("IP_POOL_EXHAUSTED")) {
      return NextResponse.json(
        {
          code: "POOL_EXHAUSTED",
          message:
            "Für diesen Knoten ist aktuell keine freie Adresse verfügbar. Bitte später erneut versuchen.",
        },
        { status: 503 },
      );
    }

    if (message.includes("DEVICE_REVOKED")) {
      return NextResponse.json(
        {
          code: "DEVICE_REVOKED",
          message: "Dieses Gerät wurde widerrufen. Bitte ein neues Schlüsselpaar erzeugen.",
        },
        { status: 409 },
      );
    }

    if (message.includes("DEVICE_LIMIT_REACHED")) {
      return NextResponse.json(
        {
          code: "DEVICE_LIMIT_REACHED",
          message: "Die maximale Geräteanzahl dieses Kontos ist erreicht.",
        },
        { status: 409 },
      );
    }

    if (message.includes("DEVICE_KEY_CONFLICT") || error.code === "23505") {
      return NextResponse.json(
        { code: "DEVICE_EXISTS", message: "Dieser Schlüssel ist bereits registriert." },
        { status: 409 },
      );
    }

    if (error.code === "23503") {
      return NextResponse.json(
        { code: "PROFILE_MISSING", message: "Für dieses Konto existiert noch kein Profil." },
        { status: 409 },
      );
    }

    // Keine DB-Fehlertexte nach außen geben (können Constraints verraten).
    return NextResponse.json(
      { code: "PERSIST_FAILED", message: "Gerät konnte nicht gespeichert werden." },
      { status: 502 },
    );
  }

  const row = (Array.isArray(data) ? data[0] : data) as RegisterDeviceRow | null;
  if (!row) {
    return NextResponse.json(
      { code: "PERSIST_FAILED", message: "Registrierung lieferte kein Ergebnis." },
      { status: 502 },
    );
  }

  return NextResponse.json(
    {
      persisted: true,
      fingerprint,
      device: {
        id: row.device_id,
        assignedIp: row.assigned_ip,
        reused: row.reused,
      },
    },
    { status: row.reused ? 200 : 201 },
  );
}
