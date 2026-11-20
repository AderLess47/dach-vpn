#!/usr/bin/env bun
/**
 * HTTP-Ebene der Abo-Routen `stripe/checkout` und `stripe/portal` — ohne Netz,
 * ohne Stripe-Konto.
 *
 * Beide Routen hängen an denselben zwei Stubs: Supabase (Anmeldung, Tabelle
 * `subscriptions`) und Stripe (Kunden anlegen, Checkout-Session, Portal-Session
 * über `scripts/lib/stripe-api-stub.mjs`).
 *
 * Geprüft wird für den Checkout:
 * - 202-Trockenlauf ohne Supabase und ohne Stripe-Konfiguration, inklusive
 *   `missing`-Liste (Key, Basispreis, Service-Role-Key),
 * - 401/503 der Anmeldung,
 * - vorhandener Kunde: kein `customers.create`, Session mit dieser Kunden-ID,
 * - neuer Kunde: `customers.create` mit E-Mail und `metadata[user_id]`, dann
 *   Upsert auf `subscriptions` mit der Nutzer-ID aus dem Token,
 * - Add-on: zweite Position nur mit konfiguriertem Add-on-Preis, `addon` nur
 *   bei `true`, kaputtes JSON zählt als „kein Add-on“,
 * - Session-Parameter: Modus, `client_reference_id`, Metadaten, Rücksprung-URLs
 *   aus `NEXT_PUBLIC_APP_URL`,
 * - 502 CHECKOUT_FAILED bei Lese-, Kunden-, Upsert- und Session-Fehler.
 *
 * Für das Portal:
 * - 401/503, 202 ohne Stripe- oder Service-Role-Key,
 * - 409 NO_CUSTOMER ohne Zeile und ohne Kunden-ID,
 * - Portal-Session mit Kunden-ID und `return_url`, 200 mit URL,
 * - 502 PORTAL_FAILED bei Stripe-Fehler.
 *
 * Und für beide: keine Antwort enthält SQLSTATE, DB-Text oder Stripe-Meldungen.
 */
import { callRoute } from "./lib/route-http.mjs";
import { installStripeStub } from "./lib/stripe-api-stub.mjs";
import { startSupabaseStub } from "./lib/supabase-stub.mjs";
import { createChecker } from "./lib/db-fixture.mjs";

const APP_URL = "https://app.stub.invalid";
const STRIPE_KEY = "sk_test_stub";
const PRICE_BASE = "price_base_stub";
const PRICE_ADDON = "price_addon_stub";
const CUSTOMER_ID = "cus_existing";

const { check, finish } = createChecker();
const stripe = installStripeStub();
const supabase = await startSupabaseStub();
supabase.installEnv({
  STRIPE_SECRET_KEY: STRIPE_KEY,
  STRIPE_PRICE_ID_BASE: PRICE_BASE,
  STRIPE_PRICE_ID_PIHOLE: PRICE_ADDON,
  NEXT_PUBLIC_APP_URL: APP_URL,
});

const checkout = await import("../apps/dashboard/app/api/stripe/checkout/route.ts");
const portal = await import("../apps/dashboard/app/api/stripe/portal/route.ts");

// --- PostgREST: subscriptions --------------------------------------------
let selectReply = { status: 200, body: [] };
let upsertReply = { status: 201, body: null };
let tableCalls = [];

supabase.route("/rest/v1/subscriptions", (request, response, ctx) => {
  tableCalls.push({ method: request.method, url: ctx.url, body: ctx.json });
  if (request.method === "POST") return ctx.send(response, upsertReply.status, upsertReply.body);
  return ctx.send(response, selectReply.status, selectReply.body);
});

