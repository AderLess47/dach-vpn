#!/usr/bin/env node
/**
 * Zugangs-Gate (Migration 0009): Geräte nur mit Abo, Pi-hole nur mit Add-on.
 *
 * Geprüft wird:
 * - ohne Abo, mit `incomplete` und mit `canceled` entsteht kein Gerät und keine
 *   Pool-Adresse (kein Verbrauch durch abgelehnte Versuche),
 * - `past_due` erhält Kulanz-Zugang,
 * - das Pi-hole-Add-on wird serverseitig erzwungen, nicht nur in der UI,
 * - ein abbestelltes Add-on setzt `pihole_enabled` bestehender Geräte zurück,
 * - der Schlüsselwechsel hängt am selben Gate, der Besitz wird aber zuerst
 *   geprüft (fremde Geräte bleiben DEVICE_NOT_FOUND),
 * - Widerruf und idempotenter Retry funktionieren weiterhin ohne Abo.
 *
 * ACHTUNG: setzt das Schema zurück. Nie gegen Produktion laufen lassen.
 */
import { createChecker, createTestUser, fakePublicKey, migrate } from "./lib/db-fixture.mjs";

const NODE = "eu-ent-1";
const { check, finish } = createChecker();

async function register(db, userId, index, pihole = false) {
  const { rows } = await db.query(
    "select * from public.register_device($1, $2, 'web', $3, $4, $5, 20)",
    [userId, `Gerät ${index}`, fakePublicKey(index), NODE, pihole],
  );
  return rows[0];
}

async function subscribe(db, userId, status, pihole = false) {
  await db.query(
    "select * from public.apply_subscription_state($1, $2, $3, $4, $5, null, false)",
    [userId, `cus_${userId.slice(0, 8)}`, `sub_${userId.slice(0, 8)}`, status, pihole],
  );
}

async function failure(fn) {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
}

