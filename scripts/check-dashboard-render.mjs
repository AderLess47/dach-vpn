#!/usr/bin/env node
/**
 * Prüft die Startseite des Dashboards in beiden Zuständen und hält die Zahl der
 * Prüfungen gegen die README:
 *
 * - Standard (`bun run check:render`, CI-Job `dashboard-auth`): Build mit
 *   `NEXT_PUBLIC_*` — Auth-Formular sichtbar, kein Trockenlauf-Hinweis.
 * - `dry` (`bun run check:render:dry`, CI-Job `quality`): Build ohne
 *   `NEXT_PUBLIC_*` — die Startseite muss den Trockenlauf-Hinweis zeigen und
 *   darf kein Anmeldeformular rendern.
 *
 * Vorher standen diese Prüfungen als `curl` + `grep`-Block in der CI und in der
 * README-Anleitung; damit gab es zwei Fassungen und keine Absicherung der
 * dokumentierten Zahlen. Jetzt prüft genau eine Implementierung, und nach einem
 * grünen Lauf vergleicht sie die Zahl mit „<n> Render-Prüfungen“ bzw.
 * „<n> Trockenlauf-Prüfungen“ — in der README und in `docs/testing.md`,
 * damit die beiden Dokumente nicht getrennt voneinander veralten.
 *
 * Erwartet eine gebaute und gestartete App unter `BASE_URL` (Default
 * `http://127.0.0.1:3000`). `RENDER_PAGE_FILE` legt das abgerufene HTML
 * zusätzlich ab (in CI das Artefakt `page.html`).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const MODE = process.argv[2] === "dry" ? "dry" : "live";
const BASE_URL = (process.env.BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const README_URL = new URL("../README.md", import.meta.url);
const DOCS_URL = new URL("../docs/testing.md", import.meta.url);
const EXPECTED = MODE === "dry" ? /(\d+) Trockenlauf-Prüfungen/ : /(\d+) Render-Prüfungen/;
const KIND = MODE === "dry" ? "Trockenlauf-Prüfungen" : "Render-Prüfungen";

let status;
let html;
try {
  const response = await fetch(BASE_URL, { signal: AbortSignal.timeout(10_000) });
  status = response.status;
  html = await response.text();
} catch (error) {
  const reason = error.cause?.code ?? error.code ?? error.message;
  console.error(`Kein Server unter ${BASE_URL} — ${reason}.`);
  console.error(
    MODE === "dry"
      ? "Zuerst ohne NEXT_PUBLIC_* bauen und starten (bun run build, bun run start); in CI macht das der Job `quality`."
      : "Zuerst bauen und starten: README.md, Abschnitt „Beide Supabase-Jobs lokal nachstellen“, Schritt 4.",
  );
  process.exit(1);
}

const pageFile = process.env.RENDER_PAGE_FILE?.trim();
if (pageFile) {
  mkdirSync(dirname(pageFile), { recursive: true });
  writeFileSync(pageFile, html);
}

let checks = 0;
let failures = 0;

function check(condition, message) {
  checks += 1;
  console.log(`${condition ? "PASS" : "FAIL"} ${message}`);
  if (!condition) failures += 1;
}

check(status === 200, `Startseite antwortet mit 200 (${status})`);

if (MODE === "dry") {
  check(
    html.includes("Supabase Auth ist nicht konfiguriert"),
    "Trockenlauf-Hinweis wird gerendert",
  );
  check(
    html.includes("NEXT_PUBLIC_SUPABASE_URL") && html.includes("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    "Hinweis nennt beide benötigten Variablen",
  );
  check(!html.includes("Anmelden"), "kein Anmeldeformular ohne Konfiguration");
} else {
  check(html.includes("Anmelden"), "Auth-Formular wird server-gerendert");
  check(html.includes("E-Mail"), "E-Mail-Feld ist vorhanden");
  check(html.includes("Passwort"), "Passwort-Feld ist vorhanden");
  check(
    !html.includes("Supabase Auth ist nicht konfiguriert"),
    "kein Konfigurationshinweis (Auth ist aktiv)",
  );
  check(!html.includes("DEMO_USER_ID"), "kein Demo-User-Hinweis im HTML");
}

const label = MODE === "dry" ? "Dashboard-Render (Trockenlauf)" : "Dashboard-Render (Auth aktiv)";
console.log(`\n${label}: ${checks - failures} PASS, ${failures} FAIL.`);

if (failures > 0) {
  console.error(
    MODE === "dry"
      ? "Die Startseite zeigt den Trockenlauf nicht wie erwartet — Ausgabe oben."
      : "Startseite entspricht nicht der Erwartung — Ausgabe oben.",
  );
  process.exit(1);
}

// Beide Dokumente nennen die Zahl; beide müssen zum Lauf passen, sonst
// veraltet eines von beiden still.
const SOURCES = [
  { label: "README.md", url: README_URL },
  { label: "docs/testing.md", url: DOCS_URL },
];

const mismatches = [];
for (const source of SOURCES) {
  let text;
  try {
    text = readFileSync(source.url, "utf8");
  } catch (error) {
    mismatches.push(`${source.label} nicht lesbar: ${error.message}`);
    continue;
  }

  const match = text.match(EXPECTED);
  if (!match) {
    mismatches.push(`${source.label}: Angabe „<n> ${KIND}“ fehlt`);
  } else if (Number(match[1]) !== checks) {
    mismatches.push(`${source.label}: nennt ${match[1]}, Lauf ${checks}`);
  }
}

if (mismatches.length > 0) {
  console.error("Prüfungszahlen weichen vom Lauf ab:");
  for (const line of mismatches) console.error(`  ${line}`);
  console.error("Bitte README.md und docs/testing.md nachziehen.");
  process.exit(1);
}

console.log(`Zahlen stimmen: ${checks} ${KIND} in README.md und docs/testing.md.`);
