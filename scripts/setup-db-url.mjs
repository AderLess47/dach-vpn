#!/usr/bin/env node
/**
 * Ergänzt ausschließlich DATABASE_URL in apps/dashboard/.env.local.
 *
 * Gedacht für den Migrations-Lauf gegen das echte Supabase-Projekt: fragt die
 * Verbindungszeichenfolge verdeckt ab, prüft die Form und warnt vor den zwei
 * üblichen Fehlgriffen (Direct-Host ohne IPv6, Transaction-Pooler für DDL).
 * Die übrigen Zeilen der Datei bleiben unverändert.
 *
 * Aufruf: bun run setup:db
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const target = "apps/dashboard/.env.local";

function ask(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    let value = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener("data", onData);
          process.stdout.write("\n");
          resolve(value.trim());
          return;
        }
        if (char === "\u0003") {
          process.stdin.setRawMode(false);
          process.stdout.write("\nAbbruch.\n");
          process.exit(130);
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function main() {
  if (!existsSync(target)) {
    console.log(`Abbruch: ${target} fehlt. Zuerst bun run setup:env ausführen.`);
    process.exit(1);
  }

  console.log("Datenbank-Zugang für die Migrationen");
  console.log("Nimm den Session-Pooler aus dem Connect-Dialog (nicht Direct, nicht Transaction).\n");

  let value = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    value = await ask(
      "Connection String einfügen und Enter drücken\n  (postgres://postgres.<ref>:<passwort>@aws-N-<region>.pooler.supabase.com:5432/postgres)\n> ",
    );
    if (!value) {
      console.log("  Nichts eingegeben — bitte erneut.");
      continue;
    }
    if (!/^postgres(ql)?:\/\//.test(value)) {
      console.log("  ! Erwartet wird ein String, der mit postgres:// oder postgresql:// beginnt.");
      continue;
    }
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      console.log("  ! Der String ist keine gültige URL (Sonderzeichen im Passwort müssen URL-kodiert sein).");
      continue;
    }
    if (parsed.port === "6543") {
      console.log("  ! Port 6543 ist der Transaction-Pooler — der kann keine DDL-Transaktion halten. Bitte 5432 (Session-Pooler).");
      continue;
    }
    if (/^db\.[a-z0-9-]+\.supabase\.(co|in)$/i.test(parsed.hostname)) {
      console.log("  ! Das ist der Direct-Host (nur IPv6) — aus dieser Umgebung unerreichbar. Bitte den Session-Pooler kopieren.");
      continue;
    }
    console.log(`  ✓ übernommen (host ${parsed.hostname}, port ${parsed.port || "5432"}, db ${parsed.pathname.slice(1) || "postgres"})`);
    break;
  }

  if (!value) {
    console.log("\nAbgebrochen — die Datei wurde nicht verändert.");
    process.exit(1);
  }

  const lines = readFileSync(target, "utf8").split("\n");
  const filtered = lines.filter((line) => !/^\s*DATABASE_URL=/.test(line));
  while (filtered.length > 0 && filtered[filtered.length - 1].trim() === "") filtered.pop();
  filtered.push("# Nur für Migrationen — nicht für den App-Betrieb nötig.", `DATABASE_URL=${value}`, "");

  writeFileSync(target, filtered.join("\n"), { mode: 0o600 });
  chmodSync(target, 0o600);

  console.log(`\n✓ DATABASE_URL ergänzt (${target}, Rechte 0600)`);
  console.log("Nächster Schritt: bun run db:apply");
}

main().catch((error) => {
  console.error(`Fehler: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
