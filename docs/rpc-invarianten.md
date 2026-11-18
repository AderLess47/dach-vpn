# RPC-Invarianten und ihre Tests

Alle Funktionen in `public` sind `security definer` und laufen nur als
`service_role` — ein Aufruf aus dem Browser ist damit nicht möglich. Was diese
Funktionen zusichern, prüfen die DB-Tests in `scripts/`; die HTTP-E2E kommt für
das dazu, was nur über die Route sichtbar ist. Diese Datei hält fest, welche
Zusicherung wo steht und wie man prüft, dass eine Prüfung überhaupt fehlschlagen
kann.

## Wo was läuft

| Skript | Gegenstand | CI-Job, Schritt |
| --- | --- | --- |
| `scripts/ipam-loadtest.mjs` (`test:ipam`) | `seed_ip_pool`, `allocate_ip`, `release_ip`, `revoke_device` | IPAM & Registrierung (Integration), „Datenbank-Tests" |
| `scripts/registration-integration.mjs` (`test:registration`) | `register_device`, `revoke_device`, `rebind_device_key` | derselbe Schritt |
| `scripts/rls-test.mjs` (`test:rls`) | Policies, Endnutzer-Sperren, `handle_new_user` | derselbe Schritt |
| `scripts/subscription-sync-test.mjs` (`test:subscription`) | `apply_subscription_state`, `admin_metrics`, `stripe_events` | derselbe Schritt |
| `scripts/auth-route-e2e.mjs` (`test:auth-route`) | dieselben Zusicherungen über die Route, gegen den lokalen Supabase-Stack | Auth-Route (lokaler Supabase-Stack), „Auth-Route gegen den Stack prüfen" |

`bun run test:db` startet die vier DB-Suiten nacheinander mit `&&`: schlägt eine
fehl, laufen die folgenden nicht mehr. Jede Suite setzt das Schema `public`
zurück — nie gegen eine echte Datenbank richten.

In den Skripten sammelt `check()` nur Fehlschläge; erst `finish()` beendet den
Prozess mit Exit 1. Ein fehlgeschlagener Check reißt also nicht sofort ab,
sondern erzeugt mehrere FAIL-Zeilen. **Ursache ist die erste.** Was danach
kommt, kann Folgefehler sein, weil der kaputte Zustand weitergeschrieben wurde.

## Invarianten je Funktion

**`seed_ip_pool(node, cidr)`**

- idempotent: ein zweiter Lauf fügt nichts hinzu (Assertion: Rückgabe `0`).
- eine `cidr` ohne nutzbare Hosts wird mit `POOL_TOO_SMALL` abgelehnt.
- das befüllte Netz enthält genau die Hosts, die der Test erwartet (30 aus
  `/27`).

**`allocate_ip(node, device)`**

- seriell über `pg_advisory_xact_lock` je Knoten: unter paralleler Last gibt es
  keine doppelte Adresse (120 parallele Anfragen auf 30 Adressen → 30 Erfolge,
  30 verschiedene Adressen).
- Erschöpfung ist `IP_POOL_EXHAUSTED` (`P0001`), kein Constraint-Fehler.
- Idempotenz: dasselbe Gerät bekommt beim zweiten Aufruf dieselbe Adresse.
- Pool und Geräte stimmen zusammen (jede belegte Adresse gehört zu einem
  aktiven Gerät).

**`release_ip(device)`**

- gibt genau eine Adresse frei (Rückgabe `1`).
- danach hält das Gerät keine Adresse mehr (`device_id` leer).

**`revoke_device(device)`**

- setzt `status = 'revoked'`, `revoked_at` und leert `assigned_ip`.
- gibt die Adresse frei; der Pool-Eintrag ist `free` und ohne Gerät.
- eine neue Registrierung erhält die freigewordene Adresse wieder.

**`register_device(user, name, platform, key, node, pihole)`**

- Gerät und Adresse entstehen atomar: erschöpfter Pool → `IP_POOL_EXHAUSTED`
  (`P0001`) **und** die Geräteanzahl bleibt unverändert (Rollback).
- idempotent über den Public Key: Retry liefert `reused = true`, dieselbe
  Geräte-ID und dieselbe Adresse, ohne zusätzliches Gerät.
- Gerätelimit greift (`DEVICE_LIMIT_REACHED`, `P0003`).
- ein Public Key, der einem anderen Konto gehört, wird abgelehnt (`P0004`).

**`rebind_device_key(user, device, key)`**

- der Eigentümer bekommt dieselbe Geräte-ID und dieselbe Adresse zurück; nur
  `public_key` ändert sich.
