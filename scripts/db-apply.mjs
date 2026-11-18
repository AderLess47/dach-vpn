#!/usr/bin/env node
/**
 * Wendet supabase/migrations/*.sql in Reihenfolge an.
 *
 * - Prüft vorab die Verbindung und die Rolle.
 * - Führt jede Datei in einer eigenen Transaktion aus; bei Fehler wird genau
 *   diese Datei zurückgerollt und der Lauf endet mit ihrem Namen.
 * - Merkt sich angewandte Versionen in `supabase_migrations.schema_migrations`,
 *   damit ein zweiter Lauf nichts doppelt ausführt.
 *
 * Aufruf: bun run db:apply
 */
import { readFileSync, readdirSync } from "node:fs";
import { Client } from "pg";

function readEnv() {
  const text = readFileSync("apps/dashboard/.env.local", "utf8");
  const env = {};
  for (const line of text.split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

const env = readEnv();
const connectionString = process.env.DATABASE_URL ?? env.DATABASE_URL ?? "";

if (!connectionString) {
  console.log("DATABASE_URL fehlt (weder in apps/dashboard/.env.local noch in der Umgebung).");
  process.exit(2);
}

const files = readdirSync("supabase/migrations")
  .filter((name) => name.endsWith(".sql"))
  .sort();

if (files.length === 0) {
  console.log("Keine Migrationen gefunden.");
  process.exit(2);
}

const client = new Client({
  connectionString,
  ssl: { rejectUnauthorized: false },
  application_name: "dachvpn-db-apply",
});

let applied = 0;
let skipped = 0;

async function main() {
  await client.connect();

  const who = await client.query("select current_user as user, current_database() as db, version() as server");
  console.log(`Verbunden als ${who.rows[0].user} auf ${who.rows[0].db} (${who.rows[0].server.split(" ").slice(0, 2).join(" ")})`);

  await client.query("create schema if not exists supabase_migrations");
  await client.query(`
    create table if not exists supabase_migrations.schema_migrations (
      version text primary key,
      name text not null,
      applied_at timestamptz not null default now()
    )
  `);

  const done = new Set(
    (await client.query("select version from supabase_migrations.schema_migrations")).rows.map((row) => row.version),
  );

  for (const file of files) {
    const version = file.split("_")[0];
    if (done.has(version)) {
      console.log(`SKIP ${file}`);
      skipped += 1;
      continue;
    }

    const sql = readFileSync(`supabase/migrations/${file}`, "utf8");
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query(
        "insert into supabase_migrations.schema_migrations (version, name) values ($1, $2)",
        [version, file],
      );
      await client.query("commit");
      console.log(`OK   ${file}`);
      applied += 1;
    } catch (error) {
      await client.query("rollback");
      console.log(`FAIL ${file}`);
      console.log(`     ${error instanceof Error ? error.message : error}`);
      throw error;
    }
  }

  const tables = await client.query(`
    select table_name
    from information_schema.tables
    where table_schema = 'public'
    order by table_name
  `);
  console.log(`\nTabellen in public (${tables.rows.length}): ${tables.rows.map((row) => row.table_name).join(", ")}`);

  const policies = await client.query(`
    select count(*)::int as n from pg_policies where schemaname = 'public'
  `);
  console.log(`RLS-Policies in public: ${policies.rows[0].n}`);

  console.log(`\nErgebnis: ${applied} Migration(en) angewandt, ${skipped} übersprungen.`);
}

main()
  .then(async () => {
    await client.end();
    process.exit(0);
  })
  .catch(async (error) => {
    await client.end().catch(() => {});
    console.error(`\nAbbruch: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
