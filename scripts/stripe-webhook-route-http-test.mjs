#!/usr/bin/env bun
/**
 * HTTP-Ebene der Stripe-Webhook-Route — ohne Netz, ohne Stripe-Konto.
 *
 * Die Route prüft die Signatur selbst (HMAC über den Rohbody), schreibt in
 * `stripe_events` und `subscriptions` und ruft `apply_subscription_state`. Zwei
 * Stubs decken das ab:
 *
 * - Supabase-Stub: GoTrue unnötig (der Webhook hat keine Anmeldung), PostgREST
 *   für die beiden Tabellen und den RPC.
 * - Stripe-API-Stub: hängt an `globalThis.fetch` und beantwortet
 *   `GET /v1/subscriptions/…`, das die Route bei `checkout.session.completed`
 *   und beim Nachziehen aus einem `invoice.payment_failed` braucht.
 *
 * Geprüft wird:
 * - 202-Trockenlauf ohne Konfiguration (Key, Secret oder Service-Role-Key),
 * - 400 ohne Signatur und bei falschem Secret,
 * - die Abbildung Event → RPC: Nutzer-ID aus den Metadaten, Status-Mapping,
 *   Add-on-Erkennung, spätestes Periodenende, Kündigung über `cancel_at`,
 * - Ereignisse ohne Wirkung (unbekannter Typ, fehlende `user_id`) bleiben 200,
 * - Idempotenz: abgeschlossene Events sind Duplikat, abgebrochene werden erneut
 *   verarbeitet, ein Lesefehler wird 502,
 * - `checkout.session.completed` mit String- und Objekt-Referenz,
 * - `invoice.payment_failed` mit und ohne vorhandene Abo-Zeile, inklusive
 *   `parent.subscription_details` und fehlender `metadata.user_id` (500),
 * - dass kein SQLSTATE, keine DB-Meldung und keine interne Fehlermeldung in
 *   einer Antwort landet.
 *
 * Kein Docker, keine Datenbank, kein Stripe-Key.
 */
import { createHmac } from "node:crypto";
import { callRoute } from "./lib/route-http.mjs";
import { installStripeStub } from "./lib/stripe-api-stub.mjs";
import { startSupabaseStub } from "./lib/supabase-stub.mjs";
import { createChecker } from "./lib/db-fixture.mjs";

const WEBHOOK_SECRET = "whsec_test_stub";
const STRIPE_KEY = "sk_test_stub";
const PRICE_BASE = "price_base_stub";
const PRICE_ADDON = "price_addon_stub";
const PERIOD_END = 1_800_000_000;
const NOW = Math.floor(Date.now() / 1000);

const { check, finish } = createChecker();
const stripe = installStripeStub();
const stub = await startSupabaseStub();
stub.installEnv({
  STRIPE_SECRET_KEY: STRIPE_KEY,
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  STRIPE_PRICE_ID_BASE: PRICE_BASE,
  STRIPE_PRICE_ID_PIHOLE: PRICE_ADDON,
});

const route = await import("../apps/dashboard/app/api/stripe/webhook/route.ts");

// --- PostgREST: stripe_events und subscriptions ---------------------------
let insertReply = { status: 201, body: null };
let selectReply = { status: 200, body: [] };
let updateReply = { status: 204, body: null };
let writes = [];
let subscriptionRow = null;

stub.route("/rest/v1/stripe_events", (request, response, ctx) => {
  writes.push({ method: request.method, url: ctx.url, body: ctx.json });
  if (request.method === "POST") return ctx.send(response, insertReply.status, insertReply.body);
  if (request.method === "GET") return ctx.send(response, selectReply.status, selectReply.body);
  if (request.method === "PATCH") return ctx.send(response, updateReply.status, updateReply.body);
  return ctx.send(response, 405, { message: `unerwartete Methode ${request.method}` });
});

