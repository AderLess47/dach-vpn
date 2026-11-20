/**
 * Stripe-API-Stub für Routen-Tests — ohne Netz, ohne Stripe-Konto.
 *
 * Die Stripe-Routen bauen ihren Client selbst (`apps/dashboard/lib/stripe.ts`);
 * eine Options-Injektion gibt es nicht. Deshalb hängt dieser Stub an
 * `globalThis.fetch`: Das Stripe-SDK greift `fetch` beim Erzeugen des Clients
 * aus dem Global ab und schickt jede Anfrage darüber.
 *
 * Alles, was nicht nach `api.stripe.com` geht, reicht der Stub unverändert an
 * das echte `fetch` weiter — Supabase und GoTrue laufen also normal gegen den
 * Supabase-Stub.
 *
 * Zwei Grenzen sind bewusst:
 * - Es gibt keine Stripe-Objekte und keine Stripe-Fehlertexte; der Stub liefert
 *   genau die JSON-Form, die das SDK erwartet.
 * - `install()` muss **vor** dem ersten `stripeClient()`-Aufruf laufen, weil
 *   das SDK die Funktion beim Erzeugen des Clients festhält. `restore()` gibt
 *   das Original zurück.
 *
 * Beispiel:
 *
 *   const stripe = installStripeStub();
 *   stripe.on("GET", "/v1/subscriptions/sub_1", 200, { id: "sub_1", ... });
 *   ...
 *   stripe.restore();
 */

const API_PREFIX = "https://api.stripe.com/";

function normalise(statusOrReply, body) {
  if (typeof statusOrReply === "function") return statusOrReply;
  if (typeof statusOrReply === "number") return { status: statusOrReply, body };
  return { status: 200, ...(statusOrReply ?? {}) };
}

export function installStripeStub() {
  const realFetch = globalThis.fetch;
  const routes = new Map();
  const calls = [];

  globalThis.fetch = async function stripeStubFetch(input, init) {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    if (!url.startsWith(API_PREFIX)) {
      return realFetch(input, init);
    }

    const method = String(
      init?.method ?? (typeof input === "string" ? "GET" : input?.method ?? "GET"),
    ).toUpperCase();
    const path = new URL(url).pathname;
    const call = { method, path, url, body: init?.body ?? null };
    calls.push(call);

    const reply = routes.get(`${method} ${path}`);
    if (!reply) {
      return new Response(
        JSON.stringify({
          error: { type: "stub_missing_route", message: `kein Stub für ${method} ${path}` },
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    }

    const resolved = typeof reply === "function" ? reply(call) : reply;
    return new Response(resolved.body === undefined ? "" : JSON.stringify(resolved.body), {
      status: resolved.status ?? 200,
      headers: { "content-type": "application/json", "request-id": "req_stripe_stub" },
    });
  };

  const stub = {
    calls,

    /** Antwort für `METHOD /v1/pfad`: `(status, body)` oder `({status, body})`. */
    on(method, path, statusOrReply, body) {
      routes.set(`${method.toUpperCase()} ${path}`, normalise(statusOrReply, body));
      return stub;
    },

    /** Alle Anfragen an einen Pfad (ohne Methode), für Zählungen. */
    callsTo(path) {
      return calls.filter((call) => call.path === path);
    },

    get lastCall() {
      return calls.at(-1) ?? null;
    },

    /** Setzt die Aufzeichnung zurück; registrierte Pfade bleiben. */
    clear() {
      calls.length = 0;
    },

    restore() {
      globalThis.fetch = realFetch;
    },
  };

  return stub;
}
