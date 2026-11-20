#!/usr/bin/env bun
/**
 * HTTP-Ebene der Geräte-Routen — ohne Supabase-Stack.
 *
 * Aufgerufen werden die echten Handler aus `apps/dashboard/app/api/devices/…`;
 * Supabase ersetzt `scripts/lib/supabase-stub.mjs`. Dadurch läuft der
 * vollständige Pfad inklusive `supabase-js`: Fehlerantworten werden genau so
 * geparst, wie sie in echt ankommen (`{ code: "P0006", message: "SUBSCRIPTION_REQUIRED" }`).
 *
 * Geprüft wird:
 * - 400/422 vor jeder Netzwerkaktion (JSON, unbekannte Felder, privates Material),
 * - 401 ohne bzw. mit ungültigem Token, 503 wenn der Auth-Server nicht antwortet,
 * - 202 wenn Supabase nicht konfiguriert ist (Trockenlauf),
 * - 200/201 im Erfolgsfall,
 * - 403/404/409/502/503 für jeden Datenbankfehler — inklusive der Texte, die
 *   niemanden den DB-Fehler sehen lassen,
 * - dass die Nutzer-ID aus dem Token kommt, der RPC mit dem Service-Role-Key
 *   läuft und das Limit aus der Umgebung.
 *
 * Kein Docker, keine Datenbank. Läuft mit Bun, weil die Handler TypeScript und
 * `next/server` importieren.
 */
import { callRoute } from "./lib/route-http.mjs";
import { startSupabaseStub } from "./lib/supabase-stub.mjs";
import { createChecker, fakePublicKey } from "./lib/db-fixture.mjs";

const DEVICE_ID = "99999999-8888-4777-8666-555555555555";
const PUBLIC_KEY = fakePublicKey(1);
const BASE = { name: "Wohnzimmer-TV", platform: "firetv", publicKey: PUBLIC_KEY };
const ENV = { DEFAULT_NODE_ID: "eu-http-1", MAX_DEVICES_PER_USER: "7" };

const { check, finish } = createChecker();
const stub = await startSupabaseStub();
const USER_ID = stub.userId;
let restoreEnv = stub.installEnv(ENV);

const registerRoute = await import("../apps/dashboard/app/api/devices/register/route.ts");
const rebindRoute = await import("../apps/dashboard/app/api/devices/rebind/route.ts");

// --- Hilfen ---------------------------------------------------------------

/** Aufruf mit gültigem Token; einzelne Fälle dürfen ihn überschreiben. */
function authed(handler, options = {}) {
  return callRoute(handler, { token: stub.token, ...options });
}

async function expect(handler, options, expected, label) {
  const result = await authed(handler, options);
  const okStatus = result.status === expected.status;
  const okCode = expected.code === undefined || result.payload?.code === expected.code;
  check(okStatus && okCode, `${label} → ${result.status} ${result.payload?.code ?? ""}`.trim());

  if (expected.message) {
    check(
      typeof result.payload?.message === "string" && expected.message.test(result.payload.message),
      `${label}: Text passt`,
    );
  }
  // Kein SQLSTATE und kein roher DB-Text in der Antwort.
  check(
    !/P000\d|235\d\d/.test(result.payload?.message ?? ""),
    `${label}: Antwort ohne SQLSTATE`,
  );
  return result;
}

/** Setzt die Umgebung zurück und stellt sie danach wieder her. */
async function withoutSupabase(fn) {
  restoreEnv();
  try {
    await fn();
  } finally {
    restoreEnv = stub.installEnv(ENV);
  }
}

// --- Registrierung: Eingaben vor jeder Netzwerkaktion ----------------------
await expect(
  registerRoute.POST,
  { body: "{kaputt", token: null },
  { status: 400, code: "INVALID_JSON" },
  "Registrierung: kaputtes JSON",
);

await expect(
  registerRoute.POST,
  { body: { ...BASE, privateKey: "geheim" } },
  { status: 422, code: "PRIVATE_KEY_MATERIAL" },
  "Registrierung: privates Material",
);

await expect(
  registerRoute.POST,
  { body: { ...BASE, userId: USER_ID } },
  { status: 400, code: "UNKNOWN_FIELD" },
  "Registrierung: user_id im Body abgelehnt",
);

