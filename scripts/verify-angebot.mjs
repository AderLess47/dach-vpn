#!/usr/bin/env node
/**
 * Prüft die kaufmännischen Dokumente gegen die Kalkulationsbasis.
 *
 * Geprüft werden:
 *   - Meilenstein- und Gesamtsummen (§1) gegen kalkulation.csv
 *   - Rollentabelle und Matrix Meilenstein × Rolle (§4.1/§4.2)
 *   - jede AP-Zeile (Rollen, Stunden, Summe)
 *   - P80 (+12 %) und Zahlungsplan (Prozente und Beträge)
 *   - Risikotabelle gegen die genannte Summe
 *   - Variante B (Delta-CSV) und A+ in Variantenvergleich + Entscheidungsvorlage
 *   - AP-Referenzen in allen Markdown-Dateien
 *
 * Keine Abhängigkeiten: reines Node, damit es in CI und lokal ohne Setup läuft.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

const ANGEBOT = "angebot/Angebot-DACH-VPN.md";
const VARIANTEN = "angebot/Variantenvergleich-SSO.md";
const ENTSCHEIDUNG = "angebot/Entscheidungsvorlage-SSO.md";
const P80_FACTOR = 1.12;

let failures = 0;
function check(condition, message) {
  console.log(`${condition ? "PASS" : "FAIL"} ${message}`);
  if (!condition) failures += 1;
}

/** Zahl im deutschen Format ("3.208", "362.260 €", "112,90") → number. */
function num(text) {
  return Number(String(text).replace(/\./g, "").replace(",", ".").replace(/[^\d.]/g, ""));
}

function fmt(value) {
  return Math.round(value).toLocaleString("de-DE");
}

/** Minimaler CSV-Parser für Semikolon-Dateien inkl. Anführungszeichen. */
function readCsv(relativePath) {
  const text = readFileSync(path.join(root, relativePath), "utf8").trim();
  const lines = text.split(/\r?\n/);
  const header = splitCsvLine(lines[0]);

  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row = {};
    header.forEach((key, index) => {
      row[key] = cells[index] ?? "";
    });
    return row;
  });
}

