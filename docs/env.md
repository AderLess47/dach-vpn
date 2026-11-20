# ENV-Variablen, Keys und Secrets

**Regel:** Werte niemals im Chat, in Commits, Tickets oder Screenshots. Lokal in
`.env` (git-ignoriert), für Deployments als Projekt-Secret beim jeweiligen
Anbieter. Diese Liste enthält nur Namen und Zweck.

## Browser-sichtbar (`NEXT_PUBLIC_*`)

| Variable | Zweck | Ab wann |
|---|---|---|
| `NEXT_PUBLIC_APP_NAME` | Fallback-Anzeigename, wenn kein Mandant zur Domain passt; leer = Default aus `packages/shared/src/brand.ts` ("HubGuard") | M1 |
| `NEXT_PUBLIC_APP_URL` | Öffentliche Basis-URL für Checkout-Rücksprünge | M1 (Abo) |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase-Projekt-URL für Client-Calls | M1 (Auth) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Öffentlicher Anon-Key (RLS schützt die Daten) | M1 (Auth) |
| `NEXT_PUBLIC_WG_SERVER_PUBLIC_KEY` | Public Key des Knotens für die Config-Vorschau | Sprint 0 (optional) |
| `NEXT_PUBLIC_WG_ENDPOINT` | `host:port` des Knotens für die Config | Sprint 0 (optional) |

`NEXT_PUBLIC_*` landet im Browser-Bundle. Dort gehören **keine** Secrets hinein.

Der Anzeigename entsteht **pro Request** in `apps/dashboard/lib/brand.ts` aus dem
Host. Reihenfolge: Mandant aus der Datenbank → `NEXT_PUBLIC_APP_NAME` → Default
`HubGuard`. Ein neuer Mandant braucht damit **kein Deployment**:

1. Mandant anlegen (SQL-Editor oder Service-Role):

   ```sql
   insert into public.tenants (slug, name, tagline)
   values ('acme-vpn', 'Acme VPN', 'Streaming ohne Umwege')
   returning id;

   insert into public.tenant_domains (domain, tenant_id)
   values ('tv.acme.example', '<id aus dem insert>');
   ```

2. Die Domain muss normalisiert sein: klein, ohne Port, ohne Pfad. Dieselbe Form
   bildet `normalizeHost()` in `packages/shared`; abweichende Schreibweisen im
   Host werden serverseitig angeglichen.
3. Spätestens nach 60 Sekunden greift die Änderung (Cache pro Host), ein
   Neustart ist nicht nötig. Unbekannte Hosts bekommen die Env-Marke bzw.
   `HubGuard`.

Die Tabellen `tenants` und `tenant_domains` sind für Endnutzer vollständig
 gesperrt (RLS ohne Policy); gelesen wird ausschließlich über
`resolve_tenant_brand()` mit Service-Role. `NEXT_PUBLIC_APP_NAME` ist nur noch
der Fallback und wird weiterhin beim Build eingebacken.

Dieselbe Marke landet über `bun run mail:render` in den Auth-Mail-Vorlagen —
pro Mandant mit eigenem Supabase-Projekt (Ablauf und manuelle Schritte:
[`supabase/templates/README.md`](../supabase/templates/README.md)).

## Server-seitig (Supabase, Stripe, Knoten)

| Variable | Zweck | Ab wann |
|---|---|---|
| `SUPABASE_URL` | Projekt-URL für Server-Calls | M1 |
| `SUPABASE_ANON_KEY` | Anon-Key; wird serverseitig zur Token-Verifikation genutzt | M1 |
| `SUPABASE_SERVICE_ROLE_KEY` | Umgeht RLS; nur Server/Edge Functions, nie Client | Sprint 0 (Persistenz) |
| `MAX_DEVICES_PER_USER` | Gerätelimit je Konto (Default 5); gilt in der Route und in der Edge Function gleich | M1 |
| `ADMIN_USER_IDS` | Kommaseparierte Supabase-User-IDs für `/api/admin/metrics` | M1 |
| `STRIPE_SECRET_KEY` | Checkout-Sessions, Customer-Portal, Subscription-Reads | M1 |
| `STRIPE_WEBHOOK_SECRET` | Signaturprüfung der Stripe-Webhooks | M1 |
| `STRIPE_PRICE_ID_BASE` | Preis-ID Basis-Abo | M1 |
| `STRIPE_PRICE_ID_PIHOLE` | Preis-ID Pi-hole Add-on | M1 |
| `DEFAULT_NODE_ID` | Knoten, dem neue Geräte zugewiesen werden (IP-Pool) | M1 |
| `WG_SERVER_ENDPOINT` | Öffentlicher Endpoint des Knotens | M1/M2 |
| `WG_SERVER_PUBLIC_KEY` | Public Key des Knotens | M1/M2 |
| `WG_DNS_FILTERED` | Sinkhole-DNS bei aktivem Add-on (Default `10.9.0.1`) | M1 |
| `WG_DNS_PLAIN` | DNS ohne Add-on (Default `1.1.1.1`) | M1 |
| `NODE_ID` | Knoten-Kennung des Pull-Agenten | M2 |
| `AGENT_API_KEY` | API-Key/mTLS-Client des Agenten | M2 |
| `AGENT_POLL_INTERVAL_SECONDS` | Poll-Intervall (Default 30) | M2 |
| `SENTRY_DSN` | Self-hosted Sentry, No-PII-Konfiguration | M3/M4 |
| `DATABASE_URL` | Nur lokal/CI für die DB-Tests (IPAM, Registrierung, RLS) | Sprint 0 |

