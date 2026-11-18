# DACH VPN — Sprint 0 Fundament

Hochsicheres No-Log VPN mit Pi-hole Add-on. Dieses Repository enthält das
technische Fundament aus Sprint 0/1: Monorepo, Datenbankschema, IPAM, Supabase
Auth mit Gerätebindung und den Zero-Knowledge-Proof-of-Concept für die
Schlüsselerzeugung.

Die kaufmännischen Unterlagen (Angebot, Aufwandskalkulation, Variantenvergleich)
liegen bewusst nicht im Repository.

## Struktur

```
apps/dashboard          Next.js 15 + Tailwind — Dashboard & PoC-Oberfläche
apps/mobile             React-Native-Basis (Gerüst, Installation separat)
packages/shared         Registrierungs-Vertrag + Private-Key-Guard (abhängigkeitsfrei)
packages/crypto         Curve25519-Erzeugung, WireGuard-Config, Fingerprint
supabase/migrations     Schema/RLS (0001), IPAM (0002), Registrierung (0003),
                        Auth-Bindung (0004)
supabase/functions      Edge Function register-device (Deno)
scripts/                DB-Tests (IPAM, Registrierung, RLS), Auth-Route-E2E,
                        Prüfung der Angebotszahlen gegen kalkulation.csv
.github/workflows       CI: quality, database, auth, dashboard-auth
.github/actions         Composite-Action `supabase-local`
```

Doku unter [`docs/`](docs/): [ENV-Liste](docs/env.md) · [Hardware-Anforderungen](docs/hardware-hetzner.md) · [RPC-Invarianten](docs/rpc-invarianten.md)

## Schnellstart

```bash
bun install
bun run test          # Unit-Tests (Guard, Krypto, Token-Parsing)
bun run typecheck     # alle drei Packages
bun run verify:angebot # Angebotszahlen gegen kalkulation.csv
bun run dev           # Dashboard auf http://localhost:3000
```

Datenbank-Tests gegen ein lokales Postgres (Docker):

```bash
docker run -d --rm --name dachvpn-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16-alpine
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres bun run test:db
```

`test:db` startet drei Suiten: `test:ipam` (Vergabe unter Nebenläufigkeit),
`test:registration` (atomare Registrierung, Idempotenz, Widerruf) und `test:rls`
(Mandantentrennung als Rolle `authenticated` mit gesetzten JWT-Claims). Alle
setzen das Schema `public` zurück — nie gegen eine echte Datenbank richten.

### Beide Supabase-Jobs lokal nachstellen

