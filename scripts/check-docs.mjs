#!/usr/bin/env node
/**
 * Vergleicht die dokumentierten Prüfungszahlen zwischen README.md und
 * docs/testing.md — ohne einen einzigen Test auszuführen.
 *
 * Die Runner (`test:http`, `test:db`, `test:auth-route`, `check:render`) prüfen
 * ihre Zahlen erst nach einem echten Lauf. Dieser Befehl beantwortet vorab und
 * in Millisekunden die Frage, ob die beiden Dokumente noch dieselben Zahlen
 * nennen und ob die Gesamtzahlen zu den Einzelzahlen passen. Er ersetzt keinen
 * Lauf — er hält nur die Doku konsistent, damit ein Zahlendreher beim
 * Bearbeiten sofort auffällt statt erst in der CI nach Minuten.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const README_URL = new URL("../README.md", import.meta.url);
const DOCS_URL = new URL("../docs/testing.md", import.meta.url);
const HTTP_RUNNER_URL = new URL("./run-http-suites.mjs", import.meta.url);
const DB_RUNNER_URL = new URL("./run-db-suites.mjs", import.meta.url);
const VITEST_URL = new URL("../vitest.config.ts", import.meta.url);
const PACKAGE_URL = new URL("../package.json", import.meta.url);
const CI_URL = new URL("../.github/workflows/ci.yml", import.meta.url);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "out", "coverage", ".turbo"]);

const problems = [];

function read(url) {
  try {
    return readFileSync(url, "utf8");
  } catch (error) {
    problems.push(`${url.pathname} nicht lesbar: ${error.message}`);
    return "";
  }
}

/** Liest eine Zahl; fehlt die Angabe, wird das als Problem vermerkt. */
function pick(text, pattern, source, label) {
  const match = text.match(pattern);
  if (!match) {
    problems.push(`${label}: Angabe fehlt in ${source}`);
    return null;
  }
  return Number(match[1]);
}

/** Suite-Namen aus einem Runner, damit die Doku-Liste nicht doppelt gepflegt wird. */
function suitesOf(url) {
  const block = read(url).match(/const SUITES = \[([\s\S]*?)\];/);
  if (!block) {
    problems.push(`Suite-Liste in ${url.pathname} nicht gefunden`);
    return [];
  }
  return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

/** `include`-Muster aus vitest.config.ts, damit die Zählung der Suite entspricht. */
function includePatterns() {
  const block = read(VITEST_URL).match(/include:\s*\[([\s\S]*?)\]/);
  if (!block) {
    problems.push("include-Muster in vitest.config.ts nicht gefunden");
    return [];
  }
  return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

/** Übersetzt ein einfaches Glob (`**`, `*`, `?`) in einen regulären Ausdruck. */
function globToRegExp(glob) {
  let out = "^";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      i += 1;
      if (glob[i + 1] === "/") {
        i += 1;
        out += "(?:.*/)?";
      } else {
        out += ".*";
      }
    } else if (ch === "*") {
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${out}$`);
}

/** Alle Dateien unterhalb des Repos, ohne Build-, Cache- und Abhängigkeitsordner. */
function allFiles(dir = ROOT, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) allFiles(full, files);
    } else if (entry.isFile()) {
      files.push(relative(ROOT, full).split(sep).join("/"));
    }
  }
  return files;
}

/** Zahl einer Suite aus dem README, z. B. `` `test:ipam` (11, ``. */
function suiteCount(readme, suite) {
  const match = readme.match(new RegExp(`\`${suite}\`\\s*\\((\\d+),`));
  if (!match) {
    problems.push(`${suite}: Zahl fehlt in README.md`);
    return null;
  }
  return Number(match[1]);
}

const readme = read(README_URL);
const docs = read(DOCS_URL);

