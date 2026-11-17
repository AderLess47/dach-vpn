#!/usr/bin/env node
/**
 * Stripe-Smoke-Test gegen den Testmodus.
 *
 * Zwei Stufen, damit das Skript auch ohne kompletten Stack nützlich ist:
 *
 *   A  Stripe-Seite: Kunde anlegen, Preise prüfen, Checkout-Session erzeugen,
 *      Session wieder schließen, Kunde löschen. Braucht nur `sk_test_…`.
 *   B  Webhook-Seite: ein synthetisches `customer.subscription.updated`-Event
 *      mit gültiger Signatur an die eigene Route schicken, Wiederholung
 *      (Idempotenz) und falsche Signatur prüfen. Braucht zusätzlich
 *      `STRIPE_WEBHOOK_SECRET`, `APP_BASE_URL` und `SMOKE_USER_ID`.
 *
 * Aufruf:
 *   STRIPE_SECRET_KEY=sk_test_… STRIPE_PRICE_ID_BASE=price_… \
 *   STRIPE_PRICE_ID_PIHOLE=price_… \
 *   bun run test:stripe
 *
 *   # mit Webhook-Stufe
 *   APP_BASE_URL=http://127.0.0.1:3001 STRIPE_WEBHOOK_SECRET=whsec_… \
 *   SMOKE_USER_ID=<supabase-user-uuid> bun run test:stripe
 *
 *   node scripts/stripe-smoke.mjs --self-test   # ohne Netzwerk, ohne Keys
 *
 * Sicherheitsregeln: Live-Keys werden abgelehnt, bevor irgendetwas passiert.
 * Es werden keine Keys, Secrets oder vollständigen Payloads ausgegeben.
 * `SMOKE_USER_ID` muss ein existierender Supabase-Nutzer sein, sonst schlägt
 * der Fremdschlüssel in `subscriptions` zu Recht fehl.
 */
import { createHmac } from "node:crypto";

const STRIPE_API = "https://api.stripe.com/v1";
const SELF_TEST = process.argv.includes("--self-test");

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function fatal(message) {
  console.log(`Abbruch: ${message}`);
  process.exit(2);
}

/**
 * Live-Keys sind hier nie erlaubt — sie würden echte Zahlungen auslösen.
 * Wirft absichtlich, damit der Selbsttest das Verhalten prüfen kann.
 */
function assertTestKey(key) {
  if (!key) throw new Error("STRIPE_SECRET_KEY fehlt.");
  if (/^(sk|rk)_live_/.test(key)) {
    throw new Error("Live-Key erkannt. Dieses Skript arbeitet ausschließlich mit sk_test_… / rk_test_….");
  }
  if (!/^(sk|rk)_test_/.test(key)) {
    throw new Error("Key sieht nicht wie ein Stripe-Testkey aus (erwartet sk_test_… oder rk_test_…).");
  }
}

