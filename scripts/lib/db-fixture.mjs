import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..", "..");

export const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@127.0.0.1:5432/postgres";

const SETUP_FILES = [
  "scripts/sql/auth_stub.sql",
  "supabase/migrations/20261117090001_init.sql",
  "supabase/migrations/20261117090002_ipam.sql",
  "supabase/migrations/20261117090003_register_device.sql",
  "supabase/migrations/20261117090004_auth_binding.sql",
  "supabase/migrations/20261117090005_stripe.sql",
  "supabase/migrations/20261117090006_ipam_host_addresses.sql",
];

/**
 * Setzt das Schema zurück und spielt Stub + alle Migrationen ein.
 * ACHTUNG: zerstört `public` und `auth`. Nie gegen Produktion richten.
 */
export async function migrate() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  await client.query("drop schema if exists public cascade");
  await client.query("drop schema if exists auth cascade");
  await client.query("create schema public");

  for (const file of SETUP_FILES) {
    const sql = await readFile(path.join(root, file), "utf8");
    await client.query(sql);
  }

  // In Supabase bringt das `public`-Schema diese Rechte mit; nach einem
  // DROP/CREATE im Test müssen wir sie nachziehen, sonst greift keine Policy.
  await client.query("grant usage on schema public to anon, authenticated, service_role");

  return client;
}

export function createChecker() {
  const state = { failures: 0 };

  function check(condition, message) {
    console.log(`${condition ? "PASS" : "FAIL"} ${message}`);
    if (!condition) state.failures += 1;
  }

  function finish(label) {
    console.log("");
    if (state.failures > 0) {
      console.error(`${state.failures} Prüfung(en) fehlgeschlagen (${label}).`);
      process.exit(1);
    }
    console.log(`Alle Prüfungen bestanden (${label}).`);
  }

  return { check, finish };
}

/** Legt einen Testnutzer in profil + auth an und gibt dessen UUID zurück. */
export async function createTestUser(client, email = "test@example.invalid") {
  const { rows } = await client.query(
    "insert into auth.users (email) values ($1) returning id",
    [email],
  );
  const userId = rows[0].id;
  // Seit Migration 0004 legt ein Trigger das Profil an; hier nur absichern.
  await client.query(
    "insert into public.profiles (user_id, email) values ($1, $2) on conflict (user_id) do nothing",
    [userId, email],
  );
  return userId;
}

/** Erzeugt einen formal gültigen (aber nicht benutzten) Public Key. */
export function fakePublicKey(index) {
  const raw = `dachvpn-test-key-${String(index).padStart(3, "0")}`;
  return Buffer.alloc(32, raw.slice(-32)).toString("base64");
}