// --- Zahlen, die in beiden Dokumenten stehen ------------------------------
const PAIRS = [
  {
    label: "Unit-Tests",
    readme: [/(\d+) Unit-Tests/, "README.md"],
    docs: [/(\d+) Tests in \d+ Dateien/, "docs/testing.md"],
  },
  {
    label: "Datenbank",
    readme: [/Datenbank-Ebene in sieben Suiten ab, zusammen (\d+)\s+Prüfungen/, "README.md"],
    docs: [/Suiten, (\d+) Prüfungen/, "docs/testing.md"],
  },
  {
    label: "Auth-Route",
    readme: [/Job `auth` prüft (\d+) Punkte/, "README.md"],
    docs: [/(\d+) Prüfungen —/, "docs/testing.md"],
  },
  {
    label: "Render (Auth)",
    readme: [/(\d+) Render-Prüfungen/, "README.md"],
    docs: [/(\d+) Render-Prüfungen/, "docs/testing.md"],
  },
  {
    label: "Trockenlauf",
    readme: [/(\d+) Trockenlauf-Prüfungen/, "README.md"],
    docs: [/(\d+) Trockenlauf-Prüfungen/, "docs/testing.md"],
  },
];

console.log("Dokument-Zahlen");
const rows = [];
for (const pair of PAIRS) {
  const readmeValue = pick(readme, ...pair.readme, pair.label);
  const docsValue = pick(docs, ...pair.docs, pair.label);
  const ok = readmeValue !== null && readmeValue === docsValue;
  if (!ok && readmeValue !== null && docsValue !== null) {
    problems.push(`${pair.label}: README ${readmeValue}, docs/testing.md ${docsValue}`);
  }
  rows.push({ label: pair.label, value: readmeValue ?? docsValue, text: `${readmeValue ?? "?"} / ${docsValue ?? "?"}`, ok });
}
for (const row of rows) {
  console.log(`  ${row.ok ? "ok " : "ABW"} ${row.label.padEnd(16)} ${String(row.value ?? "?").padEnd(5)} (README ${row.text})`);
}

// --- Testdateien gegen vitest.config.ts und den Dateibaum ----------------
console.log("\nUnit-Testdateien");
const fileMatch = docs.match(/(\d+) Tests in (\d+) Dateien/);
const documentedFiles = fileMatch ? Number(fileMatch[2]) : null;
const patterns = includePatterns().map(globToRegExp);
const testFiles = patterns.length > 0 ? allFiles().filter((file) => patterns.some((re) => re.test(file))).sort() : [];
const filesOk = documentedFiles !== null && patterns.length > 0 && documentedFiles === testFiles.length;
if (!filesOk && documentedFiles !== null && patterns.length > 0) {
  problems.push(`Unit-Testdateien: docs/testing.md nennt ${documentedFiles}, gefunden ${testFiles.length}`);
}
console.log(
  `  ${filesOk ? "ok " : "ABW"} docs/testing.md ${documentedFiles ?? "?"} · im Dateibaum ${testFiles.length}` +
    (filesOk ? ` (${includePatterns().join(", ")})` : ""),
);
if (!filesOk) for (const file of testFiles) console.log(`      ${file}`);

const LEVELS = [
  {
    label: "HTTP-Suiten",
    runnerUrl: HTTP_RUNNER_URL,
    totalPattern: /HTTP-Ebene in sechs Suiten ab, zusammen (\d+) Prüfungen/,
  },
  {
    label: "DB-Suiten",
    runnerUrl: DB_RUNNER_URL,
    totalPattern: /Datenbank-Ebene in sieben Suiten ab, zusammen (\d+)\s+Prüfungen/,
  },
];

