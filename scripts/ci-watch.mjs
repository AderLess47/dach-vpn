#!/usr/bin/env node
// Wächter für die Läufe auf main: meldet einen roten Lauf als Issue.
//
// Die Einordnung ist der eigentliche Zweck: eine Abrechnungssperre startet
// keinen Runner (keine Schritte, runner_id 0) und wird in den Billing-
// Einstellungen behoben, ein Testfehler im Code. Deshalb steht die Einordnung
// oben im Issue. Ein offenes Issue wird wiederverwendet und beim nächsten
// grünen Lauf geschlossen, damit nicht täglich ein neues entsteht.
//
// Beobachtet werden alle Workflows aus `CI_WORKFLOWS` (Komma-Liste) — je
// Workflow ein eigenes Issue, damit „CI" und „Doku-Links" nicht im selben
// Bericht verschwimmen. Der Marker im Issue nennt den Workflow; daran wird das
// offene Issue auch nach einer Titeländerung wiedergefunden.
//
// Nur Node-Bordmittel, wie scripts/check-docs-links.mjs — kein bun install.

import { appendFile } from "node:fs/promises";
import process from "node:process";

const API = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
const REPO = process.env.GITHUB_REPOSITORY || "";
const TOKEN = process.env.GITHUB_TOKEN || "";
// CI_WORKFLOW ist der alte Einzelwert und bleibt als Rückfall gültig.
const WORKFLOWS = (process.env.CI_WORKFLOWS || process.env.CI_WORKFLOW || "ci.yml")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const BRANCH = process.env.CI_BRANCH || "main";

const ISSUE_TITLE = "CI rot auf main";
const MARKER = "ci-watch";
const RED = new Set(["failure", "timed_out", "startup_failure", "action_required"]);
const BILLING_HINT = /payment|spending limit|billing|abrechnung/i;
const KIND_LABELS = {
  billing: "Abrechnungssperre",
  failure: "Testfehler",
  startup: "Workflow startet nicht",
};

function say(line = "") {
  console.log(line);
}

/** Markerzeile im Issue; `workflow=` findet das Issue wieder, `sha=` entdoppelt. */
const markerLine = (workflow, sha) => `<!-- ${MARKER} workflow=${workflow} sha=${sha} -->`;
const workflowMarker = (workflow) => `${MARKER} workflow=${workflow}`;

async function api(path, init = {}) {
  const response = await fetch(API + path, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`${init.method || "GET"} ${path} -> ${response.status}: ${detail}`);
  }
  return response.status === 204 ? null : response.json();
}

const short = (sha) => (sha || "").slice(0, 7);
const cell = (text) => String(text).replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

async function latestMainRun(workflow) {
  const query = new URLSearchParams({ branch: BRANCH, event: "push", per_page: "5" });
  const runs = (await api(`/repos/${REPO}/actions/workflows/${workflow}/runs?${query}`)).workflow_runs || [];
  if (!runs.length) {
    say(`${workflow}: kein Lauf auf ${BRANCH} gefunden.`);
    return null;
  }
  const newest = runs[0];
  if (newest.status !== "completed") {
    say(`${workflow}: Lauf #${newest.run_number} ist noch ${newest.status} — kein Urteil in diesem Tick.`);
    return null;
  }
  return newest;
}

async function jobAnnotations(job) {
  const id = (job.check_run_url || "").split("/").pop();
  if (!id) return [];
  try {
    return (await api(`/repos/${REPO}/check-runs/${id}/annotations`)) || [];
  } catch (error) {
    say(`Annotationen zu "${job.name}" nicht lesbar: ${error.message}`);
    return [];
  }
}

async function inspectRun(run) {
  const jobs = (await api(`/repos/${REPO}/actions/runs/${run.id}/jobs?per_page=100`)).jobs || [];
  const failed = [];
  for (const job of jobs) {
    if (!RED.has(job.conclusion)) continue;
    failed.push({
      job,
      annotations: await jobAnnotations(job),
      failedSteps: (job.steps || []).filter((step) => RED.has(step.conclusion)).map((step) => step.name),
    });
  }

  const notes = failed.flatMap((entry) => entry.annotations.map((a) => a.message || "")).filter(Boolean);
  const billingNote = notes.find((text) => BILLING_HINT.test(text)) || "";
  // Ohne Runner und ohne Schritte ist der Job nie angelaufen: das ist keine
  // Aussage über den Code, sondern über die Abrechnung bzw. die Runner-Zuteilung.
  const neverStarted =
    failed.length > 0 && failed.every((entry) => (entry.job.steps || []).length === 0 && !entry.job.runner_id);

  return { failed, notes, billingNote, billing: Boolean(billingNote) || neverStarted };
}