// --- Stripe: formularkodierte Antworten ----------------------------------
let customerReply = { status: 200, body: { id: "cus_new", object: "customer" } };
let checkoutReply = {
  status: 200,
  body: { id: "cs_stub", object: "checkout.session", url: "https://checkout.stripe.test/cs_stub" },
};
let portalReply = {
  status: 200,
  body: { id: "bps_stub", object: "billing_portal.session", url: "https://portal.stripe.test/bps_stub" },
};

stripe.on("POST", "/v1/customers", () => customerReply);
stripe.on("POST", "/v1/checkout/sessions", () => checkoutReply);
stripe.on("POST", "/v1/billing_portal/sessions", () => portalReply);

function resetFixtures() {
  selectReply = { status: 200, body: [] };
  upsertReply = { status: 201, body: null };
  tableCalls = [];
  customerReply = { status: 200, body: { id: "cus_new", object: "customer" } };
  checkoutReply = {
    status: 200,
    body: { id: "cs_stub", object: "checkout.session", url: "https://checkout.stripe.test/cs_stub" },
  };
  portalReply = {
    status: 200,
    body: { id: "bps_stub", object: "billing_portal.session", url: "https://portal.stripe.test/bps_stub" },
  };
  stripe.clear();
}

/** Stripe schickt `application/x-www-form-urlencoded`; Werte sind URL-kodiert. */
function form(call) {
  return new URLSearchParams(String(call?.body ?? ""));
}

function upsertBody() {
  const entry = tableCalls.find((call) => call.method === "POST");
  const row = Array.isArray(entry?.body) ? entry.body[0] : entry?.body;
  return row ?? null;
}

const responses = [];

async function call(route, options = {}) {
  const result = await callRoute(route, { token: supabase.token, ...options });
  responses.push(result);
  return result;
}

const checkoutPost = (body, options = {}) => call(checkout.POST, { body, ...options });
const portalPost = (options = {}) => call(portal.POST, { body: {}, ...options });

// =========================================================================
// Checkout
// =========================================================================

// --- Konfiguration --------------------------------------------------------
const offline = supabase.installEnv({ SUPABASE_URL: null, SUPABASE_ANON_KEY: null });
try {
  resetFixtures();
  const off = await checkoutPost({});
  check(
    off.status === 202 && off.payload?.persisted === false && off.payload?.reason === "SUPABASE_NOT_CONFIGURED",
    `Checkout ohne Supabase → 202 Trockenlauf (${off.status} ${off.payload?.reason})`,
  );
} finally {
  offline();
}

let restoreEnv = supabase.installEnv();
try {
  const anonymous = await checkoutPost({}, { token: null });
  check(
    anonymous.status === 401 &&
      anonymous.payload?.code === "AUTH_REQUIRED" &&
      anonymous.payload?.message === "Für den Checkout ist eine Anmeldung erforderlich.",
    `Checkout ohne Token → 401 AUTH_REQUIRED (${anonymous.status})`,
  );

  const bogus = await checkoutPost({}, { token: "bad-token" });
  check(
    bogus.status === 401 && bogus.payload?.code === "INVALID_TOKEN",
    `Checkout mit falschem Token → 401 INVALID_TOKEN (${bogus.status})`,
  );

  const unavailable = await checkoutPost({}, { token: supabase.unavailableToken });
  check(
    unavailable.status === 503 && unavailable.payload?.code === "AUTH_UNAVAILABLE",
    `Checkout bei Auth-Ausfall → 503 (${unavailable.status})`,
  );
  check(
    unavailable.response.headers.get("retry-after") === "2" &&
      unavailable.response.headers.get("cache-control") === "no-store",
    "Checkout-503 trägt retry-after und cache-control",
  );
} finally {
  restoreEnv();
}