await expect(
  registerRoute.POST,
  { body: { ...BASE, publicKey: "zu-kurz" } },
  { status: 400, code: "INVALID_PAYLOAD" },
  "Registrierung: ungültiger Public Key",
);

// --- Registrierung: Authentifizierung -------------------------------------
await expect(
  registerRoute.POST,
  { body: BASE, token: null },
  { status: 401, code: "AUTH_REQUIRED" },
  "Registrierung: ohne Token",
);

await expect(
  registerRoute.POST,
  { body: BASE, token: "bad-token" },
  { status: 401, code: "INVALID_TOKEN" },
  "Registrierung: ungültiger Token",
);

const authDown = await authed(registerRoute.POST, { body: BASE, token: stub.unavailableToken });
check(
  authDown.status === 503 &&
    authDown.payload?.code === "AUTH_UNAVAILABLE" &&
    authDown.response.headers.get("retry-after") === "2",
  `Registrierung: Auth nicht erreichbar → 503 mit retry-after (${authDown.status})`,
);

// --- Trockenlauf ohne Supabase --------------------------------------------
await withoutSupabase(async () => {
  await expect(
    registerRoute.POST,
    { body: BASE },
    { status: 202, code: undefined },
    "Registrierung: ohne Konfiguration",
  );
  await expect(
    rebindRoute.POST,
    { body: { deviceId: DEVICE_ID, publicKey: PUBLIC_KEY } },
    { status: 202, code: undefined },
    "Schlüsselwechsel: ohne Konfiguration",
  );
});

// --- Registrierung: Erfolg ------------------------------------------------
stub.setRpc(200, [{ device_id: DEVICE_ID, assigned_ip: "10.8.0.2", reused: false }]);
const created = await authed(registerRoute.POST, { body: BASE });
check(
  created.status === 201 &&
    created.payload?.device?.id === DEVICE_ID &&
    created.payload?.device?.assignedIp === "10.8.0.2",
  `Registrierung: angelegt → 201 (${created.status})`,
);
check(
  stub.lastAuth?.token === stub.token,
  "Registrierung: Token wird an die Auth-Prüfung weitergegeben",
);
check(
  stub.lastRpc?.name === "register_device" &&
    stub.lastRpc.body?.p_user_id === USER_ID &&
    stub.lastRpc.body?.p_public_key === PUBLIC_KEY &&
    stub.lastRpc.body?.p_max_devices === 7,
  "Registrierung: Nutzer-ID aus dem Token, Limit aus MAX_DEVICES_PER_USER",
);
check(
  stub.lastRpc?.headers?.apikey === stub.serviceKey,
  "Registrierung: RPC läuft mit dem Service-Role-Key",
);

stub.setRpc(200, [{ device_id: DEVICE_ID, assigned_ip: "10.8.0.2", reused: true }]);
const repeated = await authed(registerRoute.POST, { body: BASE });
check(
  repeated.status === 200 && repeated.payload?.device?.reused === true,
  `Registrierung: Wiederholung → 200 (${repeated.status})`,
);

stub.setRpc(200, []);
const emptyResult = await authed(registerRoute.POST, { body: BASE });
check(
  emptyResult.status === 502 && emptyResult.payload?.code === "PERSIST_FAILED",
  `Registrierung: leere Antwort → 502 (${emptyResult.status})`,
);

// --- Registrierung: Datenbankfehler --------------------------------------
const registerErrorCases = [
  ["P0006", "SUBSCRIPTION_REQUIRED", 403, "SUBSCRIPTION_REQUIRED", /Geräteregistrierung/],
  ["P0007", "ADDON_NOT_BOOKED", 403, "ADDON_NOT_BOOKED", /Pi-hole-Add-on/],
  ["P0003", "DEVICE_LIMIT_REACHED", 409, "DEVICE_LIMIT_REACHED", /Geräteanzahl/],
  ["P0002", "DEVICE_REVOKED", 409, "DEVICE_REVOKED", /neues Schlüsselpaar/],
  ["P0004", "DEVICE_KEY_CONFLICT", 409, "DEVICE_EXISTS", /bereits registriert/],
  ["P0001", "IP_POOL_EXHAUSTED", 503, "POOL_EXHAUSTED", /keine freie Adresse/],
];