// --- Gesamtzahlen gegen die Einzelzahlen ----------------------------------
console.log("\nSummen im README");
for (const { label, runnerUrl, totalPattern } of LEVELS) {
  const suites = suitesOf(runnerUrl);
  const total = pick(readme, totalPattern, "README.md", label);
  const counts = suites.map((suite) => suiteCount(readme, suite)).filter((n) => n !== null);
  const sum = counts.reduce((acc, n) => acc + n, 0);
  const ok = total !== null && counts.length === suites.length && sum === total;
  if (!ok && total !== null && counts.length === suites.length) {
    problems.push(`${label}: Einzelzahlen ergeben ${sum}, README nennt ${total}`);
  }
  console.log(
    `  ${ok ? "ok " : "ABW"} ${label.padEnd(12)} ${String(total ?? "?").padEnd(5)} = ${counts.join(" + ")}${ok ? ` = ${sum}` : ""}`,
  );
}

// --- Jede Suite muss in der Testebenen-Tabelle stehen ---------------------
// Sonst fehlt eine Suite in der Doku, ohne dass eine Zahl auffällt.
console.log("\nSuite-Namen in der Testebenen-Tabelle");
const table = docs
  .split("\n")
  .filter((line) => line.trim().startsWith("|"))
  .join("\n");
for (const { label, runnerUrl } of LEVELS) {
  const suites = suitesOf(runnerUrl);
  const missing = suites.filter((suite) => !table.includes(`\`${suite}\``));
  const ok = suites.length > 0 && missing.length === 0;
  if (missing.length > 0) {
    problems.push(`${label}: ${missing.join(", ")} fehlt in der Tabelle in docs/testing.md`);
  }
  console.log(
    `  ${ok ? "ok " : "ABW"} ${label.replace("-Suiten", "")} ${suites.length - missing.length}/${suites.length}${ok ? "" : ` — fehlt: ${missing.join(", ")}`}`,
  );
}

/** Job-Namen aus dem `jobs:`-Block der Workflow-Datei. */
function ciJobs() {
  const after = read(CI_URL).split(/^jobs:\s*$/m)[1];
  if (!after) {
    problems.push("`jobs:` in .github/workflows/ci.yml nicht gefunden");
    return [];
  }
  const jobs = [];
  for (const line of after.split("\n")) {
    if (/^\S/.test(line)) break; // nächster Top-Level-Block
    const match = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (match) jobs.push(match[1]);
  }
  return jobs;
}