const withoutStripeKey = supabase.installEnv({ STRIPE_SECRET_KEY: null });
try {
  resetFixtures();
  const off = await checkoutPost({});
  check(
    off.status === 202 &&
      off.payload?.reason === "STRIPE_NOT_CONFIGURED" &&
      Array.isArray(off.payload?.missing) &&
      off.payload.missing.includes("STRIPE_SECRET_KEY") &&
      /Trockenlauf/.test(off.payload?.message ?? ""),
    `Checkout ohne Stripe-Key → 202 mit missing (${off.payload?.missing})`,
  );
  check(stripe.calls.length === 0, "kein Stripe-Aufruf im Trockenlauf");
} finally {
  withoutStripeKey();
}

const withoutPrice = supabase.installEnv({ STRIPE_PRICE_ID_BASE: null });
try {
  resetFixtures();
  const off = await checkoutPost({});
  check(
    off.status === 202 && off.payload?.missing?.includes("STRIPE_PRICE_ID_BASE"),
    `Checkout ohne Basispreis → 202 mit missing (${off.payload?.missing})`,
  );
} finally {
  withoutPrice();
}

const withoutServiceKey = supabase.installEnv({ SUPABASE_SERVICE_ROLE_KEY: null });
try {
  resetFixtures();
  const off = await checkoutPost({});
  check(
    off.status === 202 && off.payload?.missing?.includes("SUPABASE_SERVICE_ROLE_KEY"),
    `Checkout ohne Service-Role-Key → 202 mit missing (${off.payload?.missing})`,
  );
} finally {
  withoutServiceKey();
}

const withoutAll = supabase.installEnv({
  STRIPE_SECRET_KEY: null,
  STRIPE_PRICE_ID_BASE: null,
  SUPABASE_SERVICE_ROLE_KEY: null,
});
try {
  resetFixtures();
  const off = await checkoutPost({});
  check(
    off.payload?.missing?.length === 3,
    `alle drei Voraussetzungen fehlen → missing mit drei Einträgen (${off.payload?.missing?.length})`,
  );
} finally {
  withoutAll();
}