/** Stripe erwartet `t=<ts>,v1=<hmac>`; signiert wird `<ts>.<payload>`. */
function signPayload(payload, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const signed = `${timestamp}.${payload}`;
  const v1 = createHmac("sha256", secret).update(signed).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

function isSignatureHeader(header) {
  return /^t=\d+,v1=[0-9a-f]{64}$/.test(header);
}

async function stripeRequest(key, method, path, params) {
  const response = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: params ? new URLSearchParams(params).toString() : undefined,
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${response.status} ${json.error?.type ?? "error"}: ${json.error?.message ?? "ohne Meldung"}`);
  }
  return json;
}

async function postWebhook(baseUrl, payload, signature) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/stripe/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": signature },
    body: payload,
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, body: json };
}

async function priceShape(key, priceId, label) {
  const price = await stripeRequest(key, "GET", `/prices/${encodeURIComponent(priceId)}`);
  check(`${label}: Preis ist aktiv`, price.active === true);
  check(`${label}: wiederkehrender Preis`, price.type === "recurring");
  check(`${label}: Testmodus`, price.livemode === false, `livemode=${price.livemode}`);
  check(`${label}: Währung EUR`, price.currency === "eur", String(price.currency));
  return price;
}

function syntheticEvent({ eventId, userId, subscriptionId, priceId, timestamp }) {
  const periodEnd = timestamp + 30 * 24 * 60 * 60;
  return JSON.stringify({
    id: eventId,
    object: "event",
    api_version: "2026-09-30.endive",
    created: timestamp,
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type: "customer.subscription.updated",
    data: {
      object: {
        id: subscriptionId,
        object: "subscription",
        customer: "cus_smoke_test",
        status: "active",
        cancel_at_period_end: false,
        metadata: { user_id: userId },
        items: {
          object: "list",
          data: [
            {
              id: "si_smoke_test",
              object: "subscription_item",
              current_period_end: periodEnd,
              price: { id: priceId, object: "price" },
            },
          ],
        },
      },
    },
  });
}

async function selfTest() {
  const header = signPayload('{"a":1}', "whsec_dummy", 1_700_000_000);
  check("Signaturformat t=…,v1=…", isSignatureHeader(header), header);
  check(
    "Signatur ist reproduzierbar",
    header === signPayload('{"a":1}', "whsec_dummy", 1_700_000_000),
  );
  check(
    "anderer Zeitstempel ergibt andere Signatur",
    header !== signPayload('{"a":1}', "whsec_dummy", 1_700_000_001),
  );
  check(
    "anderes Secret ergibt andere Signatur",
    header !== signPayload('{"a":1}', "whsec_other", 1_700_000_000),
  );

  const event = JSON.parse(
    syntheticEvent({
      eventId: "evt_smoke_1",
      userId: "00000000-0000-0000-0000-000000000000",
      subscriptionId: "sub_smoke_1",
      priceId: "price_smoke_1",
      timestamp: 1_700_000_000,
    }),
  );
  check("Ereignis trägt Nutzer-ID", event.data.object.metadata.user_id.length === 36);
  check("Ereignis hat genau eine Position", event.data.object.items.data.length === 1);
  check(
    "Periodenende liegt in der Zukunft",
    event.data.object.items.data[0].current_period_end > event.created,
  );

  let rejectedLive = false;
  try {
    assertTestKey("sk_live_geheim");
  } catch {
    rejectedLive = true;
  }
  check("Live-Key wird abgelehnt", rejectedLive);

  let rejectedGarbage = false;
  try {
    assertTestKey("hallo");
  } catch {
    rejectedGarbage = true;
  }
  check("Unbrauchbarer Key wird abgelehnt", rejectedGarbage);
}

async function main() {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  const basePrice = process.env.STRIPE_PRICE_ID_BASE ?? "";
  const addonPrice = process.env.STRIPE_PRICE_ID_PIHOLE ?? "";

  try {
    assertTestKey(key);
  } catch (error) {
    fatal(error.message);
  }
  if (!basePrice) fatal("STRIPE_PRICE_ID_BASE fehlt.");
  if (!basePrice.startsWith("price_")) fatal("STRIPE_PRICE_ID_BASE ist keine price_…-ID.");
  if (addonPrice && !addonPrice.startsWith("price_")) {
    fatal("STRIPE_PRICE_ID_PIHOLE ist keine price_…-ID.");
  }

  const baseUrl = process.env.APP_BASE_URL ?? "http://127.0.0.1:3001";
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? "";
  const userId = process.env.SMOKE_USER_ID ?? "";
  const stamp = Date.now();

  console.log("→ Preise prüfen");
  const base = await priceShape(key, basePrice, "Basis");
  const addon = addonPrice ? await priceShape(key, addonPrice, "Add-on") : null;

  console.log("→ Testkunde anlegen");
  const customer = await stripeRequest(key, "POST", "/customers", {
    email: `smoke+${stamp}@example.invalid`,
    "metadata[dachvpn_smoke]": "1",
  });
  check("Kunde angelegt", /^cus_/.test(customer.id));
  check("Kunde im Testmodus", customer.livemode === false);

  let session;
  let deleted = false;
  try {
    console.log("→ Checkout-Session erzeugen");
    const params = {
      mode: "subscription",
      customer: customer.id,
      "line_items[0][price]": basePrice,
      "line_items[0][quantity]": "1",
      client_reference_id: userId || "smoke-test",
      "subscription_data[metadata][user_id]": userId || "smoke-test",
      success_url: `${baseUrl}/?checkout=success`,
      cancel_url: `${baseUrl}/?checkout=cancel`,
    };
    if (addonPrice) {
      params["line_items[1][price]"] = addonPrice;
      params["line_items[1][quantity]"] = "1";
    }

    session = await stripeRequest(key, "POST", "/checkout/sessions", params);

    check("Session-ID vorhanden", /^cs_test_/.test(session.id), session.id);
    check("Session hat Zahlungs-URL", typeof session.url === "string" && session.url.startsWith("https://"));
    check("Session im Abo-Modus", session.mode === "subscription");
    check("Session im Testmodus", session.livemode === false);
    check("Session ist offen", session.status === "open", session.status);
    const expected = base.unit_amount + (addon?.unit_amount ?? 0);
    check(
      "Summe entspricht den Preisen",
      session.amount_subtotal === expected,
      `amount_subtotal=${session.amount_subtotal}, erwartet=${expected}`,
    );
    console.log(`     Checkout-URL: ${session.url.split("?")[0]} (Parameter gekürzt)`);
  } finally {
    if (session?.id) {
      await stripeRequest(key, "POST", `/checkout/sessions/${session.id}/expire`).catch(() => {});
    }
    const removal = await stripeRequest(key, "DELETE", `/customers/${customer.id}`).catch(() => null);
    deleted = removal?.deleted === true;
  }
  check("Testkunde wieder entfernt", deleted);

  console.log("→ Webhook-Stufe");
  if (!webhookSecret || !userId) {
    console.log("SKIP Webhook: STRIPE_WEBHOOK_SECRET und SMOKE_USER_ID setzen, um Signatur und Idempotenz zu prüfen.");
  } else {
    const eventId = `evt_smoke_${stamp}`;
    const payload = syntheticEvent({
      eventId,
      userId,
      subscriptionId: `sub_smoke_${stamp}`,
      priceId: basePrice,
      timestamp: Math.floor(stamp / 1000),
    });

    const first = await postWebhook(baseUrl, payload, signPayload(payload, webhookSecret));
    if (first.status === 202) {
      console.log("SKIP Webhook: Route meldet STRIPE_NOT_CONFIGURED (Stack ohne Stripe-Konfiguration).");
    } else {
      check("Webhook akzeptiert gültige Signatur", first.status === 200, `Status ${first.status}`);
      check("Webhook meldet Empfang", first.body.received === true);
      check("Webhook meldet Verarbeitung", first.body.handled === true);

      const replay = await postWebhook(baseUrl, payload, signPayload(payload, webhookSecret));
      check("Wiederholung wird erkannt", replay.status === 200 && replay.body.duplicate === true, `Status ${replay.status}`);

      const forged = await postWebhook(baseUrl, payload, signPayload(payload, `${webhookSecret}_falsch`));
      check("Falsche Signatur wird abgewiesen", forged.status === 400, `Status ${forged.status}`);
      check("Falsche Signatur meldet INVALID_SIGNATURE", forged.body.code === "INVALID_SIGNATURE");
    }
  }

  console.log(
    failed === 0
      ? `\nAlle Prüfungen bestanden (Stripe-Smoke-Test, ${passed} Prüfungen).`
      : `\n${failed} Prüfung(en) fehlgeschlagen (Stripe-Smoke-Test).`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

if (SELF_TEST) {
  await selfTest();
  console.log(
    failed === 0
      ? `\nAlle Prüfungen bestanden (Selbsttest, ${passed} Prüfungen).`
      : `\n${failed} Prüfung(en) fehlgeschlagen (Selbsttest).`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`Fehler: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
