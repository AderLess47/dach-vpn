/**
 * Supabase-Stub für Routen-Tests — ohne Docker, ohne Datenbank.
 *
 * Bildet die zwei Endpunkte nach, die die Routen wirklich benutzen:
 * - GoTrue:  `GET  /auth/v1/user`   (Token-Prüfung)
 * - PostgREST:`POST /rest/v1/rpc/*` (RPC-Aufrufe, inkl. Fehlerobjekte)
 *
 * Warum ein HTTP-Server und kein Modul-Mock: `supabase-js` bleibt im Spiel und
 * parst die Antworten selbst. Ein Fehler kommt als
 * `{ "code": "P0006", "message": "SUBSCRIPTION_REQUIRED" }` an — genau so, wie
 * PostgREST ihn im Betrieb liefert. Damit prüft ein Test nicht nur die eigene
 * Logik, sondern auch die Annahmen über die Bibliothek.
 *
 * Beispiel:
 *
 *   const stub = await startSupabaseStub();
 *   const restore = stub.installEnv({ DEFAULT_NODE_ID: "eu-1" });
 *   stub.rpcError("P0006", "SUBSCRIPTION_REQUIRED");
 *   const result = await callRoute(registerRoute.POST, { body, token: stub.token });
 *   ...
 *   restore();
 *   await stub.close();
 */

import { createServer } from "node:http";

export const DEFAULT_USER_ID = "11111111-2222-4333-8444-555555555555";

/** Schreibt eine JSON-Antwort und beendet sie. */
export function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(body === undefined ? "" : JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolve) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => resolve(raw));
    request.on("error", () => resolve(raw));
  });
}

/**
 * Startet den Stub auf einem freien Port.
 *
 * @param {object} [options]
 * @param {string} [options.userId]    ID, die als `data.user.id` zurückkommt
 * @param {string} [options.email]
 * @param {string} [options.anonKey]   erwarteter Anon-Key
 * @param {string} [options.serviceKey] erwarteter Service-Role-Key
 */
export async function startSupabaseStub(options = {}) {
  const userId = options.userId ?? DEFAULT_USER_ID;
  const email = options.email ?? "stub@example.invalid";
  const anonKey = options.anonKey ?? "test-anon-key";
  const serviceKey = options.serviceKey ?? "test-service-key";
  const validToken = options.validToken ?? "valid-token";
  const unavailableToken = options.unavailableToken ?? "unavailable-token";

  const state = {
    users: new Map([[validToken, { id: userId, email, aud: "authenticated", role: "authenticated" }]]),
    unavailable: new Set([unavailableToken]),
    rpc: { status: 200, body: [] },
    rpcCalls: [],
    lastAuth: null,
    custom: [],
  };

  const server = createServer(async (request, response) => {
    const url = request.url ?? "";
    const token = (request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const raw = await readBody(request);

    let json = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      json = null;
    }

    const context = { url, token, raw, json, send: sendJson };

    // Erweiterungspunkte zuerst, damit Tests einzelne Pfade ersetzen können.
    const custom = state.custom.find((entry) => url.startsWith(entry.prefix));
    if (custom) return custom.handler(request, response, context);

    if (url.startsWith("/auth/v1/user")) {
      state.lastAuth = { token, apikey: request.headers.apikey ?? null };
      if (state.unavailable.has(token)) {
        return sendJson(response, 503, { code: 503, msg: "upstream unavailable" });
      }
      const user = state.users.get(token);
      if (!user) return sendJson(response, 401, { code: 401, msg: "invalid JWT" });
      return sendJson(response, 200, user);
    }

    if (url.startsWith("/rest/v1/rpc/")) {
      const call = { name: url.split("/").pop(), body: json, headers: request.headers };
      state.rpcCalls.push(call);
      // `rpc()` kann eine feste Antwort oder eine Funktion sein.
      const reply = typeof state.rpc === "function" ? state.rpc(call) : state.rpc;
      return sendJson(response, reply?.status ?? 200, reply?.body ?? null);
    }

    return sendJson(response, 404, { message: `unerwarteter Pfad: ${url}` });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const stub = {
    url: baseUrl,
    port,
    userId,
    email,
    anonKey,
    serviceKey,
    token: validToken,
    unavailableToken,

    /** Legt einen weiteren gültigen Token an (z. B. für zweite Konten). */
    addUser(token, user = {}) {
      state.users.set(token, {
        id: userId,
        email,
        aud: "authenticated",
        role: "authenticated",
        ...user,
      });
    },

    /** Lässt einen Token wie einen Auth-Ausfall (503) enden. */
    addUnavailableToken(token) {
      state.unavailable.add(token);
    },

    /** Nächste RPC-Antwort: entweder `(status, body)` oder eine Funktion. */
    setRpc(statusOrReply, body) {
      state.rpc =
        typeof statusOrReply === "function"
          ? statusOrReply
          : { status: statusOrReply ?? 200, body: body ?? [] };
    },

    /** PostgREST-Fehlerantwort, wie supabase-js sie erwartet. */
    rpcError(code, message, hint = "hinweis") {
      stub.setRpc(400, { code, message, details: null, hint });
    },

    /** Eigenen Pfad bedienen; `handler(request, response, ctx)`. */
    route(prefix, handler) {
      state.custom.push({ prefix, handler });
    },

    get lastRpc() {
      return state.rpcCalls.at(-1) ?? null;
    },

    get rpcCalls() {
      return state.rpcCalls;
    },

    get lastAuth() {
      return state.lastAuth;
    },

    /**
     * Setzt die Supabase-Variablen für die Route und gibt eine Funktion zurück,
     * die den vorherigen Zustand wiederherstellt (auch „nicht gesetzt").
     *
     * `NEXT_PUBLIC_SUPABASE_*` werden bewusst entfernt: die Routen fallen darauf
     * zurück, und ein `.env` mit echten Werten würde sonst den Trockenlauf-Test
     * unbemerkt aushebeln.
     */
    installEnv(vars = {}) {
      const entries = {
        SUPABASE_URL: baseUrl,
        SUPABASE_ANON_KEY: anonKey,
        SUPABASE_SERVICE_ROLE_KEY: serviceKey,
        NEXT_PUBLIC_SUPABASE_URL: null,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: null,
        ...vars,
      };

      const previous = new Map();
      for (const [key, value] of Object.entries(entries)) {
        previous.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
        if (value === undefined || value === null) delete process.env[key];
        else process.env[key] = String(value);
      }

      return function restore() {
        for (const [key, value] of previous) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      };
    },

    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };

  return stub;
}