// --- Vorhandener Kunde ----------------------------------------------------
restoreEnv = supabase.installEnv({
  STRIPE_SECRET_KEY: STRIPE_KEY,
  STRIPE_PRICE_ID_BASE: PRICE_BASE,
  STRIPE_PRICE_ID_PIHOLE: PRICE_ADDON,
  NEXT_PUBLIC_APP_URL: APP_URL,
});
try {
  resetFixtures();
  selectReply = { status: 200, body: [{ stripe_customer_id: CUSTOMER_ID }] };
  const ok = await checkoutPost({});
  check(
    ok.status === 200 && ok.payload?.url === "https://checkout.stripe.test/cs_stub",
    `vorhandener Kunde → 200 mit Session-URL (${ok.status})`,
  );
  check(
    stripe.callsTo("/v1/customers").length === 0,
    "vorhandener Kunde legt keinen zweiten Stripe-Kunden an",
  );
  check(tableCalls.every((entry) => entry.method !== "POST"), "vorhandener Kunde braucht kein Upsert");

  const lookup = tableCalls.find((entry) => entry.method === "GET");
  check(
    lookup?.url.includes(`user_id=eq.${supabase.userId}`),
    "Kundensuche filtert auf die Nutzer-ID aus dem Token",
  );

  const params = form(stripe.callsTo("/v1/checkout/sessions").at(-1));
  check(params.get("mode") === "subscription", `Session im Abo-Modus (${params.get("mode")})`);
  check(params.get("customer") === CUSTOMER_ID, "Session nutzt den vorhandenen Kunden");
  check(
    params.get("client_reference_id") === supabase.userId &&
      params.get("subscription_data[metadata][user_id]") === supabase.userId,
    "Nutzer-ID aus dem Token landet in Session und Metadaten",
  );
  check(
    params.get("success_url") === `${APP_URL}/?checkout=success` &&
      params.get("cancel_url") === `${APP_URL}/?checkout=cancel`,
    `Rücksprung-URLs kommen aus NEXT_PUBLIC_APP_URL (${params.get("success_url")})`,
  );
  check(
    params.getAll("line_items[0][price]").join() === PRICE_BASE &&
      params.get("line_items[1][price]") === null,
    "ohne Add-on nur die Basisposition",
  );

  // --- Add-on ------------------------------------------------------------
  resetFixtures();
  selectReply = { status: 200, body: [{ stripe_customer_id: CUSTOMER_ID }] };
  await checkoutPost({ addon: true });
  const withAddon = form(stripe.callsTo("/v1/checkout/sessions").at(-1));
  check(
    withAddon.getAll("line_items[0][price]").join() === PRICE_BASE &&
      withAddon.get("line_items[1][price]") === PRICE_ADDON,
    `Add-on ergänzt die zweite Position (${withAddon.get("line_items[1][price]")})`,
  );

  resetFixtures();
  selectReply = { status: 200, body: [{ stripe_customer_id: CUSTOMER_ID }] };
  await checkoutPost({ addon: "ja" });
  check(
    form(stripe.callsTo("/v1/checkout/sessions").at(-1)).get("line_items[1][price]") === null,
    "nur addon === true bucht das Add-on",
  );

  resetFixtures();
  selectReply = { status: 200, body: [{ stripe_customer_id: CUSTOMER_ID }] };
  await checkoutPost("{kaputt");
  check(
    form(stripe.callsTo("/v1/checkout/sessions").at(-1)).get("line_items[1][price]") === null,
    "kaputtes JSON zählt als „kein Add-on“, nicht als Fehler",
  );

  // --- Neuer Kunde -------------------------------------------------------
  resetFixtures();
  selectReply = { status: 200, body: [] };
  const created = await checkoutPost({});
  check(created.status === 200, `neuer Kunde → 200 (${created.status})`);
  check(
    stripe.callsTo("/v1/customers").length === 1,
    "ohne Zeile wird genau ein Stripe-Kunde angelegt",
  );

  const customerParams = form(stripe.callsTo("/v1/customers").at(-1));
  check(
    customerParams.get("email") === supabase.email &&
      customerParams.get("metadata[user_id]") === supabase.userId,
    "Kunde trägt E-Mail und Nutzer-ID aus dem Token",
  );

  const upsert = upsertBody();
  check(
    upsert?.user_id === supabase.userId && upsert?.stripe_customer_id === "cus_new",
    `Upsert schreibt Nutzer-ID und neue Kunden-ID (${JSON.stringify(upsert)})`,
  );
  check(
    tableCalls.find((entry) => entry.method === "POST")?.url.includes("on_conflict=user_id"),
    "Upsert läuft idempotent auf user_id",
  );
  check(
    form(stripe.callsTo("/v1/checkout/sessions").at(-1)).get("customer") === "cus_new",
    "Session nutzt den neu angelegten Kunden",
  );

  // --- Fehlerpfade -------------------------------------------------------
  resetFixtures();
  selectReply = {
    status: 400,
    body: { code: "XX000", message: 'relation "subscriptions" does not exist', details: null, hint: null },
  };
  const readFailed = await checkoutPost({});
  check(
    readFailed.status === 502 &&
      readFailed.payload?.code === "CHECKOUT_FAILED" &&
      readFailed.payload?.message === "Checkout konnte nicht erstellt werden.",
    `Lesefehler → 502 CHECKOUT_FAILED (${readFailed.status})`,
  );
  check(stripe.calls.length === 0, "Lesefehler erreicht Stripe nicht");

  resetFixtures();
  selectReply = { status: 200, body: [] };
  customerReply = {
    status: 500,
    body: { error: { type: "api_error", message: 'relation "customers" does not exist' } },
  };
  const customerFailed = await checkoutPost({});
  check(
    customerFailed.status === 502 && customerFailed.payload?.code === "CHECKOUT_FAILED",
    `Kundenfehler → 502 CHECKOUT_FAILED (${customerFailed.status})`,
  );
  check(
    stripe.callsTo("/v1/checkout/sessions").length === 0,
    "ohne Kunden wird keine Session erzeugt",
  );
  check(
    !JSON.stringify(customerFailed.payload).includes("customers"),
    "Stripe-Meldung landet nicht in der Antwort",
  );

  resetFixtures();
  selectReply = { status: 200, body: [] };
  upsertReply = {
    status: 400,
    body: { code: "23503", message: 'insert violates foreign key constraint', details: null, hint: null },
  };
  const upsertFailed = await checkoutPost({});
  check(
    upsertFailed.status === 502 && upsertFailed.payload?.code === "CHECKOUT_FAILED",
    `Upsert-Fehler → 502 CHECKOUT_FAILED (${upsertFailed.status})`,
  );
  check(
    stripe.callsTo("/v1/checkout/sessions").length === 0,
    "ohne gespeicherten Kunden keine Session",
  );

  resetFixtures();
  selectReply = { status: 200, body: [{ stripe_customer_id: CUSTOMER_ID }] };
  checkoutReply = {
    status: 402,
    body: { error: { type: "invalid_request_error", message: "No such price: price_x" } },
  };
  const sessionFailed = await checkoutPost({});
  check(
    sessionFailed.status === 502 && sessionFailed.payload?.code === "CHECKOUT_FAILED",
    `Session-Fehler → 502 CHECKOUT_FAILED (${sessionFailed.status})`,
  );
  check(
    !JSON.stringify(sessionFailed.payload).includes("price_x"),
    "Session-Fehlertext bleibt intern",
  );
} finally {
  restoreEnv();
}

