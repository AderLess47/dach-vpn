#!/usr/bin/env node
/**
 * Führt die Auth-Route-E2E gegen den echten Supabase-Stack aus und hält ihre
 * Prüfungszahl gegen die README.
 *
 * Zwei Dinge, die der reine E2E-Test nicht kann:
 *
 * 1. Fehlt der Stack (typisch: kein Docker, also keine `SUPABASE_*`-Variablen),
 *    bricht der Lauf mit einer Meldung ab, die den nächsten Schritt nennt —
 *    statt 28 Prüfungen an eine tote Verbindung zu schicken.
 * 2. Nach grünem Lauf vergleicht der Wrapper die Zahl der `PASS`-Zeilen mit
 *    dem Absatz „Der Job `auth` prüft <n> Punkte“ in der README und der
 *    Zeile „<n> Prüfungen“ in `docs/testing.md`; eine Abweichung ist ein
 *    Fehlschlag, damit die dokumentierten Zahlen nicht still veralten, wenn
 *    eine Prüfung dazukommt.
 *
 * Der E2E-Test legt echte Nutzer im lokalen Stack an — nie gegen ein gehostetes
 * Projekt richten.
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const README_URL = new URL("../README.md", import.meta.url);
const DOCS_URL = new URL("../docs/testing.md", import.meta.url);
const E2E = fileURLToPath(new URL("./auth-route-e2e.mjs", import.meta.url));

// Die README nennt die Zahl als „Punkte“, die Testebenen-Tabelle als
// „Prüfungen — “ (gefolgt von den Prüfstellen). Beide müssen zum Lauf passen.
const SOURCES = [
  { label: "README.md", url: README_URL, pattern: /Job `auth` prüft (\d+) Punkte/, kind: "Punkte" },
  { label: "docs/testing.md", url: DOCS_URL, pattern: /(\d+) Prüfungen —/, kind: "Prüfungen" },
];

const REQUIRED = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "DEFAULT_NODE_ID"];
const missing = REQUIRED.filter((name) => !process.env[name]?.trim());

/** Liefert einen Hinweis, wenn Docker hier nicht benutzbar ist. */
function dockerHint() {
  const run = spawnSync("docker", ["info"], { stdio: "ignore", timeout: 5000 });
  if (run.status === 0) return null;
  return "Docker ist hier nicht verfügbar (docker info schlägt fehl) — ohne Docker gibt es keinen lokalen Supabase-Stack.";
}

if (missing.length > 0) {
  console.error("Die Auth-Route-E2E braucht den lokalen Supabase-Stack; es fehlen:");
  console.error(`  ${missing.join(", ")}`);
  const hint = dockerHint();
  if (hint) console.error(hint);
  console.error(
    "Anleitung: README.md, Abschnitt „Beide Supabase-Jobs lokal nachstellen“ (supabase start, Build, Serverstart).",
  );
  process.exit(1);
}

const child = spawn(process.execPath, [E2E], { stdio: ["inherit", "pipe", "inherit"] });

let passed = 0;
let failed = 0;
let buffer = "";

function countLine(line) {
  if (line.startsWith("PASS ")) passed += 1;
  else if (line.startsWith("FAIL ")) failed += 1;
}

child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  buffer += chunk.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  lines.forEach(countLine);
});

const status = await new Promise((resolve) => {
  child.on("error", (error) => {
    console.error(`E2E-Test konnte nicht gestartet werden — ${error.message}`);
    resolve(1);
  });
  // `status` ist null, wenn der Prozess durch ein Signal endet; das zählt als Fehler.
  child.on("close", (code) => {
    countLine(buffer);
    resolve(code ?? 1);
  });
});

console.log(`\nAuth-Route: ${passed} PASS, ${failed} FAIL (exit ${status}).`);

if (status !== 0) {
  console.error("Auth-Route-E2E fehlgeschlagen — Ausgabe oben.");
  process.exit(status);
}

const mismatches = [];
for (const source of SOURCES) {
  let text;
  try {
    text = readFileSync(source.url, "utf8");
  } catch (error) {
    mismatches.push(`${source.label} nicht lesbar: ${error.message}`);
    continue;
  }

  const match = text.match(source.pattern);
  if (!match) {
    mismatches.push(`${source.label}: Angabe „<n> ${source.kind}“ fehlt`);
  } else if (Number(match[1]) !== passed) {
    mismatches.push(`${source.label}: nennt ${match[1]}, Lauf ${passed}`);
  }
}

if (mismatches.length > 0) {
  console.error("Prüfungszahlen weichen vom Lauf ab:");
  for (const line of mismatches) console.error(`  ${line}`);
  console.error("Bitte README.md und docs/testing.md nachziehen.");
  process.exit(1);
}

console.log(`Zahlen stimmen: ${passed} Prüfungen in README.md und docs/testing.md.`);
