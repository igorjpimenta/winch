// merges.js — read PR states and apply what a merge (or an unmerged close)
// means to backlog rows, idempotently.
//
// Markers come from release PR bodies: `Backlog: <item-id>`, optional
// `Backlog-Task: <task-id>`, optional `Release: vX.Y.Z`. gh reports state as
// MERGED / CLOSED / OPEN — normalized here, callers pass raw values.
//
// HITL: a marker may name the parent or its human-review child. On MERGED,
// open HITL children close first, the PR attaches as a `pr` artifact, then
// waiting parents cascade to done once deps resolve.

import { depsResolved } from "./deps.js";

export function parseMarkers(body = "") {
  const out = { epicId: null, taskId: null, version: null };
  const text = typeof body === "string" ? body : "";
  const m = text.match(/^\s*Backlog:\s*(\S+)/m);
  if (m) out.epicId = m[1];
  const t = text.match(/^\s*Backlog-Task:\s*(\S+)/m);
  if (t) out.taskId = t[1];
  const v = text.match(/^\s*Release:\s*(\S+)/m);
  if (v) out.version = v[1];
  return out;
}

export function isHitlChild(task) {
  return !!task && task.assignee_agent === "human" && task.assignee_harness === "human_in_the_loop";
}

export function openHitlChildren(store, parentId) {
  return store.dep.listOutgoing(parentId)
    .map((e) => store.task.get(e.to_id))
    .filter((c) => isHitlChild(c) && c.status !== "done" && c.status !== "cancelled");
}

export function hitlParents(store, childId) {
  return store.dep.listIncoming(childId)
    .map((e) => store.task.get(e.from_id))
    .filter(Boolean);
}

function attachPrArtifact(store, itemId, pr, dryRun) {
  const uri = pr.url;
  if (!uri || dryRun) return;
  store.artifact.add({
    itemId,
    kind: "pr",
    uri,
    label: `PR #${pr.number}`,
  });
}

/**
 * Close a HITL child (or any task) and cascade parents that were parked on
 * it: resume deps waits, then done any parent whose deps are now resolved
 * and that is not mid-claim. Used by merge-detect and `winch resolve`.
 */
export function closeHitlAndFreeParents(store, taskId, { actor = "system", resultSummary, note } = {}) {
  const out = { doneTasks: [], resumed: [] };
  const task = store.task.get(taskId);
  if (!task) return out;
  const children = openHitlChildren(store, task.id);
  const parents = isHitlChild(task) ? hitlParents(store, task.id) : [];

  for (const c of children) {
    if (c.status !== "done" && c.status !== "cancelled") {
      store.task.update(c.id, {
        status: "done",
        result_summary: resultSummary ?? `resolved by ${actor}`,
        actor,
        note: note ?? `hitl resolved: ${actor}`,
      });
      out.doneTasks.push(c.id);
    }
  }
  if (task.status !== "done" && task.status !== "cancelled") {
    store.task.update(task.id, {
      status: "done",
      result_summary: resultSummary ?? `resolved by ${actor}`,
      actor,
      note: note ?? `hitl resolved: ${actor}`,
    });
    out.doneTasks.push(task.id);
  }
  store.task.resumeDependencyWaits();

  const waiting = new Map();
  for (const p of parents) waiting.set(p.id, p);
  for (const c of children) {
    for (const p of hitlParents(store, c.id)) waiting.set(p.id, p);
  }
  for (const p of waiting.values()) {
    const cur = store.task.get(p.id);
    if (!cur || cur.status === "done" || cur.status === "cancelled" || cur.status === "in_progress") continue;
    if (!depsResolved(store, cur.id)) continue;
    store.task.update(cur.id, {
      status: "done",
      result_summary: resultSummary ?? `closed via HITL child ${task.id} (${actor})`,
      actor,
      note: note ?? `closed via HITL child: ${task.id}`,
    });
    out.doneTasks.push(cur.id);
    store.task.resumeDependencyWaits();
    out.resumed.push(cur.id);
  }
  return out;
}