for (const [sqlstate, marker, status, code, message] of registerErrorCases) {
  stub.rpcError(sqlstate, marker);
  await expect(
    registerRoute.POST,
    { body: BASE },
    { status, code, message },
    `Registrierung: ${marker}`,
  );
}

stub.setRpc(400, {
  code: "XX000",
  message: 'relation "devices" does not exist',
  details: null,
  hint: null,
});
const unexpected = await authed(registerRoute.POST, { body: BASE });
check(
  unexpected.status === 502 &&
    unexpected.payload?.code === "PERSIST_FAILED" &&
    unexpected.payload?.message === "Gerät konnte nicht gespeichert werden.",
  `Registrierung: unbekannter Fehler → 502 ohne DB-Text (${unexpected.status})`,
);

// --- Schlüsselwechsel ----------------------------------------------------
const rebindBody = { deviceId: DEVICE_ID, publicKey: PUBLIC_KEY };
const otherKey = { deviceId: DEVICE_ID, publicKey: fakePublicKey(2) };

await expect(
  rebindRoute.POST,
  { body: "{kaputt" },
  { status: 400, code: "INVALID_JSON" },
  "Schlüsselwechsel: kaputtes JSON",
);

await expect(
  rebindRoute.POST,
  { body: { ...otherKey, privateKey: "geheim" } },
  { status: 422, code: "PRIVATE_KEY_MATERIAL" },
  "Schlüsselwechsel: privates Material",
);

await expect(
  rebindRoute.POST,
  { body: { ...otherKey, userId: USER_ID } },
  { status: 400, code: "UNKNOWN_FIELD" },
  "Schlüsselwechsel: user_id im Body abgelehnt",
);

await expect(
  rebindRoute.POST,
  { body: { deviceId: "keine-uuid", publicKey: PUBLIC_KEY } },
  { status: 400, code: "INVALID_PAYLOAD" },
  "Schlüsselwechsel: ungültige Geräte-ID",
);

await expect(
  rebindRoute.POST,
  { body: rebindBody, token: null },
  { status: 401, code: "AUTH_REQUIRED" },
  "Schlüsselwechsel: ohne Token",
);

await expect(
  rebindRoute.POST,
  { body: rebindBody, token: "bad-token" },
  { status: 401, code: "INVALID_TOKEN" },
  "Schlüsselwechsel: ungültiger Token",
);

stub.setRpc(200, [{ device_id: DEVICE_ID, assigned_ip: "10.8.0.2" }]);
const rebound = await authed(rebindRoute.POST, { body: rebindBody });
check(
  rebound.status === 200 && rebound.payload?.device?.reused === true,
  `Schlüsselwechsel: gebunden → 200 (${rebound.status})`,
);

const rebindErrorCases = [
  ["P0005", "DEVICE_NOT_FOUND", 404, "DEVICE_NOT_FOUND", /nicht zu deinem Konto/],
  ["P0006", "SUBSCRIPTION_REQUIRED", 403, "SUBSCRIPTION_REQUIRED", /Schlüsselwechsel/],
  ["P0002", "DEVICE_REVOKED", 409, "DEVICE_REVOKED", /neues Gerät registrieren/],
  ["23505", "DEVICE_KEY_CONFLICT", 409, "DEVICE_EXISTS", /bereits registriert/],
];

for (const [sqlstate, marker, status, code, message] of rebindErrorCases) {
  stub.rpcError(sqlstate, marker);
  await expect(
    rebindRoute.POST,
    { body: otherKey },
    { status, code, message },
    `Schlüsselwechsel: ${marker}`,
  );
}

stub.setRpc(400, { code: "XX000", message: "unexpected failure", details: null, hint: null });
const rebindFailed = await authed(rebindRoute.POST, { body: otherKey });
check(
  rebindFailed.status === 502 &&
    rebindFailed.payload?.message === "Der Schlüssel konnte nicht gebunden werden.",
  `Schlüsselwechsel: unbekannter Fehler → 502 mit eigenem Text (${rebindFailed.status})`,
);

restoreEnv();
await stub.close();
finish("Geräte-Routen (HTTP)");