// --- CI-Tabelle der README gegen die Workflow-Jobs ------------------------
console.log("\nCI-Tabelle in der README");
const jobs = ciJobs();
const ciSection = readme.split("\n## CI\n")[1]?.split("\n## ")[0] ?? "";
const tableJobs = [...ciSection.matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map((match) => match[1]);
const ciProblemCount = problems.length;
const jobsMissingInReadme = jobs.filter((job) => !tableJobs.includes(job));
const jobsMissingInCi = tableJobs.filter((job) => !jobs.includes(job));
for (const job of jobsMissingInReadme) {
  problems.push(`CI-Tabelle der README: Job \`${job}\` fehlt`);
}
for (const job of jobsMissingInCi) {
  problems.push(`CI-Tabelle der README: Job \`${job}\` gibt es in ci.yml nicht`);
}

// Der Satz über der Tabelle nennt die Anzahl als deutsches Zahlwort.
const WORD_NUMBERS = {
  Eins: 1,
  Zwei: 2,
  Drei: 3,
  Vier: 4,
  "Fünf": 5,
  Sechs: 6,
  Sieben: 7,
  Acht: 8,
  Neun: 9,
  Zehn: 10,
  Elf: 11,
  "Zwölf": 12,
};
const countWord = readme.match(/([A-ZÄÖÜ][a-zäöüß]+) Jobs in \[`\.github\/workflows\/ci\.yml`\]/)?.[1] ?? null;
const statedJobs = countWord ? (WORD_NUMBERS[countWord] ?? null) : null;
if (countWord === null) {
  problems.push("README: Satz „<Zahlwort> Jobs in .github/workflows/ci.yml“ fehlt");
} else if (statedJobs === null) {
  problems.push(`README: Zahlwort „${countWord} Jobs“ ist nicht zuordenbar`);
} else if (statedJobs !== jobs.length) {
  problems.push(`README-Satz nennt ${countWord} Jobs (${statedJobs}), ci.yml hat ${jobs.length}`);
}

const ciOk = jobs.length > 0 && tableJobs.length > 0 && problems.length === ciProblemCount;
console.log(
  `  ${ciOk ? "ok " : "ABW"} ci.yml ${jobs.length} Jobs · README ${tableJobs.length} Zeilen${ciOk ? ` (${[...jobs].sort().join(", ")})` : ""}`,
);
if (!ciOk) {
  console.log(`      ci.yml: ${[...jobs].sort().join(", ") || "—"}`);
  console.log(`      README: ${[...tableJobs].sort().join(", ") || "—"}`);
}

/** Zeilen je Job — Kommentare raus, damit nur Ausgeführtes zählt. */
function ciJobText() {
  const after = read(CI_URL).split(/^jobs:\s*$/m)[1] ?? "";
  const chunks = new Map();
  let current = null;
  for (const line of after.split("\n")) {
    if (/^\S/.test(line) && line.trim()) break; // nächster Top-Level-Block
    const job = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (job) {
      current = job[1];
      chunks.set(current, []);
      continue;
    }
    if (!current || /^\s*#/.test(line)) continue;
    chunks.get(current).push(line);
  }
  return chunks;
}

/** Prüf-Skripte je Job: aus den `run:`-Zeilen, ohne Startbefehle. */
function ciJobScripts() {
  const IGNORED = new Set(["install", "start", "dev", "watch"]);
  const result = new Map();
  for (const [job, lines] of ciJobText()) {
    const text = lines.join("\n");
    const tokens = new Set();
    for (const match of text.matchAll(/bun run ([a-z0-9:_-]+)/g)) tokens.add(match[1]);
    for (const match of text.matchAll(/\b(?:node|bun) scripts\/([a-z0-9-]+)\.mjs/g)) tokens.add(match[1]);
    result.set(job, [...tokens].filter((token) => !IGNORED.has(token)).sort());
  }
  return result;
}

/** `retention-days` je Job aus den upload-artifact-Schritten. */
function ciJobRetention() {
  const result = new Map();
  for (const [job, lines] of ciJobText()) {
    const days = lines
      .map((line) => line.match(/^ {10}retention-days: (\d+)\s*$/)?.[1])
      .filter(Boolean)
      .map(Number);
    result.set(job, days);
  }
  return result;
}

/** Artefaktnamen je Job: `name:` in den upload-artifact-Schritten (10 Spaces). */
function ciJobArtifacts() {
  const result = new Map();
  for (const [job, lines] of ciJobText()) {
    const names = lines
      .map((line) => line.match(/^ {10}name: ([A-Za-z0-9._-]+)\s*$/)?.[1])
      .filter(Boolean);
    result.set(job, names);
  }
  return result;
}

// --- Jede Prüfung eines CI-Jobs muss in dessen README-Zeile stehen --------
// Die Reihenfolge der Schritte prüft das nicht; es fällt nur auf, wenn ein
// Schritt in der Tabelle gar nicht erwähnt wird.
console.log("\nCI-Schritte in der Tabelle");
const rowContent = new Map();
for (const line of ciSection.split("\n")) {
  const match = line.match(/^\| `([a-z0-9-]+)` \| (.*?) \|/);
  if (match) rowContent.set(match[1], match[2].toLowerCase());
}
for (const [job, tokens] of [...ciJobScripts()].sort()) {
  const row = rowContent.get(job) ?? "";
  const missing = tokens.filter((token) => !row.includes(token.toLowerCase()));
  // Ein Job ganz ohne Skript (z. B. nur docker und ss) hat nichts zu
  // vergleichen; „0/0“ ist dort in Ordnung und kein Befund.
  const ok = missing.length === 0;
  for (const token of missing) {
    problems.push(`${job}: \`${token}\` fehlt in der README-Zeile`);
  }
  console.log(
    `  ${ok ? "ok " : "ABW"} ${job.padEnd(16)} ${tokens.length - missing.length}/${tokens.length}${ok ? "" : ` — fehlt: ${missing.join(", ")}`}`,
  );
}

// --- Artefaktnamen der CI-Tabelle gegen die upload-artifact-Schritte ------
console.log("\nCI-Artefakte in der Tabelle");
const artifactCell = new Map();
for (const line of ciSection.split("\n")) {
  const cells = line.split("|").map((cell) => cell.trim());
  const job = cells[1]?.match(/^`([a-z0-9-]+)`$/)?.[1];
  if (job) artifactCell.set(job, cells[3] ?? "");
}
for (const [job, names] of [...ciJobArtifacts()].sort()) {
  const cell = artifactCell.get(job) ?? "";
  const documented = [...cell.matchAll(/`([a-z0-9-]+-logs)`/g)].map((match) => match[1]);
  const missing = names.filter((name) => !documented.includes(name));
  const extra = documented.filter((name) => !names.includes(name));
  for (const name of missing) problems.push(`${job}: Artefakt \`${name}\` fehlt in der README-Zeile`);
  for (const name of extra) problems.push(`${job}: Artefakt \`${name}\` gibt es in ci.yml nicht`);
  const ok = names.length > 0 && missing.length === 0 && extra.length === 0;
  const details = [];
  if (missing.length > 0) details.push(`fehlt: ${missing.join(", ")}`);
  if (extra.length > 0) details.push(`zu viel: ${extra.join(", ")}`);
  console.log(
    `  ${ok ? "ok " : "ABW"} ${job.padEnd(16)} ${names.length - missing.length}/${names.length}${ok ? "" : ` — ${details.join("; ")}`}`,
  );
}

// --- Aufbewahrungsdauer der Artefakte gegen die README --------------------
console.log("\nCI-Aufbewahrung");
const retentionMatch = readme.match(/liegen (\d+) Tage bereit/);
const documentedDays = retentionMatch ? Number(retentionMatch[1]) : null;
if (documentedDays === null) {
  problems.push("README: Angabe „liegen <n> Tage bereit“ fehlt");
}
const retention = ciJobRetention();
const artifacts = ciJobArtifacts();
for (const [job, days] of [...retention].sort()) {
  const uploads = artifacts.get(job)?.length ?? 0;
  if (uploads > 0 && days.length === 0) {
    problems.push(`${job}: upload-artifact ohne retention-days (GitHub-Default 90 Tage)`);
  }
  for (const day of days) {
    if (documentedDays !== null && day !== documentedDays) {
      problems.push(`${job}: retention-days ${day}, README nennt ${documentedDays}`);
    }
  }
}
const allDays = [...retention.values()].flat();
const retentionOk =
  documentedDays !== null &&
  allDays.length > 0 &&
  allDays.every((day) => day === documentedDays) &&
  [...artifacts].every(([job, names]) => names.length === 0 || (retention.get(job) ?? []).length > 0);
console.log(
  `  ${retentionOk ? "ok " : "ABW"} README ${documentedDays ?? "?"} Tage · ci.yml ${allDays.join(", ") || "—"}`,
);

// --- Jeder genannte `bun run <skript>` muss in package.json existieren -----
// Ein umbenanntes Skript bleibt sonst als toter Befehl in der Anleitung stehen.
let scripts = {};
try {
  scripts = JSON.parse(read(PACKAGE_URL)).scripts ?? {};
} catch (error) {
  problems.push(`package.json nicht lesbar: ${error.message}`);
}

console.log("\nDokumentierte Befehle");
for (const { label, text } of [
  { label: "README.md", text: readme },
  { label: "docs/testing.md", text: docs },
]) {
  const mentioned = [...new Set([...text.matchAll(/`bun run ([A-Za-z0-9:_-]+)/g)].map((match) => match[1]))].sort();
  const missing = mentioned.filter((name) => !Object.hasOwn(scripts, name));
  const ok = mentioned.length > 0 && missing.length === 0;
  if (missing.length > 0) {
    problems.push(`${label}: ${missing.map((name) => `\`bun run ${name}\``).join(", ")} fehlt in package.json`);
  }
  console.log(
    `  ${ok ? "ok " : "ABW"} ${label.padEnd(16)} ${mentioned.length - missing.length}/${mentioned.length}${ok ? "" : ` — fehlt: ${missing.join(", ")}`}`,
  );
}

// --- Interne Links und Anker in beiden Dokumenten -------------------------
// Ein Verweis auf einen umbenannten Abschnitt fällt sonst erst im Browser auf.
function stripFences(text) {
  let out = "";
  let fence = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      fence = !fence;
      continue;
    }
    if (!fence) out += `${line}\n`;
  }
  return out;
}

/** GitHub-Slug einer Überschrift: klein, Sonderzeichen raus, Leerzeichen zu `-`. */
function headingSlug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\- _]/gu, "")
    .replace(/ /g, "-");
}

/** Alle Anker einer Datei, inklusive der `-1`, `-2`-Suffixe für Doppelungen. */
function anchorsOf(file) {
  const seen = new Map();
  const anchors = new Set();
  for (const line of stripFences(read(file)).split("\n")) {
    const match = line.match(/^#{1,6}\s+(.*)$/);
    if (!match) continue;
    const base = headingSlug(match[1]);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

console.log("\nInterne Links in allen Markdown-Dateien");
const anchorCache = new Map();
const reportedLinks = new Set();
/** Meldet jede kaputte Stelle einmal, auch wenn ein Dokument sie doppelt nennt. */
function reportLink(problem) {
  if (reportedLinks.has(problem)) return;
  reportedLinks.add(problem);
  problems.push(problem);
}
const documents = [
  { label: "README.md", url: README_URL, text: readme },
  ...allFiles()
    .filter((file) => file.endsWith(".md") && file !== "README.md")
    .sort()
    .map((file) => {
      const url = new URL(`../${file}`, import.meta.url);
      return { label: file, url, text: file === "docs/testing.md" ? docs : read(url) };
    }),
];
let totalLinks = 0;
for (const { label, url, text } of documents) {
  let links = 0;
  let broken = 0;
  for (const match of stripFences(text).matchAll(/(!?)\[([^\]]*)\]\(([^)\s]+)\)/g)) {
    const [, isImage, , target] = match;
    if (isImage || /^(https?:|mailto:)/.test(target)) continue;
    links += 1;
    const [targetPath, anchor] = target.split("#");
    const file = targetPath
      ? targetPath.startsWith("/")
        ? join(ROOT, targetPath)
        : fileURLToPath(new URL(targetPath, url))
      : fileURLToPath(url);
    if (!existsSync(file)) {
      broken += 1;
      reportLink(`${label}: Linkziel ${target} existiert nicht`);
      continue;
    }
    if (anchor === undefined) continue;
    if (!anchorCache.has(file)) anchorCache.set(file, anchorsOf(file));
    if (!anchorCache.get(file).has(anchor)) {
      broken += 1;
      reportLink(`${label}: Anker #${anchor} fehlt in ${relative(ROOT, file).split(sep).join("/")}`);
    }
  }
  totalLinks += links;
  const ok = broken === 0;
  const text2 = links === 0 ? "keine Links" : `${links - broken}/${links} Links`;
  console.log(`  ${ok ? "ok " : "ABW"} ${label.padEnd(30)} ${text2}${ok ? "" : " — tot oder Anker fehlt"}`);
}
if (totalLinks === 0) {
  problems.push("Interne Links: kein einziger relativer Link gefunden");
}

// --- Jede Migration muss in der Invarianten-Doku stehen -------------------
// Dort stehen Zusicherung und prüfender Test je Migration; ohne Link fällt
// eine neue Migration niemandem auf, weil ihre Zahl nirgends auftaucht.
console.log("\nMigrationen in der Invarianten-Doku");
const MIGRATIONSDOKU = "docs/rpc-invarianten.md";
const MIGRATIONSORDNER = join(ROOT, "supabase/migrations");
const migrations = existsSync(MIGRATIONSORDNER)
  ? readdirSync(MIGRATIONSORDNER).filter((name) => name.endsWith(".sql")).sort()
  : [];
if (migrations.length === 0) {
  problems.push("supabase/migrations: keine .sql-Datei gefunden");
}
const migrationsdokuUrl = new URL(`../${MIGRATIONSDOKU}`, import.meta.url);
const migrationsdokuText = existsSync(fileURLToPath(migrationsdokuUrl))
  ? read(migrationsdokuUrl)
  : "";
if (migrationsdokuText === "") {
  problems.push(`${MIGRATIONSDOKU} fehlt oder ist leer`);
}
const verlinkteMigrationen = new Set();
for (const match of stripFences(migrationsdokuText).matchAll(/(!?)\[([^\]]*)\]\(([^)\s]+)\)/g)) {
  const target = match[3].split("#")[0];
  if (!target || /^(https?:|mailto:)/.test(target)) continue;
  const ziel = target.startsWith("/")
    ? join(ROOT, target)
    : fileURLToPath(new URL(target, migrationsdokuUrl));
  verlinkteMigrationen.add(relative(ROOT, ziel).split(sep).join("/"));
}
const fehlendeMigrationen = migrations.filter(
  (name) => !verlinkteMigrationen.has(`supabase/migrations/${name}`),
);
for (const name of fehlendeMigrationen) {
  problems.push(`${MIGRATIONSDOKU}: supabase/migrations/${name} ist nicht verlinkt`);
}
const migrationenOk =
  migrations.length > 0 && migrationsdokuText !== "" && fehlendeMigrationen.length === 0;
console.log(
  `  ${migrationenOk ? "ok " : "ABW"} ${migrations.length} Migration(en) · ` +
    `${migrations.length - fehlendeMigrationen.length}/${migrations.length} in ${MIGRATIONSDOKU} verlinkt`,
);
if (!migrationenOk) {
  for (const name of fehlendeMigrationen) console.log(`      supabase/migrations/${name}`);
}

// --- Skripte und Pfade, die die Workflows referenzieren -------------------
// Ein umbenanntes Skript fällt sonst erst im CI-Lauf auf. Erzeugte Pfade
// (`ci-logs/`, `.next/trace`, Logs in `/tmp`) entstehen erst im Lauf und
// werden deshalb nicht verlangt.
/** Kommentarzeilen fliegen raus: nur Ausgeführtes zählt. */
function withoutComments(text) {
  return text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

/** Alle `scripts` aus Root- und Workspace-`package.json`, Name zu Datei. */
function scriptOwners() {
  const owners = new Map();
  const files = allFiles().filter(
    (file) => file === "package.json" || /^(?:apps|packages)\/[^/]+\/package\.json$/.test(file),
  );
  for (const file of files) {
    let parsed;
    try {
      parsed = JSON.parse(read(new URL(`../${file}`, import.meta.url)));
    } catch (error) {
      problems.push(`${file}: nicht lesbar (${error.message})`);
      continue;
    }
    for (const name of Object.keys(parsed.scripts ?? {})) {
      if (!owners.has(name)) owners.set(name, []);
      owners.get(name).push(file);
    }
  }
  return owners;
}

console.log("\nSkripte und Pfade in den Workflows");
const owners = scriptOwners();
const workflowFiles = allFiles().filter((file) => /^\.github\/.*\.ya?ml$/.test(file)).sort();
if (workflowFiles.length === 0) {
  problems.push("Workflows: keine YAML-Datei unter .github/ gefunden");
}
for (const file of workflowFiles) {
  const text = withoutComments(read(new URL(`../${file}`, import.meta.url)));
  const found = [];

  const runScripts = [...new Set([...text.matchAll(/\bbun run ([A-Za-z0-9:_-]+)/g)].map((match) => match[1]))].sort();
  for (const name of runScripts) {
    if (!owners.has(name)) found.push(`\`bun run ${name}\` fehlt in jedem package.json`);
  }
  const runnerScripts = [
    ...new Set([...text.matchAll(/\b(?:node|bun) (scripts\/[A-Za-z0-9._/-]+)/g)].map((match) => match[1])),
  ].sort();
  for (const script of runnerScripts) {
    if (!existsSync(join(ROOT, script))) found.push(`\`${script}\` existiert nicht`);
  }

  // Pfade, die vor dem Lauf da sein müssen. `hashFiles` zählt nur, wenn der
  // Schritt nicht selbst unter dieser Bedingung steht (optionaler Input).
  const guarded = new Set(
    text
      .split("\n")
      .filter((line) => /^\s*if:/.test(line))
      .flatMap((line) => [...line.matchAll(/hashFiles\(\s*'([^']+)'\s*\)/g)].map((match) => match[1])),
  );
  const pathChecks = new Map();
  const addPath = (path, kind) => {
    if (!path || path.includes("$") || path.startsWith("/")) return;
    if (!pathChecks.has(path) || kind === "action") pathChecks.set(path, kind);
  };
  for (const match of text.matchAll(/uses:\s+\.\/([^\s#]+)/g)) addPath(match[1], "action");
  for (const match of text.matchAll(/(?:^|[\s(&;|])cd\s+([^\s&;|)]+)/gm)) addPath(match[1], "dir");
  for (const match of text.matchAll(/working-directory:\s*([^\s#]+)/g)) addPath(match[1], "dir");
  for (const match of text.matchAll(/hashFiles\(\s*'([^']+)'\s*\)/g)) {
    if (!guarded.has(match[1])) addPath(match[1], "file");
  }

  // `supabase start` liest die Projektdatei und spielt die Migrationen ein.
  const startsSupabase = /\bsupabase start\b/.test(text);
  if (startsSupabase) {
    addPath("supabase/config.toml", "file");
    addPath("supabase/migrations", "dir");
  }

  for (const [path, kind] of pathChecks) {
    const full = join(ROOT, path);
    const ok =
      existsSync(full) &&
      (kind !== "action" || existsSync(join(full, "action.yml")) || existsSync(join(full, "action.yaml")));
    if (!ok) {
      found.push(kind === "action" ? `lokale Action \`${path}\` fehlt oder hat kein action.yml` : `Pfad \`${path}\` existiert nicht`);
    }
  }

  if (startsSupabase && existsSync(join(ROOT, "supabase/migrations"))) {
    const migrations = readdirSync(join(ROOT, "supabase/migrations")).filter((entry) => entry.endsWith(".sql"));
    if (migrations.length === 0) {
      found.push("`supabase start` findet keine Migration in `supabase/migrations`");
    }
  }

  const references = runScripts.length + runnerScripts.length + pathChecks.size;
  if (references === 0) found.push("keine Skripte oder Pfade gefunden");
  for (const line of found) problems.push(`${file}: ${line}`);
  const ok = found.length === 0;
  const counts = `${runScripts.length + runnerScripts.length} Skripte · ${pathChecks.size} Pfade`;
  console.log(`  ${ok ? "ok " : "ABW"} ${file.padEnd(42)} ${counts}${ok ? "" : ` — ${found.join("; ")}`}`);
}

if (problems.length > 0) {
  console.error("\nAbweichungen:");
  for (const line of problems) console.error(`  ${line}`);
  console.error("Bitte README.md und docs/testing.md angleichen.");
  process.exit(1);
}

console.log("\nAlle Zahlangaben stimmen.");