function classify(info) {
  if (info.billing) return "billing";
  if (info.failed.length === 0) return "startup";
  return "failure";
}

async function commitInfo(sha) {
  try {
    const commit = await api(`/repos/${REPO}/commits/${sha}`);
    return {
      message: (commit.commit?.message || "").split("\n")[0],
      url: commit.html_url,
    };
  } catch (error) {
    say(`Commit ${short(sha)} nicht lesbar: ${error.message}`);
    return null;
  }
}

function buildReport({ workflow, label, run, commit, info, kind }) {
  const lines = [];
  lines.push(markerLine(workflow, run.head_sha));
  lines.push("");
  lines.push(`## ${label} auf \`${BRANCH}\` ist rot`);
  lines.push("");
  lines.push(`- Lauf: [#${run.run_number}](${run.html_url}) — \`${run.conclusion}\``);
  const commitLink = `[\`${short(run.head_sha)}\`](${commit?.url || run.html_url})`;
  lines.push(`- Commit: ${commitLink}${commit?.message ? ` — ${cell(commit.message)}` : ""}`);
  lines.push(`- Erkannt: ${new Date().toISOString().replace(/\.\d+Z$/, "Z")}`);
  lines.push("");
  lines.push("### Einordnung");
  lines.push("");

  if (kind === "billing") {
    lines.push("**Abrechnungssperre, kein Codefehler.** Die fehlgeschlagenen Jobs sind nie gestartet: keine Schritte, kein Runner.");
    if (info.billingNote) {
      lines.push("");
      for (const note of info.billingNote.split("\n").filter(Boolean).slice(0, 6)) {
        lines.push(`> ${note.trim().slice(0, 900)}`);
      }
    }
    lines.push("");
    lines.push("Zu prüfen: **Settings → Billing & plans** (Zahlungsmittel, Spending Limit). Ein Re-Run der alten Läufe hilft nicht; neue Pushes laufen erst wieder, wenn die Abrechnung greift.");
  } else if (kind === "startup") {
    lines.push(`**Der Workflow ist nicht gestartet.** Der Lauf endete mit \`${run.conclusion}\`, ohne einen Job zu protokollieren — typisch für einen Syntaxfehler in \`${workflow}\` oder einen ungültigen Trigger.`);
  } else {
    lines.push("**Echter Testfehler.** Fehlgeschlagene Jobs und Schritte:");
    lines.push("");
    lines.push("| Job | Ergebnis | Fehlgeschlagene Schritte |");
    lines.push("| --- | --- | --- |");
    for (const entry of info.failed) {
      const steps = entry.failedSteps.length ? entry.failedSteps.map(cell).join("<br>") : "—";
      lines.push(`| ${cell(entry.job.name)} | \`${entry.job.conclusion}\` | ${steps} |`);
    }
    lines.push("");
    lines.push("Job-Logs und Artefakte:");
    for (const entry of info.failed) {
      lines.push(`- [${cell(entry.job.name)}](${entry.job.html_url})`);
    }
  }

  lines.push("");
  lines.push("---");
  lines.push(`Automatisch erstellt von \`.github/workflows/ci-watch.yml\` für \`${workflow}\`. Ein weiterer roter Lauf wird hier kommentiert, ein grüner Lauf auf \`${BRANCH}\` schließt das Issue.`);
  return lines.join("\n");
}

async function findOpenIssue(workflow) {
  const issues = (await api(`/repos/${REPO}/issues?state=open&per_page=100`)) || [];
  return (
    issues.find(
      (issue) =>
        !issue.pull_request &&
        issue.title.startsWith(ISSUE_TITLE) &&
        (issue.body || "").includes(workflowMarker(workflow)),
    ) || null
  );
}