async function main() {
  const db = await migrate();
  await db.query("select public.seed_ip_pool($1, '10.8.7.0/27'::cidr)", [NODE]);

  const deviceCount = async () =>
    (await db.query("select count(*)::int as n from public.devices")).rows[0].n;
  const assignedCount = async () =>
    (await db.query("select count(*)::int as n from public.ip_pool where state = 'assigned'"))
      .rows[0].n;

  // --- 1. Ohne Abo ---------------------------------------------------------
  const noSub = await createTestUser(db, "nosub@example.invalid");
  const required = await failure(() => register(db, noSub, 1));
  check(
    required?.code === "P0006" && /SUBSCRIPTION_REQUIRED/.test(required.message),
    `Ohne Abo → SUBSCRIPTION_REQUIRED (${required?.code ?? "kein Fehler"})`,
  );
  check(
    (await deviceCount()) === 0 && (await assignedCount()) === 0,
    "Ohne Abo entsteht weder Gerät noch Adresse",
  );

  // --- 2. Unbezahlt und beendet -------------------------------------------
  const incomplete = await createTestUser(db, "incomplete@example.invalid");
  await subscribe(db, incomplete, "incomplete");
  const incompleteError = await failure(() => register(db, incomplete, 2));
  check(
    incompleteError?.code === "P0006",
    `Status incomplete ist gesperrt (${incompleteError?.code ?? "kein Fehler"})`,
  );

  const canceled = await createTestUser(db, "canceled@example.invalid");
  await subscribe(db, canceled, "canceled");
  const canceledError = await failure(() => register(db, canceled, 3));
  check(
    canceledError?.code === "P0006",
    `Status canceled ist gesperrt (${canceledError?.code ?? "kein Fehler"})`,
  );

  // --- 3. Kulanz bei past_due ---------------------------------------------
  const pastDue = await createTestUser(db, "pastdue@example.invalid");
  await subscribe(db, pastDue, "past_due");
  const grace = await register(db, pastDue, 4);
  check(Boolean(grace.assigned_ip), `past_due erhält Kulanz-Zugang (${grace.assigned_ip})`);

  // --- 4. Add-on erzwungen -------------------------------------------------
  const noAddon = await createTestUser(db, "noaddon@example.invalid");
  await subscribe(db, noAddon, "active", false);
  const beforeAddonAttempt = await deviceCount();

  const addonError = await failure(() => register(db, noAddon, 5, true));
  check(
    addonError?.code === "P0007" && /ADDON_NOT_BOOKED/.test(addonError.message),
    `Pi-hole ohne Buchung → ADDON_NOT_BOOKED (${addonError?.code ?? "kein Fehler"})`,
  );
  check(
    (await deviceCount()) === beforeAddonAttempt,
    "Abgelehntes Add-on legt kein Gerät an",
  );

  const plain = await register(db, noAddon, 6, false);
  check(Boolean(plain.assigned_ip), "Ohne Pi-hole klappt die Registrierung im Basis-Abo");

  // --- 5. Gebuchtes Add-on -------------------------------------------------
  const withAddon = await createTestUser(db, "addon@example.invalid");
  await subscribe(db, withAddon, "active", true);
  const filtered = await register(db, withAddon, 7, true);
  const filteredRow = await db.query(
    "select pihole_enabled from public.devices where id = $1",
    [filtered.device_id],
  );
  check(
    filteredRow.rows[0].pihole_enabled === true,
    "Gebuchtes Add-on erlaubt Pi-hole am Gerät",
  );

  // --- 6. Add-on abbestellt ------------------------------------------------
  await subscribe(db, withAddon, "active", false);
  const afterCancel = await db.query(
    "select pihole_enabled from public.devices where id = $1",
    [filtered.device_id],
  );
  check(
    afterCancel.rows[0].pihole_enabled === false,
    "Abbestelltes Add-on setzt pihole_enabled des Geräts zurück",
  );

  // --- 7. Schlüsselwechsel am selben Gate ----------------------------------
  const rebound = await db.query(
    "select * from public.rebind_device_key($1, $2, $3)",
    [withAddon, filtered.device_id, fakePublicKey(8)],
  );
  check(
    rebound.rows[0]?.device_id === filtered.device_id,
    "Aktives Abo darf den Schlüssel wechseln",
  );

  await subscribe(db, withAddon, "canceled");
  const rebindBlocked = await failure(() =>
    db.query("select * from public.rebind_device_key($1, $2, $3)", [
      withAddon,
      filtered.device_id,
      fakePublicKey(9),
    ]),
  );
  check(
    rebindBlocked?.code === "P0006",
    `Ohne Abo kein Schlüsselwechsel (${rebindBlocked?.code ?? "kein Fehler"})`,
  );

  // --- 8. Besitzprüfung bleibt vor dem Gate --------------------------------
  const stranger = await createTestUser(db, "stranger@example.invalid");
  await subscribe(db, stranger, "active");
  const foreign = await failure(() =>
    db.query("select * from public.rebind_device_key($1, $2, $3)", [
      stranger,
      filtered.device_id,
      fakePublicKey(10),
    ]),
  );
  check(
    foreign?.code === "P0005",
    `Fremdes Gerät bleibt DEVICE_NOT_FOUND (${foreign?.code ?? "kein Fehler"})`,
  );

  // --- 9. Widerruf bleibt ohne Abo möglich ---------------------------------
  const revoked = await db.query("select public.revoke_device($1) as n", [
    filtered.device_id,
  ]);
  check(Number(revoked.rows[0].n) === 1, "Widerruf funktioniert auch ohne Abo");

  // --- 10. Idempotenter Retry nach Ablauf ----------------------------------
  await subscribe(db, pastDue, "canceled");
  const retry = await register(db, pastDue, 4);
  check(
    retry.reused === true && retry.device_id === grace.device_id,
    "Retry mit bestehendem Key bleibt idempotent, auch ohne Abo",
  );

  // --- 11. Keine verwaisten Adressen ---------------------------------------
  const withIp = await db.query(
    "select count(*)::int as n from public.devices where assigned_ip is not null",
  );
  check(
    withIp.rows[0].n === (await assignedCount()),
    `Jede vergebene Adresse gehört zu einem Gerät (${withIp.rows[0].n} / ${await assignedCount()})`,
  );

  await db.end();
  finish("Zugangs-Gate");
}

main().catch((error) => {
  console.error("Gate-Test abgebrochen:", error.message);
  process.exit(1);
});
