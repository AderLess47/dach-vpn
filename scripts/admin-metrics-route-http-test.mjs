#!/usr/bin/env bun
/**
 * HTTP-Ebene der Admin-Kennzahlen-Route — ohne Supabase-Stack.
 *
 * Die Route hat keine Anmeldung im klassischen Sinn, sondern eine Allowlist:
 * `ADMIN_USER_IDS`. Geprüft wird deshalb vor allem die Reihenfolge der Tore —
 * Konfiguration, Anmeldung, Allowlist, Service-Role-Key — und dass ein
 * abgelehnter Aufruf keinen RPC auslöst.
 *
 * Geprüft wird:
 * - 202-Trockenlauf ohne Supabase-Konfiguration,
 * - 401 ohne Token und mit falschem Token, 503 samt `retry-after` bei Ausfall,
 * - 403 ohne Allowlist-Eintrag, auch bei leerer `ADMIN_USER_IDS` (sichere
 *   Voreinstellung),
 * - Allowlist mit Leerzeichen und Kommas wird korrekt gelesen,
 * - 202, wenn die Anmeldung gültig ist, aber der Service-Role-Key fehlt,
 * - 502 METRICS_FAILED bei RPC-Fehler, ohne SQLSTATE in der Antwort,
 * - 200 mit `cache-control: no-store, private` und den Kennzahlen des RPC,
 * - dass die Token-Prüfung mit dem Anon-Key läuft (nicht mit dem
 *   Service-Role-Key) und die Antwort keinen Personenbezug enthält.
 *
 * Kein Docker, keine Datenbank.
 */
import { callRoute } from "./lib/route-http.mjs";
import { startSupabaseStub } from "./lib/supabase-stub.mjs";
import { createChecker } from "./lib/db-fixture.mjs";

const OTHER_USER = "77777777-6666-4555-8444-333333333333";
const OTHER_TOKEN = "other-user-token";
const THIRD_USER = "88888888-7777-4666-8555-444444444444";
const THIRD_TOKEN = "third-user-token";

const { check, finish } = createChecker();
const stub = await startSupabaseStub();
stub.addUser(OTHER_TOKEN, { id: OTHER_USER, email: "other@example.invalid" });
stub.addUser(THIRD_TOKEN, { id: THIRD_USER, email: "third@example.invalid" });

const route = await import("../apps/dashboard/app/api/admin/metrics/route.ts");

const responses = [];

/** Umgebung für einen Fall; `ADMIN_USER_IDS` enthält den Stub-Nutzer. */
function env(vars = {}) {
  return stub.installEnv({ ADMIN_USER_IDS: stub.userId, ...vars });
}

async function get(options = {}) {
  const result = await callRoute(route.GET, { method: "GET", ...options });
  responses.push(result);
  return result;
}

// --- Ohne Supabase: Trockenlauf -------------------------------------------
const offline = stub.installEnv({ SUPABASE_URL: null, SUPABASE_ANON_KEY: null });
try {
  const off = await get({ token: stub.token });
  check(
    off.status === 202 && off.payload?.persisted === false && off.payload?.reason === "SUPABASE_NOT_CONFIGURED",
    `ohne Konfiguration → 202 Trockenlauf (${off.status} ${off.payload?.reason})`,
  );
} finally {
  offline();
}

// --- Anmeldung ------------------------------------------------------------
let restoreEnv = env();
try {
  const anonymous = await get();
  check(
    anonymous.status === 401 && anonymous.payload?.code === "AUTH_REQUIRED",
    `ohne Token → 401 AUTH_REQUIRED (${anonymous.status})`,
  );

  const bogus = await get({ token: "bad-token" });
  check(
    bogus.status === 401 && bogus.payload?.code === "INVALID_TOKEN",
    `falscher Token → 401 INVALID_TOKEN (${bogus.status})`,
  );

  const unavailable = await get({ token: stub.unavailableToken });
  check(
    unavailable.status === 503 && unavailable.payload?.code === "AUTH_UNAVAILABLE",
    `Auth-Ausfall → 503 AUTH_UNAVAILABLE (${unavailable.status})`,
  );
  check(
    unavailable.response.headers.get("retry-after") === "2" &&
      unavailable.response.headers.get("cache-control") === "no-store",
    "503 trägt retry-after und cache-control",
  );
} finally {
  restoreEnv();
}

// --- Allowlist ------------------------------------------------------------
const withoutEntry = env({ ADMIN_USER_IDS: "" });
try {
  const noAdmin = await get({ token: stub.token });
  check(
    noAdmin.status === 403 &&
      noAdmin.payload?.code === "ADMIN_REQUIRED" &&
      noAdmin.payload?.message === "Kein Zugriff auf Admin-Kennzahlen.",
    `leere Allowlist → 403 ADMIN_REQUIRED (${noAdmin.status})`,
  );
  check(stub.rpcCalls.length === 0, "abgelehnter Aufruf löst keinen RPC aus");
} finally {
  withoutEntry();
}

