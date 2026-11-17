#!/usr/bin/env node
/**
 * Geführtes Setup für apps/dashboard/.env.local.
 *
 * Fragt die drei Supabase-Werte ab (Eingabe verdeckt, sofern das Terminal es
 * erlaubt), prüft ihre Form und schreibt die Datei mit Rechten 0600. Werte
 * erscheinen weder in der Ausgabe noch in der Shell-History noch im Chat.
 *
 * Aufruf:  bun run setup:env
 * Test:    bun run setup:env --target=/tmp/probe.env   (schreibt woandershin)
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

const targetArg = process.argv.find((arg) => arg.startsWith("--target="));
const target = targetArg ? targetArg.slice("--target=".length) : "apps/dashboard/.env.local";

const FIELDS = [
  {
    key: "NEXT_PUBLIC_SUPABASE_URL",
    label: "Project URL",
    hint: "https://<projekt-ref>.supabase.co  (Connect-Dialog → Project URL)",
    validate: (value) =>
      /^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i.test(value)
        ? null
        : "Das sieht nicht wie eine Project URL aus (erwartet https://<ref>.supabase.co).",
  },
  {
    key: "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    label: "Publishable key",
    hint: "sb_publishable_…  (Settings → API Keys → Publishable key)",
    validate: (value) =>
      value.startsWith("sb_publishable_") || value.split(".").length === 3
        ? null
        : "Erwartet einen Publishable Key (sb_publishable_…) oder einen anon-JWT.",
  },
  {
    key: "SUPABASE_SERVICE_ROLE_KEY",
    label: "Secret key",
    hint: "sb_secret_…  (Settings → API Keys → Secret keys, Augen-Symbol)",
    validate: (value) =>
      value.startsWith("sb_secret_") || value.split(".").length === 3
        ? null
        : "Erwartet einen Secret Key (sb_secret_…) oder einen service_role-JWT.",
  },
];

/**
 * Liest eine Zeile; im TTY verdeckt, sonst aus dem einmalig gelesenen stdin.
 * Bei Pipes kommt alles in einem Block an, deshalb wird stdin dort komplett
 * eingelesen und als Zeilenwarteschlange bedient.
 */
let pipedLines = null;

function ask(question, hidden) {
  return new Promise((resolve) => {
    process.stdout.write(question);

    if (!process.stdin.isTTY) {
      if (pipedLines === null) {
        pipedLines = readFileSync(0, "utf8").split(/\r?\n/);
      }
      const line = (pipedLines.shift() ?? "").trim();
      process.stdout.write(hidden ? "\n" : `${line}\n`);
      resolve(line);
      return;
    }

    let value = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const onData = (chunk) => {
      const text = chunk.toString("utf8");
      for (const char of text) {
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
          if (!hidden) process.stdout.write("\b \b");
          continue;
        }
        value += char;
        if (!hidden) process.stdout.write(char);
      }
    };

    process.stdin.on("data", onData);
  });
}

async function collect() {
  const values = new Map();

  for (const field of FIELDS) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const value = await ask(`\n${field.label} einfügen und Enter drücken\n  (${field.hint})\n> `, true);
      if (!value) {
        console.log("  Nichts eingegeben — bitte erneut.");
        continue;
      }
      const problem = field.validate(value);
      if (!problem) {
        values.set(field.key, value);
        console.log(`  ✓ übernommen (${value.length} Zeichen)`);
        break;
      }
      console.log(`  ! ${problem}`);
      if (attempt === 3) return null;
    }
  }

  return values;
}

async function main() {
  console.log("Supabase-Setup für das Dashboard");
  console.log(`Ziel: ${target} (wird nicht committet, Rechte 0600)`);
  if (existsSync(target)) {
    const existing = readFileSync(target, "utf8");
    const filled = existing
      .split("\n")
      .filter((line) => /^[A-Z_]+=.+/.test(line.trim())).length;
    console.log(`Hinweis: Datei existiert bereits (${filled} gesetzte Zeilen) und wird überschrieben.`);
  }

  const values = await collect();
  if (!values) {
    console.log("\nAbgebrochen — die Datei wurde nicht verändert.");
    process.exit(1);
  }

  const body = [
    "# Supabase-Konfiguration — automatisch erzeugt, nicht committen.",
    "# Browser-Client (beim Build eingebacken):",
    `NEXT_PUBLIC_SUPABASE_URL=${values.get("NEXT_PUBLIC_SUPABASE_URL")}`,
    `NEXT_PUBLIC_SUPABASE_ANON_KEY=${values.get("NEXT_PUBLIC_SUPABASE_ANON_KEY")}`,
    "# Server-Code (nur serverseitig lesen, niemals in den Client):",
    `SUPABASE_SERVICE_ROLE_KEY=${values.get("SUPABASE_SERVICE_ROLE_KEY")}`,
    "",
  ].join("\n");

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body, { mode: 0o600 });
  chmodSync(target, 0o600);

  const url = new URL(values.get("NEXT_PUBLIC_SUPABASE_URL"));
  console.log(`\n✓ Geschrieben: ${target}`);
  console.log(`  Projekt: ${url.host}`);
  console.log(`  Anon:    ${values.get("NEXT_PUBLIC_SUPABASE_ANON_KEY").slice(0, 14)}… (${values.get("NEXT_PUBLIC_SUPABASE_ANON_KEY").length} Zeichen)`);
  console.log(`  Secret:  ${values.get("SUPABASE_SERVICE_ROLE_KEY").slice(0, 10)}… (${values.get("SUPABASE_SERVICE_ROLE_KEY").length} Zeichen)`);
  console.log("\nNächster Schritt: bun run check:env — danach baut der Agent das Dashboard neu.");
}

main().catch((error) => {
  console.error(`Fehler: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