async function closeIssue(issue, run, label) {
  await api(`/repos/${REPO}/issues/${issue.number}/comments`, {
    method: "POST",
    body: JSON.stringify({
      body: `${label} auf \`${BRANCH}\` ist wieder grün: Lauf [#${run.run_number}](${run.html_url}) auf \`${short(run.head_sha)}\`.`,
    }),
  });
  await api(`/repos/${REPO}/issues/${issue.number}`, {
    method: "PATCH",
    body: JSON.stringify({ state: "closed", state_reason: "completed" }),
  });
  say(`Issue #${issue.number} kommentiert und geschlossen.`);
}

async function writeSummary(text) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  try {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `### CI-Wächter\n\n${text}\n`);
  } catch (error) {
    say(`Step-Summary nicht schreibbar: ${error.message}`);
  }
}

/** Prüft einen Workflow; ein Fehler hier darf die anderen nicht verhindern. */
async function watchWorkflow(workflow) {
  const run = await latestMainRun(workflow);
  if (!run) return;

  const label = run.name || workflow;
  const openIssue = await findOpenIssue(workflow);

  if (run.conclusion === "cancelled") {
    say(`${label}: Lauf #${run.run_number} wurde abgebrochen — das ist kein Urteil über ${BRANCH}, nichts zu melden.`);
    return;
  }

  if (!RED.has(run.conclusion)) {
    say(`${label} auf ${BRANCH} ist grün (Lauf #${run.run_number}, ${short(run.head_sha)}, ${run.conclusion}).`);
    if (openIssue) await closeIssue(openIssue, run, label);
    await writeSummary(`${label} grün: Lauf #${run.run_number} auf \`${short(run.head_sha)}\`.`);
    return;
  }

  const info = await inspectRun(run);
  const kind = classify(info);

  if (openIssue && (openIssue.body || "").includes(`sha=${run.head_sha}`)) {
    say(`${label}: Lauf #${run.run_number} (${short(run.head_sha)}) steht schon in Issue #${openIssue.number} — kein Duplikat.`);
    return;
  }

  const report = buildReport({ workflow, label, run, commit: await commitInfo(run.head_sha), info, kind });
  const kindLabel = KIND_LABELS[kind];

  if (openIssue) {
    await api(`/repos/${REPO}/issues/${openIssue.number}`, {
      method: "PATCH",
      body: JSON.stringify({ body: report }),
    });
    await api(`/repos/${REPO}/issues/${openIssue.number}/comments`, {
      method: "POST",
      body: JSON.stringify({
        body: `Weiterhin rot: Lauf [#${run.run_number}](${run.html_url}) auf \`${short(run.head_sha)}\` — ${kindLabel}.`,
      }),
    });
    say(`Issue #${openIssue.number} auf Lauf #${run.run_number} aktualisiert.`);
    await writeSummary(`${label} rot (${kindLabel}): Lauf #${run.run_number}, Issue #${openIssue.number} aktualisiert.`);
    return;
  }

  const issue = await api(`/repos/${REPO}/issues`, {
    method: "POST",
    body: JSON.stringify({ title: `${ISSUE_TITLE} — ${label}`, body: report, labels: ["bug"] }),
  });
  say(`Issue #${issue.number} geöffnet: ${issue.html_url}`);
  await writeSummary(`${label} rot (${kindLabel}): Lauf #${run.run_number}, Issue #${issue.number} geöffnet.`);
}

async function main() {
  if (!REPO) throw new Error("GITHUB_REPOSITORY fehlt");
  if (!TOKEN) throw new Error("GITHUB_TOKEN fehlt");
  if (WORKFLOWS.length === 0) throw new Error("CI_WORKFLOWS ist leer");

  const errors = [];
  for (const workflow of WORKFLOWS) {
    try {
      await watchWorkflow(workflow);
    } catch (error) {
      errors.push(`${workflow}: ${error.message}`);
      say(`${workflow}: Prüfung abgebrochen — ${error.message}`);
    }
  }
  if (errors.length > 0) throw new Error(errors.join("; "));
}

main().catch((error) => {
  console.error(`CI-Wächter abgebrochen: ${error.message}`);
  process.exitCode = 1;
});
