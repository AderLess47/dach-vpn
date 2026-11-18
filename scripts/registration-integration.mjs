#!/usr/bin/env node
/**
 * Integrationstest: Geräteregistrierung ⇄ IPAM.
 *
 * Prüft, was die Route über die RPC `register_device` zusichert:
 *   1. Gerät und Adresse entstehen atomar (kein Gerät ohne IP, keine IP ohne Gerät)
 *   2. Erschöpfter Pool rollt das Gerät zurück
 *   3. Ein Retry mit demselben Public Key erzeugt nichts Neues
 *   4. Widerruf gibt die Adresse frei und leert assigned_ip
 *   5. Unter Nebenläufigkeit gibt es keine Doppelvergabe
 *   6. rebind_device_key prüft den Besitz selbst: per RPC aufgerufen lehnt sie
 *      fremde und unbekannte Geräte ab und lässt die Zeile unverändert
 *
 * Voraussetzung: erreichbares Postgres (siehe README).
 * ACHTUNG: setzt das Schema zurück. Nie gegen Produktion laufen lassen.
 */
import { Pool } from "pg";
import { createChecker, createTestUser, fakePublicKey, migrate } from "./lib/db-fixture.mjs";

// Zwei getrennte Knoten: Phase 5 braucht einen frischen Pool mit exakt 30
// Adressen, sonst zählt der Test Reste aus den Phasen davor mit.
const NODE_A = "eu-test-1";
const NODE_B = "eu-test-2";
const { check, finish } = createChecker();

async function register(
  executor,
  { userId, index, pihole = false, nodeId = NODE_A, maxDevices = 1000 },
) {
  const { rows } = await executor.query(
    "select * from public.register_device($1, $2, 'web', $3, $4, $5, $6)",
    [userId, `Gerät ${index}`, fakePublicKey(index), nodeId, pihole, maxDevices],
  );
  return rows[0];
}

async function countDevices(client) {
  const { rows } = await client.query("select count(*)::int as n from public.devices");
  return rows[0].n;
}

