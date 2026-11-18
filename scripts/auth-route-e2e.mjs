#!/usr/bin/env node
/**
 * Prüft die Auth-Route gegen einen echten Supabase-Stack (in CI: `supabase start`).
 *
 * Ablauf:
 *   1. Pool über die Service-Rolle-RPC füllen (der Stack kennt keine Fixtures).
 *   2. Nutzer über die Admin-API anlegen und per Passwort einloggen.
 *   3. Route ohne Token, mit falschem Token, mit privatem Schlüssel aufrufen.
 *   4. Mit gültigem Token registrieren, Retry prüfen, RLS-Sicht prüfen.
 *   5. Schlüsselwechsel an einem bestehenden Gerät prüfen: die Adresse bleibt,
 *      fremde und widerrufene Geräte werden abgewiesen.
 *   6. Gerätelimit des Kontos prüfen.
 *
 * Benötigt: BASE_URL, SUPABASE_URL, SUPABASE_ANON_KEY,
 * SUPABASE_SERVICE_ROLE_KEY, DEFAULT_NODE_ID.
 *
 * Der Test legt echte Nutzer im lokalen Stack an — niemals gegen ein
 * gehostetes Projekt richten.
 */
import { randomBytes } from "node:crypto";

const BASE_URL = (process.env.BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const NODE_ID = process.env.DEFAULT_NODE_ID;
const CIDR = process.env.AUTH_E2E_CIDR ?? "10.9.0.0/27";
const PASSWORD = "Test-Passwort-123!";

const missing = Object.entries({
  SUPABASE_URL,
  SUPABASE_ANON_KEY: ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  DEFAULT_NODE_ID: NODE_ID,
})
  .filter(([, value]) => !value)
  .map(([name]) => name);

if (missing.length > 0) {
  console.error(`Fehlende Umgebungsvariablen: ${missing.join(", ")}`);
  process.exit(1);
}

let failures = 0;

function check(condition, message) {
  console.log(`${condition ? "PASS" : "FAIL"} ${message}`);
  if (!condition) failures += 1;
}

async function request(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

function serviceHeaders() {
  return {
    "content-type": "application/json",
    apikey: SERVICE_KEY,
    authorization: `Bearer ${SERVICE_KEY}`,
  };
}

async function seedPool() {
  const { status, body } = await request(`${SUPABASE_URL}/rest/v1/rpc/seed_ip_pool`, {
    method: "POST",
    headers: serviceHeaders(),
    body: JSON.stringify({ p_node_id: NODE_ID, p_cidr: CIDR }),
  });

  if (status >= 300) {
    throw new Error(
      `seed_ip_pool fehlgeschlagen (${status}): ${JSON.stringify(body)} — sind die Migrationen eingespielt?`,
    );
  }
  return Number(body);
}

async function createUser(email) {
  const { status, body } = await request(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: serviceHeaders(),
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
  });

  if (status >= 300 || !body?.id) {
    throw new Error(`Nutzer ${email} nicht angelegt (${status}): ${JSON.stringify(body)}`);
  }
  return body.id;
}

async function signIn(email) {
  const { status, body } = await request(
    `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: { "content-type": "application/json", apikey: ANON_KEY },
      body: JSON.stringify({ email, password: PASSWORD }),
    },
  );

  if (status >= 300 || !body?.access_token) {
    throw new Error(`Login ${email} fehlgeschlagen (${status}): ${JSON.stringify(body)}`);
  }
  return body.access_token;
}

function newPublicKey() {
  return randomBytes(32).toString("base64");
}

async function register(accessToken, payload) {
  return request(`${BASE_URL}/api/devices/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(payload),
  });
}

async function rebind(accessToken, payload) {
  return request(`${BASE_URL}/api/devices/rebind`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(payload),
  });
}

async function revoke(accessToken, deviceId) {
  return request(`${BASE_URL}/api/devices/revoke`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ deviceId }),
  });
}