- **fremdes Gerät** → `DEVICE_NOT_FOUND` (`P0005`), Zeile unverändert
  (Key, Adresse, Status). Diese Prüfung existiert **nur in der Funktion**: die
  Route bildet den Fehlercode auf 404 ab und prüft den Besitz nicht selbst.
  Fehlt der Vergleich in der Funktion, antwortet die Route mit 200 — genau das
  hat die Gegenprobe unten gezeigt.
- **unbekannte Geräte-ID** → dieselbe Antwort `P0005`: von außen ist fremd und
  nicht vorhanden nicht unterscheidbar, die Funktion ist keine Sonde.
- **widerrufenes Gerät** → `DEVICE_REVOKED` (`P0002`); geprüft über die Route in
  `auth-route-e2e.mjs`.
- für `authenticated` nicht ausführbar (`42501`).

**`apply_subscription_state(…)` / `admin_metrics()` / `stripe_events`**

- Upsert je `user_id`; Status und Add-on folgen dem Event.
- fehlende Werte überschreiben nichts: `stripe_customer_id` und
  `current_period_end` bleiben bei einem Update ohne diese Felder erhalten.
- `admin_metrics` liefert nur Aggregate (keine Nutzer-IDs, keine E-Mails,
  keine Adressen) und ein Knoten-Aggregat auch dann, wenn es leer ist.
- alle drei sind für `authenticated` gesperrt (`42501`).

**`handle_new_user()`**

- jeder `auth.users`-Eintrag bekommt ein Profil (Trigger).

## Gegenprobe per Mutation

Eine Prüfung, die nicht fehlschlagen kann, beweist nichts. Deshalb: eine
Zusicherung absichtlich brechen und nachsehen, ob genau die zuständige Prüfung
rot wird.

Der Ablauf bleibt auf einem Wegwerf-Branch; `main` wird nicht angefasst. Die CI
läuft laut `ci.yml` auch auf `freebuff/**`, solche Branches sind also ein
geeigneter Ort für die Gegenprobe.

1. Branch vom aktuellen `main` abzweigen, z. B.
   `freebuff/mutation-rebind-besitz`.
2. **Genau eine** Zusicherung entfernen. Beispiel `rebind_device_key`: aus
   `if not found or v_device.user_id <> p_user_id then` wird
   `if not found then`.
3. Pushen und den Lauf abwarten. Erwartet für dieses Beispiel:
   - „IPAM & Registrierung (Integration)" → rot, Schritt „Datenbank-Tests":
     FAIL auf „Fremdes Gerät wird per RPC abgelehnt", danach auf „Gerät bleibt
     unverändert".
   - „Auth-Route (lokaler Supabase-Stack)" → rot, Schritt „Auth-Route gegen den
     Stack prüfen".
   - „Typecheck, Tests, Build" und „Dashboard mit Supabase Auth (Rendering)"
     → grün.

   Wichtig für die Aussagekraft: der Schritt, der die Migrationen einspielt
   (`./.github/actions/supabase-local`), muss **grün** sein. Sonst ist die rote
   Suite nur ein SQL-Fehler und kein Verhaltensbefund.
4. Branch löschen. Der CI-Lauf bleibt als Beleg in der Historie stehen.

Für andere Funktionen gilt dasselbe Muster: Advisory Lock in `allocate_ip`
entfernen → Doppelvergabe im Lasttest; `coalesce` im Upsert von
`apply_subscription_state` auflösen → „Kunden-ID bleibt erhalten" wird rot.
Verschiebt man die Besitzprüfung aus der Funktion in die Route, bleibt der
E2E-Test grün und nur der DB-Test wird rot — das ist der Grund, warum die
Prüfung auf RPC-Ebene existiert.

Lokal geht das auch:

```bash
docker run -d --rm --name dachvpn-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16-alpine
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres bun run test:db
```

## Nicht abgesichert

Damit die Tabelle oben nicht mehr verspricht, als sie hält:

- `POOL_TOO_SMALL` (zu kleines Netz) wird von keiner Prüfung angesprochen.
- `register_device` mit bereits widerrufenem Public Key (`DEVICE_REVOKED` aus
  Migration 0003) ist nur über `rebind_device_key` abgedeckt, nicht für die
  Registrierung selbst.
- die Edge Function `register-device` hat keine Tests (keine Deno-Runtime in der
  CI); geprüft wird die Next.js-Route.
- Stripe-Webhook und Checkout nur über `bun run test:stripe` im Testmodus, siehe
  [stripe-test.md](stripe-test.md).
