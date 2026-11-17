#!/usr/bin/env node
/**
 * Abo-Zustand aus Stripe (Migration 0005).
 *
 * Prüft: Upsert der Subscription, Erhalt von Kunden-ID und Periodenende bei
 * Updates ohne diese Werte, Sperren für Endnutzer (stripe_events, RPC,
 * admin_metrics) und die Aggregate der Admin-Funktion.
 *
 * Setzt das Schema `public` zurück — nie gegen eine echte Datenbank richten.
 */
import { Client } from "pg";
import {
  DATABASE_URL,
  createChecker,
  createTestUser,
  migrate,
} from "./lib/db-fixture.mjs";

const { check, finish } = createChecker();

async function main() {
  console.log("→ Setze Schema zurück und spiele Migrationen ein");
  const admin = await migrate();
  const userId = await createTestUser(admin, "abo@example.invalid");

  console.log("→ Abo anlegen");
  const created = (
    await admin.query(
      "select * from public.apply_subscription_state($1, $2, $3, $4, $5, $6, $7)",
      [userId, "cus_test_1", "sub_test_1", "active", true, "2026-12-17T00:00:00Z", false],
    )
  ).rows[0];

  check(created.status === "active", `Status active gesetzt (${created.status})`);
  check(created.pihole_addon_active === true, "Pi-hole Add-on übernommen");
  check(created.stripe_customer_id === "cus_test_1", "Stripe-Customer gespeichert");
  check(created.stripe_subscription_id === "sub_test_1", "Subscription-ID gespeichert");
  check(
    new Date(created.current_period_end).getTime() === new Date("2026-12-17T00:00:00Z").getTime(),
    "Periodenende gespeichert",
  );

  console.log("→ Update ohne Kunden-ID und Periodenende");
  const updated = (
    await admin.query(
      "select * from public.apply_subscription_state($1, $2, $3, $4, $5, $6, $7)",
      [userId, null, "sub_test_1", "past_due", false, null, true],
    )
  ).rows[0];

  check(updated.status === "past_due", `Status auf past_due gewechselt (${updated.status})`);
  check(updated.pihole_addon_active === false, "Add-on deaktiviert");
  check(updated.cancel_at_period_end === true, "Kündigung zum Periodenende vermerkt");
  check(updated.stripe_customer_id === "cus_test_1", "Kunden-ID bleibt erhalten");
  check(
    new Date(updated.current_period_end).getTime() === new Date("2026-12-17T00:00:00Z").getTime(),
    "Periodenende bleibt erhalten",
  );

  console.log("→ Admin-Kennzahlen");
  const metrics = (await admin.query("select public.admin_metrics() as m")).rows[0].m;
  check(metrics.subscriptions.pastDue === 1, "Genau ein zahlungsverzugenes Abo gezählt");
  check(metrics.subscriptions.active === 0, "Kein aktives Abo gezählt");
  check(metrics.devices.active === 0 && metrics.devices.revoked === 0, "Gerätezähler leer");
  check(metrics.nodes !== null, "Knoten-Aggregat vorhanden (auch leer)");

  console.log("→ Endnutzer-Sperren");
  const asUser = new Client({ connectionString: DATABASE_URL });
  await asUser.connect();
  try {
    await asUser.query("begin");
    await asUser.query("set local role authenticated");
    await asUser.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ]);

    // Jede Prüfung in einem eigenen Savepoint: ein Rechtefehler bricht sonst die
    // gesamte Transaktion ab und die folgenden Prüfungen liefern 25P02.
    const events = await lockedQuery(asUser, "select count(*) from public.stripe_events");
    check(events.code === "42501", `stripe_events für Endnutzer gesperrt (${events.code})`);

    const rpc = await lockedQuery(
      asUser,
      "select public.apply_subscription_state($1,$2,$3,$4,$5,$6,$7)",
      [userId, "cus_x", "sub_x", "active", true, null, false],
    );
    check(rpc.code === "42501", `apply_subscription_state für Endnutzer gesperrt (${rpc.code})`);

    const adminCall = await lockedQuery(asUser, "select public.admin_metrics()");
    check(adminCall.code === "42501", `admin_metrics für Endnutzer gesperrt (${adminCall.code})`);

    await asUser.query("rollback");
  } finally {
    await asUser.end();
  }

  await admin.end();
  finish("Abo-Zustand aus Stripe");
}

async function lockedQuery(client, sql, params = []) {
  await client.query("savepoint sp");
  try {
    await client.query(sql, params);
    await client.query("release savepoint sp");
    return { code: "erlaubt" };
  } catch (error) {
    await client.query("rollback to savepoint sp");
    return { code: error?.code ?? "unbekannt" };
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
