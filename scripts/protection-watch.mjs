#!/usr/bin/env node
// Wächter für die Branch-Protection auf main: meldet als Issue, wenn die
// Admin-Durchsetzung (`enforce_admins`) aus ist, die Regel ganz fehlt oder der
// Wächter sie nicht lesen darf.
//
// Warum ein eigenes Token: die klassische Branch-Protection ist nur mit
// Adminrechten lesbar — ohne Auth antwortet `GET /branches/{branch}/protection`
// mit 401, und das `GITHUB_TOKEN` eines Workflows hat diese Rechte nie. Gelesen
// wird deshalb `PROTECTION_WATCH_TOKEN` (Fine-grained PAT, nur dieses Repo,
// „Administration: Read-only"); geschrieben (Issues) wird mit dem normalen
// `GITHUB_TOKEN`. Fehlt das Lesetoken, ist der Wächter blind und sagt das als
// Issue — ein stiller grüner Lauf wäre schlimmer als gar kein Wächter. Der Lauf
// bleibt dabei grün, weil der Wächter über Issues meldet und nicht über rote
// Läufe; sonst stünde main dauerhaft rot, bis jemand das Secret anlegt.
//
// Ein offenes Issue wird wiederverwendet (Marker im Body) und bei wieder
// aktivem Schutz geschlossen, damit nicht täglich ein neues entsteht.
// Nur Node-Bordmittel, wie scripts/ci-watch.mjs — kein bun install.

import { appendFile } from "node:fs/promises";
import process from "node:process";

const API = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
const REPO = process.env.GITHUB_REPOSITORY || "";
const READ_TOKEN = process.env.PROTECTION_WATCH_TOKEN || process.env.GITHUB_TOKEN || "";
const WRITE_TOKEN = process.env.GITHUB_TOKEN || READ_TOKEN;
const BRANCH = process.env.PROTECTION_BRANCH || "main";
// Trockenlauf für lokale Prüfungen: druckt den Befund, schreibt nichts.
const DRY_RUN = process.argv.includes("dry-run") || process.env.DRY_RUN === "1";

const MARKER = "protection-watch";
const TITLES = {
  weakened: `Branch-Protection auf ${BRANCH} abgeschwächt`,
  missing: `Branch-Protection auf ${BRANCH} fehlt`,
  blind: "Schutz-Wächter kann die Branch-Protection nicht prüfen",
};

function say(line = "") {
  console.log(line);
}

/** Markerzeile im Issue; `branch=` findet das Issue nach einer Titeländerung wieder. */
const header = (state) => `<!-- ${MARKER} branch=${BRANCH} state=${state} -->`;
const branchMarker = `${MARKER} branch=${BRANCH}`;

