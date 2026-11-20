#!/usr/bin/env bun
/**
 * HTTP-Ebene der Widerruf-Route — ohne Supabase-Stack.
 *
 * `revoke` ist der erste Fall mit **Tabellenzugriff**: vor dem RPC liest die
 * Route `devices` per `.from("devices").select("id, status")…maybeSingle()`.
 * Der Stub kennt nur GoTrue und RPCs, deshalb bedient `stub.route()` diesen
 * Pfad; die Abfrage-URL wird mitgeschnitten, damit prüfbar ist, dass gefiltert
 * wird — und zwar auf die Nutzer-ID aus dem Token.
 *
 * Geprüft wird:
 * - 202-Trockenlauf ohne Konfiguration, 401 ohne/mit falschem Token,
 *   503 samt `retry-after` bei Auth-Ausfall,
 * - 400 für kaputtes JSON und ungültige Geräte-IDs,
 * - 502 LOOKUP_FAILED bei Lesefehler, 404 bei fehlender Zeile,
 * - Idempotenz: ein bereits widerrufenes Gerät ruft keinen RPC mehr auf,
 * - Erfolg mit `releasedIp` aus dem RPC, 502 REVOKE_FAILED bei RPC-Fehler,
 * - dass kein SQLSTATE und kein DB-Text in einer Antwort landet,
 * - dass die Nutzer-ID aus dem Token kommt, nicht aus dem Body.
 *
 * Kein Docker, keine Datenbank.
 */
import { callRoute } from "./lib/route-http.mjs";
import { startSupabaseStub } from "./lib/supabase-stub.mjs";
import { createChecker } from "./lib/db-fixture.mjs";

const DEVICE_ID = "99999999-8888-4777-8666-555555555555";
const OTHER_USER = "77777777-6666-4555-8444-333333333333";

const { check, finish } = createChecker();
const stub = await startSupabaseStub();
let restoreEnv = stub.installEnv();

const route = await import("../apps/dashboard/app/api/devices/revoke/route.ts");

// --- Tabellenzugriff der Route --------------------------------------------
// `.maybeSingle()` wertet `200 []` als „keine Zeile" (data null, error null) —
// ein 406 PGRST116 käme dagegen als Fehler an und ergäbe 502 statt 404.
let tableReply = [200, [{ id: DEVICE_ID, status: "active" }]];
const lookups = [];

stub.route("/rest/v1/devices", (request, response, ctx) => {
  lookups.push({
    url: ctx.url,
    apikey: request.headers.apikey,
    authorization: request.headers.authorization,
  });
  ctx.send(response, tableReply[0], tableReply[1]);
});

/** Antworten für die Sammelprüfung „kein SQLSTATE nach außen". */
const responses = [];

async function revoke(body, options = {}) {
  const result = await callRoute(route.POST, { token: stub.token, body, ...options });
  responses.push(result);
  return result;
}

// --- Ohne Supabase: Trockenlauf -------------------------------------------
restoreEnv();
try {
  const off = await revoke({ deviceId: DEVICE_ID });
  check(
    off.status === 202 && off.payload?.reason === "SUPABASE_NOT_CONFIGURED",
    `ohne Konfiguration → 202 Trockenlauf (${off.status} ${off.payload?.reason})`,
  );
} finally {
  restoreEnv = stub.installEnv();
}

// Auth konfiguriert, aber kein Service-Role-Key: die Route kann nicht schreiben.
const withoutServiceKey = stub.installEnv({ SUPABASE_SERVICE_ROLE_KEY: null });
try {
  const degraded = await revoke({ deviceId: DEVICE_ID });
  check(
    degraded.status === 202 && degraded.payload?.reason === "SUPABASE_NOT_CONFIGURED",
    `ohne Service-Role-Key → 202 Trockenlauf (${degraded.status} ${degraded.payload?.reason})`,
  );
} finally {
  withoutServiceKey();
}

// --- Anmeldung ------------------------------------------------------------
const anonymous = await revoke({ deviceId: DEVICE_ID }, { token: null });
check(
  anonymous.status === 401 &&
    anonymous.payload?.code === "AUTH_REQUIRED" &&
    anonymous.payload?.message === "Für den Widerruf ist eine Anmeldung erforderlich.",
  `ohne Token → 401 AUTH_REQUIRED (${anonymous.status})`,
);

const bogus = await revoke({ deviceId: DEVICE_ID }, { token: "bad-token" });
check(
  bogus.status === 401 && bogus.payload?.code === "INVALID_TOKEN",
  `falscher Token → 401 INVALID_TOKEN (${bogus.status})`,
);

const unavailable = await revoke({ deviceId: DEVICE_ID }, { token: stub.unavailableToken });
check(
  unavailable.status === 503 && unavailable.payload?.code === "AUTH_UNAVAILABLE",
  `Auth-Ausfall → 503 AUTH_UNAVAILABLE (${unavailable.status})`,
);
check(
  unavailable.response.headers.get("retry-after") === "2" &&
    unavailable.response.headers.get("cache-control") === "no-store",
  "503 trägt retry-after und cache-control",
);

// --- Eingaben -------------------------------------------------------------
const broken = await revoke("{kaputt");
check(
  broken.status === 400 && broken.payload?.code === "INVALID_JSON",
  `kaputtes JSON → 400 INVALID_JSON (${broken.status})`,
);

const missing = await revoke({});
check(
  missing.status === 400 && missing.payload?.code === "INVALID_DEVICE_ID",
  `fehlende Geräte-ID → 400 INVALID_DEVICE_ID (${missing.status})`,
);