function splitCsvLine(line) {
  const cells = [];
  let current = "";
  let quoted = false;

  for (const char of line) {
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === ";" && !quoted) {
      cells.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells;
}

// --- Kalkulationsbasis einlesen -------------------------------------------
const positionen = readCsv("angebot/kalkulation.csv");
const deltaZeilen = readCsv("angebot/variante-b-delta.csv");

const perMs = new Map();
const perRole = new Map();
const perMsRole = new Map();
const perAp = new Map();
const sätze = new Map();

for (const row of positionen) {
  const ms = row.meilenstein;
  const role = row.rolle;
  const hours = Number(row.stunden);
  const rate = Number(row.satz);

  perMs.set(ms, (perMs.get(ms) ?? 0) + hours);
  const roleEntry = perRole.get(role) ?? { hours: 0, euro: 0, rates: new Set() };
  roleEntry.hours += hours;
  roleEntry.euro += hours * rate;
  roleEntry.rates.add(rate);
  perRole.set(role, roleEntry);
  sätze.set(role, rate);

  if (!perMsRole.has(ms)) perMsRole.set(ms, new Map());
  const msRole = perMsRole.get(ms);
  msRole.set(role, (msRole.get(role) ?? 0) + hours);

  if (!perAp.has(row.ap)) perAp.set(row.ap, new Map());
  const apEntry = perAp.get(row.ap);
  apEntry.set(role, (apEntry.get(role) ?? 0) + hours);
}

const apSumme = (ap) => [...perAp.get(ap).values()].reduce((a, b) => a + b, 0);
const totalHours = [...perMs.values()].reduce((a, b) => a + b, 0);
const totalEuro = [...perRole.values()].reduce((a, b) => a + b.euro, 0);
const msEuro = new Map(
  [...perMs.keys()].map((ms) => [
    ms,
    [...perMsRole.get(ms)].reduce((sum, [role, hours]) => sum + hours * sätze.get(role), 0),
  ]),
);

const msOrder = [...perMs.keys()].sort();
const rollen = [...perRole.keys()];

console.log(
  `→ Basis: ${positionen.length} Positionen, ${perAp.size} APs, ${fmt(totalHours)} h, ${fmt(totalEuro)} €`,
);

// --- Variante B aus dem Delta -------------------------------------------------
let deltaHours = 0;
let deltaEuro = 0;
const msDelta = new Map();
const perDeltaAp = new Map();
for (const row of deltaZeilen) {
  const hoursDelta = Number(row.stunden_b) - Number(row.stunden_a);
  // Kostenänderung: negative Stunden bedeuten Einsparung.
  const euroDelta = hoursDelta * Number(row.satz);
  deltaHours += hoursDelta;
  deltaEuro += euroDelta;
  const apEntry = perDeltaAp.get(row.ap) ?? { a: 0, b: 0, delta: 0 };
  apEntry.a += Number(row.stunden_a);
  apEntry.b += Number(row.stunden_b);
  apEntry.delta += hoursDelta;
  perDeltaAp.set(row.ap, apEntry);
  const ms = `M${row.ap.split(".")[0]}`;
  const entry = msDelta.get(ms) ?? { hours: 0, euro: 0 };
  entry.hours += hoursDelta;
  entry.euro += euroDelta;
  msDelta.set(ms, entry);
}
const bHours = totalHours + deltaHours;
const bEuro = totalEuro + deltaEuro;

console.log("→ Delta-CSV gegen Kalkulation");
for (const [ap, entry] of perDeltaAp) {
  check(
    entry.a === apSumme(ap),
    `Delta AP ${ap}: Ausgangsstunden ${entry.a} h (Kalkulation ${apSumme(ap)} h)`,
  );
  check(entry.b === entry.a + entry.delta, `Delta AP ${ap}: B ${entry.b} h = A ${entry.a} h + Δ ${entry.delta} h`);
}

// --- Angebot parsen ----------------------------------------------------------
const angebot = readFileSync(path.join(root, ANGEBOT), "utf8").split(/\r?\n/);

console.log("→ §1 Meilensteine");
for (const line of angebot) {
  const row = /^\|\s*\*\*(M\d)\*\*\s*\|.*?\|\s*([\d.]+)\s*h\s*\|\s*([\d.]+)\s*€\s*\|/.exec(line);
  if (row) {
    const [, ms, hours, euro] = row;
    check(
      num(hours) === perMs.get(ms),
      `${ms}: ${hours} h in der Tabelle, ${perMs.get(ms)} h in der CSV`,
    );
    check(
      num(euro) === Math.round(msEuro.get(ms)),
      `${ms}: ${euro} € in der Tabelle, ${fmt(msEuro.get(ms))} € in der CSV`,
    );
  }
}

// Eindeutig die Gesamtsumme aus §1: | **Summe** | | **3.208 h** | **362.260 €** |
const gesamtZeile = angebot
  .map((line) =>
    /\|\s*\*\*Summe\*\*\s*\|[^|]*\|\s*\*\*([\d.]+) h\*\*\s*\|\s*\*\*([\d.]+) €\*\*/.exec(line),
  )
  .find(Boolean);
if (!gesamtZeile) {
  check(false, "Gesamtsumme in §1 nicht gefunden");
} else {
  check(num(gesamtZeile[1]) === totalHours, `Summe: ${gesamtZeile[1]} h (CSV ${fmt(totalHours)} h)`);
  check(
    num(gesamtZeile[2]) === Math.round(totalEuro),
    `Summe: ${gesamtZeile[2]} € (CSV ${fmt(totalEuro)} €)`,
  );
}

console.log("→ P80-Kennzahlen");
const p80Hours = Math.round(totalHours * P80_FACTOR);
const p80Euro = Math.round(totalEuro * P80_FACTOR);
const angebotText = angebot.join("\n");
check(angebotText.includes(`${fmt(p80Hours)} h`), `P80-Stunden ${fmt(p80Hours)} h im Dokument`);
check(angebotText.includes(`${fmt(p80Euro)} €`), `P80-Investition ${fmt(p80Euro)} € im Dokument`);

console.log("→ §4.1 Rollentabelle");
let rollenGeprueft = 0;
for (const line of angebot) {
  const row = /^\|\s*[^|]+\|\s*([A-Z]+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*([\d.]+)\s*€\s*\|$/.exec(line);
  if (!row) continue;
  const [, role, rate, hours, euro] = row;
  const entry = perRole.get(role);
  rollenGeprueft += 1;
  if (!entry) {
    check(false, `${role}: Rolle kommt in der CSV nicht vor`);
    continue;
  }
  check(
    Number(rate) === [...entry.rates][0] && entry.rates.size === 1,
    `${role}: Satz ${rate} €/h (CSV ${[...entry.rates].join("/")})`,
  );
  check(entry.hours === Number(hours), `${role}: ${hours} h (CSV ${entry.hours})`);
  check(
    Math.round(entry.euro) === num(euro),
    `${role}: ${euro} € (CSV ${fmt(entry.euro)} €)`,
  );
}
check(rollenGeprueft === rollen.length, `${rollenGeprueft} Rollen geprüft (CSV: ${rollen.length})`);

console.log("→ §4.2 Matrix Meilenstein × Rolle");
// Spaltenreihenfolge aus der Tabellenkopfzeile lesen, nicht aus der CSV.
const matrixKopf = angebot.find(
  (line) => line.startsWith("| Meilenstein |") && line.includes("ARCH"),
);
const matrixRollen = matrixKopf
  ? matrixKopf.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()).slice(1, -1)
  : [];
check(
  matrixRollen.length === rollen.length,
  `Kopfzeile der Matrix: ${matrixRollen.length} Rollenspalten (CSV: ${rollen.length})`,
);
let matrixZeilen = 0;
for (const line of angebot) {
  const row = /^\|\s*(M\d)\s*\|(.*)\|\s*\*{0,2}(\d+)\*{0,2}\s*\|$/.exec(line);
  if (!row) continue;
  const [, ms, rest, summe] = row;
  const cells = rest.split("|").map((cell) => cell.trim().replaceAll("*", ""));
  if (cells.length !== matrixRollen.length) {
    check(false, `${ms}: ${cells.length} Rollenspalten, erwartet ${matrixRollen.length}`);
    continue;
  }
  matrixZeilen += 1;
  matrixRollen.forEach((role, index) => {
    const value = cells[index] === "–" || cells[index] === "" ? 0 : Number(cells[index]);
    check(
      value === (perMsRole.get(ms)?.get(role) ?? 0),
      `${ms}/${role}: ${value} h (CSV ${perMsRole.get(ms)?.get(role) ?? 0} h)`,
    );
  });
  check(Number(summe) === perMs.get(ms), `${ms}: Zeilensumme ${summe} h`);
}
check(matrixZeilen === msOrder.length, `${matrixZeilen} Meilensteinzeilen geprüft`);

console.log("→ AP-Tabellen");
let apZeilen = 0;
const geseheneAps = new Set();
for (const line of angebot) {
  const row = /^\|\s*(\d+\.\d+)\s*\|.+?\|\s*([A-Z]+(?:\s*\/\s*[A-Z]+)*)\s*\|\s*([\d\s/]+)\s*\|$/.exec(line);
  if (!row) continue;
  const [, ap, rolesRaw, hoursRaw] = row;
  const roleList = rolesRaw.split("/").map((role) => role.trim());
  const hourList = hoursRaw.split("/").map((hours) => Number(hours.trim()));
  if (roleList.length !== hourList.length) {
    check(false, `AP ${ap}: ${roleList.length} Rollen, ${hourList.length} Stundenangaben`);
    continue;
  }
  apZeilen += 1;
  geseheneAps.add(ap);
  const docEntry = new Map(roleList.map((role, index) => [role, hourList[index]]));
  const csvEntry = perAp.get(ap);
  if (!csvEntry) {
    check(false, `AP ${ap}: in der CSV nicht vorhanden`);
    continue;
  }
  check(
    [...csvEntry.keys()].length === docEntry.size &&
      [...csvEntry].every(([role, hours]) => docEntry.get(role) === hours),
    `AP ${ap}: Rollen/Stunden dokumentiert wie kalkuliert`,
  );
  check(
    hourList.reduce((a, b) => a + b, 0) === apSumme(ap),
    `AP ${ap}: Summe ${hourList.reduce((a, b) => a + b, 0)} h (CSV ${apSumme(ap)} h)`,
  );
}
check(apZeilen === perAp.size, `${apZeilen} AP-Zeilen geprüft (CSV: ${perAp.size})`);
check(geseheneAps.size === perAp.size, "jedes AP hat eine Tabellenzeile");

console.log("→ §15 Zahlungsplan");
let prozent = 0;
let betrag = 0;
let raten = 0;
for (const line of angebot) {
  const row = /^\|\s*(\d+)\s*\|.*\|\s*(\d+)\s*%\s*\|\s*([\d.]+)\s*€\s*\|$/.exec(line);
  if (!row) continue;
  const [, , pct, euro] = row;
  raten += 1;
  prozent += Number(pct);
  betrag += num(euro);
  check(
    num(euro) === Math.round((totalEuro * Number(pct)) / 100),
    `Rate ${raten}: ${pct} % = ${euro} € (erwartet ${fmt((totalEuro * Number(pct)) / 100)} €)`,
  );
}
check(prozent === 100, `${raten} Raten summieren sich auf ${prozent} %`);
check(betrag === Math.round(totalEuro), `Raten summieren sich auf ${fmt(betrag)} €`);

console.log("→ §17 Risikotabelle");
const risikoStart = angebot.findIndex((line) => line.startsWith("## 17."));
let deltaMin = 0;
let deltaMax = 0;
let risikoZeilen = 0;
if (risikoStart >= 0) {
  for (const line of angebot.slice(risikoStart, risikoStart + 40)) {
    const cells = line.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
    if (cells.length < 5 || !/^\d+$/.test(cells[0])) continue;
    const zahlen = cells.at(-1).match(/\d+/g);
    if (!zahlen) continue;
    risikoZeilen += 1;
    deltaMin += Number(zahlen[0]);
    deltaMax += Number(zahlen.at(-1));
  }
  check(risikoZeilen > 0, `${risikoZeilen} Risikopositionen erfasst`);
  const satz = angebot.slice(risikoStart).join("\n");
  const behauptung = /Summe möglicher Zusatzaufwände: (\d+)–(\d+) h\. Der P80-Puffer von (\d+) h/.exec(satz);
  if (!behauptung) {
    check(false, "Summensatz der Risikotabelle nicht gefunden");
  } else {
    check(
      /Summe möglicher Zusatzaufwände: (\d+)–(\d+) h/.exec(satz)[1] === String(deltaMin) &&
        /\d+–(\d+) h/.exec(satz)[1] === String(deltaMax),
      `Risikosumme ${behauptung[1]}–${behauptung[2]} h (Tabelle ${deltaMin}–${deltaMax} h)`,
    );
    check(
      Number(behauptung[3]) === p80Hours - totalHours,
      `P80-Puffer ${behauptung[3]} h (rechnerisch ${p80Hours - totalHours} h)`,
    );
  }
} else {
  check(false, "Abschnitt 17 nicht gefunden");
}

console.log("→ Varianten B und A+");
const varianten = readFileSync(path.join(root, VARIANTEN), "utf8");
const entscheidung = readFileSync(path.join(root, ENTSCHEIDUNG), "utf8");

for (const [name, text] of [
  ["Variantenvergleich", varianten],
  ["Entscheidungsvorlage", entscheidung],
]) {
  check(text.includes(`${fmt(totalHours)} h`), `${name}: A-Stunden ${fmt(totalHours)} h genannt`);
  check(text.includes(`${fmt(totalEuro)} €`), `${name}: A-Investition ${fmt(totalEuro)} € genannt`);
  check(text.includes(`${fmt(bHours)} h`), `${name}: B-Stunden ${fmt(bHours)} h genannt`);
  check(text.includes(`${fmt(bEuro)} €`), `${name}: B-Investition ${fmt(bEuro)} € genannt`);
}

check(
  varianten.includes(
    `−${Math.abs(deltaHours)} h / −${fmt(Math.abs(deltaEuro))} €`,
  ),
  `Variantenvergleich: Delta −${Math.abs(deltaHours)} h / −${fmt(Math.abs(deltaEuro))} €`,
);
check(
  Math.round(bHours * P80_FACTOR) === 3508 && Math.round(bEuro * P80_FACTOR) === 396323,
  `P80 B: ${fmt(Math.round(bHours * P80_FACTOR))} h / ${fmt(Math.round(bEuro * P80_FACTOR))} €`,
);

const m4Delta = msDelta.get("M4") ?? { hours: 0, euro: 0 };
const m5Delta = msDelta.get("M5") ?? { hours: 0, euro: 0 };
check(
  varianten.includes(
    `${fmt(perMs.get("M4"))} h / ${fmt(msEuro.get("M4"))} € | ${fmt(perMs.get("M4") + m4Delta.hours)} h / ${fmt(msEuro.get("M4") + m4Delta.euro)} €`,
  ),
  `M4 in B: ${fmt(perMs.get("M4") + m4Delta.hours)} h / ${fmt(msEuro.get("M4") + m4Delta.euro)} €`,
);
check(
  varianten.includes(
    `${fmt(perMs.get("M5"))} h / ${fmt(msEuro.get("M5"))} € | ${fmt(perMs.get("M5") + m5Delta.hours)} h / ${fmt(msEuro.get("M5") + m5Delta.euro)} €`,
  ),
  `M5 in B: ${fmt(perMs.get("M5") + m5Delta.hours)} h / ${fmt(msEuro.get("M5") + m5Delta.euro)} €`,
);

const aPlusZeile = /Aufwand \|\s*([\d.]+) h \/ ([\d.]+) €\s*\|\s*\*\*([\d.]+) h \/ ([\d.]+) €\*\* \(\+(\d+) h \/ \+([\d.]+) €\)/.exec(varianten);
if (!aPlusZeile) {
  check(false, "A+-Zeile im Variantenvergleich nicht gefunden");
} else {
  const [, aH, aE, plusH, plusE, dH, dE] = aPlusZeile;
  check(num(aH) === totalHours && num(aE) === Math.round(totalEuro), "A+-Zeile nennt A korrekt");
  check(
    num(plusH) === totalHours + Number(dH) && num(plusE) === Math.round(totalEuro) + num(dE),
    `A+: ${plusH} h / ${plusE} € = A + ${dH} h / ${dE} €`,
  );
  check(
    varianten.includes(`${fmt(Math.round((totalHours + Number(dH)) * P80_FACTOR))} h / ${fmt((Math.round(totalEuro) + num(dE)) * P80_FACTOR)} €`),
    "A+-P80 folgt aus A+ × 1,12",
  );
}

console.log("→ §14 Optionen");
const optionenStart = angebot.findIndex((line) => line.startsWith("## 14."));
const optionen = [];
if (optionenStart >= 0) {
  for (const line of angebot.slice(optionenStart, optionenStart + 25)) {
    const row = /^\|\s*([A-Z])\s*\|(.+?)\|\s*(\d+ h|monatlich)\s*\|\s*([\d.]+)\s*€(\/Monat)?\s*\|$/.exec(line);
    if (!row) continue;
    const [, letter, content, aufwand, preis, monatsSuffix] = row;
    const monatlich = aufwand === "monatlich";
    const stunden = monatlich
      ? Number(/(\d+)\s*h(?:\/Monat)?/.exec(content)?.[1] ?? 0)
      : Number(aufwand.replace(" h", ""));
    optionen.push({
      letter,
      monatlich,
      stunden,
      preis: num(preis),
      monatsSuffix: Boolean(monatsSuffix),
    });
  }
}
check(optionen.length === 10, `${optionen.length} Optionen erfasst (erwartet A–J)`);
check(
  new Set(optionen.map((option) => option.letter)).size === optionen.length,
  "Optionsbuchstaben sind eindeutig",
);
check(
  optionen.filter((option) => option.monatlich).map((option) => option.letter).join(",") === "G,J",
  `laufende Optionen: ${optionen.filter((o) => o.monatlich).map((o) => o.letter).join(", ")} (erwartet G, J)`,
);
check(
  optionen.every((option) => option.monatlich === option.monatsSuffix),
  "€/Monat-Suffix passt zur Einordnung als laufende Leistung",
);

const satzListe = [...new Set([...perRole.values()].map((entry) => [...entry.rates][0]))];
// Bewusste Paketpreise ohne Rollensatz. Änderungen hier sind eine kaufmännische
// Entscheidung — der Eintrag hält den Ist-Stand fest, damit Abweichungen auffallen.
const PAKETPREISE = new Map([
  ["F", 130],
  ["J", 1300 / 12],
]);

for (const option of optionen) {
  if (!Number.isFinite(option.stunden) || option.stunden <= 0) {
    check(false, `Option ${option.letter}: Stunden nicht lesbar`);
    continue;
  }
  const satz = option.preis / option.stunden;
  const rollensatz = satzListe.find((rate) => Math.abs(rate - satz) < 0.01);
  const paket = PAKETPREISE.get(option.letter);
  const paketPasst = paket !== undefined && Math.abs(paket - satz) < 0.01;
  const einheit = option.monatlich ? "€/Monat" : "€";
  check(
    rollensatz !== undefined || paketPasst,
    `Option ${option.letter}: ${fmt(option.preis)} ${einheit} / ${option.stunden} h = ${satz.toFixed(2)} €/h` +
      (rollensatz !== undefined
        ? ` (Rollensatz ${rollensatz})`
        : paketPasst
          ? " (hinterlegter Paketpreis)"
          : " — weder Rollensatz noch Paketpreis"),
  );
}

// Plausibilität: Optionen dürfen in keiner Summe des Angebots stecken.
const einmaligeOptionen = optionen.filter((option) => !option.monatlich);
const laufendeOptionen = optionen.filter((option) => option.monatlich);
const optionenStunden = einmaligeOptionen.reduce((sum, option) => sum + option.stunden, 0);
const optionenEuro = einmaligeOptionen.reduce((sum, option) => sum + option.preis, 0);
const mitOptionenStunden = totalHours + optionenStunden;
const mitOptionenEuro = Math.round(totalEuro) + optionenEuro;

check(
  /nicht in der Angebotssumme enthalten/i.test(angebot[optionenStart] ?? ""),
  "§14 ist als „nicht in der Angebotssumme enthalten“ gekennzeichnet",
);
check(
  !angebotText.includes(`${fmt(mitOptionenStunden)} h`),
  `Summe inkl. Optionen (${fmt(mitOptionenStunden)} h) kommt nirgends als Aufwand vor`,
);
check(
  !angebotText.includes(`${fmt(mitOptionenEuro)} €`),
  `Summe inkl. Optionen (${fmt(mitOptionenEuro)} €) kommt nirgends als Betrag vor`,
);
check(
  totalHours !== mitOptionenStunden && Math.round(totalEuro) !== mitOptionenEuro,
  `Angebotssumme (${fmt(totalHours)} h / ${fmt(totalEuro)} €) unterscheidet sich von der Summe inkl. Optionen`,
);
check(
  laufendeOptionen.every((option) => !angebotText.includes(`${fmt(totalEuro + option.preis)} €`)),
  "laufende Optionen sind nicht in die Angebotssumme eingerechnet",
);

console.log("→ AP-Referenzen");
const apIds = new Set(perAp.keys());
const verweise = [];
for (const file of markdownFiles(root)) {
  const text = readFileSync(path.join(root, file), "utf8");
  for (const match of text.matchAll(/AP\s?(\d+\.\d+)/g)) {
    verweise.push({ file, ap: match[1] });
  }
}
const unbekannt = verweise.filter((ref) => !apIds.has(ref.ap));
check(
  unbekannt.length === 0,
  unbekannt.length === 0
    ? `${verweise.length} AP-Referenzen, alle in der CSV vorhanden`
    : `unbekannte APs: ${unbekannt.map((ref) => `${ref.ap} (${ref.file})`).join(", ")}`,
);

// --- Ergebnis ----------------------------------------------------------------
console.log("");
if (failures > 0) {
  console.error(`${failures} Prüfung(en) fehlgeschlagen (Angebotszahlen).`);
  process.exit(1);
}
console.log("Alle Prüfungen bestanden (Angebotszahlen gegen kalkulation.csv).");

function markdownFiles(directory, prefix = "") {
  const found = [];
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
    const relative = prefix ? `${prefix}/${entry}` : entry;
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) {
      found.push(...markdownFiles(full, relative));
    } else if (entry.endsWith(".md")) {
      found.push(relative);
    }
  }
  return found;
}
