/**
 * Supabase Edge Function: register-device (Deno)
 *
 * Nutzt denselben Guard wie der Next.js-Endpoint (`@dachvpn/shared`), damit die
 * Sicherheitsregel nicht in zwei Implementierungen auseinanderläuft.
 *
 * Invarianten:
 * - Body wird nie geloggt; nur `public_key` erreicht die Datenbank.
 * - Die Nutzer-ID kommt aus dem verifizierten Bearer-Token (Supabase Auth),
 *   niemals aus dem Request-Body.
 * - Die RPC `register_device` ist auch hier nur mit Service-Role aufrufbar.
 */

import { guardRegisterDevice, parseBearerToken } from "../../../packages/shared/src/index.ts";

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-allow-methods": "POST, OPTIONS",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "POST") {
    return json(405, { code: "METHOD_NOT_ALLOWED", message: "Nur POST." });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json(400, { code: "INVALID_JSON", message: "Body ist kein gültiges JSON." });
  }

  const guarded = guardRegisterDevice(payload);
  if (!guarded.ok) {
    return json(guarded.status, {
      code: guarded.code,
      message: guarded.message,
      ...(guarded.fields ? { fields: guarded.fields } : {}),
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const nodeId = Deno.env.get("DEFAULT_NODE_ID") ?? Deno.env.get("NODE_ID");

  if (!supabaseUrl || !anonKey || !serviceRoleKey || !nodeId) {
    return json(500, {
      code: "NOT_CONFIGURED",
      message:
        "SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY und DEFAULT_NODE_ID müssen als Secret gesetzt sein.",
    });
  }

  const accessToken = parseBearerToken(request.headers.get("authorization"));
  if (!accessToken) {
    return json(401, {
      code: "AUTH_REQUIRED",
      message: "Für die Registrierung ist eine Anmeldung erforderlich.",
    });
  }

  const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: anonKey, authorization: `Bearer ${accessToken}` },
  });
  if (!userResponse.ok) {
    return json(401, { code: "INVALID_TOKEN", message: "Sitzung ist ungültig oder abgelaufen." });
  }

  const user = (await userResponse.json()) as { id?: string };
  if (!user.id) {
    return json(401, { code: "INVALID_TOKEN", message: "Token enthält keine Nutzer-ID." });
  }

  const { name, platform, publicKey, piholeEnabled } = guarded.data;

  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/register_device`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
    },
    body: JSON.stringify({
      p_user_id: user.id,
      p_name: name,
      p_platform: platform,
      p_public_key: publicKey,
      p_node_id: nodeId,
      p_pihole_enabled: piholeEnabled ?? false,
      p_max_devices: 5,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    if (body.includes("IP_POOL_EXHAUSTED")) {
      return json(503, {
        code: "POOL_EXHAUSTED",
        message: "Für diesen Knoten ist aktuell keine freie Adresse verfügbar.",
      });
    }
    if (body.includes("DEVICE_LIMIT_REACHED")) {
      return json(409, {
        code: "DEVICE_LIMIT_REACHED",
        message: "Die maximale Geräteanzahl dieses Kontos ist erreicht.",
      });
    }
    if (body.includes("DEVICE_REVOKED") || body.includes("DEVICE_KEY_CONFLICT")) {
      return json(409, {
        code: "DEVICE_EXISTS",
        message: "Dieses Gerät kann nicht erneut registriert werden.",
      });
    }
    return json(502, {
      code: "PERSIST_FAILED",
      message: "Gerät konnte nicht gespeichert werden.",
    });
  }

  const rows = (await response.json()) as Array<{
    device_id: string;
    assigned_ip: string | null;
    reused: boolean;
  }>;
  const row = rows[0] ?? null;

  return json(row?.reused ? 200 : 201, {
    persisted: true,
    device: row
      ? { id: row.device_id, assignedIp: row.assigned_ip, reused: row.reused }
      : null,
  });
});
