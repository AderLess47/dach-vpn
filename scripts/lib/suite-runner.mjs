#!/usr/bin/env node
/**
 * Gemeinsamer Runner für Suiten-Ebenen (HTTP und Datenbank).
 *
 * Beide Ebenen bestehen aus mehreren unabhängigen Suiten, die nacheinander
 * laufen sollen, ohne dass eine rote Suite die übrigen verschluckt. Deshalb
 * startet der Runner jede Suite einzeln, leitet ihre Ausgabe live durch, zählt
 * `PASS`/`FAIL`-Zeilen und fasst am Ende Prüfungszahl, Exit-Status und Dauer
 * je Suite zusammen. Ein `&&` zwischen den Skripten würde nach dem ersten
 * Fehler abbrechen; dieser Runner endet erst mit 1, wenn alles durch ist.
 *
 * Sind alle Suiten grün, vergleicht er die Gesamtzahl und die Zahl je Suite mit
 * der README. `parseReadme` liefert dafür `{ total, perSuite }` oder
 * `{ error }`; eine Abweichung ist ein Fehlschlag, damit die dokumentierten
 * Zahlen nicht still veralten, wenn ein Test dazukommt.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

/** Startet eine Suite, leitet stdout live weiter und zählt PASS/FAIL-Zeilen. */
function runSuite(suite) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("bun", ["run", suite], { stdio: ["inherit", "pipe", "inherit"] });

    let buffer = "";
    let passed = 0;
    let failedChecks = 0;
    let settled = false;

    function countLine(line) {
      if (line.startsWith("PASS ")) passed += 1;
      else if (line.startsWith("FAIL ")) failedChecks += 1;
    }

    function settle(status, error) {
      if (settled) return;
      settled = true;
      // Letzte Zeile ohne abschließenden Zeilenumbruch nicht verlieren.
      countLine(buffer);
      resolve({
        suite,
        status,
        passed,
        failedChecks,
        error,
        seconds: Math.round((Date.now() - started) / 100) / 10,
      });
    }

    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      lines.forEach(countLine);
    });

    child.on("error", (error) => {
      console.error(`${suite}: konnte nicht gestartet werden — ${error.message}`);
      settle(1, error);
    });
    // `status` ist null, wenn der Prozess durch ein Signal endet; das zählt als Fehler.
    child.on("close", (code) => settle(code ?? 1));
  });
}

/**
 * Führt `suites` nacheinander aus, fasst zusammen und prüft die README-Zahlen.
 *
 * - `title`: Überschrift der Zusammenfassung, z. B. „HTTP-Suiten“.
 * - `successMessage`: letzte Zeile bei Erfolg.
 * - `readmeUrl`: `URL` auf die README.
 * - `parseReadme(text)`: liest Gesamtzahl und Zahl je Suite aus dem Absatz.
 * - `hint`: Aufforderung, welcher README-Absatz nachzuziehen ist.
 */
export async function runSuites({
  title,
  successMessage,
  suites,
  readmeUrl,
  parseReadme,
  hint,
}) {
  const results = [];
  for (const suite of suites) {
    console.log(`\n=== ${suite} ===`);
    results.push(await runSuite(suite));
  }

  const failed = results.filter((entry) => entry.status !== 0);
  const totalPassed = results.reduce((sum, entry) => sum + entry.passed, 0);
  const totalFailedChecks = results.reduce((sum, entry) => sum + entry.failedChecks, 0);
  const nameWidth = Math.max(13, ...suites.map((suite) => suite.length));

  console.log(`\n${title}`);
  for (const entry of results) {
    const mark = entry.status === 0 ? "ok " : "FEHLER";
    const checks = `${entry.passed} PASS${entry.failedChecks > 0 ? `, ${entry.failedChecks} FAIL` : ""}`;
    console.log(
      `  ${mark.padEnd(7)} ${entry.suite.padEnd(nameWidth)} ${checks.padEnd(15)} exit ${entry.status}  ${entry.seconds}s`,
    );
  }
  console.log(
    `Gesamt: ${totalPassed} PASS, ${totalFailedChecks} FAIL — ${results.length - failed.length}/${results.length} Suiten grün.`,
  );

  if (failed.length > 0) {
    console.error(`Fehlgeschlagen: ${failed.map((entry) => entry.suite).join(", ")}`);
    process.exit(1);
  }

  // --- README gegen den echten Lauf halten -------------------------------
  let expected;
  try {
    expected = parseReadme(readFileSync(readmeUrl, "utf8"));
  } catch (error) {
    expected = { error: `README.md nicht lesbar: ${error.message}` };
  }

  const mismatches = [];
  if (expected.error) {
    mismatches.push(expected.error);
  } else {
    if (expected.total === null) {
      mismatches.push("Gesamtzahl fehlt im README-Absatz");
    } else if (expected.total !== totalPassed) {
      mismatches.push(`Gesamt: README ${expected.total}, Lauf ${totalPassed}`);
    }

    for (const entry of results) {
      const want = expected.perSuite[entry.suite];
      if (want === null) {
        mismatches.push(`${entry.suite}: Zahl fehlt im README-Absatz`);
      } else if (want !== entry.passed) {
        mismatches.push(`${entry.suite}: README ${want}, Lauf ${entry.passed}`);
      }
    }
  }

  if (mismatches.length > 0) {
    console.error("\nREADME-Prüfungszahlen weichen vom Lauf ab:");
    for (const line of mismatches) console.error(`  ${line}`);
    console.error(hint);
    process.exit(1);
  }

  console.log(`README-Prüfungszahlen stimmen (${totalPassed} gesamt).`);
  console.log(successMessage);
}

/** Baut die Prüfung je Suite aus einem Muster wie `` `test:ipam` (11, ``. */
export function perSuiteCounts(text, suites) {
  const counts = {};
  for (const suite of suites) {
    const match = text.match(new RegExp(`\`${suite}\`\\s*\\((\\d+),`));
    counts[suite] = match ? Number(match[1]) : null;
  }
  return counts;
}