const notUuid = await revoke({ deviceId: "keine-uuid" });
check(
  notUuid.status === 400 &&
    notUuid.payload?.code === "INVALID_DEVICE_ID" &&
    notUuid.payload?.message === "deviceId muss eine UUID sein.",
  `ungültige Geräte-ID → 400 (${notUuid.status})`,
);

const numberId = await revoke({ deviceId: 42 });
check(
  numberId.status === 400 && numberId.payload?.code === "INVALID_DEVICE_ID",
  `Zahl als Geräte-ID → 400 (${numberId.status})`,
);

check(
  lookups.length === 0 && stub.rpcCalls.length === 0,
  "kein Netzzugriff bei Eingabefehlern",
);

// --- Lesen der Gerätezeile ------------------------------------------------
tableReply = [200, [{ id: DEVICE_ID, status: "active" }]];
const ok = await revoke({ deviceId: DEVICE_ID, userId: OTHER_USER });
const lookup = lookups.at(-1);
check(
  ok.status === 200 && ok.payload?.revoked === true && ok.payload?.alreadyRevoked === false,
  `Erfolg → 200 revoked (${ok.status})`,
);
check(
  lookup?.url.includes(`id=eq.${DEVICE_ID}`) && lookup?.url.includes(`user_id=eq.${stub.userId}`),
  "Abfrage filtert auf Geräte-ID und Nutzer-ID aus dem Token",
);
check(
  !lookup?.url.includes(OTHER_USER),
  "userId aus dem Body landet nicht in der Abfrage",
);
check(
  lookup?.apikey === stub.serviceKey && lookup?.authorization === `Bearer ${stub.serviceKey}`,
  "Tabellenzugriff läuft mit dem Service-Role-Key",
);

tableReply = [400, { code: "XX000", message: 'relation "devices" does not exist', details: null, hint: null }];
const lookupFailed = await revoke({ deviceId: DEVICE_ID });
check(
  lookupFailed.status === 502 && lookupFailed.payload?.code === "LOOKUP_FAILED",
  `Lesefehler → 502 LOOKUP_FAILED (${lookupFailed.status})`,
);

tableReply = [200, []];
const notFound = await revoke({ deviceId: DEVICE_ID });
check(
  notFound.status === 404 &&
    notFound.payload?.code === "DEVICE_NOT_FOUND" &&
    notFound.payload?.message === "Gerät nicht gefunden.",
  `keine Zeile → 404 DEVICE_NOT_FOUND (${notFound.status})`,
);

// --- Idempotenz -----------------------------------------------------------
tableReply = [200, [{ id: DEVICE_ID, status: "revoked" }]];
const before = stub.rpcCalls.length;
const alreadyRevoked = await revoke({ deviceId: DEVICE_ID });
check(
  alreadyRevoked.status === 200 &&
    alreadyRevoked.payload?.alreadyRevoked === true &&
    alreadyRevoked.payload?.releasedIp === 0,
  `bereits widerrufen → 200 idempotent (${alreadyRevoked.status})`,
);
check(
  stub.rpcCalls.length === before,
  "bereits widerrufenes Gerät ruft keinen RPC mehr auf",
);

// --- Widerrufen -----------------------------------------------------------
tableReply = [200, [{ id: DEVICE_ID, status: "active" }]];
stub.setRpc(200, 2);
const revoked = await revoke({ deviceId: DEVICE_ID });
check(
  revoked.status === 200 && revoked.payload?.releasedIp === 2,
  `RPC-Rückgabe wird zu releasedIp (${revoked.payload?.releasedIp})`,
);
check(
  stub.lastRpc?.name === "revoke_device" &&
    stub.lastRpc?.body?.p_device_id === DEVICE_ID,
  `RPC revoke_device mit der Geräte-ID (${stub.lastRpc?.name})`,
);
check(stub.lastRpc?.headers?.apikey === stub.serviceKey, "RPC läuft mit dem Service-Role-Key");

stub.setRpc(200, null);
const withoutCount = await revoke({ deviceId: DEVICE_ID });
check(
  withoutCount.status === 200 && withoutCount.payload?.releasedIp === 0,
  `RPC ohne Zahl → releasedIp 0 (${withoutCount.payload?.releasedIp})`,
);

stub.rpcError("P0005", "DEVICE_NOT_FOUND");
const rpcFailed = await revoke({ deviceId: DEVICE_ID });
check(
  rpcFailed.status === 502 &&
    rpcFailed.payload?.code === "REVOKE_FAILED" &&
    rpcFailed.payload?.message === "Gerät konnte nicht widerrufen werden.",
  `RPC-Fehler → 502 REVOKE_FAILED (${rpcFailed.status})`,
);

stub.setRpc(400, {
  code: "XX000",
  message: 'relation "devices" does not exist',
  details: null,
  hint: null,
});
const unexpected = await revoke({ deviceId: DEVICE_ID });
check(
  unexpected.status === 502 &&
    unexpected.payload?.message === "Gerät konnte nicht widerrufen werden.",
  `unbekannter RPC-Fehler → 502 ohne DB-Text (${unexpected.status})`,
);

// --- Sammelprüfung: nichts aus der Datenbank nach außen --------------------
const leaks = responses.filter((entry) => {
  const text = JSON.stringify(entry.payload ?? {});
  return /P000\d|235\d\d|relation "|SQLSTATE/i.test(text);
});
check(
  leaks.length === 0,
  `keine Antwort enthält SQLSTATE oder DB-Text (${leaks.length} verdächtig)`,
);

restoreEnv();
await stub.close();
finish("Widerruf-Route (HTTP)");
