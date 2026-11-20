#!/usr/bin/env node
/**
 * RLS-Test: Gerätebindung und Mandantentrennung.
 *
 * Läuft als `authenticated` mit gesetzten JWT-Claims — also so, wie Supabase
 * einen Browser-Request ausführt. Geprüft wird, dass ein Konto ausschließlich
 * seine eigenen Geräte sieht und schreiben kann.
 *
 * ACHTUNG: setzt das Schema zurück. Nie gegen Produktion laufen lassen.
 */
import { createChecker, createTestUser, fakePublicKey, migrate } from "./lib/db-fixture.mjs";

const NODE = "eu-rls-1";
const { check, finish } = createChecker();

/**
 * Seit Migration 0009 verlangt register_device ein laufendes Abo. Der Test
 * registriert Geräte für drei Konten, also braucht jedes eines.
 */
async function grantSubscription(db, userId, { pihole = false } = {}) {
  await db.query(
    "select * from public.apply_subscription_state($1, $2, $3, 'active', $4, null, false)",
    [userId, `cus_${userId.slice(0, 8)}`, `sub_${userId.slice(0, 8)}`, pihole],
  );
}

async function main() {
  const db = await migrate();

  const userA = await createTestUser(db, "alice@example.invalid");
  const userB = await createTestUser(db, "bob@example.invalid");
  await grantSubscription(db, userA, { pihole: true });
  await grantSubscription(db, userB);

  // --- Profil-Trigger ------------------------------------------------------
  const profiles = await db.query(
    "select user_id from public.profiles where user_id = any($1::uuid[])",
    [[userA, userB]],
  );
  check(profiles.rowCount === 2, "Trigger legt für jeden auth.users-Eintrag ein Profil an");

  // --- Testdaten (service-Kontext, umgeht RLS) -----------------------------
  await db.query("select public.seed_ip_pool($1, '10.8.9.0/29'::cidr)", [NODE]);
  await db.query(
    "select public.register_device($1, 'Alice-TV', 'web', $2, $3, false, 10)",
    [userA, fakePublicKey(1), NODE],
  );
  await db.query(
    "select public.register_device($1, 'Bob-TV', 'web', $2, $3, false, 10)",
    [userB, fakePublicKey(2), NODE],
  );
  // Das Abo von Alice entsteht oben bereits (Migration 0009 verlangt es vor der
  // Registrierung); hier ist nichts nachzuziehen.

  /** Führt eine Funktion in einer Transaktion als `authenticated` mit JWT-Sub aus. */
  async function asUser(userId, fn) {
    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: userId, role: "authenticated" }),
      ]);
      return await fn();
    } finally {
      await db.query("rollback");
    }
  }

  /** Erwartet einen Fehler und macht die Transaktion per Savepoint weiter nutzbar. */
  async function expectError(fn) {
    await db.query("savepoint sp");
    try {
      await fn();
      await db.query("release savepoint sp");
      return null;
    } catch (error) {
      await db.query("rollback to savepoint sp");
      return error;
    }
  }

  // --- Lesen ---------------------------------------------------------------
  await asUser(userA, async () => {
    const own = await db.query("select count(*)::int as n from public.devices");
    check(own.rows[0].n === 1, `Alice sieht genau ihr Gerät (${own.rows[0].n})`);

    const foreign = await db.query(
      "select count(*)::int as n from public.devices where user_id = $1",
      [userB],
    );
    check(foreign.rows[0].n === 0, "Alice sieht Bobs Gerät nicht");

    const subs = await db.query("select count(*)::int as n from public.subscriptions");
    check(subs.rows[0].n === 1, "Alice sieht ihr Abo");

    let poolRows = null;
    const poolError = await expectError(async () => {
      const result = await db.query("select count(*)::int as n from public.ip_pool");
      poolRows = result.rows[0].n;
    });
    check(
      poolError?.code === "42501" || poolRows === 0,
      `ip_pool ist für Endnutzer nicht lesbar (${poolError ? `Fehler ${poolError.code}` : `${poolRows} Zeilen`})`,
    );
  });

  // --- Schreiben -----------------------------------------------------------
  await asUser(userA, async () => {
    const ownInsert = await expectError(() =>
      db.query(
        `insert into public.devices (user_id, name, platform, public_key)
         values ($1, 'Alice-Phone', 'ios', $2)`,
        [userA, fakePublicKey(11)],
      ),
    );
    check(ownInsert === null, "Alice darf ein eigenes Gerät anlegen");

    const foreignInsert = await expectError(() =>
      db.query(
        `insert into public.devices (user_id, name, platform, public_key)
         values ($1, 'Fremd', 'web', $2)`,
        [userB, fakePublicKey(12)],
      ),
    );
    check(
      foreignInsert?.code === "42501",
      `Insert für fremdes Konto wird von RLS abgewiesen (${foreignInsert?.code ?? "kein Fehler"})`,
    );

    const foreignUpdate = await db.query(
      "update public.devices set name = 'gekapert' where user_id = $1",
      [userB],
    );
    check(foreignUpdate.rowCount === 0, "Update auf fremdes Gerät trifft keine Zeile");

    const foreignDelete = await db.query("delete from public.devices where user_id = $1", [userB]);
    check(foreignDelete.rowCount === 0, "Delete auf fremdes Gerät trifft keine Zeile");
  });

  // --- RPC bleibt dem Server vorbehalten -----------------------------------
  await asUser(userA, async () => {
    const rpc = await expectError(() =>
      db.query("select public.register_device($1, 'x', 'web', $2, $3)", [
        userA,
        fakePublicKey(13),
        NODE,
      ]),
    );
    check(
      rpc?.code === "42501",
      `register_device ist für Endnutzer gesperrt (${rpc?.code ?? "kein Fehler"})`,
    );
  });

  // --- Service-Rolle sieht alles ------------------------------------------
  await db.query("begin");
  await db.query("set local role service_role");
  const all = await db.query("select count(*)::int as n from public.devices");
  await db.query("rollback");
  check(all.rows[0].n >= 2, `service_role sieht alle Geräte (${all.rows[0].n})`);

  // --- Gerätelimit ---------------------------------------------------------
  const userC = await createTestUser(db, "carol@example.invalid");
  await grantSubscription(db, userC);
  const limited = [];
  for (let i = 1; i <= 2; i += 1) {
    await db.query("select public.register_device($1, $2, 'web', $3, $4, false, 2)", [
      userC,
      `C-${i}`,
      fakePublicKey(20 + i),
      NODE,
    ]);
    limited.push(i);
  }
  let limitError = null;
  try {
    await db.query("select public.register_device($1, 'C-3', 'web', $2, $3, false, 2)", [
      userC,
      fakePublicKey(23),
      NODE,
    ]);
  } catch (error) {
    limitError = error;
  }
  check(
    limitError?.code === "P0003" && /DEVICE_LIMIT_REACHED/.test(limitError.message),
    "Drittes Gerät bei Limit 2 wird mit DEVICE_LIMIT_REACHED abgelehnt",
  );

  // --- Fremder Public Key ------------------------------------------------
  let conflictError = null;
  try {
    await db.query("select public.register_device($1, 'Fremd-Key', 'web', $2, $3, false, 10)", [
      userC,
      fakePublicKey(1),
      NODE,
    ]);
  } catch (error) {
    conflictError = error;
  }
  check(
    conflictError?.code === "P0004",
    `Public Key eines anderen Kontos wird abgelehnt (${conflictError?.code ?? "kein Fehler"})`,
  );

  await db.end();
  finish("RLS & Gerätebindung");
}

main().catch((error) => {
  console.error("RLS-Test abgebrochen:", error.message);
  process.exit(1);
});
