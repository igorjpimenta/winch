// merges.js — close the loop S2.5 opens: read PR states, apply what a merge
// (or an unmerged close) means to backlog rows, idempotently.
//
// Markers come from release PR bodies: `Backlog: EPIC-x`, optional
// `Backlog-Task: TASK-y`, optional `Release: vX.Y.Z`. gh reports state as
// MERGED / CLOSED / OPEN — normalized here, callers pass raw values.

export function parseMarkers(body = "") {
  const out = { epicId: null, taskId: null, version: null };
  const m = body.match(/^\s*Backlog:\s*(\S+)/m);
  if (m) out.epicId = m[1];
  const t = body.match(/^\s*Backlog-Task:\s*(\S+)/m);
  if (t) out.taskId = t[1];
  const v = body.match(/^\s*Release:\s*(\S+)/m);
  if (v) out.version = v[1];
  return out;
}

/**
 * @param {Array<{number:number, state:string, title:string, body:string}>} prs
 * @param {{exec?: Function, cwd?: string, dryRun?: boolean}} opts — exec runs
 *   the git tag when a Release marker lands; tests inject a recorder.
 * @returns summary of every transition applied (idempotent on re-run)
 */
export function applyMergeOutcomes(store, prs, { exec = null, cwd = process.cwd(), dryRun = false } = {}) {
  const out = { doneTasks: [], reopenedTasks: [], closedEpics: [], tagged: [], skipped: [] };
  for (const pr of prs) {
    const markers = parseMarkers(pr.body);
    const state = String(pr.state ?? "").toUpperCase();
    if (!markers.epicId && !markers.taskId) continue;

    if (state === "MERGED") {
      if (markers.taskId) {
        const task = store.task.get(markers.taskId);
        if (task && task.status !== "done") {
          // A merge lands regardless of who holds the claim. When it takes
          // a task out from under a working agent, the note names the
          // displacement — the agent's next tool call would otherwise fail
          // with no account of why its task completed itself.
          const displaced = task.status === "in_progress" && task.assigned ? ` (displaced ${task.assigned})` : "";
          if (!dryRun) {
            store.task.update(task.id, {
              status: "done",
              result_summary: `merged via PR #${pr.number}: ${pr.title}`,
              actor: "merge-detector",
              note: `merged: PR #${pr.number}${displaced}`,
            });
          }
          out.doneTasks.push(task.id);
        }
      }
      if (markers.epicId && markers.version) {
        const epic = store.epic.get(markers.epicId);
        if (epic && epic.status !== "done") {
          if (!dryRun) store.epic.update(epic.id, { status: "done" });
          out.closedEpics.push(epic.id);
        }
        // The shipped marker hangs off the release task: events are
        // task-scoped, so a version without a task anchor has nowhere honest
        // to live. The missing anchor reports before the tag attempt, so a
        // tag failure still surfaces both skips instead of hiding one.
        const releaseTask = markers.taskId ? store.task.get(markers.taskId) : null;
        const releaseNote = `release shipped: ${markers.version}`;
        const already = releaseTask
          ? store.db.prepare("SELECT 1 FROM events WHERE task_id=? AND note=?").get(releaseTask.id, releaseNote)
          : null;
        if (!releaseTask && !already) out.skipped.push(`release:${markers.version} (no release task)`);
        // Tag before the event: the shipped row asserts a tag exists, so a
        // failed tag records a skip and writes nothing — the wire never
        // claims an untagged shipment. No tag backend (library use without
        // exec) means nothing to verify, and the write stands.
        if (exec && !out.tagged.includes(markers.version)) {
          if (!dryRun) {
            try { exec("git", ["tag", markers.version], { cwd, stdio: "ignore" }); } catch { out.skipped.push(`tag:${markers.version}`); continue; }
          }
          out.tagged.push(markers.version);
        }
        if (releaseTask && !already) {
          if (!dryRun) {
            const cur = store.task.get(releaseTask.id);
            store.db.prepare(
              "INSERT INTO events(task_id, from_status, to_status, kind, actor, note, at) VALUES (?, ?, ?, ?, ?, ?, ?)"
            ).run(releaseTask.id, cur.status, cur.status, "release.shipped", "merge-detector", releaseNote, Date.now());
          }
        }
      }
    } else if (state === "CLOSED") {
      // Unmerged close = the work did not land. Anything mid-flight on that PR
      // returns to the queue for a fresh claim; 'done' stays done — a later
      // revert is a new ticket, not a rewrite of history.
      if (markers.taskId) {
        const task = store.task.get(markers.taskId);
        if (task && ["in_progress", "review", "blocked"].includes(task.status)) {
          // A gate dissolved this way is not a resolution — nobody approved —
          // but it must still stream as a gate ending, not a plain release.
          // Otherwise kind-filtering subscribers count opened gates that can
          // never resolve and their pending set leaks.
          const dissolved = task.status === "blocked" && task.gate_type;
          if (!dryRun) {
            store.task.update(task.id, {
              status: "todo", assigned: null, gate_type: null, blocked_at: null,
              actor: "merge-detector",
              note: dissolved ? `gate dissolved: closed unmerged PR #${pr.number}` : `closed unmerged: PR #${pr.number}`,
            });
          }
          out.reopenedTasks.push(task.id);
        }
      }
    } else {
      out.skipped.push(`pr#${pr.number}:${state || "unknown"}`);
    }
  }
  return out;
}

/**
 * Pull PR rows via gh in `cwd`. exec is injectable; returns parsed JSON.
 */
export function collectPRs({ exec, cwd = process.cwd(), limit = 100 } = {}) {
  const raw = exec(
    "gh",
    ["pr", "list", "--state", "merged", "--state", "closed", "--limit", String(limit), "--json", "number,title,body,state"],
    { cwd, encoding: "utf8" }
  );
  return JSON.parse(raw);
}

const invokedDirectly = process.argv[1]?.endsWith("merges.js");
if (invokedDirectly) {
  const { execFileSync } = await import("node:child_process");
  const { createStore } = await import("./store.js");
  const dryRun = process.argv.includes("--dry-run");
  const store = createStore();
  try {
    const prs = collectPRs({ exec: execFileSync });
    const summary = applyMergeOutcomes(store, prs, { exec: execFileSync, dryRun });
    console.log(JSON.stringify(summary));
  } catch (e) {
    console.error(`merge-detect failed: ${e.message ?? e}`);
    process.exitCode = 1;
  } finally {
    store.close();
  }
}
