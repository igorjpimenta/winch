// release.js — Herald's delivery surface: render release notes from the
// store, then open a branch + PR that carries the backlog markers S2.6's
// merge detector keys on (`Backlog: EPIC-…`, optional `Backlog-Task: TASK-…`,
// optional `Release: vX.Y.Z`).

import { execFileSync } from "node:child_process";

export function renderReleaseNotes(store, epicId) {
  const epic = store.epic.get(epicId);
  if (!epic) throw new Error(`epic not found: ${epicId}`);
  const stories = store.story.list({ epicId });
  const lines = [
    `# Release notes — ${epic.title}`,
    "",
    `Epic: ${epic.id} · status: ${epic.status} · priority: ${epic.priority}`,
    epic.acceptance ? `\n## Acceptance\n${epic.acceptance}` : "",
    "",
    "## Stories",
  ];
  for (const s of stories) {
    lines.push(`- [${s.status}] ${s.id} ${s.title}${s.acceptance ? ` — ${s.acceptance}` : ""}`);
    for (const t of store.task.list({ storyId: s.id })) {
      const mark = t.status === "done" ? "x" : " ";
      lines.push(`  - [${mark}] ${t.id} ${t.title}${t.result_summary ? ` — ${t.result_summary.split("\n")[0]}` : ""}`);
    }
  }
  const gated = store.db.prepare(
    "SELECT id, title, gate_type FROM tasks WHERE status='blocked' AND gate_type IS NOT NULL AND story_id IN (SELECT id FROM stories WHERE epic_id=?)"
  ).all(epicId);
  if (gated.length) {
    lines.push("", "## Open gates");
    for (const g of gated) lines.push(`- ${g.gate_type}: ${g.id} ${g.title}`);
  }
  const events = store.db.prepare(
    "SELECT COUNT(*) AS n FROM events WHERE task_id IN (SELECT id FROM tasks WHERE story_id IN (SELECT id FROM stories WHERE epic_id=?))"
  ).get(epicId);
  lines.push("", `## Audit`, `- ${events.n} recorded events across this epic's tasks`, "");
  return lines.filter((l) => l !== null && l !== undefined).join("\n");
}

/**
 * Open a release PR in `cwd` (a git checkout with gh auth). Returns
 * {prUrl, branch, notes}. `exec` is injectable for tests; the default runs
 * git/gh synchronously and throws on non-zero exit.
 */
export function shipRelease(store, { epicId, taskId = null, version = null, base = "main", cwd = process.cwd(), exec = execFileSync } = {}) {
  const epic = store.epic.get(epicId);
  if (!epic) throw new Error(`epic not found: ${epicId}`);
  const slug = epicId.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const branch = `release/${slug}`;
  const notes = renderReleaseNotes(store, epicId);
  const marker = [`Backlog: ${epicId}`];
  if (taskId) marker.push(`Backlog-Task: ${taskId}`);
  if (version) marker.push(`Release: ${version}`);
  const notesPath = `RELEASE-NOTES-${epicId}.md`;

  const sh = (cmd, args) => exec(cmd, args, { cwd, encoding: "utf8" });
  try { sh("git", ["checkout", base]); } catch { /* fresh branch from current HEAD */ }
  sh("git", ["checkout", "-B", branch]);
  sh("bash", ["-c", `cat > ${notesPath} <<'RELEASE_NOTES_EOF'\n${notes}\nRELEASE_NOTES_EOF`]);
  sh("git", ["add", notesPath]);
  sh("git", ["commit", "-m", `docs(release): ${epic.title}`]);
  sh("git", ["push", "-u", "origin", branch, "--force-with-lease"]);
  const body = [
    notes,
    "",
    "---",
    marker.join(" · "),
    "_Opened by winch release automation; merge closes the loop with the merge detector._",
  ].join("\n");
  const prUrl = sh("gh", [
    "pr", "create", "--base", base, "--head", branch,
    "--title", `docs(release): ${epic.title}`,
    "--body", body,
  ]).trim();
  return { prUrl, branch, notes, notesPath };
}

const invokedDirectly = process.argv[1]?.endsWith("release.js");
if (invokedDirectly) {
  const { createStore } = await import("./store.js");
  const argv = process.argv.slice(2);
  const get = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
  const epicId = get("--epic");
  if (!epicId) { console.error("usage: release.js --epic EPIC-x [--task TASK-y] [--version vX.Y.Z] [--base main]"); process.exit(2); }
  const store = createStore();
  try {
    const r = shipRelease(store, { epicId, taskId: get("--task"), version: get("--version"), base: get("--base") || "main" });
    console.log(r.prUrl);
  } catch (e) {
    console.error(`release failed: ${e.message ?? e}`);
    process.exitCode = 1;
  } finally {
    store.close();
  }
}
