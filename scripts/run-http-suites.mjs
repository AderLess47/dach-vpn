#!/usr/bin/env node
/**
 * Führt alle HTTP-Stub-Suiten nacheinander aus — auch dann weiter, wenn eine
 * fehlschlägt — zählt die Prüfungen je Suite mit und hält die Zahlen in der
 * README gegen den echten Lauf.
 *
 * Warum nicht einfach `a && b && c`: Bei `&&` bleibt nach dem ersten roten Lauf
 * der Rest ungeprüft, und man sieht pro Durchlauf nur eine Baustelle. Die
 * Mechanik steckt in [`lib/suite-runner.mjs`](./lib/suite-runner.mjs), damit
 * die Datenbank-Ebene (`run-db-suites.mjs`) dieselbe Semantik nutzt.
 */
import { perSuiteCounts, runSuites } from "./lib/suite-runner.mjs";

const SUITES = [
  "test:stub",
  "test:routes",
  "test:revoke",
  "test:webhook",
  "test:admin",
  "test:billing",
];

await runSuites({
  title: "HTTP-Suiten",
  successMessage: "Alle HTTP-Suiten bestanden.",
  suites: SUITES,
  readmeUrl: new URL("../README.md", import.meta.url),
  hint: "Bitte den test:http-Absatz in README.md nachziehen.",
  parseReadme(text) {
    const total = text.match(/HTTP-Ebene in sechs Suiten ab, zusammen (\d+) Prüfungen/);
    return {
      total: total ? Number(total[1]) : null,
      perSuite: perSuiteCounts(text, SUITES),
    };
  },
});