const otherOnly = env({ ADMIN_USER_IDS: OTHER_USER });
try {
  const noAdmin = await get({ token: stub.token });
  check(
    noAdmin.status === 403 && noAdmin.payload?.code === "ADMIN_REQUIRED",
    `anderer Eintrag in der Allowlist → 403 (${noAdmin.status})`,
  );
} finally {
  otherOnly();
}

restoreEnv = env({ ADMIN_USER_IDS: ` ${OTHER_USER} , ${stub.userId} ` });
try {
  stub.setRpc(200, [{ status: "active", count: 3 }]);
  const admin = await get({ token: stub.token });
  check(
    admin.status === 200,
    `Allowlist mit Leerzeichen und Kommas → 200 (${admin.status})`,
  );

  const third = await get({ token: THIRD_TOKEN });
  check(
    third.status === 403 && third.payload?.code === "ADMIN_REQUIRED",
    `dritter Nutzer ohne Admin-Recht → 403 (${third.status})`,
  );
} finally {
  restoreEnv();
}

// --- Fehlender Service-Role-Key ------------------------------------------
const withoutServiceKey = env({ SUPABASE_SERVICE_ROLE_KEY: null });
try {
  const before = stub.rpcCalls.length;
  const degraded = await get({ token: stub.token });
  check(
    degraded.status === 202 && degraded.payload?.reason === "SUPABASE_NOT_CONFIGURED",
    `ohne Service-Role-Key → 202 Trockenlauf (${degraded.status} ${degraded.payload?.reason})`,
  );
  check(stub.rpcCalls.length === before, "ohne Service-Role-Key kein RPC");
} finally {
  withoutServiceKey();
}

// --- RPC-Fehler -----------------------------------------------------------
restoreEnv = env();
try {
  const before = stub.rpcCalls.length;
  stub.rpcError("P0006", "SUBSCRIPTION_REQUIRED");
  const failed = await get({ token: stub.token });
  check(
    failed.status === 502 && failed.payload?.code === "METRICS_FAILED",
    `RPC-Fehler → 502 METRICS_FAILED (${failed.status})`,
  );
  check(
    !/P0006|SUBSCRIPTION_REQUIRED|relation "/i.test(JSON.stringify(failed.payload ?? {})),
    "502 enthält weder SQLSTATE noch DB-Text",
  );
  check(
    stub.rpcCalls.length === before + 1 && stub.rpcCalls.length > 0,
    "fehlgeschlagener Aufruf erreicht den RPC genau einmal",
  );

  // --- Erfolgsfall --------------------------------------------------------
  const metrics = [
    { status: "active", count: 12 },
    { status: "past_due", count: 1 },
  ];
  stub.setRpc(200, metrics);
  const beforeOk = stub.rpcCalls.length;
  const ok = await get({ token: stub.token });
  check(
    ok.status === 200 && JSON.stringify(ok.payload?.metrics) === JSON.stringify(metrics),
    `Erfolg → 200 mit den Kennzahlen des RPC (${ok.status})`,
  );
  check(
    ok.response.headers.get("cache-control") === "no-store, private",
    `Erfolg trägt cache-control no-store, private (${ok.response.headers.get("cache-control")})`,
  );

  const rpc = stub.lastRpc;
  check(rpc?.name === "admin_metrics", `RPC-Name (${rpc?.name})`);
  check(rpc?.headers?.apikey === stub.serviceKey, "RPC läuft mit dem Service-Role-Key");
  check(
    stub.rpcCalls.length === beforeOk + 1,
    "erfolgreicher Aufruf ruft den RPC genau einmal",
  );
  check(
    stub.lastAuth?.apikey === stub.anonKey,
    "Token-Prüfung läuft mit dem Anon-Key, nicht mit dem Service-Role-Key",
  );

  const text = JSON.stringify(ok.payload ?? {});
  check(
    !text.includes(stub.userId) && !text.includes(stub.email),
    "Antwort enthält weder Nutzer-ID noch E-Mail",
  );
} finally {
  restoreEnv();
}

// --- Sammelprüfung: nichts aus der Datenbank nach außen -------------------
const leaks = responses.filter((entry) => {
  const text = JSON.stringify(entry.payload ?? {});
  return /P000\d|235\d\d|relation "|SQLSTATE/i.test(text);
});
check(
  leaks.length === 0,
  `keine Antwort enthält SQLSTATE oder DB-Text (${leaks.length} verdächtig)`,
);

await stub.close();
finish("Admin-Kennzahlen (HTTP, Stub)");
