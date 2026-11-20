#!/usr/bin/env node
/**
 * Hält die Zahl der Unit-Tests im README gegen einen echten Vitest-Lauf.
 *
 * `bun run test` bleibt die Quelle der Wahrheit: Dieses Skript führt genau
 * diesen Befehl aus (kein zweiter Testpfad, keine eigene Auswahl), liest die
 * Zusammenfassung `Tests  <n> passed` und vergleicht sie mit der Angabe im
 * Schnellstart (`# 84 Unit-Tests …`). Weicht sie ab, endet das Skript mit 1 und
 * nennt beide Werte — so veraltet die Zahl nicht still, wenn ein Test
 * dazukommt.
 *
 * Die Ausgabe von Vitest wird vollständig durchgereicht, damit ein roter Lauf
 * im CI-Log genauso lesbar bleibt wie ohne diesen Check.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const README_URL = new URL("../README.md", import.meta.url);
const SUMMARY = /Tests\s+(\d+) passed/;

/** Vitest färbt die Zusammenfassung im CI ein; ANSI-Codes raus vor dem Vergleich. */
function plain(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

let expected = null;
try {
  const readme = readFileSync(README_URL, "utf8");
  const match = readme.match(/(\d+) Unit-Tests/);
  expected = match ? Number(match[1]) : null;
} catch (error) {
  console.error(`README.md nicht lesbar: ${error.message}`);
  process.exit(1);
}

if (expected === null) {
  console.error("Keine Angabe „<n> Unit-Tests“ im README-Schnellstart gefunden.");
  process.exit(1);
}

const run = spawnSync("bun", ["run", "test"], { encoding: "utf8" });
process.stdout.write(run.stdout ?? "");
process.stderr.write(run.stderr ?? "");

if (run.error) {
  console.error(`bun run test konnte nicht gestartet werden — ${run.error.message}`);
  process.exit(1);
}

if (run.status !== 0) {
  console.error(`Unit-Tests fehlgeschlagen (exit ${run.status ?? "unbekannt"}).`);
  process.exit(run.status ?? 1);
}

const actual = plain(run.stdout ?? "").match(SUMMARY);
if (!actual) {
  console.error("Zusammenfassung „Tests  <n> passed“ nicht gefunden — Ausgabeformat von Vitest geändert?");
  process.exit(1);
}

const passed = Number(actual[1]);
if (passed !== expected) {
  console.error(`README nennt ${expected} Unit-Tests, der Lauf hat ${passed}.`);
  console.error("Bitte den Schnellstart in README.md nachziehen.");
  process.exit(1);
}

console.log(`README-Zahl stimmt: ${passed} Unit-Tests.`);
