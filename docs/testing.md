# Testebenen

Fünf Ebenen prüfen unterschiedliche Dinge. Keine ersetzt eine andere — und keine
darf eine andere ersetzen, nur weil sie schneller ist oder ohne Docker läuft.

| Ebene | Kommando | Prüft | Sieht nicht | Braucht |
|---|---|---|---|---|
| **Unit** | `bun run test` | 84 Tests in 8 Dateien: Guard und Private-Key-Scan, Krypto, Stripe-Status, Marke, Entitlement, Fehlerabbildung, Limit-Parsing | SQL, HTTP, RLS, UI | nichts |
| **Datenbank** | `bun run test:db` (führt `test:ipam`, `test:registration`, `test:rls`, `test:subscription`, `test:tenants`, `test:entitlement`, `test:errors` nacheinander aus) | Sieben Suiten, 140 Prüfungen gegen echtes PostgreSQL: IPAM unter Nebenläufigkeit, atomare Registrierung, RLS, Stripe-Zustand, Mandanten-Registry, Abo-Gate und Fehlerabbildung gegen echte Postgres-Fehler | Routen/HTTP, Token-Verifikation, UI | `DATABASE_URL`; setzt `public`/`auth` zurück |
| **HTTP mit Stub** | `bun run test:http` (führt `test:stub`, `test:routes`, `test:revoke`, `test:webhook`, `test:admin`, `test:billing` nacheinander aus) | Echte Route-Handler mit echtem `supabase-js` gegen einen gestubbten GoTrue/PostgREST: Status, Codes, Texte, Header, Identität aus dem Token, Nutzung des Service-Role-Keys, Tabellenzugriffe samt Filter-URL (`revoke`), Signatur und Idempotenz des Stripe-Webhooks, Allowlist der Admin-Route, Kundenanlage samt Upsert und Session-Parameter von Checkout und Portal | echtes GoTrue/PostgREST: Token-Format, Claim-Auswertung, RLS, echte Fehlertexte; echte Stripe-Objekte (der Stripe-Client läuft gegen einen fetch-Stub — das prüft `test:stripe`) | nichts (Bun) |
| **Echter Stack** | `bun run test:auth-route` (CI-Job `auth`) | 28 Prüfungen — 24 Prüfstellen, eine davon läuft im Gerätelimit-Loop fünfmal: Registrierung, Retry, RLS-Sicht, Schlüsselwechsel, Gerätelimit und Abo-Sperre gegen `supabase start`, mit echten Nutzern und echten Logins | Browser/UI | Docker |
| **UI-Render** | `bun run check:render` (CI-Job `dashboard-auth`) und `bun run check:render:dry` (CI-Job `quality`) | Startseite mit `NEXT_PUBLIC_*`: 6 Render-Prüfungen; ohne sie: 4 Trockenlauf-Prüfungen (Hinweis samt Variablennamen, kein Formular) | Interaktion, Klicks | Build, Serverstart |

`bun run test:http` ist der Sammelbefehl für diese Ebene
([`scripts/run-http-suites.mjs`](../scripts/run-http-suites.mjs)): Er läuft alle
sechs Suiten auch dann weiter, wenn eine fehlschlägt, nennt am Ende
Prüfungszahl, Exit-Status und Dauer je Suite und endet mit 1, sobald eine rot
war. Die Prüfungszahlen zählt er aus den `PASS`-Zeilen desselben Laufs mit und
vergleicht sie anschließend mit dem `test:http`-Absatz in der README; eine
Abweichung ist ein Fehlschlag, damit die dokumentierten Zahlen nicht still
veralten. Kommt ein Test hinzu, gehören beide Stellen in denselben Schritt.

### `bun run check:docs`

`bun run check:docs`
([`scripts/check-docs.mjs`](../scripts/check-docs.mjs)) beantwortet in
Millisekunden die Frage, ob README und diese Datei noch dieselben Zahlen
nennen — und ob die Doku zu den Dateien passt, aus denen die Zahlen stammen.
Er führt keinen Test aus und braucht kein Netz, keine Datenbank und keinen
Build: Er liest Text und zählt nach. Quellen sind `README.md`,
`docs/testing.md`, die beiden Suite-Runner, `vitest.config.ts`, `package.json`,
die Migrationen samt [`docs/rpc-invarianten.md`](rpc-invarianten.md)
und alle YAML-Dateien unter `.github/` (Workflow und Composite-Action); die
Suiten-Listen, `include`-Muster,
Skriptnamen und Job-Namen werden aus diesen Dateien gelesen, nicht im Skript
dupliziert.