async function visibleDevices(accessToken, filter = "") {
  const { status, body } = await request(
    `${SUPABASE_URL}/rest/v1/devices?select=id,user_id,assigned_ip${filter}`,
    {
      headers: { apikey: ANON_KEY, authorization: `Bearer ${accessToken}` },
    },
  );
  if (status >= 300) {
    throw new Error(`Geräteabfrage fehlgeschlagen (${status}): ${JSON.stringify(body)}`);
  }
  return body;
}

async function main() {
  console.log("→ Pool füllen");
  const seeded = await seedPool();
  check(seeded > 0, `Pool für ${NODE_ID} befüllt (${seeded} Adressen)`);

  console.log("→ Testnutzer anlegen");
  const run = Date.now();
  const emailA = `auth-e2e-${run}-a@example.invalid`;
  const emailB = `auth-e2e-${run}-b@example.invalid`;
  const emailC = `auth-e2e-${run}-c@example.invalid`;
  const userA = await createUser(emailA);
  const userB = await createUser(emailB);
  const userC = await createUser(emailC);
  const tokenA = await signIn(emailA);
  const tokenB = await signIn(emailB);
  const tokenC = await signIn(emailC);
  check(Boolean(userA && userB && tokenA && tokenB), "Nutzer angelegt und eingeloggt");

  const keyA = newPublicKey();
  const payloadA = { name: "E2E A", platform: "web", publicKey: keyA };

  console.log("→ Route ohne bzw. mit falschem Token");
  const anonymous = await register(null, payloadA);
  check(
    anonymous.status === 401 && anonymous.body?.code === "AUTH_REQUIRED",
    `Ohne Token → 401 AUTH_REQUIRED (${anonymous.status} ${anonymous.body?.code})`,
  );

  const bogus = await register("falsches.token.hier", payloadA);
  check(
    bogus.status === 401 && bogus.body?.code === "INVALID_TOKEN",
    `Falscher Token → 401 INVALID_TOKEN (${bogus.status} ${bogus.body?.code})`,
  );

  const spoofed = await register(tokenA, { ...payloadA, user_id: userB });
  check(
    spoofed.status === 400,
    `user_id im Body wird abgewiesen (${spoofed.status} ${spoofed.body?.code})`,
  );

  console.log("→ Privater Schlüssel mit gültigem Token");
  const withPrivateKey = await register(tokenA, { ...payloadA, privateKey: "AAAA" });
  check(
    withPrivateKey.status === 422 && withPrivateKey.body?.code === "PRIVATE_KEY_MATERIAL",
    `Privater Schlüssel → 422 (${withPrivateKey.status} ${withPrivateKey.body?.code})`,
  );

  console.log("→ Registrierung gegen den angemeldeten Nutzer");
  const created = await register(tokenA, payloadA);
  const deviceA = created.body?.device;
  check(
    created.status === 201 && created.body?.persisted === true,
    `Registrierung → 201 persisted (${created.status})`,
  );
  check(
    typeof deviceA?.assignedIp === "string" && /^10\.9\.0\.\d+$/.test(deviceA.assignedIp),
    `Adresse aus dem Pool vergeben (${deviceA?.assignedIp})`,
  );

  const retry = await register(tokenA, payloadA);
  check(
    retry.status === 200 && retry.body?.device?.reused === true,
    `Retry mit gleichem Key → 200 reused (${retry.status})`,
  );
  check(
    retry.body?.device?.id === deviceA?.id,
    "Retry liefert dieselbe Geräte-ID",
  );

  console.log("→ Schlüsselwechsel an einem bestehenden Gerät");
  const rebound = await rebind(tokenA, {
    deviceId: deviceA?.id,
    publicKey: newPublicKey(),
  });
  check(
    rebound.status === 200 && rebound.body?.device?.id === deviceA?.id,
    `Eigener Schlüsselwechsel → 200 mit derselben Geräte-ID (${rebound.status})`,
  );
  check(
    rebound.body?.device?.assignedIp === deviceA?.assignedIp &&
      typeof deviceA?.assignedIp === "string",
    `Schlüsselwechsel lässt die Adresse unverändert (${deviceA?.assignedIp} → ${rebound.body?.device?.assignedIp})`,
  );

  console.log("→ RLS: jeder sieht nur seine Geräte");
  const devicesOfA = await visibleDevices(tokenA);
  check(
    Array.isArray(devicesOfA) && devicesOfA.length === 1 && devicesOfA[0].user_id === userA,
    `Nutzer A sieht genau sein Gerät (${devicesOfA?.length} Einträge)`,
  );

  const createdB = await register(tokenB, {
    name: "E2E B",
    platform: "web",
    publicKey: newPublicKey(),
  });
  const deviceB = createdB.body?.device;
  check(createdB.status === 201, `Nutzer B registriert eigenes Gerät (${createdB.status})`);

  const foreignRebind = await rebind(tokenA, {
    deviceId: deviceB?.id,
    publicKey: newPublicKey(),
  });
  check(
    foreignRebind.status === 404 && foreignRebind.body?.code === "DEVICE_NOT_FOUND",
    `Fremdes Gerät umschlüsseln → 404 DEVICE_NOT_FOUND (${foreignRebind.status} ${foreignRebind.body?.code})`,
  );

  const devicesOfB = await visibleDevices(tokenB);
  check(
    Array.isArray(devicesOfB) &&
      devicesOfB.length === 1 &&
      devicesOfB[0].assigned_ip === deviceB?.assignedIp,
    "Gerät von B bleibt nach dem abgewiesenen Wechsel unverändert",
  );

  const devicesOfAAfterB = await visibleDevices(tokenA);
  check(
    Array.isArray(devicesOfAAfterB) && devicesOfAAfterB.length === 1,
    `Nach B-Registrierung sieht A weiterhin nur ein Gerät (${devicesOfAAfterB?.length})`,
  );

  const foreign = await visibleDevices(tokenA, `&id=eq.${deviceB?.id}`);
  check(
    Array.isArray(foreign) && foreign.length === 0,
    "B-Gerät ist für A unsichtbar (RLS)",
  );

  console.log("→ Gerätelimit des Kontos");
  const limitPayload = { name: "Limit", platform: "web" };
  let lastStatus = 0;
  let lastBody = null;
  for (let index = 1; index <= 6; index += 1) {
    const response = await register(tokenC, {
      ...limitPayload,
      name: `Limit ${index}`,
      publicKey: newPublicKey(),
    });
    lastStatus = response.status;
    lastBody = response.body;
    if (index < 6) {
      check(response.status === 201, `Gerät ${index} von Nutzer C registriert (${response.status})`);
    }
  }
  check(
    lastStatus === 409 && lastBody?.code === "DEVICE_LIMIT_REACHED",
    `Sechstes Gerät → 409 DEVICE_LIMIT_REACHED (${lastStatus} ${lastBody?.code})`,
  );

  console.log("→ Widerrufenes Gerät nimmt keinen neuen Schlüssel an");
  const emailD = `auth-e2e-${run}-d@example.invalid`;
  await createUser(emailD);
  const tokenD = await signIn(emailD);
  const createdD = await register(tokenD, {
    name: "E2E D",
    platform: "web",
    publicKey: newPublicKey(),
  });
  const deviceD = createdD.body?.device;
  const revokedD = await revoke(tokenD, deviceD?.id);
  check(
    createdD.status === 201 && revokedD.status === 200,
    `Gerät von D registriert und widerrufen (${createdD.status}/${revokedD.status})`,
  );

  const revokedRebind = await rebind(tokenD, {
    deviceId: deviceD?.id,
    publicKey: newPublicKey(),
  });
  check(
    revokedRebind.status === 409 && revokedRebind.body?.code === "DEVICE_REVOKED",
    `Widerrufenes Gerät umschlüsseln → 409 DEVICE_REVOKED (${revokedRebind.status} ${revokedRebind.body?.code})`,
  );

  console.log("");
  if (failures > 0) {
    console.error(`${failures} Prüfung(en) fehlgeschlagen (Auth-Route).`);
    process.exit(1);
  }
  console.log("Alle Prüfungen bestanden (Auth-Route ⇄ Supabase Auth).");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