async function main() {
  const admin = await migrate();
  const userId = await createTestUser(admin);

  // --- 1. Atomare Anlage ---------------------------------------------------
  console.log("→ Registrierung vergibt Adresse und Gerät gemeinsam");
  await admin.query("select public.seed_ip_pool($1, '10.8.1.0/29'::cidr)", [NODE_A]); // 6 Hosts

  const registered = [];
  for (let i = 1; i <= 6; i += 1) {
    registered.push(await register(admin, { userId, index: i }));
  }
  check(registered.every((row) => row.assigned_ip), "Jede Registrierung liefert eine Adresse");
  check(
    new Set(registered.map((row) => row.assigned_ip)).size === 6,
    "Alle sechs Adressen sind verschieden",
  );
  check(await countDevices(admin) === 6, "Sechs Geräte in der Datenbank");

  const deviceRow = await admin.query(
    "select assigned_ip, status, node_id from public.devices where id = $1",
    [registered[0].device_id],
  );
  check(
    deviceRow.rows[0].assigned_ip === registered[0].assigned_ip,
    "devices.assigned_ip entspricht der Pool-Adresse",
  );

  // --- 2. Erschöpfter Pool rollt zurück ------------------------------------
  console.log("→ Erschöpfter Pool lässt kein Gerät zurück");
  const before = await countDevices(admin);
  let exhausted = null;
  try {
    await register(admin, { userId, index: 99 });
  } catch (error) {
    exhausted = error;
  }
  check(exhausted?.code === "P0001" && /IP_POOL_EXHAUSTED/.test(exhausted.message), "Siebte Registrierung scheitert mit IP_POOL_EXHAUSTED");
  check(await countDevices(admin) === before, `Geräteanzahl unverändert (${before}) — Insert wurde zurückgerollt`);

  // --- 3. Idempotenz -------------------------------------------------------
  console.log("→ Retry mit demselben Public Key erzeugt nichts Neues");
  const beforeRetry = await countDevices(admin);
  const retry = await register(admin, { userId, index: 1 });
  check(retry.reused === true, "Retry meldet reused=true");
  check(retry.device_id === registered[0].device_id, "Retry liefert dieselbe Geräte-ID");
  check(retry.assigned_ip === registered[0].assigned_ip, "Retry liefert dieselbe Adresse");
  check(await countDevices(admin) === beforeRetry, "Kein zusätzliches Gerät durch Retry");

  // --- 4. Widerruf gibt frei ----------------------------------------------
  console.log("→ Widerruf löst die Adresse");
  const revokedIp = registered[1].assigned_ip;
  const revoked = await admin.query("select public.revoke_device($1) as n", [registered[1].device_id]);
  check(Number(revoked.rows[0].n) === 1, "revoke_device gibt genau eine Adresse frei");

  const revokedDevice = await admin.query(
    "select status, assigned_ip, revoked_at from public.devices where id = $1",
    [registered[1].device_id],
  );
  check(
    revokedDevice.rows[0].status === "revoked" && revokedDevice.rows[0].assigned_ip === null && revokedDevice.rows[0].revoked_at !== null,
    "Gerät ist widerrufen, assigned_ip geleert, revoked_at gesetzt",
  );

  const poolEntry = await admin.query(
    "select state, device_id from public.ip_pool where address = $1 and node_id = $2",
    [revokedIp, NODE_A],
  );
  check(
    poolEntry.rows[0].state === "free" && poolEntry.rows[0].device_id === null,
    "Pool-Eintrag ist wieder frei und von keinem Gerät belegt",
  );

  const reuse = await register(admin, { userId, index: 7 });
  check(reuse.assigned_ip === revokedIp, `Neue Registrierung erhält die freigegebene Adresse (${revokedIp})`);

  // --- 5. Nebenläufigkeit --------------------------------------------------
  console.log("→ 40 parallele Registrierungen auf 30 Adressen (frischer Knoten)");
  await admin.query("select public.seed_ip_pool($1, '10.8.2.0/27'::cidr)", [NODE_B]); // 30 Hosts

  const concurrentUser = await createTestUser(admin, "concurrent@example.invalid");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 16 });

  const results = await Promise.all(
    Array.from({ length: 40 }, async (_, index) => {
      const client = await pool.connect();
      try {
        return {
          ok: true,
          ...(await register(client, {
            userId: concurrentUser,
            index: 1000 + index,
            nodeId: NODE_B,
          })),
        };
      } catch (error) {
        return { ok: false, code: error.code, message: error.message };
      } finally {
        client.release();
      }
    }),
  );

  const granted = results.filter((row) => row.ok);
  const rejected = results.filter((row) => !row.ok);
  check(granted.length === 30, `30 von 40 Registrierungen erfolgreich (${granted.length})`);
  check(
    new Set(granted.map((row) => row.assigned_ip)).size === granted.length,
    "Keine doppelte Adresse unter Nebenläufigkeit",
  );
  check(
    rejected.length === 10 && rejected.every((row) => row.code === "P0001"),
    "10 Registrierungen sauber abgelehnt (keine Constraint-Verletzung)",
  );

  // Nur aktive Geräte halten eine Adresse — widerrufene Geräte nicht.
  const activeOnB = await admin.query(
    "select count(*)::int as n from public.devices where node_id = $1 and status = 'active'",
    [NODE_B],
  );
  const assignedPool = await admin.query(
    "select count(*)::int as n from public.ip_pool where node_id = $1 and state = 'assigned'",
    [NODE_B],
  );
  check(
    activeOnB.rows[0].n === 30 && assignedPool.rows[0].n === 30,
    `Aktive Geräte und belegte Adressen stimmen überein (${activeOnB.rows[0].n} / ${assignedPool.rows[0].n})`,
  );

  // --- 6. Rebind-RPC schützt fremde Geräte ---------------------------------
  // Die Route prüft den Besitz schon, die Funktion muss es aber selbst tun:
  // ein Fehler in der Route darf keinen fremden Datensatz umschreiben.
  console.log("→ rebind_device_key lehnt fremde Geräte auch direkt per RPC ab");
  const target = registered[0];
  const stranger = await createTestUser(admin, "stranger@example.invalid");
  const ownerKey = fakePublicKey(201);

  const rebound = await admin.query("select * from public.rebind_device_key($1, $2, $3)", [
    userId,
    target.device_id,
    ownerKey,
  ]);
  check(
    rebound.rows[0]?.device_id === target.device_id && rebound.rows[0]?.assigned_ip === target.assigned_ip,
    "Eigener Schlüsselwechsel liefert dieselbe Geräte-ID und Adresse",
  );

  let foreignError = null;
  try {
    await admin.query("select * from public.rebind_device_key($1, $2, $3)", [
      stranger,
      target.device_id,
      fakePublicKey(202),
    ]);
  } catch (error) {
    foreignError = error;
  }
  check(
    foreignError?.code === "P0005" && /DEVICE_NOT_FOUND/.test(foreignError.message ?? ""),
    `Fremdes Gerät wird per RPC abgelehnt (${foreignError?.code ?? "kein Fehler"})`,
  );

  const untouched = await admin.query(
    "select public_key, assigned_ip, status from public.devices where id = $1",
    [target.device_id],
  );
  check(
    untouched.rows[0].public_key === ownerKey &&
      untouched.rows[0].assigned_ip === target.assigned_ip &&
      untouched.rows[0].status === "active",
    "Gerät bleibt unverändert (Key des Eigentümers, Adresse, Status)",
  );

  // Unbekannte IDs liefern dieselbe Antwort wie fremde — keine Sonde auf Geräte.
  let unknownError = null;
  try {
    await admin.query("select * from public.rebind_device_key($1, $2, $3)", [
      userId,
      "00000000-0000-0000-0000-000000000000",
      fakePublicKey(203),
    ]);
  } catch (error) {
    unknownError = error;
  }
  check(
    unknownError?.code === "P0005" && /DEVICE_NOT_FOUND/.test(unknownError.message ?? ""),
    `Unbekannte Geräte-ID wird identisch abgelehnt (${unknownError?.code ?? "kein Fehler"})`,
  );

  // Endnutzer kommen gar nicht erst an die Funktion (nur service_role).
  let roleError = null;
  await admin.query("begin");
  try {
    await admin.query("set local role authenticated");
    await admin.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: stranger, role: "authenticated" }),
    ]);
    await admin.query("select * from public.rebind_device_key($1, $2, $3)", [
      stranger,
      target.device_id,
      fakePublicKey(204),
    ]);
  } catch (error) {
    roleError = error;
  } finally {
    await admin.query("rollback");
  }
  check(
    roleError?.code === "42501",
    `rebind_device_key ist für Endnutzer gesperrt (${roleError?.code ?? "kein Fehler"})`,
  );

  await pool.end();
  await admin.end();
  finish("Registrierung ⇄ IPAM");
}

main().catch((error) => {
  console.error("Integrationstest abgebrochen:", error.message);
  process.exit(1);
});
