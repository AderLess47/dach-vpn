#!/usr/bin/env node
// Wächter für den Direkt-Push-Schutz auf main. Er prüft zwei Ebenen:
//
// 1. Die wirksamen Regeln des Repository-Rulesets — öffentlich lesbar, also
//    ohne persönliches Token (`GET /rules/branches/{branch}`). Hier zählt:
//    Pull-Request-Pflicht, die drei Pflicht-Checks, kein Force-Push, kein
//    Löschen. Fallen sie weg (Ruleset gelöscht oder auf „Disabled“ gestellt),
//    ist das ein Alarm.
// 2. Die klassische Branch-Protection über `enforce_admins`. Diesen Zustand
//    gibt GitHub nur mit Adminrechten heraus (ohne Auth `401`), das
//    `GITHUB_TOKEN` eines Workflows hat sie nie. Dafür liest der Wächter
//    `PROTECTION_WATCH_TOKEN` (Fine-grained PAT, nur dieses Repo,
//    „Administration: Read-only“); geschrieben (Issues) wird mit dem normalen
//    `GITHUB_TOKEN`.
//
// Der PAT ist damit nur noch für `enforce_admins` nötig: Die Sperre selbst
// hängt am Ruleset, das ohne Bypass-Eintrag auch für Admins gilt. Fehlt der
// PAT, bleibt dieser eine Punkt ungeprüft und der Wächter sagt das als Issue —
// er behauptet dann nicht, der Schutz sei weg, sondern nennt die Lücke.
//
// Ein offenes Issue wird wiederverwendet (Marker im Body) und bei wieder
// vollständigem Schutz geschlossen, damit nicht täglich ein neues entsteht.
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

// Die Checks, die das Ruleset auf dem Branch verlangt. Der Workflow setzt sie
// als Umgebungsvariable, damit eine Umbenennung an genau einer Stelle sichtbar
// wird; die Vorgabe hält den Aufruf ohne CI lauffähig.
const DEFAULT_CHECKS = [
  "Typecheck, Tests, Build",
  "IPAM & Registrierung (Integration)",
  "Relative Links in docs/ und README.md",
];
const REQUIRED_CHECKS = (process.env.PROTECTION_REQUIRED_CHECKS || DEFAULT_CHECKS.join("\n"))
  .split("\n")
  .map((name) => name.trim())
  .filter(Boolean);

