#!/usr/bin/env node
/**
 * Prüft die relativen Links der Doku gegen das Repository.
 *
 * Geprüft werden `docs/` und die `README.md` im Wurzelverzeichnis. Die Links
 * dort zeigen auf Migrationsdateien, Skripte und andere Doku.
 * Wird ein Ziel umbenannt oder verschoben, soll die CI rot werden — und nicht
 * erst der Leser ins Leere klicken.
 *
 * Geprüft wird nur, was ohne Netz entscheidbar ist: externe URLs, `mailto:`
 * und reine Sprungmarken (`#…`) bleiben außen vor. Relative Ziele werden ab
 * der Datei aufgelöst, absolute (`/docs/x`) ab der Repo-Wurzel.
 *
 * Zweite Prüfung: jede Migration aus `supabase/migrations/` muss in
 * `docs/rpc-invarianten.md` verlinkt sein. Dort steht, welche Zusicherung sie
 * trägt und welcher Test sie prüft — eine neue Migration ohne Link fällt sonst
 * niemandem auf.
 *
 * Aufruf: `node scripts/check-docs-links.mjs [pfad …]`
 * (Default: `docs` und `README.md`).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ARGUMENTE = process.argv.slice(2);
const WURZELN = ARGUMENTE.length > 0 ? ARGUMENTE : ["docs", "README.md"];
const MARKDOWN = /\.mdx?$/i;
const MIGRATIONEN = "supabase/migrations";
const MIGRATIONSDOKU = "docs/rpc-invarianten.md";
// [Text](ziel) und [Text](ziel "Titel"); Bilder (![alt](src)) fallen mit darunter.
const LINK = /\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;

/** Sammelt alle Markdown-Dateien unter einem Pfad (Datei oder Verzeichnis). */
function markdownDateien(pfad) {
  if (!existsSync(pfad)) return [];
  if (!statSync(pfad).isDirectory()) return MARKDOWN.test(pfad) ? [pfad] : [];
  return readdirSync(pfad, { withFileTypes: true }).flatMap((eintrag) => {
    const kind = join(pfad, eintrag.name);
    if (eintrag.isDirectory()) {
      return eintrag.name === "node_modules" ? [] : markdownDateien(kind);
    }
    return MARKDOWN.test(eintrag.name) ? [kind] : [];
  });
}

/**
 * Entfernt Code, damit Beispiele nicht als Link gelten: gezäunte Blöcke,
 * Inline-Code. Die Zeilennummern bleiben dabei erhalten.
 */
function ohneCode(text) {
  let imZaun = false;
  return text
    .split("\n")
    .map((zeile) => {
      if (/^\s*(```|~~~)/.test(zeile)) {
        imZaun = !imZaun;
        return "";
      }
      return imZaun ? "" : zeile.replace(/`[^`]*`/g, "");
    })
    .join("\n");
}

/** Liefert das Repo-Ziel eines Links oder null, wenn es keins ist. */
function repoZiel(ziel) {
  const roh = ziel.trim();
  if (roh === "" || roh.startsWith("#")) return null;
  // http:, https:, mailto:, data: … sowie protokollrelative //host/pfad
  if (/^[a-z][a-z0-9+.-]*:/i.test(roh) || roh.startsWith("//")) return null;
  const ohneAnker = roh.split("#")[0].split("?")[0];
  try {
    return decodeURIComponent(ohneAnker);
  } catch {
    return ohneAnker;
  }
}

/**
 * Löst ein Linkziel ab der Datei zu einem Repo-Pfad auf; null, wenn das Ziel
 * außerhalb des Repos liegt.
 */
function pfadImRepo(datei, ziel) {
  const pfad = ziel.startsWith("/")
    ? resolve(".", `.${ziel}`)
    : resolve(dirname(datei), ziel);
  const relativ = relative(".", pfad);
  return relativ.startsWith("..") ? null : relativ;
}

/** Alle Repo-Pfade, auf die eine Markdown-Datei relativ verlinkt. */
function verlinkteZiele(datei) {
  const ziele = new Set();
  ohneCode(readFileSync(datei, "utf8"))
    .split("\n")
    .forEach((zeile) => {
      for (const treffer of zeile.matchAll(LINK)) {
        const ziel = repoZiel(treffer[1]);
        if (ziel === null) continue;
        const pfad = pfadImRepo(datei, ziel);
        if (pfad !== null) ziele.add(pfad);
      }
    });
  return ziele;
}

let dateien = 0;
let links = 0;
let dateienMitFehlern = 0;

for (const datei of WURZELN.flatMap(markdownDateien).sort()) {
  dateien += 1;
  const defekt = [];
  let anzahl = 0;

  ohneCode(readFileSync(datei, "utf8"))
    .split("\n")
    .forEach((zeile, index) => {
      for (const treffer of zeile.matchAll(LINK)) {
        const ziel = repoZiel(treffer[1]);
        if (ziel === null) continue;
        anzahl += 1;
        const pfad = pfadImRepo(datei, ziel);
        if (pfad === null) {
          defekt.push(`${datei}:${index + 1} → ${treffer[1]} (außerhalb des Repos)`);
        } else if (!existsSync(pfad)) {
          defekt.push(`${datei}:${index + 1} → ${treffer[1]}`);
        }
      }
    });

  links += anzahl;
  if (defekt.length === 0) {
    console.log(`PASS ${datei}: ${anzahl} relative Links, alle Ziele vorhanden`);
    continue;
  }
  dateienMitFehlern += 1;
  console.log(`FAIL ${datei}: ${defekt.length} von ${anzahl} relativen Links ohne Ziel`);
  for (const zeile of defekt) console.log(`     ${zeile}`);
}

// Jede Migration gehört in die Invarianten-Doku. Der Abgleich läuft immer,
// auch wenn das Skript nur einzelne Dateien prüft.
const migrationen = existsSync(MIGRATIONEN)
  ? readdirSync(MIGRATIONEN)
      .filter((name) => name.endsWith(".sql"))
      .sort()
  : [];
let migrationenOhneLink = 0;

if (migrationen.length > 0) {
  const dokumentiert = verlinkteZiele(MIGRATIONSDOKU);
  const fehlend = migrationen.filter(
    (name) => !dokumentiert.has(join(MIGRATIONEN, name)),
  );
  if (fehlend.length === 0) {
    console.log(
      `PASS ${MIGRATIONEN}: alle ${migrationen.length} Migration(en) in ${MIGRATIONSDOKU} verlinkt`,
    );
  } else {
    migrationenOhneLink = fehlend.length;
    console.log(
      `FAIL ${MIGRATIONEN}: ${fehlend.length} von ${migrationen.length} Migration(en) nicht in ${MIGRATIONSDOKU} verlinkt`,
    );
    for (const name of fehlend) console.log(`     ${MIGRATIONEN}/${name}`);
  }
}

console.log(
  `\nErgebnis: ${dateien} Datei(en) unter ${WURZELN.join(", ")}, ${links} relative Links geprüft, ` +
    `${dateienMitFehlern} Datei(en) mit Fehlschlägen, ` +
    `${migrationenOhneLink} Migration(en) ohne Link in ${MIGRATIONSDOKU}.`,
);
process.exit(dateienMitFehlern === 0 && migrationenOhneLink === 0 ? 0 : 1);