/**
 * @param {Array<{number:number, state:string, title:string, body:string, url?:string}>} prs
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

    const task = markers.taskId ? store.task.get(markers.taskId) : null;
    const epic = markers.epicId ? store.epic.get(markers.epicId) : null;
    if (epic && task && task.epic_id !== epic.id) {
      out.skipped.push(`pr#${pr.number}:task-epic-mismatch`);
      continue;
    }

    if (state === "MERGED") {
      if (task) {
        const children = openHitlChildren(store, task.id);
        const parents = isHitlChild(task) ? hitlParents(store, task.id) : [];
        const needsWork = task.status !== "done" || children.length > 0;
        if (needsWork) {
          // A merge lands regardless of who holds the claim. When it takes
          // a task out from under a working agent, the note names the
          // displacement — the agent's next tool call would otherwise fail
          // with no account of why its task completed itself.
          const displaced = task.status === "in_progress" && task.assignee_agent ? ` (displaced ${task.assignee_agent})` : "";
          if (!dryRun) {
            // artifacts.uri is globally unique — one PR row, on the HITL
            // child when one exists (the review unit), else the marked task.
            attachPrArtifact(store, (children[0] ?? task).id, pr, dryRun);
            for (const c of children) {
              if (c.status !== "done") {
                store.task.update(c.id, {
                  status: "done",
                  result_summary: `merged via PR #${pr.number}: ${pr.title}`,
                  actor: "merge-detector",
                  note: `merged: PR #${pr.number}`,
                });
                out.doneTasks.push(c.id);
              }
            }
            if (task.status !== "done") {
              store.task.update(task.id, {
                status: "done",
                result_summary: `merged via PR #${pr.number}: ${pr.title}`,
                actor: "merge-detector",
                note: `merged: PR #${pr.number}${displaced}`,
              });
              out.doneTasks.push(task.id);
            }
            store.task.resumeDependencyWaits();
            // Parents that were parked on a HITL child close once the dep
            // resolves — the human merge was the only remaining gate.
            const waiting = new Map();
            for (const p of parents) waiting.set(p.id, p);
            for (const c of children) {
              for (const p of hitlParents(store, c.id)) waiting.set(p.id, p);
            }
            for (const p of waiting.values()) {
              const cur = store.task.get(p.id);
              if (!cur || cur.status === "done" || cur.status === "cancelled" || cur.status === "in_progress") continue;
              if (!depsResolved(store, cur.id)) continue;
              store.task.update(cur.id, {
                status: "done",
                result_summary: `closed via HITL child (PR #${pr.number})`,
                actor: "merge-detector",
                note: `closed via HITL child: PR #${pr.number}`,
              });
              out.doneTasks.push(cur.id);
              store.task.resumeDependencyWaits();
            }
          } else {
            if (task.status !== "done") out.doneTasks.push(task.id);
            for (const c of children) out.doneTasks.push(c.id);
            for (const p of parents) out.doneTasks.push(p.id);
          }
        }
      }
      if (markers.epicId && markers.version) {
        if (epic && epic.status !== "done") {
          if (!dryRun) store.epic.update(epic.id, { status: "done", actor: "merge-detector", note: `release ${markers.version}` });
          out.closedEpics.push(epic.id);
        }
        // The shipped marker hangs off the release task: events are
        // item-scoped, so a version without a task anchor has nowhere honest
        // to live.
        const releaseTask = task;
        const releaseNote = `release shipped: ${markers.version}`;
        const already = releaseTask
          ? store.event.listFor(releaseTask.id).some((e) => e.note === releaseNote)
          : null;
        if (!releaseTask) out.skipped.push(`release:${markers.version} (no release task)`);
        // Tag before the event: the shipped row asserts a tag exists, so a
        // failed tag records a skip and writes nothing — the wire never
        // claims an untagged shipment.
        if (exec) {
          if (!out.tagged.includes(markers.version)) {
            if (!dryRun) {
              try { exec("git", ["tag", markers.version], { cwd, stdio: "ignore" }); } catch { out.skipped.push(`tag:${markers.version}`); continue; }
            }
            out.tagged.push(markers.version);
          }
          if (releaseTask && !already && !dryRun) {
            const cur = store.task.get(releaseTask.id);
            store.event.append({
              itemId: releaseTask.id, fromStatus: cur.status, toStatus: cur.status,
              kind: "release.shipped", actor: "merge-detector", note: releaseNote,
            });
          }
        } else if (releaseTask && !already) {
          out.skipped.push(`release:${markers.version} (no tag executor)`);
        }
      }
    } else if (state === "CLOSED") {
      // Unmerged close = the work did not land. Anything mid-flight on that PR
      // returns to the queue for a fresh claim; 'done' stays done — a later
      // revert is a new ticket, not a rewrite of history. A HITL child stays
      // ready (the human still owns it); a parent parked on deps stays parked.
      if (task) {
        const reopenable = task.status === "in_progress" || task.status === "review"
          || (task.status === "blocked" && task.gate_type);
        if (reopenable) {
          // A gate dissolved this way is not a resolution — nobody approved —
          // but it must still stream as a gate ending, not a plain release.
          const dissolved = task.status === "blocked" && task.gate_type;
          if (!dryRun) {
            store.task.update(task.id, {
              status: task.assignee_agent ? "ready" : "backlog",
              gate_type: null, blocked_at: null,
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
    ["pr", "list", "--state", "merged", "--state", "closed", "--limit", String(limit), "--json", "number,title,body,state,url"],
    { cwd, encoding: "utf8" }
  );
  return JSON.parse(raw);
}

const invokedDirectly = process.argv[1]?.endsWith("merges.js");
if (invokedDirectly) {
  const { execFileSync } = await import("node:child_process");
  const { createStore } = await import("./store/index.js");
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