Jeder Lauf gibt zwölf Abschnitte in fester Reihenfolge aus, jeder mit einer
Zeile je geprüfter Angabe (`ok` oder `ABW`), und sammelt alle Abweichungen in
einer Liste. Ist die Liste leer, endet er mit `Alle Zahlangaben stimmen.` und
Exit 0; sonst gibt er `Abweichungen:` samt Zeilen und dem Hinweis
`Bitte README.md und docs/testing.md angleichen.` aus und endet mit Exit 1.

1. **Dokument-Zahlen** — fünf Paare aus README und dieser Datei: Unit-Tests
   (`84 Unit-Tests` / `84 Tests in 8 Dateien`), Datenbank (`140 Prüfungen`),
   Auth-Route (`28 Punkte` / `28 Prüfungen —`), Render (6) und Trockenlauf (4).
   Beide Seiten werden über ihre Formulierung gesucht; fehlt eine Angabe,
   meldet der Abschnitt `Angabe fehlt in <Datei>`, weichen die Zahlen ab,
   `Unit-Tests: README 85, docs/testing.md 84`. Die Ausgabe zeigt beide Werte
   nebeneinander (`README 84 / 84`).
2. **Unit-Testdateien** — die 8 Testdateien aus `8 Tests in 8 Dateien` in
   dieser Datei prüft er gegen den echten Dateibaum, gefiltert mit den
   `include`-Mustern aus `vitest.config.ts` (einfache Globs: `**`, `*`, `?`).
   Abhängigkeits-, Build- und Cache-Ordner (`node_modules`, `.next`, `dist`,
   `build`, `out`, `coverage`, `.turbo`, `.git`) und symbolische Links bleiben
   außen vor. Bei einer Abweichung nennt er zusätzlich die gefundenen Dateien.
