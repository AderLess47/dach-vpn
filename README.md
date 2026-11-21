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
                        Auth-Bindung (0004), Stripe (0005), Host-Adressen (0006),
                        Rebind (0007), Mandanten (0008), Abo-Gate (0009)
supabase/functions      Edge Function register-device (Deno)
scripts/                DB-Tests (IPAM, Registrierung, RLS, Abo, Mandanten,
                        Gate, Fehlerabbildung), HTTP-Tests der Routen mit Stub,
                        Auth-Route-E2E, Doku-Prüfung, Prüfung der Angebotszahlen
docs/                   ENV-Liste, Testebenen, Hardware-Anforderungen,
                        RPC-Invarianten
.github/workflows       CI: quality, database, auth, dashboard-auth;
                        Doku-Links, CI-Wächter, Schutz-Wächter
.github/actions         Composite-Action `supabase-local`
```

Doku unter [`docs/`](docs/): [ENV-Liste](docs/env.md) · [Hardware-Anforderungen](docs/hardware-hetzner.md) · [RPC-Invarianten](docs/rpc-invarianten.md)

## Schnellstart

```bash
bun install
bun run test          # 84 Unit-Tests (Guard, Krypto, Token-Parsing)
bun run test:http     # HTTP-Ebene aller Routen, Supabase/Stripe gestubbt
bun run check         # check:docs, mail:check und Typecheck der drei Packages
bun run verify:angebot # Angebotszahlen gegen kalkulation.csv
bun run dev           # Dashboard auf http://localhost:3000
```

Datenbank-Tests gegen ein lokales Postgres (Docker):

```bash
docker run -d --rm --name dachvpn-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16-alpine
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres bun run test:db
```

`test:db` deckt die Datenbank-Ebene in sieben Suiten ab, zusammen 140
Prüfungen: `test:ipam` (11, Vergabe unter Nebenläufigkeit), `test:registration`
(23, atomare Registrierung, Idempotenz, Widerruf), `test:rls` (13,
Mandantentrennung als Rolle `authenticated` mit gesetzten JWT-Claims),
`test:subscription` (17, Abo-Zustand aus Stripe), `test:tenants` (15, Marke je
Host), `test:entitlement` (16, Abo- und Add-on-Gate) und `test:errors` (45,
Fehlerabbildung gegen echte Postgres-Fehler). Eine rote Suite hält die übrigen
nicht an; am Ende stehen Prüfungszahl, Exit-Status und Dauer je Suite, und der
Befehl vergleicht die Zahlen anschließend mit diesem Absatz. Alle Suiten setzen
das Schema `public` zurück — nie gegen eine echte Datenbank richten.
`test:errors` läuft mit Bun, weil es die Abbildung direkt aus
`packages/shared` importiert.

`test:http` deckt die HTTP-Ebene in sechs Suiten ab, zusammen 270 Prüfungen:
`test:stub` (34, Kontrakt der Test-Hilfen), `test:routes` (68, Geräte-Routen),
`test:revoke` (26, Widerruf), `test:webhook` (65, Stripe-Webhook), `test:admin`
(23, Admin-Kennzahlen) und `test:billing` (54, Checkout und Portal). Eine rote
Suite hält die übrigen nicht an; am Ende stehen Prüfungszahl, Exit-Status und
Dauer je Suite, und der Befehl endet mit 1, sobald eine Suite fehlschlug. Die
Zahlen stammen aus den `PASS`-Zeilen desselben Laufs; der Befehl vergleicht sie
anschließend mit diesem Absatz und schlägt fehl, wenn eine Angabe hier nicht
mehr stimmt. Für die Unit-Zahl oben tut `bun run check:unit-count` dasselbe:
Es führt `bun run test` aus und vergleicht das Ergebnis mit dieser Angabe.

Vorab, ohne einen Test und ohne installierte Abhängigkeiten, prüft
`bun run check:docs` die Doku gegen sich selbst und gegen den Code: ob README
und [`docs/testing.md`](docs/testing.md) dieselben Zahlen nennen, ob die
Gesamtzahlen zu den Einzelzahlen passen, ob es tatsächlich so viele Testdateien
sind wie die 8 im Text und die `include`-Muster aus `vitest.config.ts` erfassen,
ob jede Suite der Runner in der Testebenen-Tabelle steht, ob jeder hier und in
`docs/testing.md` genannte `bun run`-Befehl in `package.json` existiert, ob die
internen Verweise in allen Markdown-Dateien samt Ankern noch stimmen, ob jede
Migration aus `supabase/migrations` in
[`docs/rpc-invarianten.md`](docs/rpc-invarianten.md) verlinkt ist und ob die in
den Workflows referenzierten Skripte, lokalen Actions und Pfade existieren
(`bun run <skript>` gegen die `package.json` von Root und Workspaces,
`scripts/*.mjs` im Dateibaum, `uses: ./…`, `cd`-Ziele).
Dazu hält er die
[CI-Tabelle](#ci) an `.github/workflows/ci.yml`: dieselben Jobs samt Zahlwort im
Satz darüber, die dort laufenden Prüf-Skripte in der Zeile jedes Jobs, die
Artefaktnamen und die Aufbewahrungsdauer von 7 Tagen. Er läuft als erster
Schritt im CI-Job `quality`. Die zwölf Abschnitte mit ihren Quellen und den
Grenzen der Prüfung stehen in
[`docs/testing.md`](docs/testing.md#bun-run-checkdocs).

Welche Ebene was abdeckt — Unit, Datenbank, HTTP mit Stub, echter Stack, UI —
und warum der echte Stack nicht durch den Stub ersetzt wird, steht in
[`docs/testing.md`](docs/testing.md).

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

Der Job `auth` prüft 28 Punkte: 401 ohne bzw. mit falschem Token, 422 bei
privatem Schlüssel, 201 mit Adresse aus dem Pool, den Retry, den Schlüsselwechsel
an einem bestehenden Gerät (die Adresse bleibt, fremde und widerrufene Geräte
werden abgewiesen), das Gerätelimit und dass jeder Nutzer per RLS nur seine
eigenen Geräte sieht. Die Zahl hält `bun run test:auth-route` nach dem Lauf
gegen diesen Absatz und [`docs/testing.md`](docs/testing.md); fehlt der Stack
(kein Docker), bricht der Befehl mit einer Meldung samt Anleitung ab, statt
Verbindungsfehler zu stapeln.

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

bun run check:render
```

`check:render` prüft die sechs Punkte — Status 200, Auth-Formular, E-Mail-,
Passwort-Feld, kein Trockenlauf-Hinweis, kein Demo-Hinweis — und hält die Zahl
gegen diesen Absatz und [`docs/testing.md`](docs/testing.md). Den Gegenfall prüft
`bun run check:render:dry` (vier Punkte): Ein Build **ohne** `NEXT_PUBLIC_*` muss
den Trockenlauf-Hinweis samt beiden Variablennamen zeigen und darf kein
Anmeldeformular rendern. In der CI macht das der Job `quality`, dessen Build
ohnehin ohne diese Variablen läuft.

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
| `quality` | Doku-Zahlen (`bun run check:docs`), Typecheck (`bun run typecheck`), Unit-Tests samt README-Zahl (`check-unit-count`), Stub-Kontrakt und HTTP-Tests der Geräte-, Widerruf-, Stripe-Webhook-, Admin-, Checkout- und Portal-Routen (`bun run test:http`), Mail-Vorlagen der Marke (`bun run mail:check`), Angebotszahlen (`bun run verify:angebot`), `bun run build` mit Log in `ci-logs/`, Startseite im Trockenlauf (`bun run check:render:dry`, 4 Trockenlauf-Prüfungen) | `next-build-logs` — Build-Log und `apps/dashboard/.next/trace` |
| `database` | `bun run test:db` gegen einen `postgres:16`-Service: IPAM, Registrierung, RLS, Abo, Mandanten, Gate, Fehlerabbildung | `database-logs` — Container-Log der Datenbank |
| `auth` | Lokaler Supabase-Stack, `bun run build`, Serverstart, `bun run test:auth-route` (28 Prüfungen) | `auth-route-logs` — E2E-Ausgabe, Build- und Server-Log, `supabase status`, `docker ps` |
| `dashboard-auth` | Lokaler Supabase-Stack, Build mit `NEXT_PUBLIC_*`, 6 Render-Prüfungen der Startseite (`bun run check:render`) | `dashboard-auth-logs` — `page.html`, Build- und Server-Log, `supabase status` |

Artefakte entstehen nur bei Fehlschlag (`if: failure()`), liegen 7 Tage bereit
und sind im Actions-Lauf unter „Artifacts“ herunterzuladen — pro Job ein Archiv
mit dem jeweiligen Namen. Sie enthalten keine echten Schlüssel; der lokale
Supabase-Stack nutzt seine Standardwerte.

### Composite-Action `supabase-local`

[`.github/actions/supabase-local`](.github/actions/supabase-local/action.yml)
wird von `auth` und `dashboard-auth` genutzt und kapselt alles, was den Stack
betrifft:

1. `supabase/setup-cli@v3`
2. Portbelegung protokollieren, aufräumen, dann `supabase start` — spielt
   `supabase/migrations` ein. Vor jedem Versuch steht im Log, welcher Prozess
   (`ss`, mit `sudo` samt PID) und welcher Container die Stack-Ports 54321 API,
   54322 DB und 54324 Inbucket hält. Container werden über die Portabbildung
   (`:54321->` im Ports-Feld) **und über das Host-Netzwerk** erkannt: ein
   Container mit `--network host` veröffentlicht keine Ports, seine Listener
   stehen nur auf dem Host. Er wird über die PID des Host-Listeners der
   Container-ID zugeordnet; ohne PID (kein `sudo`) sucht die Action den
   Listener im Container selbst. Entfernt werden eigene Reste
   (`name=_dachvpn`) **und fremde Container, die einen dieser Ports halten** —
   sonst scheitert der Versuch genau dann wieder, wenn der Halter nicht zum
   Projekt gehört. Bis zu drei Versuche, statt den Job vor dem
   ersten Test rot zu machen. Das setzt einen für den Job eigenen Runner voraus
   (bei GitHub-hosted der Fall); einen Prozess ohne Container protokolliert die
   Action nur, er bleibt als Ursache im Log sichtbar
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

### Schutz-Wächter

[`.github/workflows/protection-watch.yml`](.github/workflows/protection-watch.yml)
prüft täglich und nach jedem CI-Lauf auf `main` zwei Ebenen des Direkt-Push-
Schutzes und öffnet bei Befund ein Issue mit Einstellungspfad; greift alles
wieder, schließt es das Issue:

1. **Ruleset** (öffentlich lesbar, ohne persönliches Token): Pull-Request-
   Pflicht, die drei Pflicht-Checks, kein Force-Push, kein Löschen. Die leere
   Bypass-Liste gilt auch für Admins.
2. **Klassische Regel** (`enforce_admins`): nur mit Adminrechten lesbar, deshalb
   über das Secret **`PROTECTION_WATCH_TOKEN`** (Fine-grained PAT, nur dieses
   Repo, Berechtigung „Administration: Read-only“). Fehlt es, meldet der
   Wächter, dass dieser eine Punkt ungeprüft ist — die Ruleset-Ebene blockiert
   Direkt-Pushes trotzdem.

Das ist die Gegenprobe zu einem Direkt-Push wie dem versehentlichen `a352fa8`:
Die Regeln setzen den Push serverseitig durch, der Wächter meldet, wenn jemand
sie abschaltet.

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
  Gerätelimit, Zugangs-Gate (Abo + Pi-hole-Add-on), Stripe-Abo (Checkout, Portal, idempotenter Webhook),
  Geräteübersicht mit Widerruf, Admin-Kennzahlen ohne Personenbezug,
  Krypto-PoC, API-Routen mit Guard, Edge Function, sieben DB-Suiten
  (IPAM, Registrierung, RLS, Abo, Mandanten, Gate, Fehlerabbildung),
  Auth-Route-E2E und vier CI-Jobs.
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