async function call(path, init = {}, token = READ_TOKEN) {
  const response = await fetch(API + path, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  return { ok: response.ok, status: response.status, data, text };
}

async function api(path, init = {}) {
  const res = await call(path, init, WRITE_TOKEN);
  if (!res.ok) {
    throw new Error(`${init.method || "GET"} ${path} -> ${res.status}: ${(res.text || "").slice(0, 300)}`);
  }
  return res.data;
}

const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const yesNo = (value) => (value ? "ja" : "nein");
const pflicht = (value) => (value ? "Pflicht" : "**nicht** Pflicht");

/**
 * Die Regel lesen. 404 heißt „keine Schutzregel", 401/403 heißt „kein
 * Leserecht" — beides ist ein Alarm, nur ein anderer.
 */
async function readProtection() {
  const res = await call(`/repos/${REPO}/branches/${encodeURIComponent(BRANCH)}/protection`);
  if (res.status === 404) return { state: "missing" };
  if (res.status === 401 || res.status === 403) {
    return {
      state: "blind",
      reason:
        `GitHub antwortet mit ${res.status}: die Schutzregel ist ohne Adminrechte nicht lesbar. ` +
        "Das Secret `PROTECTION_WATCH_TOKEN` fehlt oder hat keine Leserechte.",
    };
  }
  if (!res.ok) {
    return { state: "blind", reason: `GitHub antwortet mit ${res.status}: ${(res.text || "").slice(0, 200)}` };
  }
  return { state: "present", protection: res.data || {} };
}

/** Alles, was einen Direkt-Push auf den Branch wieder möglich macht. */
function findings(protection) {
  const list = [];
  if (!protection.enforce_admins?.enabled) {
    list.push(
      "`enforce_admins` ist **aus** — Repository-Admins (und damit der Owner) dürfen wieder direkt pushen.",
    );
  }
  if (!protection.required_pull_request_reviews) {
    list.push("Ein Pull Request ist **nicht** mehr Pflicht — jeder mit Schreibrecht darf direkt pushen.");
  }
  if (protection.allow_force_pushes?.enabled) {
    list.push("Force-Push ist erlaubt — Historie auf `main` lässt sich überschreiben.");
  }
  if (protection.allow_deletions?.enabled) {
    list.push("Löschen des Branches ist erlaubt.");
  }
  return list;
}

function settingsTable(protection) {
  const checks = protection.required_status_checks;
  const contexts = checks?.contexts || [];
  return [
    "| Einstellung | Wert |",
    "| --- | --- |",
    `| Admins unterliegen der Regel (\`enforce_admins\`) | ${protection.enforce_admins?.enabled ? "ja" : "**nein**"} |`,
    `| Pull Request vor dem Merge | ${pflicht(protection.required_pull_request_reviews)} |`,
    `| Erforderliche Checks | ${contexts.length ? contexts.length : "**keine**"} |`,
    `| Force-Push erlaubt | ${protection.allow_force_pushes?.enabled ? "**ja**" : "nein"} |`,
    `| Branch löschen erlaubt | ${protection.allow_deletions?.enabled ? "**ja**" : "nein"} |`,
  ];
}

const FIXES = {
  enforceAdmins:
    "**Settings → Rules → Branches → `main`** öffnen und bei „Do not allow bypassing the above settings“ den Haken setzen. Ein Direkt-Push wird danach serverseitig mit `GH006` abgelehnt.",
  pullRequest:
    "**Settings → Rules → Branches → `main`** öffnen und „Require a pull request before merging“ aktivieren.",
  forcePush: "**Settings → Rules → Branches → `main`**: „Allow force pushes“ abschalten.",
  deletions: "**Settings → Rules → Branches → `main`**: „Allow deletions“ abschalten.",
};

function fixesFor(protection) {
  const fixes = [];
  if (!protection.enforce_admins?.enabled) fixes.push(FIXES.enforceAdmins);
  if (!protection.required_pull_request_reviews) fixes.push(FIXES.pullRequest);
  if (protection.allow_force_pushes?.enabled) fixes.push(FIXES.forcePush);
  if (protection.allow_deletions?.enabled) fixes.push(FIXES.deletions);
  return fixes;
}

function buildReport(protection) {
  const list = findings(protection);
  const lines = [header("weakened"), ""];
  lines.push(`## Branch-Protection auf \`${BRANCH}\` ist abgeschwächt`);
  lines.push("");
  lines.push(`- Geprüft: ${now()}`);
  lines.push(`- Direkt-Push auf \`${BRANCH}\` ist wieder möglich.`);
  lines.push("");
  lines.push("### Befund");
  lines.push("");
  for (const entry of list) lines.push(`- ${entry}`);
  lines.push("");
  lines.push("### Einstellungen");
  lines.push("");
  lines.push(...settingsTable(protection));
  lines.push("");
  lines.push("### Was zu tun ist");
  lines.push("");
  for (const fix of fixesFor(protection)) lines.push(`1. ${fix}`);
  lines.push("");
  lines.push("---");
  lines.push(
    `Automatisch erstellt von \`.github/workflows/protection-watch.yml\` für \`${BRANCH}\`. ` +
      "Ein weiterer Befund wird hier kommentiert; eine wieder greifende Regel schließt das Issue.",
  );
  return lines.join("\n");
}

function buildMissingReport() {
  return [
    header("missing"),
    "",
    `## Branch-Protection auf \`${BRANCH}\` fehlt`,
    "",
    `- Geprüft: ${now()}`,
    `- GitHub liefert für \`${BRANCH}\` keine Schutzregel (\`404\`) — jeder mit Schreibrecht kann direkt pushen, auch ohne Pull Request.`,
    "",
    "### Was zu tun ist",
    "",
    "1. **Settings → Rules → Branches → `main`** öffnen (bzw. „Add branch ruleset“) und die Regel wieder anlegen: Pull Request Pflicht, die drei Checks aus `.github/workflows/ci.yml` und `.github/workflows/docs-links.yml`, keine Force-Pushes, kein Löschen.",
    "2. Danach „Do not allow bypassing the above settings“ setzen, damit die Regel auch für Admins gilt.",
    "",
    "---",
    `Automatisch erstellt von \`.github/workflows/protection-watch.yml\` für \`${BRANCH}\`. Eine wieder greifende Regel schließt das Issue.`,
  ].join("\n");
}

function buildBlindReport(reason) {
  return [
    header("blind"),
    "",
    "## Schutz-Wächter kann die Branch-Protection nicht prüfen",
    "",
    `- Geprüft: ${now()}`,
    `- Befund: ${reason}`,
    "",
    "### Was zu tun ist",
    "",
    "1. Fine-grained PAT anlegen: **Settings → Developer settings → Personal access tokens → Fine-grained tokens**, nur dieses Repository, Berechtigung **Administration: Read-only** (klassisch: Scope `repo`).",
    "2. Unter **Settings → Secrets and variables → Actions** als `PROTECTION_WATCH_TOKEN` speichern.",
    "3. Lauf unter **Actions → Schutz-Wächter → Run workflow** neu starten; bei lesbarer Regel schließt sich das Issue selbst.",
    "",
    "Ohne dieses Lesetoken ist der Wächter blind: er kann eine abgeschaltete Admin-Durchsetzung nicht erkennen.",
    "",
    "---",
    `Automatisch erstellt von \`.github/workflows/protection-watch.yml\` für \`${BRANCH}\`.`,
  ].join("\n");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Das offene Issue zur Branch suchen. Die Liste ist direkt nach dem Anlegen
 * eines Issues kurz inkonsistent (sie liefert dann `[]`, obwohl das Issue per
 * Einzelabruf schon da ist); ohne Wiederholung würde ein Grünlauf das gerade
 * gemeldete Issue nicht finden und offen lassen. Deshalb ein paar Versuche mit
 * wachsender Pause — im Normalfall kostet der erste Treffer nichts.
 */
async function findOpenIssue() {
  for (const pause of [0, 1000, 2000, 4000]) {
    if (pause) await sleep(pause);
    const issues = (await api(`/repos/${REPO}/issues?state=open&per_page=100`)) || [];
    const found = issues.find(
      (issue) => !issue.pull_request && (issue.body || "").includes(branchMarker),
    );
    if (found) return found;
  }
  return null;
}

function preview(state, title, body) {
  say(`[dry-run] Zustand: ${state} — ${title}`);
  for (const line of body.split("\n").slice(0, 16)) say(`  ${line}`);
}

async function publish(state, body, comment) {
  const title = TITLES[state];
  const open = await findOpenIssue();
  if (DRY_RUN) {
    preview(state, title, body);
    say(`[dry-run] ${open ? `offenes Issue #${open.number} würde aktualisiert` : "Issue würde geöffnet"}`);
    return;
  }
  if (open) {
    await api(`/repos/${REPO}/issues/${open.number}`, {
      method: "PATCH",
      body: JSON.stringify({ title, body }),
    });
    if (comment) {
      await api(`/repos/${REPO}/issues/${open.number}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: comment }),
      });
    }
    say(`Issue #${open.number} aktualisiert: ${title}`);
    await writeSummary(`${title} — Issue #${open.number} aktualisiert.`);
    return;
  }
  const issue = await api(`/repos/${REPO}/issues`, {
    method: "POST",
    body: JSON.stringify({ title, body, labels: ["bug"] }),
  });
  say(`Issue #${issue.number} geöffnet: ${issue.html_url}`);
  await writeSummary(`${title} — Issue #${issue.number} geöffnet.`);
}

async function clear(comment) {
  const open = await findOpenIssue();
  if (!open) {
    say("Schutz greift, kein offenes Issue.");
    return;
  }
  if (DRY_RUN) {
    say(`[dry-run] Issue #${open.number} würde kommentiert und geschlossen.`);
    return;
  }
  await api(`/repos/${REPO}/issues/${open.number}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: comment }),
  });
  await api(`/repos/${REPO}/issues/${open.number}`, {
    method: "PATCH",
    body: JSON.stringify({ state: "closed", state_reason: "completed" }),
  });
  say(`Issue #${open.number} kommentiert und geschlossen.`);
  await writeSummary(`Schutz greift — Issue #${open.number} geschlossen.`);
}

async function writeSummary(text) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  try {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Schutz-Wächter\n\n${text}\n`);
  } catch (error) {
    say(`Step-Summary nicht schreibbar: ${error.message}`);
  }
}

async function main() {
  if (!REPO) throw new Error("GITHUB_REPOSITORY fehlt");
  if (!READ_TOKEN) throw new Error("weder PROTECTION_WATCH_TOKEN noch GITHUB_TOKEN gesetzt");

  const result = await readProtection();

  if (result.state === "missing") {
    await publish("missing", buildMissingReport());
    return;
  }
  if (result.state === "blind") {
    await publish("blind", buildBlindReport(result.reason));
    return;
  }

  const protection = result.protection;
  const list = findings(protection);
  if (list.length === 0) {
    const contexts = protection.required_status_checks?.contexts?.length ?? 0;
    say(
      `Schutz auf ${BRANCH} greift: enforce_admins aktiv, PR-Pflicht ja, ${contexts} Pflicht-Check(s), ` +
        `Force-Push nein, Löschen nein.`,
    );
    await writeSummary(
      `Schutz auf \`${BRANCH}\` greift: enforce_admins aktiv, PR-Pflicht ja, ${contexts} Pflicht-Check(s).`,
    );
    await clear(
      `Die Branch-Protection auf \`${BRANCH}\` greift wieder: \`enforce_admins\` aktiv, Pull Request Pflicht, ` +
        `${contexts} Pflicht-Check(s), keine Force-Pushes, kein Löschen. Geprüft: ${now()}.`,
    );
    return;
  }

  say(`Schutz auf ${BRANCH} ist abgeschwächt:`);
  for (const entry of list) say(`  - ${entry.replace(/`/g, "")}`);
  await publish(
    "weakened",
    buildReport(protection),
    `Weiterhin abgeschwächt (${now()}): ${list.map((entry) => entry.replace(/`/g, "")).join("; ")}`,
  );
}

main().catch((error) => {
  console.error(`Schutz-Wächter abgebrochen: ${error.message}`);
  process.exitCode = 1;
});