## Was du anlegen musst

1. **Supabase-Projekt** (Region EU, z. B. Frankfurt) → `SUPABASE_URL`,
   `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`. Der Service-Role-Key wird
   **nicht** ins Frontend gegeben.
2. **Schema einspielen**: `bun run setup:db` (Session-Pooler-String aus dem
   Connect-Dialog) und danach `bun run db:apply` — das führt
   `supabase/migrations/*.sql` der Reihe nach aus und merkt sich angewandte
   Versionen. Lokal übernimmt das `supabase start`.
3. **Stripe** (Testmodus zuerst) → zwei wiederkehrende Preise in EUR (Basis,
   Pi-hole Add-on), `STRIPE_SECRET_KEY` und beide Preis-IDs. Webhook-Ziel ist
   die Route im Dashboard, `<öffentliche Basis-URL>/api/stripe/webhook`, mit den
   Events `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted` und
   `invoice.payment_failed`; das dort angezeigte `whsec_…` wird
   `STRIPE_WEBHOOK_SECRET`. Lokal genügt
   `stripe listen --forward-to 127.0.0.1:3001/api/stripe/webhook` — eine
   Supabase-Edge-Function gibt es dafür nicht. Ausführliche Anleitung mit
   Preisprüfungen, Fehlerfällen und Aufräum-SQL: [`stripe-test.md`](stripe-test.md).
4. **Erster VPN-Knoten**: WireGuard-Schlüsselpaar serverseitig erzeugen
   (`wg genkey | tee private.key | wg pubkey > public.key`) — der **Public** Key
   geht in `WG_SERVER_PUBLIC_KEY`, der private bleibt auf dem Knoten.
5. **IP-Pool des Knotens**: einmalig im SQL-Editor des Projekts
   `select public.seed_ip_pool('node-fsn1-1', '10.8.0.0/24');`. Das `p_node_id`
   muss zu `DEFAULT_NODE_ID` passen; ohne Pool findet die Registrierung keine
   Adresse und schlägt fehl.
6. **Resend/CI**: keine Secrets nötig; GitHub Actions nutzt den eingebauten Token.

## Admin-Zugang (ADMIN_USER_IDS)

`/admin` und `/api/admin/metrics` hängen an einer Allowlist von Nutzer-IDs,
nicht an einer eigenen Rolle im Schema.

1. **IDs holen**: Supabase → *Authentication → Users*, dort die UUID des
   Kontos kopieren — nicht die E-Mail-Adresse, die Route vergleicht die
   `sub`-ID aus dem Token.
2. **Eintragen**: `ADMIN_USER_IDS` in `apps/dashboard/.env.local`,
   kommasepariert, Leerzeichen werden toleriert: `ADMIN_USER_IDS=<uuid>` oder
   `ADMIN_USER_IDS=<uuid>,<uuid>`. Server-seitig, also **kein**
   `NEXT_PUBLIC_`-Präfix; der Wert gehört nicht ins Browser-Bundle.
3. **Neustart**: `.env.local` wird beim Start des Servers gelesen. Ein `build`
   ist nicht nötig, ein Neustart von `next start` schon. Zusätzlich muss
   `SUPABASE_SERVICE_ROLE_KEY` gesetzt sein — die RPC `admin_metrics` ist nur
   für `service_role` ausführbar.
4. **Format prüfen**: `bun run check:env` zeigt `ADMIN_USER_IDS` mit
   gesetzt/leer, Quelle und Länge, nie den Wert. Als plausibel gilt nur eine
   kommaseparierte Liste 36-stelliger UUIDs. Ist die Variable leer, hat
   **niemand** Zugriff: die Route antwortet für jedes Konto mit `403`.
5. **Zugriff prüfen**: mit genau diesem Konto anmelden und `/admin` öffnen.
   Gegenprobe per HTTP mit dem Session-Token:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' \
     -H "Authorization: Bearer $ACCESS_TOKEN" \
     http://127.0.0.1:3001/api/admin/metrics
   ```

   `200` heißt in der Liste, `403` heißt nicht (`ADMIN_REQUIRED`, die Seite
   schreibt „Dieses Konto steht nicht in ADMIN_USER_IDS“), `401` heißt Token
   ungültig, `202` heißt Supabase nicht konfiguriert, `503` heißt Auth gerade
   nicht erreichbar — dann bleibt die Sitzung gültig und der Versuch ist
   wiederholbar.

Die Antwort trägt `cache-control: no-store, private` und enthält nur Zähler:
Abos je Status, Geräte und der IP-Pool je Knoten. Keine Nutzer-IDs, keine
E-Mails, keine IP-Adressen.

## Wo die Werte liegen

| Umgebung | Ablage |
|---|---|
| lokal | `.env` (nicht committen), Vorlage: `.env.example` |
| CI | GitHub → Settings → Secrets and variables → Actions |
| Supabase Edge Functions | Supabase → Project Settings → Edge Functions → Secrets |
| Hosting (Dashboard) | Projekt-Secrets des Hosters, nicht im Repo |

## Reihenfolge für den Start

Für die Registrierung brauchst du `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY` (Browser-Login), `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DEFAULT_NODE_ID` und optional
`MAX_DEVICES_PER_USER` — plus die beiden `NEXT_PUBLIC_WG_*` für den
Config-Download. Stripe kommt mit dem Abo-Flow.

Die Route verifiziert den Bearer-Token gegen Supabase (`auth.getUser`) und
nimmt die Nutzer-ID ausschließlich von dort — es gibt keinen Demo-User und keine
`user_id` im Request-Body.