const MARKER = "protection-watch";
const TITLES = {
  weakened: `Branch-Protection auf ${BRANCH} abgeschwächt`,
  blind: "Schutz-Wächter kann enforce_admins nicht prüfen",
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
const pflicht = (value) => (value ? "Pflicht" : "**nicht** Pflicht");

/** Die wirksamen Ruleset-Regeln des Branches — ohne Adminrechte lesbar. */
async function readRules() {
  const res = await call(`/repos/${REPO}/rules/branches/${encodeURIComponent(BRANCH)}`, {}, WRITE_TOKEN);
  if (!res.ok) {
    return { error: `GitHub antwortet mit ${res.status}: ${(res.text || "").slice(0, 200)}` };
  }
  return { rules: Array.isArray(res.data) ? res.data : [] };
}

/**
 * Die klassische Regel lesen. 404 heißt „keine Schutzregel", 401/403 heißt
 * „kein Leserecht" — beides ist ein Alarm, nur ein anderer.
 */
async function readProtection() {
  const res = await call(`/repos/${REPO}/branches/${encodeURIComponent(BRANCH)}/protection`);
  if (res.status === 404) return { state: "missing" };
  if (res.status === 401 || res.status === 403) {
    return {
      state: "blind",
      reason:
        `GitHub antwortet mit ${res.status}: die klassische Regel ist ohne Adminrechte nicht lesbar. ` +
        "Das Secret `PROTECTION_WATCH_TOKEN` fehlt oder hat keine Leserechte.",
    };
  }
  if (!res.ok) {
    return { state: "blind", reason: `GitHub antwortet mit ${res.status}: ${(res.text || "").slice(0, 200)}` };
  }
  return { state: "present", protection: res.data || {} };
}

/**
 * Befunde aus der klassischen Regel — alles, was den Admin-Durchgriff öffnet.
 * Jeder Befund trägt eine feste Art (`kind`). Die Reparaturhinweise werden
 * über diese Art zugeordnet, nicht über den Text: Eine Umformulierung darf
 * keinen Hinweis verschlucken.
 */
function protectionFindings(protection) {
  const list = [];
  if (!protection.enforce_admins?.enabled) {
    list.push({
      kind: "protection-enforce-admins",
      text: "`enforce_admins` der klassischen Regel ist **aus** — Repository-Admins dürfen dort wieder vorbei.",
    });
  }
  if (!protection.required_pull_request_reviews) {
    list.push({
      kind: "protection-pull-request",
      text: "Die klassische Regel verlangt keinen Pull Request mehr.",
    });
  }
  if (protection.allow_force_pushes?.enabled) {
    list.push({ kind: "protection-force-push", text: "Die klassische Regel erlaubt Force-Pushes." });
  }
  if (protection.allow_deletions?.enabled) {
    list.push({
      kind: "protection-deletions",
      text: "Die klassische Regel erlaubt das Löschen des Branches.",
    });
  }
  return list;
}

/** Befunde aus den Ruleset-Regeln — die Ebene, die auch Admins blockiert. */
function ruleFindings(rules) {
  const list = [];
  const types = new Set(rules.map((rule) => rule.type));

  if (!types.has("pull_request")) {
    list.push({
      kind: "rules-pull-request",
      text: `Kein aktives Ruleset verlangt einen Pull Request — ein Direkt-Push auf \`${BRANCH}\` ist damit möglich.`,
    });
  }
  if (!types.has("non_fast_forward")) {
    list.push({
      kind: "rules-force-push",
      text: `Kein aktives Ruleset blockiert Force-Pushes auf \`${BRANCH}\`.`,
    });
  }
  if (!types.has("deletion")) {
    list.push({
      kind: "rules-deletion",
      text: `Kein aktives Ruleset blockiert das Löschen von \`${BRANCH}\`.`,
    });
  }

  const checkRule = rules.find((rule) => rule.type === "required_status_checks");
  if (!checkRule) {
    list.push({ kind: "rules-checks", text: "Kein aktives Ruleset verlangt die Pflicht-Checks." });
  } else {
    const contexts = new Set(
      (checkRule.parameters?.required_status_checks ?? []).map((entry) => entry.context),
    );
    const missing = REQUIRED_CHECKS.filter((name) => !contexts.has(name));
    if (missing.length > 0) {
      list.push({
        kind: "rules-checks",
        text: `Dem Ruleset fehlen Pflicht-Checks: ${missing.map((name) => `\`${name}\``).join(", ")}.`,
      });
    }
  }
  return list;
}

function rulesTable(rules) {
  const types = new Set(rules.map((rule) => rule.type));
  const checkRule = rules.find((rule) => rule.type === "required_status_checks");
  const contexts = (checkRule?.parameters?.required_status_checks ?? []).map((entry) => entry.context);
  return [
    "| Regel (aus `/rules/branches/…`) | Status |",
    "| --- | --- |",
    `| Pull Request vor dem Merge | ${types.has("pull_request") ? "aktiv" : "**fehlt**"} |`,
    `| Pflicht-Checks | ${
      contexts.length ? `${contexts.length} von ${REQUIRED_CHECKS.length}` : "**fehlen**"
    } |`,
    `| Force-Push blockiert | ${types.has("non_fast_forward") ? "ja" : "**nein**"} |`,
    `| Löschen blockiert | ${types.has("deletion") ? "ja" : "**nein**"} |`,
  ];
}

function settingsTable(protection) {
  const checks = protection.required_status_checks;
  const contexts = checks?.contexts || [];
  return [
    "| Einstellung | Wert |",
    "| --- | --- |",
    `| Admins unterliegen der klassischen Regel (\`enforce_admins\`) | ${protection.enforce_admins?.enabled ? "ja" : "**nein**"} |`,
    `| Pull Request vor dem Merge | ${pflicht(protection.required_pull_request_reviews)} |`,
    `| Erforderliche Checks | ${contexts.length ? contexts.length : "**keine**"} |`,
    `| Force-Push erlaubt | ${protection.allow_force_pushes?.enabled ? "**ja**" : "nein"} |`,
    `| Branch löschen erlaubt | ${protection.allow_deletions?.enabled ? "**ja**" : "nein"} |`,
  ];
}

// Ein Reparaturhinweis je Befundart. Die Schlüssel sind genau die `kind`-Werte
// der Befunde; die Reihenfolge der Einträge ist die Reihenfolge im Bericht
// (erst die Ebene, die auch Admins blockiert, dann die klassische Regel) und
// hängt nicht davon ab, in welcher Reihenfolge die Befunde entstehen.
const FIXES = {
  "rules-pull-request":
    "**Settings → Rules → Rulesets**: das Ruleset für `main` prüfen, Enforcement „Active“, und „Require a pull request before merging“ aktivieren.",
  "rules-force-push": "**Settings → Rules → Rulesets**: „Block force pushes“ aktivieren.",
  "rules-deletion": "**Settings → Rules → Rulesets**: „Restrict deletions“ aktivieren.",
  "rules-checks":
    `**Settings → Rules → Rulesets**: „Require status checks to pass“ mit genau diesen Kontexten aktivieren: ${REQUIRED_CHECKS.map(
      (name) => `\`${name}\``,
    ).join(", ")}.`,
  "protection-enforce-admins":
    "**Settings → Branches → `main`**: „Do not allow bypassing the above settings“ setzen. Ein Direkt-Push wird danach serverseitig mit `GH006` abgelehnt.",
  "protection-pull-request":
    "**Settings → Branches → `main`**: „Require a pull request before merging“ aktivieren.",
  "protection-force-push": "**Settings → Branches → `main`**: „Allow force pushes“ abschalten.",
  "protection-deletions": "**Settings → Branches → `main`**: „Allow deletions“ abschalten.",
};
const FIX_ORDER = Object.keys(FIXES);

/** Zu den Befundarten die passenden Hinweise — ohne jeden Textvergleich. */
function fixesFor(findings) {
  const kinds = new Set(findings.map((finding) => finding.kind));
  return FIX_ORDER.filter((kind) => kinds.has(kind)).map((kind) => FIXES[kind]);
}

function buildReport({ ruleList, protectionList, rules, protection, ruleError, blindReason }) {
  const lines = [header("weakened"), ""];
  lines.push(`## Branch-Protection auf \`${BRANCH}\` ist abgeschwächt`);
  lines.push("");
  lines.push(`- Geprüft: ${now()}`);
  lines.push(`- Befunde aus der wirksamen Regel (Ruleset) und der klassischen Regel.`);
  lines.push("");
  lines.push("### Befund");
  lines.push("");
  for (const finding of ruleList) lines.push(`- ${finding.text}`);
  for (const finding of protectionList) lines.push(`- ${finding.text}`);
  lines.push("");
  lines.push("### Wirksame Regeln (ohne persönliches Token geprüft)");
  lines.push("");
  if (rules) lines.push(...rulesTable(rules));
  else lines.push(`> Nicht lesbar — ${ruleError || "unbekannter Fehler"}`);
  lines.push("");
  lines.push("### Klassische Regel (`enforce_admins`)");
  lines.push("");
  if (protection) lines.push(...settingsTable(protection));
  else if (blindReason) lines.push(`> Nicht prüfbar — ${blindReason}`);
  else lines.push("> Keine klassische Schutzregel vorhanden (`404`).");
  lines.push("");
  lines.push("### Was zu tun ist");
  lines.push("");
  const fixes = fixesFor([...ruleList, ...protectionList]);
  if (fixes.length === 0) {
    lines.push("Den Zustand in den Repository-Einstellungen prüfen (Settings → Rules und Settings → Branches).");
  } else {
    for (const fix of fixes) lines.push(`1. ${fix}`);
  }
  lines.push("");
  lines.push("---");
  lines.push(
    `Automatisch erstellt von \`.github/workflows/protection-watch.yml\` für \`${BRANCH}\`. ` +
      "Ein weiterer Befund wird hier kommentiert; ein wieder vollständiger Schutz schließt das Issue.",
  );
  return lines.join("\n");
}

function buildBlindReport(reason, rules) {
  const lines = [
    header("blind"),
    "",
    `## Schutz-Wächter kann \`enforce_admins\` auf \`${BRANCH}\` nicht prüfen`,
    "",
    `- Geprüft: ${now()}`,
    `- Befund: ${reason}`,
    "",
    "Die **wirksamen Ruleset-Regeln** sind davon nicht betroffen — sie werden ohne persönliches Token geprüft:",
    "",
  ];
  if (rules) lines.push(...rulesTable(rules));
  else lines.push("> Regeln in diesem Lauf nicht lesbar.");
  lines.push("");
  lines.push("### Was zu tun ist");
  lines.push("");
  lines.push(
    "1. Fine-grained PAT anlegen: **Settings → Developer settings → Personal access tokens → Fine-grained tokens**, nur dieses Repository, Berechtigung **Administration: Read-only** (klassisch: Scope `repo`).",
  );
  lines.push("2. Unter **Settings → Secrets and variables → Actions** als `PROTECTION_WATCH_TOKEN` speichern.");
  lines.push("3. Lauf unter **Actions → Schutz-Wächter → Run workflow** neu starten; danach schließt sich das Issue selbst.");
  lines.push("");
  lines.push(
    "Ohne dieses Lesetoken bleibt nur die Admin-Durchsetzung der klassischen Regel ungeprüft; Direkt-Pushes blockiert bereits das Ruleset.",
  );
  lines.push("");
  lines.push("---");
  lines.push(`Automatisch erstellt von \`.github/workflows/protection-watch.yml\` für \`${BRANCH}\`.`);
  return lines.join("\n");
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
  for (const line of body.split("\n").slice(0, 18)) say(`  ${line}`);
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
    say("Schutz vollständig, kein offenes Issue.");
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
  await writeSummary(`Schutz vollständig — Issue #${open.number} geschlossen.`);
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
  if (!WRITE_TOKEN) throw new Error("GITHUB_TOKEN fehlt");

  const rulesResult = await readRules();
  const protectionResult = await readProtection();

  const ruleList = rulesResult.rules ? ruleFindings(rulesResult.rules) : [];
  const protectionList =
    protectionResult.state === "present" ? protectionFindings(protectionResult.protection) : [];
  if (protectionResult.state === "missing") {
    // Eigene Art ohne Reparaturhinweis: die Regel wird unter Settings → Branches
    // neu angelegt, dafür gibt es keinen einzelnen Schalter.
    protectionList.push({
      kind: "protection-missing",
      text: "Die klassische Schutzregel fehlt (`404`) — die zweite Ebene mit `enforce_admins` ist weg.",
    });
  }

  const blindParts = [];
  if (protectionResult.state === "blind") blindParts.push(protectionResult.reason);
  if (rulesResult.error) blindParts.push(`Die wirksamen Regeln waren nicht lesbar: ${rulesResult.error}`);
  const blindReason = blindParts.join(" ");
  const ruleError = rulesResult.error || "";

  if (ruleList.length > 0 || protectionList.length > 0) {
    say(`Schutz auf ${BRANCH} ist abgeschwächt:`);
    for (const finding of [...ruleList, ...protectionList]) say(`  - ${finding.text.replace(/`/g, "")}`);
    await publish(
      "weakened",
      buildReport({
        ruleList,
        protectionList,
        rules: rulesResult.rules,
        protection: protectionResult.protection,
        ruleError,
        blindReason,
      }),
      `Weiterhin abgeschwächt (${now()}): ${[...ruleList, ...protectionList]
        .map((finding) => finding.text.replace(/`/g, ""))
        .join("; ")}`,
    );
    return;
  }

  if (blindReason) {
    say(`Regeln greifen, aber enforce_admins ist ungeprüft: ${blindReason}`);
    await publish("blind", buildBlindReport(blindReason, rulesResult.rules));
    return;
  }

  const contexts = rulesResult.rules?.find((rule) => rule.type === "required_status_checks")
    ?.parameters?.required_status_checks?.length;
  say(
    `Schutz auf ${BRANCH} greift: Ruleset mit PR-Pflicht, ${contexts} Pflicht-Check(s), kein Force-Push, ` +
      `kein Löschen; enforce_admins aktiv.`,
  );
  await writeSummary(
    `Schutz auf \`${BRANCH}\` greift: Ruleset mit PR-Pflicht, ${contexts} Pflicht-Check(s), kein Force-Push, ` +
      "kein Löschen; `enforce_admins` aktiv.",
  );
  await clear(
    `Der Schutz auf \`${BRANCH}\` ist wieder vollständig: aktives Ruleset (Pull-Request-Pflicht, ` +
      `${contexts} Pflicht-Check(s), keine Force-Pushes, kein Löschen) und \`enforce_admins\` aktiv. ` +
      `Geprüft: ${now()}.`,
  );
}

main().catch((error) => {
  console.error(`Schutz-Wächter abgebrochen: ${error.message}`);
  process.exitCode = 1;
});
