#!/usr/bin/env node
/**
 * Führt die Datenbank-Suiten nacheinander gegen ein echtes PostgreSQL aus —
 * auch dann weiter, wenn eine fehlschlägt — und hält die Prüfungszahlen in der
 * README gegen den echten Lauf.
 *
 * Die Suiten setzen `public`/`auth` zurück; dieser Befehl gehört deshalb nie
 * gegen eine echte Datenbank gerichtet (siehe `docs/testing.md`, Regel 3).
 * `DATABASE_URL` zeigt per Default auf `127.0.0.1:5432`.
 */
import net from "node:net";
import { Client } from "pg";
import { perSuiteCounts, runSuites } from "./lib/suite-runner.mjs";

const SUITES = [
  "test:ipam",
  "test:registration",
  "test:rls",
  "test:subscription",
  "test:tenants",
  "test:entitlement",
  "test:errors",
];

// Ohne URL scheitert sonst jede der sieben Suiten einzeln an der Verbindung —
// sieben Fehlerberge für eine vergessene Variable. Lieber einmal abbrechen.
if (!process.env.DATABASE_URL?.trim()) {
  console.error("DATABASE_URL fehlt — die DB-Suiten brauchen ein erreichbares PostgreSQL.");
  console.error(
    "Beispiel: DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres bun run test:db",
  );
  console.error("Ohne Docker: docs/testing.md, Abschnitt „DB-Suiten ohne Docker“.");
  process.exit(1);
}

let target;
try {
  target = new URL(process.env.DATABASE_URL.trim());
} catch {
  console.error("DATABASE_URL ist keine gültige URL — erwartet wird z. B. postgres://…");
  process.exit(1);
}

const host = target.hostname;
const port = target.port || "5432";

/** Einmal TCP anklopfen, bevor Zugangsdaten ins Spiel kommen. */
function probe() {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port: Number(port) });
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(3000);
    socket.once("connect", () => done({ ok: true }));
    socket.once("timeout", () => done({ ok: false, reason: "Zeitüberschreitung nach 3000 ms" }));
    socket.once("error", (error) => done({ ok: false, reason: error.code ?? error.message }));
  });
}

// Lieber einmal prüfen als sieben Suiten an derselben toten Verbindung
// scheitern lassen. Nur Host und Port landen in der Ausgabe, nie die URL mit
// Zugangsdaten.
/** Anmelden und prüfen, ob die Rolle die Suiten überhaupt fahren darf. */
async function checkLogin() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL.trim(),
    connectionTimeoutMillis: 3000,
  });
  try {
    await client.connect();
    // `migrate()` löscht `public` und `auth`; das kann nur der Eigentümer der
    // Datenbank oder ein Superuser. Fehlt beides, scheitern sonst alle sieben
    // Suiten an derselben Berechtigung.
    const { rows } = await client.query(
      `select current_user as role,
              (select rolsuper from pg_roles where rolname = current_user) as is_super,
              (select pg_get_userbyid(datdba) from pg_database where datname = current_database()) = current_user as is_owner`,
    );
    const { role, is_super: isSuper, is_owner: isOwner } = rows[0];
    if (!isSuper && !isOwner) {
      return {
        ok: false,
        reason: `Rolle ${role} ist weder Eigentümer der Datenbank noch Superuser und kann public/auth nicht zurücksetzen`,
      };
    }
    return { ok: true };
  } catch (error) {
    const known = {
      "28P01": "falsches Passwort (28P01)",
      "28000": "Anmeldung abgelehnt (28000)",
      "3D000": "Datenbank existiert nicht (3D000)",
    };
    return { ok: false, reason: known[error.code] ?? `${error.code ?? "Fehler"}: ${error.message}` };
  } finally {
    await client.end().catch(() => {});
  }
}

if (!host) {
  console.log("DATABASE_URL nennt keinen Host — Erreichbarkeit wird nicht vorab geprüft.");
} else {
  const reachable = await probe();
  if (!reachable.ok) {
    console.error(`Keine Verbindung zu ${host}:${port} — ${reachable.reason}.`);
    console.error("Die DB-Suiten brauchen ein erreichbares PostgreSQL; sie setzen public und auth zurück.");
    console.error("Ohne Docker: docs/testing.md, Abschnitt „DB-Suiten ohne Docker“.");
    process.exit(1);
  }

  const login = await checkLogin();
  if (!login.ok) {
    console.error(`Anmeldung an ${host}:${port} fehlgeschlagen — ${login.reason}.`);
    console.error("Die DB-Suiten brauchen eine Rolle, die public und auth zurücksetzen darf.");
    process.exit(1);
  }

  console.log(`Datenbank erreichbar, Anmeldung und Rechte ok: ${host}:${port}.`);
}

await runSuites({
  title: "DB-Suiten",
  successMessage: "Alle DB-Suiten bestanden.",
  suites: SUITES,
  readmeUrl: new URL("../README.md", import.meta.url),
  hint: "Bitte den test:db-Absatz in README.md nachziehen.",
  parseReadme(text) {
    const total = text.match(/Datenbank-Ebene in sieben Suiten ab, zusammen (\d+)\s+Prüfungen/);
    return {
      total: total ? Number(total[1]) : null,
      perSuite: perSuiteCounts(text, SUITES),
    };
  },
});
