#!/usr/bin/env node
/**
 * Kontrakt-Test für die Test-Hilfen (`scripts/lib/supabase-stub.mjs`,
 * `scripts/lib/stripe-api-stub.mjs` und `scripts/lib/route-http.mjs`).
 *
 * Warum das nötig ist: Der Stub ist selbst Testinfrastruktur. Ist er kaputt,
 * schlagen die Routen-Tests fehl — und der Fehler sieht wie ein Fehler in der
 * Route aus. Dieser Test hält die Zusagen des Stubs fest:
 *
 * - GoTrue: gültiger Token → Nutzer, unbekannter Token → 401, Ausfall → 503,
 *   `addUser` liefert eigene IDs, `lastAuth` protokolliert den Aufruf.
 * - PostgREST: feste und dynamische RPC-Antworten, Fehlerform, gesammelte
 *   Aufrufe (`rpcCalls`), kein Absturz bei kaputtem JSON.
 * - Eigene Pfade über `route()`.
 * - `installEnv` setzt die Supabase-Variablen, entfernt `NEXT_PUBLIC_*` und
 *   stellt beim Restore exakt den vorherigen Zustand her.
 * - Zwei Stubs laufen parallel auf verschiedenen Ports; `close()` beendet den
 *   Server wirklich.
 * - Stripe-Stub: `on()` beantwortet Pfade, `calls` protokolliert Methode/Pfad/
 *   Body, unbekannte Pfade melden `stub_missing_route`, alles außerhalb von
 *   `api.stripe.com` geht unverändert ans echte `fetch`, `restore()` gibt es
 *   zurück.
 *
 * Kein Docker, keine Datenbank. Läuft mit Node.
 */
import { callRoute } from "./lib/route-http.mjs";
import { createChecker } from "./lib/db-fixture.mjs";
import { startSupabaseStub } from "./lib/supabase-stub.mjs";
import { installStripeStub } from "./lib/stripe-api-stub.mjs";

const { check, finish } = createChecker();

