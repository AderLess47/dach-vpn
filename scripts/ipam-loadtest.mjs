#!/usr/bin/env node
/**
 * IPAM-Lasttest: prüft, dass die Advisory-Lock-Vergabe unter Nebenläufigkeit
 * keine Adresse doppelt ausgibt und bei Erschöpfung sauber ablehnt.
 *
 * Voraussetzung: erreichbares Postgres (lokal via Docker oder CI-Service).
 *   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres
 *
 * Der Test setzt das Schema `public` zurück. Niemals gegen Produktion laufen lassen.
 */
import { Pool } from "pg";
import { DATABASE_URL, createChecker, createTestUser, migrate } from "./lib/db-fixture.mjs";

const NODE_ID = "eu-test-1";
const CIDR = "10.8.0.0/27"; // 30 nutzbare Adressen
const USABLE = 30;
const CONCURRENCY = 120;

const { check, finish } = createChecker();

async function main() {
  console.log("→ Setze Schema zurück und spiele Migrationen ein");
  const admin = await migrate();

  const seeded = await admin.query("select public.seed_ip_pool($1, $2::cidr) as n", [
    NODE_ID,
    CIDR,
  ]);
  check(Number(seeded.rows[0].n) === USABLE, `Pool mit ${USABLE} Adressen befüllt (${seeded.rows[0].n})`);

  const reseed = await admin.query("select public.seed_ip_pool($1, $2::cidr) as n", [
    NODE_ID,
    CIDR,
  ]);
  check(Number(reseed.rows[0].n) === 0, "Seed ist idempotent (zweiter Lauf fügt nichts hinzu)");

  // --- Nebenläufigkeit ----------------------------------------------------
  console.log(`→ ${CONCURRENCY} parallele Vergaben auf ${USABLE} Adressen`);
  const pool = new Pool({ connectionString: DATABASE_URL, max: 16 });

  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      const client = await pool.connect();
      try {
        const { rows } = await client.query("select public.allocate_ip($1) as ip", [NODE_ID]);
        return { ok: true, ip: rows[0].ip };
      } catch (error) {
        return { ok: false, code: error.code, message: error.message };
      } finally {
        client.release();
      }
    }),
  );

  const granted = results.filter((r) => r.ok);
  const rejected = results.filter((r) => !r.ok);
  const uniqueIps = new Set(granted.map((r) => r.ip));

  check(granted.length === USABLE, `Genau ${USABLE} Vergaben erfolgreich (${granted.length})`);
  check(uniqueIps.size === granted.length, `Keine Doppelvergabe (${uniqueIps.size} eindeutige von ${granted.length})`);
  check(
    rejected.length === CONCURRENCY - USABLE,
    `${CONCURRENCY - USABLE} Anfragen abgelehnt (${rejected.length})`,
  );
  check(
    rejected.every((r) => r.code === "P0001" && /IP_POOL_EXHAUSTED/.test(r.message)),
    "Ablehnungen sind IP_POOL_EXHAUSTED (kein Constraint-Fehler)",
  );

  const state = await admin.query(
    "select count(*) filter (where state = 'assigned') as assigned, count(*) as total from public.ip_pool",
  );
  check(
    Number(state.rows[0].assigned) === USABLE && Number(state.rows[0].total) === USABLE,
    `Pool-Zustand konsistent (${state.rows[0].assigned}/${state.rows[0].total} belegt)`,
  );

  // --- Idempotenz je Gerät ------------------------------------------------
  console.log("→ Idempotenz, Freigabe und Widerruf");
  await admin.query(
    "update public.ip_pool set state = 'free', device_id = null, assigned_at = null",
  );
  const userId = await createTestUser(admin, "ipam-test@example.invalid");
  const deviceId = (
    await admin.query(
      `insert into public.devices (user_id, name, platform, public_key, node_id)
       values ($1, 'IPAM-Test', 'web', $2, $3) returning id`,
      [userId, "IPk3z9pQ1sV7mR2tL8xN4wJ6hD0fG5cB1aZ9uK3eP7o=", NODE_ID],
    )
  ).rows[0].id;

  const first = (await admin.query("select public.allocate_ip($1, $2) as ip", [NODE_ID, deviceId])).rows[0].ip;
  const second = (await admin.query("select public.allocate_ip($1, $2) as ip", [NODE_ID, deviceId])).rows[0].ip;
  check(first === second, `Zweite Vergabe für dasselbe Gerät liefert dieselbe Adresse (${first})`);

  const released = await admin.query("select public.release_ip($1) as n", [deviceId]);
  check(Number(released.rows[0].n) === 1, "release_ip gibt genau eine Adresse frei");

  const afterRelease = await admin.query(
    "select count(*)::int as n from public.ip_pool where device_id = $1",
    [deviceId],
  );
  check(afterRelease.rows[0].n === 0, "Nach Freigabe hält das Gerät keine Adresse mehr");

  await admin.query("select public.allocate_ip($1, $2)", [NODE_ID, deviceId]);
  const revoked = await admin.query("select public.revoke_device($1) as n", [deviceId]);
  const device = await admin.query("select status from public.devices where id = $1", [deviceId]);
  const freedOnRevoke = await admin.query(
    "select count(*)::int as n from public.ip_pool where device_id = $1",
    [deviceId],
  );
  check(
    Number(revoked.rows[0].n) === 1 && device.rows[0].status === "revoked" && freedOnRevoke.rows[0].n === 0,
    "revoke_device widerruft das Gerät und gibt die Adresse frei",
  );

  await pool.end();
  await admin.end();

  finish("IPAM");
}

main().catch((error) => {
  console.error("Lasttest abgebrochen:", error.message);
  process.exit(1);
});