3. **Summen im README** — die Gesamtzahl aus dem README-Absatz (`… in sechs
   Suiten ab, zusammen 270 Prüfungen`) muss die Summe der Einzelzahlen sein,
   die dort je Suite in Backticks stehen (`` `test:ipam` (11, ``). Die
   Suiten-Namen kommen aus `SUITES` in
   [`scripts/run-http-suites.mjs`](../scripts/run-http-suites.mjs) bzw.
   [`scripts/run-db-suites.mjs`](../scripts/run-db-suites.mjs); fehlt eine
   Einzelzahl, ist das ein eigener Fehler. Beide Abschnitte zusammen ergeben
   die Zeilen `HTTP-Suiten 270 = 34 + 68 + 26 + 65 + 23 + 54` und
   `DB-Suiten 140 = 11 + 23 + 13 + 17 + 15 + 16 + 45`.
4. **Suite-Namen in der Testebenen-Tabelle** — jede Suite aus beiden Runnern
   muss in der Tabelle oben in Backticks vorkommen. Geprüft werden nur Zeilen,
   die mit `|` beginnen; eine neue Suite ohne Tabellenzeile fällt damit auf
   (`HTTP-Suiten: test:extra fehlt in der Tabelle in docs/testing.md`), ohne
   dass sich eine Zahl ändert.
5. **CI-Tabelle in der README** — die Job-Namen aus dem `jobs:`-Block von
   `.github/workflows/ci.yml` (Schlüssel mit zwei Leerzeichen Einrückung) und
   die Tabellenzeilen im README-Abschnitt `## CI` müssen dieselben sein, in
   beide Richtungen (`Job \`lint\` fehlt` bzw. `Job \`lint\` gibt es in ci.yml
   nicht`). Zusätzlich muss der Satz über der Tabelle die Anzahl als deutsches
   Zahlwort nennen (`Vier Jobs in [`.github/workflows/ci.yml`]`); die
   Zuordnung deckt Eins bis Zwölf ab, ein unbekanntes Zahlwort oder ein
   fehlender Satz wird eigens gemeldet.
6. **CI-Schritte in der Tabelle** — je Job liest er die `run:`-Zeilen
   (Kommentarzeilen fliegen raus), zieht die Skripte aus `bun run <skript>`
   und `node scripts/<skript>.mjs` und verlangt, dass jedes davon in der
   README-Zeile des Jobs als Teilstring vorkommt. Startbefehle (`install`,
   `start`, `dev`, `watch`) und Schritte ohne Skript (psql, docker, mkdir)
   zählen nicht; die Reihenfolge wird nicht geprüft. So fällt ein Schritt auf,
   der in der Tabelle gar nicht erwähnt wird (`quality 8/9 — fehlt:
   test:stripe`), während Umsortieren erlaubt bleibt.
7. **CI-Artefakte in der Tabelle** — die `name:`-Zeilen der
   `upload-artifact`-Schritte (zehn Leerzeichen Einrückung) müssen in der
   README-Zeile als `…-logs` auftauchen, und umgekehrt darf die Tabelle kein
   Artefakt nennen, das der Workflow nicht hochlädt. Gemeldet wird beides:
   `database 0/1 — fehlt: db-logs; zu viel: database-logs`.
8. **CI-Aufbewahrung** — jeder Job mit `upload-artifact` braucht ein
   `retention-days`, und jeder Wert muss der Zahl im README-Satz `liegen 7
   Tage bereit` entsprechen. Fehlt die Angabe in einem Upload, nennt der
   Abschnitt den GitHub-Standard von 90 Tagen; abweichende Werte erscheinen
   als `quality: retention-days 30, README nennt 7`.
9. **Dokumentierte Befehle** — jeder in README oder dieser Datei genannte
   `bun run <skript>`-Befehl muss in `scripts` von `package.json` existieren;
   sonst bleibt ein umbenanntes Skript als toter Befehl in der Anleitung
   stehen, und der Abschnitt meldet `docs/testing.md: <befehl> fehlt in
   package.json`. Die Ausgabe zählt genannte und vorhandene Befehle je
   Dokument (12/12 in der README, 13/13 hier). Auch Beispiele in diesem Text
   zählen mit: Deshalb steht hier überall `bun run <skript>` statt eines
   konkreten Namens — ein absichtlich falsches Beispiel würde sich selbst als
   toten Befehl melden.
10. **Interne Links in allen Markdown-Dateien** — jeder relative Verweis in
   der README und in jeder weiteren Markdown-Datei des Repos (`docs/*.md`,
   `supabase/templates/README.md`, `apps/mobile/README.md` und jede künftige
   unter `.github/`) muss auf eine vorhandene Datei zeigen, und ein Anker
   `#…` muss
   zu einer Überschrift der Zieldatei passen. Überschriften werden nach der
   GitHub-Regel umgesetzt (klein, Sonderzeichen raus, Leerzeichen zu `-`,
   Doppelungen mit `-1`, `-2`), damit der Vergleich dem entspricht, was der
   Browser anspringt. Ausgenommen sind Code-Blöcke, `http(s)`- und
   `mailto`-Ziele und Bild-Verweise. So fällt ein Verweis auf einen
   umbenannten Abschnitt auf (`README.md: Anker #ci fehlt in README.md`),
   ohne dass jemand die Seite öffnen muss. Jede Datei bekommt eine eigene
   Zeile; Dateien ohne relative Verweise stehen als `keine Links` da.
11. **Migrationen in der Invarianten-Doku** — jede Datei aus
   `supabase/migrations/` muss in
   [`docs/rpc-invarianten.md`](rpc-invarianten.md) verlinkt sein. Dort stehen
   Zusicherung und prüfender Test je Migration; eine neue Migration ohne Link
   fällt sonst niemandem auf, weil sie in keiner Zahl auftaucht. Die Prüfung
   läuft bei jedem Aufruf mit, auch wenn nur einzelne Dokumente geprüft
   werden, und nennt fehlende Dateien mit Pfad.
12. **Skripte und Pfade in den Workflows** — in jeder YAML-Datei unter
   `.github/` (`.github/workflows/ci.yml` und `action.yml` der
   Composite-Action) muss jedes `bun run <skript>` in den `scripts` eines
   `package.json` im Repo stehen (Root, `apps/*`, `packages/*`), jedes per
   `node` oder `bun` gestartete `scripts/<datei>.mjs` im Dateibaum liegen,
   jede lokale Action (`uses: ./…`) samt eigenem `action.yml` existieren und
   jedes `cd`-Ziel bzw. `working-directory` ein Verzeichnis sein. Ein
   `hashFiles('…')`-Pfad ist nur Pflicht, wenn er nicht selbst die
   `if:`-Bedingung des Schritts ist — `angebot/kalkulation.csv` fehlt in der
   CI absichtlich, der Schritt läuft dann nicht. Startet die Datei
   `supabase start`, müssen `supabase/config.toml` und mindestens eine
   Migration in `supabase/migrations` vorhanden sein. Erzeugte Pfade
   (`ci-logs/`, `.next/trace`, Logs in `/tmp`) entstehen erst im Lauf und
   werden nicht verlangt; Kommentarzeilen zählen nicht mit. So fällt ein
   umbenanntes Skript auf (`ci.yml: bun run check:docs fehlt in jedem
   package.json`), ohne dass die CI erst starten muss.

Die Prüfungen sind bewusst textuell: Einrückung der `retention-days`- und
`name:`-Zeilen, Überschrift `## CI`, die Formulierungen der Zahlensätze. Wird
eine dieser Stellen umformatiert, schlägt der Abschnitt laut fehl, statt still
durchzulaufen — das ist gewollt, weil ein stiller Fehlschlag die Doku wieder
auseinanderlaufen ließe. Was er nicht kann: prüfen, ob eine Zahl inhaltlich
stimmt. Zwei Dokumente mit derselben falschen Zahl sind für ihn grün; das
prüfen erst `check:unit-count`, `test:http`, `test:db`, `test:auth-route` und
`check:render` nach einem echten Lauf. In der CI läuft er im Job `quality` vor
dem Unit-Check, damit ein Zahlendreher nach Sekunden statt nach Minuten
auffällt.

`bun run check` bündelt ihn mit der Markenprüfung der Mail-Vorlagen
(`mail:check`) und dem Typecheck aller drei Packages zu einem lokalen
Vorabcheck: erst die günstigen Prüfungen, dann der Compiler — alle müssen grün
sein. Er ersetzt keinen der Testläufe.

Für die Unit-Ebene macht `bun run check:unit-count` dasselbe: Es führt
`bun run test` aus, liest die Zusammenfassung `Tests  <n> passed` und
vergleicht sie mit der Zahl im README-Schnellstart. Der CI-Job `quality` nutzt
diesen Check statt eines zweiten `bun run test`.

Die Datenbank-Ebene nutzt dieselbe Mechanik: `bun run test:db` startet
[`scripts/run-db-suites.mjs`](../scripts/run-db-suites.mjs), das über
[`scripts/lib/suite-runner.mjs`](../scripts/lib/suite-runner.mjs) alle sieben
Suiten auch bei Rot weiterlaufen lässt und die Prüfungszahlen gegen den
`test:db`-Absatz der README hält. Für den echten Stack tut
`bun run test:auth-route` dasselbe
([`scripts/run-auth-route.mjs`](../scripts/run-auth-route.mjs)): Es zählt die
`PASS`-Zeilen der E2E und vergleicht sie mit dem README-Absatz **und der Zeile
„Echter Stack“ oben in dieser Datei**; fehlen Stack oder Docker, bricht es mit
einer Meldung und der Anleitung ab, statt Verbindungsfehler zu stapeln. Dasselbe für die UI-Ebene: `bun run check:render`
([`scripts/check-dashboard-render.mjs`](../scripts/check-dashboard-render.mjs))
prüft die sechs Render-Punkte der Startseite, schreibt mit `RENDER_PAGE_FILE`
das HTML für das CI-Artefakt und hält die Zahl gegen die README **und die
Tabellenzeile oben in dieser Datei**. Mit dem
Argument `dry` (`check:render:dry`) prüft dasselbe Skript den Gegenfall: Der
Build ohne `NEXT_PUBLIC_*` muss den Trockenlauf-Hinweis samt beider
Variablennamen zeigen und kein Anmeldeformular rendern — vier Prüfungen, die
ebenfalls gegen die README gehalten werden. Das läuft im Job `quality`, dessen
Build ohnehin keine Auth-Konfiguration hat. Fehlt `DATABASE_URL`, bricht der Runner vor
der ersten Suite mit einer Meldung ab. Danach prüft er einmal TCP, meldet sich
mit den Zugangsdaten an und schaut nach, ob die Rolle `public`/`auth`
zurücksetzen darf (Eigentümer der Datenbank oder Superuser) — erst dann starten
die Suiten. Nicht erreichbarer Host/Port, falsches Passwort und fehlende Rechte
nennen Host und Port samt Grund (`ECONNREFUSED`, `28P01`, „weder Eigentümer noch
Superuser“), statt sieben gleiche Fehlerberge zu erzeugen. Die URL selbst mit
Zugangsdaten druckt er nie. Die einzelnen `test:<thema>`-Skripte nutzen weiterhin den lokalen Default
aus `db-fixture.mjs`. Ein `&&` zwischen den Skripten würde nach dem
ersten Fehler abbrechen und die übrigen Baustellen verdecken.

Sonderfälle: `bun run mail:check` (Mail-Vorlagen entsprechen der Marke),
`bun run verify:angebot` (Angebotszahlen gegen `kalkulation.csv`) und
`bun run test:stripe` (echte Stripe-API; braucht Schlüssel und laufende App).

## DB-Suiten ohne Docker

`bun run test:db` braucht nur ein erreichbares PostgreSQL — kein Docker, keine
Root-Rechte. Wer keinen Stack zur Hand hat, startet ein wegwerfbares Postgres
aus einem npm-Paket **außerhalb** des Repositories; das Projekt bekommt dabei
keine neue Abhängigkeit und die `bun.lock` bleibt unberührt:

```bash
mkdir -p /tmp/dachvpn-pg && cd /tmp/dachvpn-pg
npm init -y && npm install embedded-postgres

BIN=/tmp/dachvpn-pg/node_modules/@embedded-postgres/linux-x64/native/bin
$BIN/initdb -D /tmp/dachvpn-pg/data -U postgres --auth=trust
$BIN/pg_ctl -D /tmp/dachvpn-pg/data -l /tmp/dachvpn-pg/postgres.log \
  -o "-p 5432 -c listen_addresses=127.0.0.1" -w start

cd -   # zurück ins Repository
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres bun run test:db

$BIN/pg_ctl -D /tmp/dachvpn-pg/data -m fast -w stop
rm -rf /tmp/dachvpn-pg
```

Was dabei wichtig ist:

- `-U postgres` und `--auth=trust` passen zur Default-URL in
  [`scripts/lib/db-fixture.mjs`](../scripts/lib/db-fixture.mjs)
  (`postgres:postgres@127.0.0.1:5432/postgres`); `trust` ignoriert das Passwort,
  die URL bleibt trotzdem gültig. Ist Port 5432 belegt, `-p` und `DATABASE_URL`
  gemeinsam ändern.
- npm meldet beim Installieren, dass das `postinstall`-Skript von
  `@embedded-postgres/linux-x64` nicht lief. Für diesen Weg ist das
  unerheblich: Aufruf und Pfad gehen direkt auf `native/bin`, nicht über den
  JS-Wrapper des Pakets.
- Pfad und Paketname gelten für **linux-x64**; auf macOS oder ARM heißt das
  Plattformpaket anders und der `BIN`-Pfad ändert sich entsprechend.
- Das Paket liefert derzeit PostgreSQL 18 (Beta), die CI nutzt
  `postgres:16-alpine`. Die Suiten sind identisch; bei einem Verdacht auf einen
  Versionsunterschied in der CI gegenprüfen, nicht hier.
- Das Datenverzeichnis ist wegwerfbar: Die Suiten setzen `public` und `auth`
  ohnehin zurück (Regel 3), und `rm -rf` am Ende räumt alles ab. Nichts davon
  gehört in einen Commit, ein Skript im Repo oder die `package.json`.

## Welche Ebene für welche Änderung

| Änderung | Ebene |
|---|---|
| Eingaberegel im Guard, reine Funktion | Unit, plus Routen-Stub für den Statuscode |
| Migration, RPC, Policy, Constraint | Datenbank (`test:db`) |
| Fehlercode-Mapping, Verzweigung im Handler | Routen-Stub |
| neuer `raise exception` in einer Migration | `test:errors` — schlägt fehl, bis der Marker abgebildet ist |
| Login, JWT, RLS mit echten Tokens, PostgREST-Fehlerform | echter Stack (`auth`) |
| Markup und Startseite | Render-Job (`dashboard-auth`) |

## Regeln

1. **Der Stub ersetzt nie den echten Stack.** `scripts/auth-route-e2e.mjs` bleibt
   bewusst beim echten Supabase-Stack. Ein Stub dort würde Token-Format,
   Claim-Auswertung und RLS nicht mehr prüfen — genau die Fehler, die ein Stub
   nicht nachbilden kann.
2. **Der Stub ist selbst getestet.** Wer
   `scripts/lib/supabase-stub.mjs` ändert, prüft zuerst `bun run test:stub` und
   danach die Routen-Tests.
3. **DB-Tests sind destruktiv.** Sie setzen `public` und `auth` zurück — nie gegen
   eine echte Datenbank richten.
4. **Neue Fläche, neue Ebene.** Eine neue Route bekommt einen Routen-Stub-Test,
   eine neue Migration einen DB-Test. Zusätzlich, nicht statt.
5. **Fehlerzuordnung.** Ist der Stub-Kontrakt grün und ein Routen-Test rot, liegt
   der Fehler in der Route. Umgekehrt ist es ein Hinweis auf die Test-Hilfe.

## Skelett: neuer Routen-Test mit dem Stub

Datei `scripts/<thema>-http-test.mjs`, Start mit Bun (die Handler importieren
TypeScript und `next/server`):

```js
#!/usr/bin/env bun
import { callRoute } from "./lib/route-http.mjs";
import { startSupabaseStub } from "./lib/supabase-stub.mjs";
import { createChecker, fakePublicKey } from "./lib/db-fixture.mjs";

const { check, finish } = createChecker();
const stub = await startSupabaseStub();
const restoreEnv = stub.installEnv({ DEFAULT_NODE_ID: "eu-http-1", MAX_DEVICES_PER_USER: "7" });

const route = await import("../apps/dashboard/app/api/devices/rebind/route.ts");
const BODY = { deviceId: "99999999-8888-4777-8666-555555555555", publicKey: fakePublicKey(1) };

try {
  // 1. Auth-Ebene: ohne Token, mit Ausfall-Token.
  const anonymous = await callRoute(route.POST, { body: BODY });
  check(anonymous.status === 401 && anonymous.payload?.code === "AUTH_REQUIRED", `ohne Token → 401 (${anonymous.status})`);

  const down = await callRoute(route.POST, { body: BODY, token: stub.unavailableToken });
  check(down.status === 503, `Auth-Ausfall → 503 (${down.status})`);

  // 2. Erfolgsfall — und was tatsächlich am RPC ankam.
  stub.setRpc(200, [{ device_id: BODY.deviceId, assigned_ip: "10.8.0.2" }]);
  const ok = await callRoute(route.POST, { body: BODY, token: stub.token });
  check(ok.status === 200 && ok.payload?.device?.reused === true, `Erfolg → 200 (${ok.status})`);
  check(stub.lastRpc?.name === "rebind_device_key", `RPC-Name (${stub.lastRpc?.name})`);
  check(stub.lastRpc?.body?.p_user_id === stub.userId, "Nutzer-ID kommt aus dem Token");
  check(stub.lastRpc?.headers?.apikey === stub.serviceKey, "Service-Role-Key am RPC");

  // 3. Datenbankfehler in PostgREST-Form, ohne SQLSTATE nach außen.
  stub.rpcError("P0006", "SUBSCRIPTION_REQUIRED");
  const gated = await callRoute(route.POST, { body: BODY, token: stub.token });
  check(gated.status === 403 && gated.payload?.code === "SUBSCRIPTION_REQUIRED", `Abo fehlt → 403 (${gated.status})`);
  check(!/P000\d|235\d\d/.test(gated.payload?.message ?? ""), "Antwort ohne SQLSTATE");
} finally {
  restoreEnv();
  await stub.close();
}

finish("Route (HTTP, Stub)");
```

Was das Skelett festhält und was daran bewusst fehlt:

- `try/finally` ist Pflicht: `restoreEnv()` und `stub.close()` müssen auch bei
  einer Ausnahme laufen, sonst bleibt der Port offen und die Umgebung verschmutzt.
- `installEnv` setzt `SUPABASE_URL` und die Keys auf den Stub und entfernt die
  `NEXT_PUBLIC_*`-Fallbacks — so kann ein lokales `.env` den Trockenlauf nicht
  unbemerkt aushebeln.
- `setRpc` gilt für den **nächsten** RPC-Aufruf; nach jedem Fall neu setzen.
- Nur RPC-Routen sind ohne Zusatz abgedeckt. Liest eine Route eine Tabelle
  (`revoke` tut das mit `.from("devices")`), braucht sie einen eigenen Pfad:
  `stub.route("/rest/v1/devices", (req, res, ctx) => ctx.send(res, 200, [{ id, status: "active" }]))`.
  Vorbild ist [`scripts/revoke-route-http-test.mjs`](../scripts/revoke-route-http-test.mjs):
  `200 []` bedeutet für `.maybeSingle()` „keine Zeile“ (404-Pfad), ein
  406 `PGRST116` käme dagegen als Fehler an.
- Danach fehlen noch zwei Zeilen außerhalb der Datei: ein Skript in
  `package.json` (`"test:<thema>": "bun scripts/<thema>-http-test.mjs"`) und ein
  Eintrag in `test:http`. Der CI-Job `quality` ruft nur `bun run test:http` auf
  und nimmt den neuen Test damit automatisch mit.
- Wer den Stub dafür erweitert, prüft zuerst `bun run test:stub`.

## Stripe-Routen: der fetch-Stub

Die Stripe-Routen bauen ihren Client selbst (`apps/dashboard/lib/stripe.ts`) —
es gibt keinen Injektionspunkt für einen Testclient. `scripts/lib/stripe-api-stub.mjs`
hängt deshalb an `globalThis.fetch`: Das Stripe-SDK greift `fetch` beim Erzeugen
des Clients aus dem Global ab. Anfragen an `api.stripe.com` beantwortet der
Stub, alles andere (Supabase, GoTrue) geht unverändert ans echte `fetch`.

```js
const stripe = installStripeStub();
stripe.on("GET", "/v1/subscriptions/sub_1", 200, { id: "sub_1", status: "active" });
// ... Route aufrufen ...
stripe.restore();
```

Drei Dinge sind dabei wichtig:

- **Vor dem ersten `stripeClient()`-Aufruf installieren.** Das SDK merkt sich
  die fetch-Funktion beim Erzeugen des Clients; ein späteres `install()` wirkt
  nicht mehr. Vorbild ist
  [`scripts/stripe-webhook-route-http-test.mjs`](../scripts/stripe-webhook-route-http-test.mjs).
- **Es gibt keine Stripe-Objekte und keine Stripe-Fehler.** Der Stub liefert
  genau die JSON-Form, die das SDK erwartet; Preis-, Kunden- und
  Session-Prüfungen gegen die echte API bleiben `test:stripe`.
- **Bun löst das Stripe-Paket über die `bun`-Exportbedingung auf** — dort
  liefert das SDK nur einen asynchronen HMAC. Der Webhook prüft die Signatur
  deshalb mit `constructEventAsync()`; `constructEvent()` würde unter Bun
  `CryptoProviderOnlySupportsAsyncError` werfen und als `400 INVALID_SIGNATURE`
  enden. Die Prüfung selbst ist identisch (Rohbody, Toleranz 300 s).

Für Routen-Tests heißt das: einen Stripe-Aufruf im Test erwarten, nicht
nachbauen. `stripe.callsTo("/v1/subscriptions/sub_1")` zählt die Anfragen,
`stripe.lastCall` liefert Methode, Pfad und Body.

Die Request-Bodies sind formularkodiert (`application/x-www-form-urlencoded`),
nicht JSON. Ein Test liest sie deshalb mit
`new URLSearchParams(String(call.body))` und prüft Schlüssel wie
`customer`, `line_items[1][price]` oder `subscription_data[metadata][user_id]`.
Vorbild ist
[`scripts/stripe-billing-routes-http-test.mjs`](../scripts/stripe-billing-routes-http-test.mjs)
(Checkout und Portal).

## Wo ein neuer Test hingehört

- Reine Logik → `packages/*/src/*.test.ts` (Vitest).
- SQL, RPC, RLS → `scripts/*-test.mjs` mit `createChecker`/`migrate`, Eintrag in
  `test:db`.
- Route ohne Stack → `scripts/*-http-test.mjs` mit `startSupabaseStub` und
  `callRoute`, Eintrag in `test:http` (läuft im CI-Job `quality`).
- Verhalten des echten Stacks → `scripts/auth-route-e2e.mjs`, CI-Job `auth`.
