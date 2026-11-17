# Stripe-Testlauf

Ziel: `bun run test:stripe` läuft grün durch — erst gegen die Stripe-API, dann
gegen die eigene Webhook-Route. Alles ausschließlich im **Testmodus**; das
Skript lehnt `sk_live_…` und `rk_live_…` ab, bevor es irgendetwas anfragt.

Werte gehören in `apps/dashboard/.env.local` (Rechte 600, git-ignoriert) oder in
die Projekt-Secrets des Hosters — niemals in Commits, Tickets oder Chats.

## Was das Skript prüft

**Stufe A — Stripe-API** (braucht nur den Test-Key):

- jeder Preis: `active`, `type: recurring`, `livemode: false`, `currency: eur`
- Testkunde wird angelegt und ist im Testmodus
- Checkout-Session im Abo-Modus, offen, mit Zahlungs-URL
- `amount_subtotal` entspricht Basis + Add-on
- Session wird wieder geschlossen, Testkunde gelöscht

**Stufe B — eigener Webhook** (zusätzlich `STRIPE_WEBHOOK_SECRET`,
`APP_BASE_URL`, `SMOKE_USER_ID`):

- synthetisches `customer.subscription.updated` mit gültiger Signatur → `200`,
  `received: true`, `handled: true`
- dieselbe Event-ID ein zweites Mal → `200`, `duplicate: true`
- Signatur mit falschem Secret → `400`, `INVALID_SIGNATURE`

Ohne Netzwerk und ohne Keys prüfbar: `bun run test:stripe --self-test` (9
Prüfungen, Signaturformat, Event-Form, Live-Key-Ablehnung).

## Was du im Stripe-Dashboard anlegst

Testmodus einschalten (Schalter oben im Dashboard) und dort arbeiten.

1. **Zwei wiederkehrende Preise in EUR**, monatlich, beide aktiv:
   - Basis-Abo → `STRIPE_PRICE_ID_BASE`
   - Pi-hole Add-on → `STRIPE_PRICE_ID_PIHOLE`

   Die `price_…`-ID kopieren, nicht die `prod_…`-ID. Der Betrag ist frei wählbar;
   die Session-Prüfung vergleicht mit der Summe deiner eigenen Beträge.
   Das Add-on ist optional — ohne `STRIPE_PRICE_ID_PIHOLE` entfällt nur dessen
   Preisprüfung.
2. **Secret Key im Testmodus** (Developers → API keys): `sk_test_…` oder ein
   restricted key `rk_test_…` mit Schreibrecht auf Customers und
   Checkout-Sessions → `STRIPE_SECRET_KEY`.
3. **Webhook-Ziel** ist die Route im Dashboard, nicht eine Supabase-Function:
   `<öffentliche Basis-URL>/api/stripe/webhook`.

   Lokal genügt die Stripe CLI:

   ```bash
   stripe listen --forward-to 127.0.0.1:3001/api/stripe/webhook
   ```

   Das ausgegebene `whsec_…` gilt für diese CLI-Sitzung und wird
   `STRIPE_WEBHOOK_SECRET`. Im Dashboard-Endpoint dieselben Events abonnieren:
   `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`,
   `invoice.payment_failed`.
4. **`SMOKE_USER_ID`**: UUID eines **existierenden** Supabase-Nutzers
   (Authentication → Users). Der Webhook schreibt über
   `apply_subscription_state` eine Zeile in `subscriptions`, und die hat einen
   Fremdschlüssel auf das Profil. Eine erfundene UUID scheitert zu Recht.
   Am besten ein Wegwerf-Konto dafür nehmen.
5. **`APP_BASE_URL`**: nur fürs Skript, `http://127.0.0.1:3001`.

## Eintragen und starten

In `apps/dashboard/.env.local` ergänzen:

```
STRIPE_SECRET_KEY=sk_test_…
STRIPE_WEBHOOK_SECRET=whsec_…
STRIPE_PRICE_ID_BASE=price_…
STRIPE_PRICE_ID_PIHOLE=price_…
```

Danach den Dashboard-Server neu starten — die Webhook-Route liest beide Secrets
zur Laufzeit. `bun run check:env` zeigt anschließend „gesetzt" samt Quelle und
Länge, ohne den Wert auszugeben.

Aufruf (das Skript liest nur `process.env`, deshalb das `source`):

```bash
set -a; source apps/dashboard/.env.local; set +a
APP_BASE_URL=http://127.0.0.1:3001 SMOKE_USER_ID=<deine-uuid> bun run test:stripe
```

Erwartet: eine Folge von `PASS`-Zeilen und am Ende
„Alle Prüfungen bestanden (Stripe-Smoke-Test, …)". Fehlt das Webhook-Secret oder
die Nutzer-ID, meldet Stufe B `SKIP` statt eines Fehlschlags.

## Nebenwirkungen und Aufräumen

Stufe A räumt selbst auf (Session geschlossen, Kunde gelöscht). Stufe B
hinterlässt zwei Zeilen für `SMOKE_USER_ID`: einen Eintrag in `stripe_events`
und eine Subscription mit `sub_smoke_<zeitstempel>` und dem synthetischen Kunden
`cus_smoke_test`. Aufräumen im SQL-Editor des Projekts:

```sql
delete from public.subscriptions where stripe_subscription_id like 'sub_smoke_%';
delete from public.stripe_events where event_id like 'evt_smoke_%';
```

## Wenn etwas nicht läuft

| Symptom | Ursache |
|---|---|
| `Abbruch: Live-Key erkannt.` | Key stammt aus dem Livemodus — Testmodus-Key erzeugen |
| `Abbruch: … ist keine price_…-ID.` | Produkt-ID statt Preis-ID eingetragen |
| `401 … api_key_invalid` | Key vertauscht, abgelaufen oder aus einem anderen Konto |
| `No such price` | Preis gehört zu einem anderen Stripe-Konto als der Key |
| `SKIP Webhook: Route meldet STRIPE_NOT_CONFIGURED` (202) | Server läuft noch ohne Stripe-Env — neu starten |
| `Webhook akzeptiert gültige Signatur` schlägt fehl, Status 400 | Server hat ein anderes `STRIPE_WEBHOOK_SECRET` als der Aufruf (z. B. altes `whsec_` aus einer früheren `stripe listen`-Sitzung) |
| `PROCESSING_FAILED` / Status 500 | meist ein Fremdschlüssel- oder RPC-Problem — `SMOKE_USER_ID` prüfen, Migrationen 0001–0005 eingespielt? |

## Echter Rundlauf (optional)

Für den kompletten Weg Browser → Checkout → Webhook → Abo aktiv:

1. `NEXT_PUBLIC_APP_URL` setzen (z. B. `http://127.0.0.1:3001`). Der Wert landet
   im Browser-Bundle, deshalb ist danach ein `bun run build` nötig — ein
   Neustart allein reicht nicht.
2. `stripe listen --forward-to 127.0.0.1:3001/api/stripe/webhook` laufen lassen.
3. Im Dashboard anmelden, Abo starten, mit der Testkarte
   `4242 4242 4242 4242` (beliebiges zukünftiges Datum, beliebige CVC)
   abschließen.
4. Erwartet: `checkout.session.completed` und
   `customer.subscription.updated` in der CLI-Ausgabe; danach zeigt die
   Abo-Karte „aktiv" und `stripe_events` enthält beide Events mit gesetztem
   `processed_at`.