Docker erforderlich. Die Schritte entsprechen der Composite-Action
`supabase-local` und den Jobs `auth` und `dashboard-auth` ([CI](#ci)).

```bash
# 1. Stack starten — spielt supabase/migrations ein
supabase start

# 2. Zugangsdaten wie in der Action übernehmen
#    (ergänzt http://, falls die CLI API_URL ohne Schema ausgibt)
eval "$(supabase status -o env)"
export SUPABASE_URL="http://${API_URL#http://}" \
       SUPABASE_ANON_KEY="$ANON_KEY" \
       SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
       DEFAULT_NODE_ID=ci-node-1   # Knoten, unter dem der Test den Pool anlegt

# 3. Job `auth`: bauen, starten, Route gegen den Stack prüfen
bun run build
(cd apps/dashboard && PORT=3000 bun run start &)
BASE_URL=http://127.0.0.1:3000 bun run test:auth-route
```

Der Job `auth` prüft 26 Punkte: 401 ohne bzw. mit falschem Token, 422 bei
privatem Schlüssel, 201 mit Adresse aus dem Pool, den Retry, den Schlüsselwechsel
an einem bestehenden Gerät (die Adresse bleibt, fremde und widerrufene Geräte
werden abgewiesen), das Gerätelimit und dass jeder Nutzer per RLS nur seine
eigenen Geräte sieht.

Den IP-Pool legt der Test selbst an: `scripts/auth-route-e2e.mjs` ruft
`seed_ip_pool` mit `DEFAULT_NODE_ID` und `AUTH_E2E_CIDR` auf (Default
`10.9.0.0/27`). In CI muss also nichts vorbereitet werden. Für ein echtes
Supabase-Projekt ist das ein einmaliger Schritt von Hand — Pool-CIDR und
Knoten-ID aus [`docs/env.md`](docs/env.md), Punkt 4.

```bash
# 4. Job `dashboard-auth`: mit Auth-Konfiguration neu bauen und prüfen
#    (Server aus Schritt 3 vorher beenden, z. B. mit `kill %1`)
export NEXT_PUBLIC_SUPABASE_URL="$SUPABASE_URL" \
       NEXT_PUBLIC_SUPABASE_ANON_KEY="$SUPABASE_ANON_KEY"
bun run build
(cd apps/dashboard && PORT=3000 bun run start &)

curl -s -o /tmp/page.html -w "Status %{http_code}\n" http://127.0.0.1:3000/
grep -q "Anmelden" /tmp/page.html && echo "PASS Formular" || echo "FAIL Formular"
grep -q "E-Mail" /tmp/page.html && echo "PASS E-Mail" || echo "FAIL E-Mail"
grep -q "Passwort" /tmp/page.html && echo "PASS Passwort" || echo "FAIL Passwort"
grep -q "nicht konfiguriert" /tmp/page.html && echo "FAIL Auth nicht aktiv" \
  || echo "PASS Auth aktiv"
grep -q "DEMO_USER_ID" /tmp/page.html && echo "FAIL Demo-Hinweis" \
  || echo "PASS kein Demo-Hinweis"
```

`NEXT_PUBLIC_*` wird beim Build eingebacken: Die Variablen müssen **vor**
`bun run build` gesetzt sein, und ein späterer Build ohne sie entfernt die
Auth-Konfiguration wieder (die Startseite zeigt dann den Trockenlauf-Hinweis).
Die Artefakte der CI entstehen lokal nicht; alle Ausgaben stehen im Terminal.
Aufräumen mit `supabase stop`.

## CI

Vier Jobs in [`.github/workflows/ci.yml`](.github/workflows/ci.yml), alle auf
`ubuntu-latest` mit Bun 1.4.x:

| Job | Inhalt | Artefakt bei Fehlschlag |
| --- | --- | --- |
| `quality` | Typecheck, Unit-Tests, Angebotszahlen, `next build` | `next-build-logs` — Build-Log und `apps/dashboard/.next/trace` |
| `database` | `bun run test:db` gegen einen `postgres:16`-Service: IPAM, Registrierung, RLS | `database-logs` — Container-Log der Datenbank |
| `auth` | Lokaler Supabase-Stack, Build, Serverstart, `scripts/auth-route-e2e.mjs` (26 Prüfungen) | `auth-route-logs` — E2E-Ausgabe, Build- und Server-Log, `supabase status`, `docker ps` |
| `dashboard-auth` | Lokaler Supabase-Stack, Build mit `NEXT_PUBLIC_*`, sechs Render-Prüfungen der Startseite | `dashboard-auth-logs` — `page.html`, Build- und Server-Log, `supabase status` |

Artefakte entstehen nur bei Fehlschlag (`if: failure()`), liegen 7 Tage bereit
und sind im Actions-Lauf unter „Artifacts“ herunterzuladen — pro Job ein Archiv
mit dem jeweiligen Namen. Sie enthalten keine echten Schlüssel; der lokale
Supabase-Stack nutzt seine Standardwerte.

### Composite-Action `supabase-local`

[`.github/actions/supabase-local`](.github/actions/supabase-local/action.yml)
wird von `auth` und `dashboard-auth` genutzt und kapselt alles, was den Stack
betrifft:

1. `supabase/setup-cli@v3`
2. `supabase start` — spielt `supabase/migrations` ein
3. `supabase status -o env` → Snapshot in `ci-logs/supabase-status.txt` und
   Export nach `$GITHUB_ENV`:
   - `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (nötig, weil
     Next diese Werte beim Build inlined)

Die Action ergänzt `http://`, falls die CLI `API_URL` ohne Schema ausgibt, und
entfernt die Anführungszeichen aus `supabase status`. Beide Jobs bringen danach
nur noch ihre eigenen Prüfungen ein — die Startlogik existiert einmal. Wie man
beides ohne CI nachstellt, steht unter
[Beide Supabase-Jobs lokal nachstellen](#beide-supabase-jobs-lokal-nachstellen).

## Sicherheitsinvariante (nicht verhandelbar)

1. Curve25519-Schlüsselpaare entstehen **nur im Client** (`packages/crypto`).
2. Der Server akzeptiert ausschließlich `publicKey` — jeder Payload mit privatem
   Material wird mit **HTTP 422** abgewiesen, bevor validiert oder gespeichert wird
   (`packages/shared/src/index.ts`).
3. Es gibt **keine Datenbankspalte** für private Schlüssel; `devices.public_key`
   ist per CHECK auf 32-Byte-Base64 begrenzt.
4. Request-Bodies werden **nicht geloggt**.
5. Die FRITZ!Box-Konfiguration (enthält den privaten Schlüssel) wird im Browser
   zusammengesetzt und als Datei heruntergeladen — nie hochgeladen.
6. Gerät und IP-Adresse entstehen in **einer** Transaktion
   (`public.register_device`); scheitert die Vergabe, wird auch das Gerät
   zurückgerollt. Ein Retry mit demselben Public Key erzeugt nichts Neues,
   ein Widerruf gibt die Adresse vollständig frei.
7. Die Nutzer-ID kommt ausschließlich aus einem serverseitig verifizierten
   Supabase-Token (`auth.getUser`). Es gibt keinen Demo-User und keine
   `user_id` im Request-Body; `register_device` ist für `authenticated`
   gesperrt, damit kein Client die RPC mit fremder ID aufrufen kann.

Der Guard existiert bewusst in genau einer Implementierung, die von Next.js-Route
und Edge Function geteilt wird. Ein zweiter, kopierter Guard wäre die
wahrscheinlichste Stelle für eine stille Sicherheitslücke.

## Konfiguration

Alle benötigten Variablen stehen in [`.env.example`](.env.example); Erläuterungen
in [`docs/env.md`](docs/env.md). Werte gehören in `.env` (lokal) oder in
Projekt-Secrets — niemals in den Chat, in Commits oder in Tickets.

## Stand und Grenzen

- **Fertig:** Monorepo, Schema + RLS, IPAM mit Advisory Locks, atomare
  Registrierung (Gerät + Adresse), Supabase Auth mit Gerätebindung und
  Gerätelimit, Stripe-Abo (Checkout, Portal, idempotenter Webhook),
  Geräteübersicht mit Widerruf, Admin-Kennzahlen ohne Personenbezug,
  Krypto-PoC, API-Routen mit Guard, Edge Function, vier DB-Suiten
  (IPAM, Registrierung, RLS, Abo), Auth-Route-E2E und vier CI-Jobs.
- **Gerüst, nicht installiert:** `apps/mobile` (React Native). Die Abhängigkeiten
  werden mit M3 eingeführt, damit CI bis dahin schnell bleibt.
- **Nicht ausgeführt:** die Edge Function (hier fehlt eine Deno-Runtime) und die
  CI-Jobs selbst (kein Docker in der Sandbox). Die Route deckt
  `scripts/auth-route-e2e.mjs` ab — lokal gegen einen Ersatz-Stack, in der CI
  gegen den echten lokalen Supabase-Stack; ein Lauf auf GitHub steht aus.
- **Offen (M1):** E-Mail-Templates für Auth-Mails, Stripe-Live-Konfiguration
  (Preise/Webhook-Endpunkt), Feinschliff der Admin-Sicht.

## Lizenz

AGPL-3.0-only (GNU Affero General Public License v3): Der Quellcode lässt sich
frei nutzen, verändern und weitergeben. Wer eine veränderte Fassung als
Netzwerkdienst bereitstellt, muss den Quellcode dieser Fassung offenlegen —
Details in [`LICENSE`](LICENSE).
Fremdkomponenten stehen unter ihren eigenen Lizenzen.