// =========================================================================
// Portal
// =========================================================================

const portalOffline = supabase.installEnv({ SUPABASE_URL: null, SUPABASE_ANON_KEY: null });
try {
  resetFixtures();
  const off = await portalPost();
  check(
    off.status === 202 && off.payload?.reason === "SUPABASE_NOT_CONFIGURED",
    `Portal ohne Supabase → 202 Trockenlauf (${off.status})`,
  );
} finally {
  portalOffline();
}

restoreEnv = supabase.installEnv();
try {
  const anonymous = await portalPost({ token: null });
  check(
    anonymous.status === 401 &&
      anonymous.payload?.code === "AUTH_REQUIRED" &&
      anonymous.payload?.message === "Für das Abo-Portal ist eine Anmeldung erforderlich.",
    `Portal ohne Token → 401 AUTH_REQUIRED (${anonymous.status})`,
  );

  const unavailable = await portalPost({ token: supabase.unavailableToken });
  check(
    unavailable.status === 503 && unavailable.payload?.code === "AUTH_UNAVAILABLE",
    `Portal bei Auth-Ausfall → 503 (${unavailable.status})`,
  );
} finally {
  restoreEnv();
}

const portalWithoutStripe = supabase.installEnv({ STRIPE_SECRET_KEY: null });
try {
  resetFixtures();
  const off = await portalPost();
  check(
    off.status === 202 && off.payload?.reason === "STRIPE_NOT_CONFIGURED",
    `Portal ohne Stripe-Key → 202 (${off.status})`,
  );
} finally {
  portalWithoutStripe();
}

const portalWithoutServiceKey = supabase.installEnv({ SUPABASE_SERVICE_ROLE_KEY: null });
try {
  resetFixtures();
  const off = await portalPost();
  check(
    off.status === 202 && off.payload?.reason === "STRIPE_NOT_CONFIGURED",
    `Portal ohne Service-Role-Key → 202 (${off.status})`,
  );
} finally {
  portalWithoutServiceKey();
}

