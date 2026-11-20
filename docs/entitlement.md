# Zugangs-Gate: Abo und Pi-hole-Add-on

Seit Migration `20261120090009_entitlement_gate.sql` setzt der VPN-Zugang ein
laufendes Abo voraus. Die Regel liegt **in der Datenbank**, nicht in der
Oberfläche — die UI erklärt sie nur.

## Statusmatrix

| `subscriptions.status` | Gerät registrieren | Schlüssel wechseln | Pi-hole-Add-on |
|---|---|---|---|
| `active` | ja | ja | nur mit gebuchtem Add-on |
| `past_due` | ja (Kulanz) | ja (Kulanz) | nur mit gebuchtem Add-on |
| `incomplete` | nein | nein | nein |
| `canceled` | nein | nein | nein |
| keine Zeile | nein | nein | nein |

**Warum `past_due` Kulanz hat:** Stripe mahnt nach einer fehlgeschlagenen Zahlung
weiter und kündigt erst danach (`canceled`). Ein sofortiger Cutoff beim ersten
Fehlschlag würde zahlende Kunden für ein Problem bestrafen, das Stripe selbst
noch einzusammeln versucht. Wer strenger sein will, ändert genau eine Zeile — in
der Migration **und** in `packages/shared/src/entitlement.ts`:

```sql
if v_status is null or v_status <> 'active' then
```

```ts
export const ENTITLED_SUBSCRIPTION_STATUSES = ["active"] as const;
```

## Fehlercodes

| Code | HTTP | Bedeutung |
|---|---|---|
| `SUBSCRIPTION_REQUIRED` | 403 | kein `active`/`past_due`-Abo (SQL: `P0006`) |
| `ADDON_NOT_BOOKED` | 403 | `piholeEnabled: true` ohne gebuchtes Add-on (SQL: `P0007`) |

Beide Codes werden von der Next.js-Route, der Edge Function und dem
Dashboard gleich behandelt; die Meldungen sind bewusst handlungsorientiert
(„aktives Abo erforderlich", „Add-on nicht gebucht").

## Was das Gate schützt — und was nicht

**Geschützt:** jede *neue* Geräteregistrierung und jeder Schlüsselwechsel.
Ohne Abo entsteht kein Gerät und keine Pool-Adresse; ein abgelehnter Versuch
verbraucht nichts (die Prüfung läuft vor dem Insert, innerhalb derselben
Transaktion).

**Nicht geschützt:** bereits ausgegebene WireGuard-Konfigurationen. Wer sein
Abo kündigt, behält den Tunnel, bis der Knoten den Peer entfernt — das kann erst
der Pull-Agent (M2) über den Soll-Zustand. Bis dahin ist das Gate eine
*Neuzugangs*-Sperre, keine Abschaltung. Das ist bewusst dokumentiert, damit
niemand die Wirkung überschätzt.

**Add-on:** Wird das Add-on abbestellt, setzt ein Trigger
(`subscriptions_sync_device_addon`) `devices.pihole_enabled` für alle Geräte des
Kontos auf `false`. Sonst zeigte eine neu erzeugte Config weiter DNS
`10.9.0.1`, obwohl der Filter nicht mehr bezahlt ist.

**Widerruf** bleibt ohne Abo möglich: Wer nicht zahlt, muss sein Gerät trotzdem
löschen können.

**Idempotenz:** Ein Retry mit demselben Public Key liefert das bestehende Gerät
zurück, auch wenn das Abo inzwischen abgelaufen ist. Sonst würde ein Reload im
Dashboard „Abo fehlt" zeigen, obwohl das Gerät längst existiert — und der Client
könnte seine Adresse nicht mehr anzeigen.

## Tests

```bash
bun run test:entitlement   # Teil von test:db
```

Geprüft werden: Sperre ohne Abo/`incomplete`/`canceled`, Kulanz bei `past_due`,
Add-on-Zwang inklusive unverbrauchter Adresse, Rücksetzen von `pihole_enabled`,
Schlüsselwechsel am Gate, Besitzprüfung vor dem Gate, Widerruf ohne Abo und der
idempotente Retry. Die Route-Seite deckt `scripts/auth-route-e2e.mjs` ab
(403-Codes gegen einen echten Supabase-Stack).

## Offen

- **Abbruch bei Ablauf:** braucht den Agenten (M2), der Peers und nftables-
  Regeln entfernt; heute bleibt eine bestehende Config gültig.
- **Stripe-Abgleich:** Fehlt ein Webhook, bleibt der Status stehen. Ein
  periodischer Abgleich gegen Stripe wäre die Reparatur (nicht implementiert).
- **Grace-Dauer:** `past_due` gilt unbegrenzt, bis Stripe `canceled` meldet.
  Stripe konfiguriert die Mahnstufen; wir übernehmen das Ergebnis.