stub.route("/rest/v1/subscriptions", (request, response, ctx) => {
  writes.push({ method: request.method, url: ctx.url, body: ctx.json });
  return ctx.send(response, 200, subscriptionRow ? [subscriptionRow] : []);
});

/** Nach jeder Meldung zurück auf „frische Zeile"; Tests überschreiben gezielt. */
function resetEventLog() {
  insertReply = { status: 201, body: null };
  selectReply = { status: 200, body: [] };
  updateReply = { status: 204, body: null };
  subscriptionRow = null;
  writes = [];
}

/** `.insert({…})` darf als Objekt oder einelementiges Array ankommen. */
function rowOf(body) {
  return Array.isArray(body) ? (body[0] ?? null) : (body ?? null);
}

// --- Ereignisse und Signatur ---------------------------------------------
let eventSeq = 0;

function subscription(overrides = {}) {
  const {
    id = "sub_test_1",
    userId = stub.userId,
    status = "active",
    priceIds = [PRICE_BASE],
    periodEnds = [PERIOD_END],
    cancelAtPeriodEnd = false,
    cancelAt = null,
    customer = "cus_test_1",
  } = overrides;

  return {
    id,
    object: "subscription",
    customer,
    status,
    cancel_at_period_end: cancelAtPeriodEnd,
    cancel_at: cancelAt,
    metadata: userId === null ? {} : { user_id: userId },
    items: {
      object: "list",
      data: priceIds.map((priceId, index) => ({
        id: `si_${index}`,
        object: "subscription_item",
        current_period_end: periodEnds[index] ?? periodEnds[0],
        price: { id: priceId, object: "price" },
      })),
    },
  };
}

function event(type, object) {
  eventSeq += 1;
  return {
    id: `evt_stub_${eventSeq}`,
    object: "event",
    api_version: "2026-09-30.endive",
    created: NOW,
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
    data: { object },
  };
}