restoreEnv = supabase.installEnv({
  STRIPE_SECRET_KEY: STRIPE_KEY,
  STRIPE_PRICE_ID_BASE: PRICE_BASE,
  STRIPE_PRICE_ID_PIHOLE: PRICE_ADDON,
  NEXT_PUBLIC_APP_URL: APP_URL,
});
try {
  resetFixtures();
  selectReply = { status: 200, body: [] };
  const noRow = await portalPost();
  check(
    noRow.status === 409 &&
      noRow.payload?.code === "NO_CUSTOMER" &&
      /noch kein Stripe-Kunde/.test(noRow.payload?.message ?? ""),
    `Portal ohne Zeile → 409 NO_CUSTOMER (${noRow.status})`,
  );
  check(stripe.calls.length === 0, "Portal ohne Kunde ruft Stripe nicht auf");

  resetFixtures();
  selectReply = { status: 200, body: [{ stripe_customer_id: null }] };
  const noCustomer = await portalPost();
  check(
    noCustomer.status === 409 && noCustomer.payload?.code === "NO_CUSTOMER",
    `Portal mit Zeile ohne Kunden-ID → 409 (${noCustomer.status})`,
  );

  resetFixtures();
  selectReply = {
    status: 500,
    body: { code: "XX000", message: 'relation "subscriptions" does not exist', details: null, hint: null },
  };
  const readFailed = await portalPost();
  check(
    readFailed.status === 502 && readFailed.payload?.code === "PORTAL_FAILED",
    `Portal bei Lesefehler → 502 PORTAL_FAILED, nicht 409 (${readFailed.status})`,
  );
  check(stripe.calls.length === 0, "Portal-Lesefehler erreicht Stripe nicht");
  check(
    !/XX000|relation "/i.test(JSON.stringify(readFailed.payload ?? {})),
    "Portal-502 enthält keinen DB-Text",
  );

  resetFixtures();
  selectReply = { status: 200, body: [{ stripe_customer_id: CUSTOMER_ID }] };
  const ok = await portalPost();
  check(
    ok.status === 200 && ok.payload?.url === "https://portal.stripe.test/bps_stub",
    `Portal mit Kunde → 200 mit Portal-URL (${ok.status})`,
  );

  const lookup = tableCalls.find((entry) => entry.method === "GET");
  check(
    lookup?.url.includes(`user_id=eq.${supabase.userId}`),
    "Portal sucht den Kunden über die Nutzer-ID aus dem Token",
  );

  const params = form(stripe.callsTo("/v1/billing_portal/sessions").at(-1));
  check(
    params.get("customer") === CUSTOMER_ID && params.get("return_url") === `${APP_URL}/`,
    `Portal-Session nutzt Kunden-ID und Rücksprung-URL (${params.get("return_url")})`,
  );

  resetFixtures();
  selectReply = { status: 200, body: [{ stripe_customer_id: CUSTOMER_ID }] };
  portalReply = {
    status: 500,
    body: { error: { type: "api_error", message: "portal unavailable: relation" } },
  };
  const failed = await portalPost();
  check(
    failed.status === 502 &&
      failed.payload?.code === "PORTAL_FAILED" &&
      failed.payload?.message === "Abo-Portal konnte nicht geöffnet werden.",
    `Portal-Fehler → 502 PORTAL_FAILED (${failed.status})`,
  );
  check(
    !/portal unavailable|relation/i.test(JSON.stringify(failed.payload ?? {})),
    "Stripe-Meldung bleibt intern",
  );
} finally {
  restoreEnv();
}

// --- Sammelprüfung: nichts aus Datenbank oder Stripe nach außen ----------
const leaks = responses.filter((entry) => {
  const text = JSON.stringify(entry.payload ?? {});
  return /P000\d|235\d\d|XX000|relation "|SQLSTATE|No such price|portal unavailable/i.test(text);
});
check(
  leaks.length === 0,
  `keine Antwort enthält SQLSTATE, DB-Text oder Stripe-Meldung (${leaks.length} verdächtig)`,
);

stripe.restore();
await supabase.close();
finish("Stripe-Checkout und -Portal (HTTP, Stub)");
