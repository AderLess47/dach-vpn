#!/usr/bin/env node
/**
 * Mandanten-Registry (White-Label): Domain → Marke.
 *
 * Geprüft wird, was die Laufzeit-Auflösung im Dashboard braucht:
 * - `resolve_tenant_brand()` liefert die Marke, auch bei anderer Schreibweise,
 * - unbekannte Domains liefern NULL (die App fällt dann auf Env/Default zurück),
 * - Endnutzer (`authenticated`, `anon`) kommen weder an die Tabellen noch an die
 *   Funktion — die Mandantenliste ist nicht enumerierbar,
 * - Constraints halten ungültige Slugs/Domains und Duplikate draußen,
 * - das Löschen eines Mandanten räumt seine Domains ab.
 *
 * ACHTUNG: setzt das Schema zurück. Nie gegen Produktion laufen lassen.
 */
import { createChecker, migrate } from "./lib/db-fixture.mjs";

const { check, finish } = createChecker();

async function main() {
  const db = await migrate();

  const acmeRows = await db.query(
    `insert into public.tenants (slug, name, tagline)
     values ('acme-vpn', 'Acme VPN', 'Streaming ohne Umwege')
     returning id`,
  );
  const acme = acmeRows.rows[0].id;

  await db.query("insert into public.tenants (slug, name) values ('tv-guard', 'TV Guard')");
  await db.query(
    `insert into public.tenant_domains (domain, tenant_id)
     values ('tv.acme.example', $1), ('tv.example.net', $1)`,
    [acme],
  );

  /** Führt eine Abfrage in einer Transaktion unter der angegebenen Rolle aus. */
  async function asRole(role, fn) {
    await db.query("begin");
    try {
      await db.query(`set local role ${role}`);
      return await fn();
    } finally {
      await db.query("rollback");
    }
  }

  /** Erwartet einen Fehler und hält die Transaktion per Savepoint am Leben. */
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

  // --- Auflösung -----------------------------------------------------------
  const exact = await asRole("service_role", () =>
    db.query("select public.resolve_tenant_brand('tv.acme.example') as brand"),
  );
  check(
    exact.rows[0].brand?.name === "Acme VPN",
    `Service-Rolle löst den Mandanten auf (${exact.rows[0].brand?.name})`,
  );
  check(exact.rows[0].brand?.slug === "acme-vpn", "Slug kommt mit (für den Config-Dateinamen)");
  check(
    exact.rows[0].brand?.tagline === "Streaming ohne Umwege",
    "Tagline kommt mit",
  );

  const messy = await asRole("service_role", () =>
    db.query("select public.resolve_tenant_brand('  TV.ACME.EXAMPLE ') as brand"),
  );
  check(
    messy.rows[0].brand?.name === "Acme VPN",
    "Großschreibung und Leerraum werden normalisiert",
  );

  const unknown = await asRole("service_role", () =>
    db.query("select public.resolve_tenant_brand('unbekannt.example') as brand"),
  );
  check(unknown.rows[0].brand === null, "Unbekannte Domain liefert NULL (Fallback in der App)");

  // --- Sperre für Endnutzer ------------------------------------------------
  await asRole("authenticated", async () => {
    const readError = await expectError(() => db.query("select * from public.tenants"));
    check(
      readError?.code === "42501",
      `authenticated darf tenants nicht lesen (${readError?.code ?? "kein Fehler"})`,
    );

    const domainError = await expectError(() =>
      db.query("select * from public.tenant_domains"),
    );
    check(
      domainError?.code === "42501",
      `authenticated darf tenant_domains nicht lesen (${domainError?.code ?? "kein Fehler"})`,
    );

    const rpcError = await expectError(() =>
      db.query("select public.resolve_tenant_brand('tv.acme.example')"),
    );
    check(
      rpcError?.code === "42501",
      `authenticated darf die Auflösung nicht aufrufen (${rpcError?.code ?? "kein Fehler"})`,
    );
  });

  await asRole("anon", async () => {
    const readError = await expectError(() => db.query("select * from public.tenants"));
    check(
      readError?.code === "42501",
      `anon darf tenants nicht lesen (${readError?.code ?? "kein Fehler"})`,
    );
  });

  // --- Constraints ---------------------------------------------------------
  // In einer Transaktion, weil `expectError` mit Savepoints arbeitet; am Ende
  // wird zurückgerollt, damit die abgelehnten Zeilen nicht liegen bleiben.
  await db.query("begin");
  try {
    const badSlug = await expectError(() =>
      db.query("insert into public.tenants (slug, name) values ('Bad_Slug', 'X')"),
    );
    check(
      badSlug?.code === "23514",
      `ungültiger Slug wird abgewiesen (${badSlug?.code ?? "kein Fehler"})`,
    );

    const blankName = await expectError(() =>
      db.query("insert into public.tenants (slug, name) values ('blank', '   ')"),
    );
    check(
      blankName?.code === "23514",
      `leerer Name wird abgewiesen (${blankName?.code ?? "kein Fehler"})`,
    );

    const upperDomain = await expectError(() =>
      db.query(
        "insert into public.tenant_domains (domain, tenant_id) values ('Evil.Example', $1)",
        [acme],
      ),
    );
    check(
      upperDomain?.code === "23514",
      `nicht normalisierte Domain wird abgewiesen (${upperDomain?.code ?? "kein Fehler"})`,
    );

    const duplicate = await expectError(() =>
      db.query(
        "insert into public.tenant_domains (domain, tenant_id) values ('tv.example.net', $1)",
        [acme],
      ),
    );
    check(
      duplicate?.code === "23505",
      `doppelte Domain wird abgewiesen (${duplicate?.code ?? "kein Fehler"})`,
    );
  } finally {
    await db.query("rollback");
  }

  // --- Kaskade -------------------------------------------------------------
  await db.query("delete from public.tenants where id = $1", [acme]);
  const leftovers = await db.query("select count(*)::int as n from public.tenant_domains");
  check(
    leftovers.rows[0].n === 0,
    `Löschen des Mandanten räumt seine Domains ab (${leftovers.rows[0].n} übrig)`,
  );

  const afterDelete = await asRole("service_role", () =>
    db.query("select public.resolve_tenant_brand('tv.example.net') as brand"),
  );
  check(afterDelete.rows[0].brand === null, "Nach dem Löschen liefert die Auflösung NULL");

  await db.end();
  finish("Mandanten-Registry");
}

main().catch((error) => {
  console.error("Mandanten-Test abgebrochen:", error.message);
  process.exit(1);
});