/** Stripe erwartet `t=<ts>,v1=<hmac>`; signiert wird `<ts>.<payload>`. */
function sign(payload, secret = WEBHOOK_SECRET, timestamp = Math.floor(Date.now() / 1000)) {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

const responses = [];

/**
 * `signature`: undefined = gültig signieren, null = Header weglassen,
 * String = genau diesen Header schicken.
 */
async function deliver(eventOrPayload, { signature, secret } = {}) {
  const payload = typeof eventOrPayload === "string" ? eventOrPayload : JSON.stringify(eventOrPayload);
  const header = signature === undefined ? sign(payload, secret) : signature;

  const headers = { "content-type": "application/json" };
  if (header !== null) headers["stripe-signature"] = header;

  const result = await callRoute(route.POST, { body: payload, headers });
  responses.push(result);
  return result;
}

function isDuplicate(writesSoFar) {
  return writesSoFar.filter((entry) => entry.method === "PATCH").length === 0;
}

// --- Konfiguration --------------------------------------------------------
const withoutStripe = stub.installEnv({ STRIPE_SECRET_KEY: null });
try {
  resetEventLog();
  const off = await deliver(event("customer.subscription.updated", subscription()));
  check(
    off.status === 202 && off.payload?.reason === "STRIPE_NOT_CONFIGURED",
    `ohne Stripe-Key → 202 Trockenlauf (${off.status} ${off.payload?.reason})`,
  );
  check(writes.length === 0 && stripe.calls.length === 0, "Trockenlauf ohne Netzzugriff");
} finally {
  withoutStripe();
}

const withoutSecret = stub.installEnv({ STRIPE_WEBHOOK_SECRET: null });
try {
  resetEventLog();
  const off = await deliver(event("customer.subscription.updated", subscription()));
  check(
    off.status === 202 && off.payload?.reason === "STRIPE_NOT_CONFIGURED",
    `ohne Webhook-Secret → 202 Trockenlauf (${off.status})`,
  );
} finally {
  withoutSecret();
}

const withoutServiceKey = stub.installEnv({ SUPABASE_SERVICE_ROLE_KEY: null });
try {
  resetEventLog();
  const off = await deliver(event("customer.subscription.updated", subscription()));
  check(
    off.status === 202 && off.payload?.reason === "STRIPE_NOT_CONFIGURED",
    `ohne Service-Role-Key → 202 Trockenlauf (${off.status})`,
  );
} finally {
  withoutServiceKey();
}

// --- Signatur -------------------------------------------------------------
resetEventLog();
const unsigned = await deliver(event("customer.subscription.updated", subscription()), {
  signature: null,
});
check(
  unsigned.status === 400 && unsigned.payload?.code === "MISSING_SIGNATURE",
  `ohne Signatur → 400 MISSING_SIGNATURE (${unsigned.status})`,
);

resetEventLog();
const forged = await deliver(event("customer.subscription.updated", subscription()), {
  secret: "whsec_falsch",
});
check(
  forged.status === 400 && forged.payload?.code === "INVALID_SIGNATURE",
  `falsches Secret → 400 INVALID_SIGNATURE (${forged.status})`,
);

resetEventLog();
const garbage = await deliver(event("customer.subscription.updated", subscription()), {
  signature: "t=1,v1=kein-hex",
});
check(
  garbage.status === 400 && garbage.payload?.code === "INVALID_SIGNATURE",
  `kaputter Header → 400 INVALID_SIGNATURE (${garbage.status})`,
);
check(
  writes.length === 0 && stub.rpcCalls.length === 0,
  "kein Schreibzugriff ohne gültige Signatur",
);

// --- Abo-Ereignis: vollständige Abbildung --------------------------------
resetEventLog();
stub.setRpc(200, null);
const updatedEvent = event(
  "customer.subscription.updated",
  subscription({
    status: "active",
    priceIds: [PRICE_BASE, PRICE_ADDON],
    periodEnds: [PERIOD_END, PERIOD_END + 60],
  }),
);
const updated = await deliver(updatedEvent);
check(
  updated.status === 200 && updated.payload?.received === true && updated.payload?.handled === true,
  `Abo-Update → 200 received/handled (${updated.status})`,
);

const rpc = stub.lastRpc;
check(rpc?.name === "apply_subscription_state", `RPC-Name (${rpc?.name})`);
check(rpc?.body?.p_user_id === stub.userId, "Nutzer-ID aus den Subscription-Metadaten");
check(rpc?.body?.p_subscription_id === "sub_test_1", "Subscription-ID wandert in den RPC");
check(rpc?.body?.p_customer_id === "cus_test_1", "Kunden-ID wandert in den RPC");
check(rpc?.body?.p_status === "active", `Status aktiv (${rpc?.body?.p_status})`);
check(rpc?.body?.p_pihole === true, "Add-on-Position erkannt");
check(
  rpc?.body?.p_period_end === new Date((PERIOD_END + 60) * 1000).toISOString(),
  `spätestes Periodenende gewinnt (${rpc?.body?.p_period_end})`,
);
check(rpc?.body?.p_cancel_at_period_end === false, "ohne Kündigung kein Flag");
check(rpc?.headers?.apikey === stub.serviceKey, "RPC läuft mit dem Service-Role-Key");

const insert = writes.find((entry) => entry.method === "POST");
check(
  rowOf(insert?.body)?.event_id === updatedEvent.id &&
    rowOf(insert?.body)?.type === "customer.subscription.updated",
  "Event-ID und Typ werden protokolliert",
);
const processed = writes.filter((entry) => entry.method === "PATCH").at(-1);
check(
  typeof rowOf(processed?.body)?.processed_at === "string",
  "abgeschlossenes Event bekommt processed_at",
);
check(
  !("error" in (rowOf(processed?.body) ?? {})),
  "erfolgreiches Event hinterlässt keine Fehlermeldung",
);

// --- Status-Abbildung -----------------------------------------------------
for (const [stripeStatus, expected] of [
  ["trialing", "active"],
  ["unpaid", "past_due"],
  ["incomplete_expired", "canceled"],
  ["incomplete", "incomplete"],
  ["canceled", "canceled"],
]) {
  resetEventLog();
  stub.setRpc(200, null);
  const result = await deliver(event("customer.subscription.updated", subscription({ status: stripeStatus })));
  check(
    result.status === 200 && stub.lastRpc?.body?.p_status === expected,
    `Stripe-Status ${stripeStatus} → ${expected} (${stub.lastRpc?.body?.p_status})`,
  );
}

resetEventLog();
const beforeUnknown = stub.rpcCalls.length;
const unknownStatus = await deliver(
  event("customer.subscription.updated", subscription({ status: "paused" })),
);
check(
  unknownStatus.status === 200 &&
    unknownStatus.payload?.handled === true &&
    stub.rpcCalls.length === beforeUnknown,
  `unbekannter Status bleibt wirkungslos (${unknownStatus.status})`,
);

resetEventLog();
const beforeNoUser = stub.rpcCalls.length;
const withoutUser = await deliver(
  event("customer.subscription.updated", subscription({ userId: null })),
);
check(
  withoutUser.status === 200 && stub.rpcCalls.length === beforeNoUser,
  "Subscription ohne metadata.user_id bleibt wirkungslos",
);

// --- Add-on, Periodenende, Kündigung -------------------------------------
resetEventLog();
stub.setRpc(200, null);
await deliver(
  event("customer.subscription.updated", subscription({ priceIds: [PRICE_BASE], periodEnds: [PERIOD_END] })),
);
check(stub.lastRpc?.body?.p_pihole === false, "ohne Add-on-Position p_pihole false");

resetEventLog();
stub.setRpc(200, null);
await deliver(
  event(
    "customer.subscription.updated",
    subscription({ priceIds: [], periodEnds: [], cancelAtPeriodEnd: true }),
  ),
);
check(
  stub.lastRpc?.body?.p_period_end === null && stub.lastRpc?.body?.p_pihole === false,
  "ohne Positionen kein Periodenende und kein Add-on",
);
check(stub.lastRpc?.body?.p_cancel_at_period_end === true, "gesetztes Flag zählt als Kündigung");

resetEventLog();
stub.setRpc(200, null);
await deliver(
  event(
    "customer.subscription.updated",
    subscription({ cancelAtPeriodEnd: false, cancelAt: PERIOD_END }),
  ),
);
check(
  stub.lastRpc?.body?.p_cancel_at_period_end === true,
  "flexible Abrechnung: cancel_at am Periodenende zählt als Kündigung",
);

resetEventLog();
stub.setRpc(200, null);
await deliver(
  event(
    "customer.subscription.updated",
    subscription({ cancelAtPeriodEnd: false, cancelAt: PERIOD_END + 3600 }),
  ),
);
check(
  stub.lastRpc?.body?.p_cancel_at_period_end === false,
  "cancel_at nach dem Periodenende ist keine Kündigung",
);

resetEventLog();
stub.setRpc(200, null);
await deliver(
  event(
    "customer.subscription.updated",
    subscription({ customer: { id: "cus_objekt" }, cancelAtPeriodEnd: false, cancelAt: null }),
  ),
);
check(stub.lastRpc?.body?.p_customer_id === "cus_objekt", "Kunde als Objekt wird zur ID");

resetEventLog();
stub.setRpc(200, null);
await deliver(event("customer.subscription.updated", subscription({ customer: null })));
check(stub.lastRpc?.body?.p_customer_id === null, "fehlender Kunde bleibt null");

// --- Ereignisse ohne Wirkung ---------------------------------------------
resetEventLog();
const beforeUnhandled = stub.rpcCalls.length;
const unhandled = await deliver(event("customer.created", { id: "cus_1", object: "customer" }));
check(
  unhandled.status === 200 &&
    unhandled.payload?.handled === false &&
    stub.rpcCalls.length === beforeUnhandled,
  `unbehandelter Typ → 200 ohne RPC (${unhandled.status})`,
);
check(
  writes.some((entry) => entry.method === "POST") &&
    writes.some((entry) => entry.method === "PATCH"),
  "unbehandeltes Event wird protokolliert und abgeschlossen",
);

// --- Idempotenz -----------------------------------------------------------
resetEventLog();
insertReply = {
  status: 409,
  body: {
    code: "23505",
    message: 'duplicate key value violates unique constraint "stripe_events_event_id_key"',
    details: null,
    hint: null,
  },
};
selectReply = { status: 200, body: [{ processed_at: new Date().toISOString() }] };
stub.setRpc(200, null);
const beforeDuplicate = stub.rpcCalls.length;
const duplicate = await deliver(event("customer.subscription.updated", subscription()));
check(
  duplicate.status === 200 && duplicate.payload?.duplicate === true,
  `bekannte Event-ID → 200 duplicate (${duplicate.status})`,
);
check(
  stub.rpcCalls.length === beforeDuplicate,
  "Duplikat löst keinen zweiten RPC aus",
);
check(isDuplicate(writes), "Duplikat schreibt kein processed_at");
check(
  writes.find((entry) => entry.method === "GET")?.url.includes("event_id=eq.evt_stub_"),
  "Duplikat wird über die Event-ID nachgeschlagen",
);

resetEventLog();
insertReply = {
  status: 409,
  body: {
    code: "23505",
    message: 'duplicate key value violates unique constraint "stripe_events_event_id_key"',
    details: null,
    hint: null,
  },
};
selectReply = { status: 200, body: [{ processed_at: null }] };
stub.setRpc(200, null);
const retried = await deliver(event("customer.subscription.updated", subscription()));
check(
  retried.status === 200 &&
    retried.payload?.duplicate === undefined &&
    stub.lastRpc?.name === "apply_subscription_state",
  `Zeile ohne processed_at wird erneut verarbeitet (${retried.status})`,
);
check(
  writes.filter((entry) => entry.method === "PATCH").length === 1,
  "erneute Verarbeitung schließt die Zeile ab",
);

resetEventLog();
insertReply = {
  status: 409,
  body: { code: "23505", message: "duplicate key value", details: null, hint: null },
};
selectReply = {
  status: 500,
  body: { code: "XX000", message: 'relation "stripe_events" does not exist', details: null, hint: null },
};
const duplicateLookupFailed = await deliver(event("customer.subscription.updated", subscription()));
check(
  duplicateLookupFailed.status === 502 && duplicateLookupFailed.payload?.code === "EVENT_LOG_FAILED",
  `Lesefehler bei bekannter ID → 502 EVENT_LOG_FAILED (${duplicateLookupFailed.status})`,
);

resetEventLog();
insertReply = {
  status: 500,
  body: { code: "XX000", message: 'relation "stripe_events" does not exist', details: null, hint: null },
};
const beforeInsertFailed = stub.rpcCalls.length;
const insertFailed = await deliver(event("customer.subscription.updated", subscription()));
check(
  insertFailed.status === 502 && insertFailed.payload?.code === "EVENT_LOG_FAILED",
  `Schreibfehler im Event-Log → 502 (${insertFailed.status})`,
);
check(
  stub.rpcCalls.length === beforeInsertFailed,
  "ohne Event-Log kein RPC — auch nicht bei kaputter Datenbank",
);

// --- Verarbeitungsfehler --------------------------------------------------
resetEventLog();
stub.rpcError("P0006", "SUBSCRIPTION_REQUIRED");
const rpcFailed = await deliver(event("customer.subscription.updated", subscription()));
check(
  rpcFailed.status === 500 && rpcFailed.payload?.code === "PROCESSING_FAILED",
  `RPC-Fehler → 500 PROCESSING_FAILED (${rpcFailed.status})`,
);
check(
  rowOf(writes.filter((entry) => entry.method === "PATCH").at(-1)?.body)?.error ===
    "SUBSCRIPTION_REQUIRED",
  "Fehlermeldung landet nur in der Sperrzeile, nicht in der Antwort",
);
check(
  !JSON.stringify(rpcFailed.payload).includes("SUBSCRIPTION_REQUIRED"),
  "Antwort auf Verarbeitungsfehler enthält keine interne Meldung",
);

// --- checkout.session.completed ------------------------------------------
stripe.on("GET", "/v1/subscriptions/sub_checkout", 200, subscription({ id: "sub_checkout" }));
stripe.on(
  "GET",
  "/v1/subscriptions/sub_checkout_object",
  200,
  subscription({ id: "sub_checkout_object", priceIds: [PRICE_BASE, PRICE_ADDON] }),
);

resetEventLog();
stub.setRpc(200, null);
stripe.clear();
const checkout = await deliver(
  event("checkout.session.completed", { id: "cs_1", object: "checkout.session", subscription: "sub_checkout" }),
);
check(
  checkout.status === 200 && checkout.payload?.handled === true,
  `checkout.session.completed → 200 (${checkout.status})`,
);
check(
  stripe.callsTo("/v1/subscriptions/sub_checkout").length === 1,
  "String-Referenz wird bei Stripe nachgeladen",
);
check(
  stub.lastRpc?.body?.p_subscription_id === "sub_checkout" &&
    stub.lastRpc?.body?.p_status === "active",
  "nachgeladenes Abo wird angewendet",
);

resetEventLog();
stub.setRpc(200, null);
stripe.clear();
const checkoutObject = await deliver(
  event("checkout.session.completed", {
    id: "cs_2",
    object: "checkout.session",
    subscription: { id: "sub_checkout_object", object: "subscription" },
  }),
);
check(
  checkoutObject.status === 200 &&
    stub.lastRpc?.body?.p_subscription_id === "sub_checkout_object" &&
    stub.lastRpc?.body?.p_pihole === true,
  "Objekt-Referenz mit Add-on wird angewendet",
);

resetEventLog();
stub.setRpc(200, null);
stripe.clear();
const beforeCheckoutWithoutSubscription = stub.rpcCalls.length;
const checkoutWithoutSubscription = await deliver(
  event("checkout.session.completed", { id: "cs_3", object: "checkout.session", subscription: null }),
);
check(
  checkoutWithoutSubscription.status === 200 &&
    stripe.calls.length === 0 &&
    stub.rpcCalls.length === beforeCheckoutWithoutSubscription,
  "Checkout ohne Abo-Referenz lädt nichts nach",
);

// --- invoice.payment_failed ----------------------------------------------
stripe.on("GET", "/v1/subscriptions/sub_invoice", 200, subscription({ id: "sub_invoice" }));
stripe.on(
  "GET",
  "/v1/subscriptions/sub_invoice_parent",
  200,
  subscription({ id: "sub_invoice_parent", status: "active" }),
);

resetEventLog();
subscriptionRow = {
  user_id: "44444444-3333-4222-8111-000000000000",
  stripe_customer_id: "cus_bestand",
  pihole_addon_active: true,
  current_period_end: "2027-01-15T00:00:00.000Z",
  cancel_at_period_end: true,
};
stub.setRpc(200, null);
stripe.clear();
const invoiceWithRow = await deliver(
  event("invoice.payment_failed", { id: "in_1", object: "invoice", subscription: "sub_invoice" }),
);
check(
  invoiceWithRow.status === 200 && stripe.calls.length === 0,
  `vorhandene Abo-Zeile: kein Nachladen (${invoiceWithRow.status})`,
);
check(
  stub.lastRpc?.body?.p_status === "past_due" &&
    stub.lastRpc?.body?.p_user_id === subscriptionRow.user_id,
  "Zustand der Zeile wird mit past_due geschrieben",
);
check(
  stub.lastRpc?.body?.p_pihole === true &&
    stub.lastRpc?.body?.p_period_end === subscriptionRow.current_period_end &&
    stub.lastRpc?.body?.p_cancel_at_period_end === true,
  "Add-on, Periodenende und Kündigung kommen aus der Zeile",
);

resetEventLog();
stub.setRpc(200, null);
stripe.clear();
const invoiceWithoutRow = await deliver(
  event("invoice.payment_failed", { id: "in_2", object: "invoice", subscription: "sub_invoice" }),
);
check(
  invoiceWithoutRow.status === 200 &&
    stripe.callsTo("/v1/subscriptions/sub_invoice").length === 1,
  "ohne Abo-Zeile wird das Abo bei Stripe nachgeladen",
);
check(
  stub.lastRpc?.body?.p_status === "past_due" &&
    stub.lastRpc?.body?.p_user_id === stub.userId,
  "nachgeladenes Abo wird mit past_due und Metadaten-Nutzer geschrieben",
);

resetEventLog();
stub.setRpc(200, null);
stripe.clear();
const invoiceParent = await deliver(
  event("invoice.payment_failed", {
    id: "in_3",
    object: "invoice",
    parent: { subscription_details: { subscription: "sub_invoice_parent" } },
  }),
);
check(
  invoiceParent.status === 200 &&
    stripe.callsTo("/v1/subscriptions/sub_invoice_parent").length === 1,
  "Subscription-ID unter parent.subscription_details wird gefunden",
);

resetEventLog();
stub.setRpc(200, null);
stripe.clear();
const beforeInvoiceWithoutReference = stub.rpcCalls.length;
const invoiceWithoutReference = await deliver(
  event("invoice.payment_failed", { id: "in_4", object: "invoice" }),
);
check(
  invoiceWithoutReference.status === 200 &&
    stripe.calls.length === 0 &&
    stub.rpcCalls.length === beforeInvoiceWithoutReference,
  "Rechnung ohne Abo-Referenz bleibt wirkungslos",
);

resetEventLog();
stub.setRpc(200, null);
stripe.clear();
stripe.on(
  "GET",
  "/v1/subscriptions/sub_invoice_anonymous",
  200,
  subscription({ id: "sub_invoice_anonymous", userId: null }),
);
const invoiceWithoutUser = await deliver(
  event("invoice.payment_failed", {
    id: "in_5",
    object: "invoice",
    subscription: "sub_invoice_anonymous",
  }),
);
check(
  invoiceWithoutUser.status === 500 && invoiceWithoutUser.payload?.code === "PROCESSING_FAILED",
  `Abo ohne metadata.user_id → 500 statt stillem Verlust (${invoiceWithoutUser.status})`,
);
check(
  rowOf(writes.filter((entry) => entry.method === "PATCH").at(-1)?.body)?.error ===
    "SUBSCRIPTION_WITHOUT_USER_ID",
  "Grund steht in der Sperrzeile",
);
check(
  !JSON.stringify(invoiceWithoutUser.payload).includes("SUBSCRIPTION_WITHOUT_USER_ID"),
  "Grund steht nicht in der Antwort",
);

// --- Sammelprüfung: nichts aus der Datenbank nach außen -------------------
const leaks = responses.filter((entry) => {
  const text = JSON.stringify(entry.payload ?? {});
  return /P000\d|235\d\d|relation "|SQLSTATE|SUBSCRIPTION_(REQUIRED|WITHOUT)/i.test(text);
});
check(
  leaks.length === 0,
  `keine Antwort enthält SQLSTATE, DB-Text oder internen Grund (${leaks.length} verdächtig)`,
);

stripe.restore();
await stub.close();
finish("Stripe-Webhook (HTTP, Stub)");
