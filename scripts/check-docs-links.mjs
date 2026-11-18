#!/usr/bin/env node
/**
 * Prüft die relativen Links der Doku gegen das Repository.
 *
 * Die Links in `docs/` zeigen auf Migrationsdateien, Skripte und andere Doku.
 * Wird ein Ziel umbenannt oder verschoben, soll die CI rot werden — und nicht
 * erst der Leser ins Leere klicken.
 *
 * Geprüft wird nur, was ohne Netz entscheidbar ist: externe URLs, `mailto:`
 * und reine Sprungmarken (`#…`) bleiben außen vor. Relative Ziele werden ab
 * der Datei aufgelöst, absolute (`/docs/x`) ab der Repo-Wurzel.
 *
 * Aufruf: `node scripts/check-docs-links.mjs [pfad …]` (Default: `docs`).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ARGUMENTE = process.argv.slice(2);
const WURZELN = ARGUMENTE.length > 0 ? ARGUMENTE : ["docs"];
const MARKDOWN = /\.mdx?$/i;
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
        const pfad = ziel.startsWith("/")
          ? resolve(".", `.${ziel}`)
          : resolve(dirname(datei), ziel);
        if (relative(".", pfad).startsWith("..")) {
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

console.log(
  `\nErgebnis: ${dateien} Datei(en) unter ${WURZELN.join(", ")}, ${links} relative Links geprüft, ` +
    `${dateienMitFehlern} Datei(en) mit Fehlschlägen.`,
);
process.exit(dateienMitFehlern === 0 ? 0 : 1);