/** Roher HTTP-Aufruf gegen den Stub — unabhängig von `callRoute`. */
async function request(stub, path, options = {}) {
  const { method = "GET", token, body, headers = {} } = options;
  const merged = { ...headers };
  if (token) merged.authorization = `Bearer ${token}`;
  if (body !== undefined) merged["content-type"] = merged["content-type"] ?? "application/json";

  const response = await fetch(`${stub.url}${path}`, {
    method,
    headers: merged,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await response.text();

  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  return { status: response.status, payload };
}

async function main() {
  const stub = await startSupabaseStub();

  // --- GoTrue ------------------------------------------------------------
  const valid = await request(stub, "/auth/v1/user", { token: stub.token });
  check(
    valid.status === 200 &&
      valid.payload?.id === stub.userId &&
      valid.payload?.email === stub.email,
    `GoTrue: gültiger Token liefert den Nutzer (${valid.status})`,
  );
  check(stub.lastAuth?.token === stub.token, "GoTrue: lastAuth protokolliert den Token");

  const invalid = await request(stub, "/auth/v1/user", { token: "falsch" });
  check(invalid.status === 401, `GoTrue: unbekannter Token → 401 (${invalid.status})`);

  const down = await request(stub, "/auth/v1/user", { token: stub.unavailableToken });
  check(down.status === 503, `GoTrue: Ausfall-Token → 503 (${down.status})`);

  stub.addUser("zweiter", { id: "22222222-3333-4444-8555-666666666666", email: "zwei@example.invalid" });
  const second = await request(stub, "/auth/v1/user", { token: "zweiter" });
  check(
    second.status === 200 && second.payload?.id === "22222222-3333-4444-8555-666666666666",
    "GoTrue: addUser legt ein eigenes Konto an",
  );

  // --- PostgREST: feste Antwort ------------------------------------------
  stub.setRpc(200, [{ device_id: "d-1", assigned_ip: "10.0.0.2", reused: false }]);
  const rpc = await request(stub, "/rest/v1/rpc/register_device", {
    method: "POST",
    body: { p_user_id: "u-1", p_max_devices: 5 },
    headers: { apikey: "service-key" },
  });
  check(
    rpc.status === 200 && rpc.payload?.[0]?.device_id === "d-1",
    `PostgREST: feste Antwort kommt unverändert an (${rpc.status})`,
  );
  check(
    stub.lastRpc?.name === "register_device" &&
      stub.lastRpc.body?.p_user_id === "u-1" &&
      stub.lastRpc.body?.p_max_devices === 5,
    "PostgREST: lastRpc enthält Name und geparsten Body",
  );
  check(
    stub.lastRpc?.headers?.apikey === "service-key",
    "PostgREST: Header werden mitprotokolliert",
  );

  // --- PostgREST: Fehlerform ---------------------------------------------
  stub.rpcError("P0006", "SUBSCRIPTION_REQUIRED", "Abo fehlt");
  const error = await request(stub, "/rest/v1/rpc/register_device", { method: "POST", body: {} });
  check(
    error.status === 400 &&
      error.payload?.code === "P0006" &&
      error.payload?.message === "SUBSCRIPTION_REQUIRED" &&
      error.payload?.hint === "Abo fehlt" &&
      error.payload?.details === null,
    `PostgREST: rpcError liefert die PostgREST-Fehlerform (${error.status})`,
  );

  // --- PostgREST: dynamische Antwort -------------------------------------
  stub.setRpc((call) => ({ status: 201, body: [{ echo: call.body?.p_value ?? null }] }));
  const dynamic = await request(stub, "/rest/v1/rpc/rebind_device_key", {
    method: "POST",
    body: { p_value: "echo" },
  });
  check(
    dynamic.status === 201 && dynamic.payload?.[0]?.echo === "echo",
    `PostgREST: Funktion als Antwort sieht den Aufruf (${dynamic.status})`,
  );

  // --- PostgREST: kaputtes JSON und unbekannter Pfad ---------------------
  stub.setRpc(200, []);
  const broken = await request(stub, "/rest/v1/rpc/register_device", {
    method: "POST",
    body: "{kaputt",
  });
  check(
    broken.status === 200 && stub.lastRpc?.body === null,
    "PostgREST: kaputtes JSON wird nicht geparst, aber beantwortet",
  );

  const unknown = await request(stub, "/pfad/den/es/nicht/gibt");
  check(unknown.status === 404, `unbekannter Pfad → 404 (${unknown.status})`);

  check(
    stub.rpcCalls.length === 4 &&
      stub.rpcCalls.map((c) => c.name).join(",") ===
        "register_device,register_device,rebind_device_key,register_device",
    `rpcCalls sammelt alle Aufrufe in Reihenfolge (${stub.rpcCalls.length})`,
  );

  // --- Eigene Pfade -------------------------------------------------------
  stub.route("/rest/v1/subscriptions", (req, response, ctx) => {
    ctx.send(response, 200, { rows: 1, query: ctx.url, raw: ctx.raw });
  });
  const custom = await request(stub, "/rest/v1/subscriptions?select=*");
  check(
    custom.status === 200 &&
      custom.payload?.rows === 1 &&
      custom.payload?.query === "/rest/v1/subscriptions?select=*" &&
      custom.payload?.raw === "",
    `route(): eigener Pfad wird bedient (${custom.status})`,
  );

  // --- installEnv / restore ----------------------------------------------
  const before = {
    supabaseUrl: process.env.SUPABASE_URL,
    publicUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    maxDevices: process.env.MAX_DEVICES_PER_USER,
  };
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://aus-dem-env.invalid";

  const restore = stub.installEnv({ DEFAULT_NODE_ID: "eu-stub", MAX_DEVICES_PER_USER: "9" });
  check(
    process.env.SUPABASE_URL === stub.url &&
      process.env.SUPABASE_ANON_KEY === stub.anonKey &&
      process.env.SUPABASE_SERVICE_ROLE_KEY === stub.serviceKey &&
      process.env.DEFAULT_NODE_ID === "eu-stub" &&
      process.env.MAX_DEVICES_PER_USER === "9",
    "installEnv setzt URL, Keys und Zusatzwerte",
  );
  check(
    process.env.NEXT_PUBLIC_SUPABASE_URL === undefined &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY === undefined,
    "installEnv entfernt die NEXT_PUBLIC-Fallbacks",
  );

  restore();
  check(
    process.env.NEXT_PUBLIC_SUPABASE_URL === "http://aus-dem-env.invalid" &&
      process.env.SUPABASE_URL === before.supabaseUrl &&
      process.env.MAX_DEVICES_PER_USER === before.maxDevices,
    "restore stellt den vorherigen Zustand wieder her",
  );

  const removeRestore = stub.installEnv({ SUPABASE_URL: null });
  check(process.env.SUPABASE_URL === undefined, "installEnv kann Werte auch gezielt entfernen");
  removeRestore();
  check(process.env.SUPABASE_URL === before.supabaseUrl, "restore macht das Entfernen rückgängig");

  // --- callRoute ---------------------------------------------------------
  const handler = async (req) => {
    const body = await req.text();
    return new Response(JSON.stringify({ auth: req.headers.get("authorization"), body }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const objectBody = await callRoute(handler, { body: { a: 1 }, token: "t-1" });
  check(
    objectBody.status === 200 &&
      objectBody.payload?.auth === "Bearer t-1" &&
      objectBody.payload?.body === '{"a":1}',
    "callRoute: Objekt-Body wird serialisiert und Token gesetzt",
  );

  const rawBody = await callRoute(handler, { body: "{kaputt" });
  check(
    rawBody.payload?.body === "{kaputt" && rawBody.payload?.auth === null,
    "callRoute: roher String bleibt roh, ohne Token kein Header",
  );

  const notJson = await callRoute(async () => new Response("ok", { status: 202 }), {});
  check(
    notJson.status === 202 && notJson.payload === null,
    "callRoute: Nicht-JSON-Antwort ergibt payload null",
  );

  // --- Stripe-API-Stub ---------------------------------------------------
  const realFetch = globalThis.fetch;
  const stripe = installStripeStub();
  check(globalThis.fetch !== realFetch, "install() ersetzt fetch");

  stripe.on("GET", "/v1/subscriptions/sub_1", 200, { id: "sub_1", object: "subscription" });
  const subscription = await fetch("https://api.stripe.com/v1/subscriptions/sub_1");
  check(
    subscription.status === 200 && (await subscription.json()).id === "sub_1",
    "registrierter Pfad antwortet mit Status und Body",
  );
  check(
    stripe.lastCall?.method === "GET" && stripe.lastCall?.path === "/v1/subscriptions/sub_1",
    `Aufruf wird mit Methode und Pfad protokolliert (${stripe.lastCall?.method} ${stripe.lastCall?.path})`,
  );

  stripe.on("POST", "/v1/customers", (entry) => ({
    status: 201,
    body: { id: "cus_1", echo: String(entry.body ?? "") },
  }));
  const customer = await fetch("https://api.stripe.com/v1/customers", {
    method: "POST",
    body: "email=a%40b.invalid",
  });
  check(
    customer.status === 201 && (await customer.json()).echo.includes("email="),
    "POST-Body kommt in der Antwortfunktion an",
  );
  check(stripe.calls.length === 2, `calls sammelt alle Anfragen (${stripe.calls.length})`);

  const missing = await fetch("https://api.stripe.com/v1/charges");
  check(
    missing.status === 404 && (await missing.json()).error?.type === "stub_missing_route",
    "unbekannter Pfad → 404 mit stub_missing_route",
  );

  const passthrough = await request(stub, "/auth/v1/user", { token: stub.token });
  check(
    passthrough.status === 200 && stripe.calls.length === 3,
    "Nicht-Stripe-Anfragen gehen unverändert ans echte fetch",
  );

  stripe.clear();
  check(stripe.calls.length === 0, "clear() leert die Aufzeichnung");
  stripe.restore();
  check(globalThis.fetch === realFetch, "restore() stellt das echte fetch wieder her");

  // --- Parallele Stubs und Lebenszyklus ----------------------------------
  const other = await startSupabaseStub();
  check(other.port !== stub.port, `zwei Stubs belegen verschiedene Ports (${stub.port} / ${other.port})`);
  await other.close();

  const stillAlive = await request(stub, "/auth/v1/user", { token: stub.token });
  check(stillAlive.status === 200, "Schließen des zweiten Stubs lässt den ersten laufen");

  await stub.close();
  let closed = false;
  try {
    await fetch(`${stub.url}/auth/v1/user`);
  } catch {
    closed = true;
  }
  check(closed, "close() beendet den Server wirklich");

  finish("Supabase-Stub (Kontrakt)");
}

main().catch((error) => {
  console.error("Kontrakt-Test abgebrochen:", error.message);
  process.exit(1);
});
