// The recursive item tree: create/get/list/tree/update, soft drop/restore,
// tags, and kind lookups. Facades (epic/story/task) add domain rules on top.

import { newItemId } from "../ids.js";
import { resolveAssignmentPair } from "../reserved.js";
import { EXECUTION_KINDS, ITEM_KINDS } from "../schema.js";

export function createItemApi({ core }) {
  const {
    db, now, jsonIn, ITEM_SELECT, decorate, getRow, listRows, appendEvent,
    kindForTransition, STATUSES_BY_KIND, DEFAULT_STATUS, ITEM_TERMINAL,
  } = core;

  const itemApi = {
    create(input = {}) {
      const kind = input.kind;
      if (!ITEM_KINDS.includes(kind)) throw new Error(`invalid item kind: ${kind}`);
      const id = input.id || newItemId();
      const pair = resolveAssignmentPair(
        input.assigneeAgent ?? (input.assigned ?? null),
        input.assigneeHarness ?? null,
      );
      const assigneeHarness = pair.harness;
      const assigneeAgent = pair.agent;
      if ((assigneeHarness == null) !== (assigneeAgent == null)) {
        throw new Error(`assignment is a pair: ${id}`);
      }
      const assigned = assigneeHarness != null && assigneeAgent != null;
      const status = input.status ?? DEFAULT_STATUS[kind];
      if (!STATUSES_BY_KIND[kind].includes(status)) throw new Error(`invalid ${kind} status: ${status}`);
      if (status === "ready" && !assigned) throw new Error(`ready item requires an assignment: ${id}`);
      const executionKind = input.executionKind ?? "manual";
      if (!EXECUTION_KINDS.includes(executionKind)) throw new Error(`invalid execution_kind: ${executionKind}`);
      const parentId = kind === "epic" ? null : (input.parentId ?? null);
      if (kind !== "epic" && !parentId) throw new Error(`${kind} requires a parentId`);
      if (parentId) {
        const parent = db.prepare("SELECT kind FROM items WHERE id=?").get(parentId);
        if (!parent) throw new Error(`parent not found: ${parentId}`);
        if (kind === "story" && parent.kind !== "epic") throw new Error(`story parent must be an epic: ${parentId}`);
        if (kind === "task" && parent.kind !== "story" && parent.kind !== "task") throw new Error(`task parent must be a story or task: ${parentId}`);
      }
      const t = input.createdAt ?? now();
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(`
          INSERT INTO items(id, kind, parent_id, title, description, acceptance,
                            priority, size, owner_team, created_by, execution_kind, execution_args, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, kind, parentId, input.title,
          input.description ?? null, input.acceptance ?? null,
          input.priority ?? 50, input.size ?? null, input.ownerTeam ?? null,
          input.createdBy ?? null, executionKind, JSON.stringify(input.executionArgs ?? {}), t,
        );
        db.prepare(`
          INSERT INTO item_state(item_id, revision, status, state_json, assignee_harness, assignee_agent, updated_at, closed_at, deleted_at)
          VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, status, JSON.stringify(input.state ?? {}),
          assigneeHarness, assigneeAgent,
          t, ITEM_TERMINAL.has(status) ? t : null, null,
        );
        for (const tag of input.capabilities ?? []) {
          db.prepare("INSERT OR IGNORE INTO item_tags(item_id, tag, source, created_at) VALUES (?, ?, ?, ?)")
            .run(id, String(tag), input.tagSource ?? "assign", t);
        }
        if (input.emit !== false) {
          appendEvent({
            itemId: id,
            fromStatus: null,
            toStatus: status,
            kind: `${kind}.created`,
            actor: input.actor ?? null,
            note: input.note ?? `${kind} created`,
            at: t,
          });
        }
        // Birth is always the default (backlog); an assignee on the create
        // call is an assignment, so it moves the item to ready immediately.
        if (assigned && status === "backlog") {
          db.prepare("UPDATE item_state SET revision=revision+1, status='ready', updated_at=? WHERE item_id=?").run(t, id);
          if (input.emit !== false) {
            appendEvent({
              itemId: id,
              fromStatus: "backlog",
              toStatus: "ready",
              kind: `${kind}.assigned`,
              actor: input.actor ?? null,
              note: `assign ${assigneeAgent}`,
              at: t,
            });
          }
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return itemApi.get(id, { includeDeleted: true });
    },

    get(id, opts = {}) { return getRow(id, opts); },

    list(opts = {}) { return listRows(opts); },

    children(id) {
      return db.prepare(`${ITEM_SELECT} WHERE i.parent_id=? AND s.deleted_at IS NULL ORDER BY i.created_at ASC`)
        .all(id).map((r) => decorate(r));
    },

    tree(id, { includeDeleted = false } = {}) {
      const rows = db.prepare(`
        WITH RECURSIVE down(id, depth) AS (
          SELECT id, 0 FROM items WHERE id=?
          UNION ALL
          SELECT i.id, down.depth + 1 FROM items i JOIN down ON i.parent_id = down.id WHERE down.depth < 64
        )
        SELECT i.id FROM down JOIN items i ON i.id=down.id ORDER BY down.depth ASC
      `).all(id);
      return rows.map((r) => itemApi.get(r.id, { includeDeleted })).filter(Boolean);
    },

    update(id, patch = {}) {
      const existing = getRow(id, { includeDeleted: true });
      if (!existing) throw new Error(`item not found: ${id}`);
      let status = patch.status ?? existing.status;
      if (!STATUSES_BY_KIND[existing.kind].includes(status)) throw new Error(`invalid ${existing.kind} status: ${status}`);
      const executionKind = patch.executionKind ?? existing.execution_kind;
      if (!EXECUTION_KINDS.includes(executionKind)) throw new Error(`invalid execution_kind: ${executionKind}`);
      const t = patch.updatedAt ?? now();
      const next = {
        title: patch.title ?? existing.title,
        description: patch.description !== undefined ? patch.description : existing.description,
        acceptance: patch.acceptance !== undefined ? patch.acceptance : existing.acceptance,
        priority: patch.priority ?? existing.priority,
        size: patch.size !== undefined ? patch.size : existing.size,
        owner_team: patch.ownerTeam !== undefined ? patch.ownerTeam : existing.owner_team,
        created_by: patch.createdBy !== undefined ? patch.createdBy : existing.created_by,
        execution_kind: executionKind,
        execution_args: patch.executionArgs !== undefined ? patch.executionArgs : existing.execution_args,
        assignee_harness: patch.assigneeHarness !== undefined ? patch.assigneeHarness : existing.assignee_harness,
        assignee_agent: patch.assigneeAgent !== undefined ? patch.assigneeAgent : existing.assignee_agent,
        state_json: patch.state !== undefined ? patch.state : existing.state_json,
        closed_at: patch.closedAt !== undefined ? patch.closedAt : existing.closed_at,
        deleted_at: patch.deletedAt !== undefined ? patch.deletedAt : existing.deleted_at,
      };
      if (patch.assigned !== undefined) next.assignee_agent = patch.assigned ?? null;
      const pair = resolveAssignmentPair(next.assignee_agent, next.assignee_harness);
      next.assignee_agent = pair.agent;
      next.assignee_harness = pair.harness;
      if (next.assignee_agent == null) next.assignee_harness = null;
      else if (next.assignee_harness == null) throw new Error(`assignment requires a harness: ${id}`);
      if (patch.status && ITEM_TERMINAL.has(status) && !existing.closed_at) next.closed_at = t;
      if (patch.status && !ITEM_TERMINAL.has(status) && existing.closed_at && patch.closedAt === undefined) next.closed_at = null;
      if ((next.assignee_harness == null) !== (next.assignee_agent == null)) {
        throw new Error(`assignment is a pair: ${id}`);
      }
      const assignmentChanged = patch.assigneeHarness !== undefined || patch.assigneeAgent !== undefined || patch.assigned !== undefined;
      if (patch.status === undefined && assignmentChanged) {
        if (status === "ready" && (next.assignee_harness == null || next.assignee_agent == null)) status = "backlog";
        else if (status === "backlog" && next.assignee_harness != null && next.assignee_agent != null) status = "ready";
      }
      if (status === "ready" && (next.assignee_harness == null || next.assignee_agent == null)) {
        throw new Error(`ready item requires an assignment: ${id}`);
      }
      if (existing.status === "blocked" && status !== "blocked" && next.state_json?.wait?.kind === "deps") {
        const state = { ...next.state_json };
        delete state.wait;
        next.state_json = state;
      }
      const statusChanged = status !== existing.status;
      const note = patch.note ?? null;
      const actor = patch.actor ?? (statusChanged ? "system" : null);
      const kind = patch.kind ?? kindForTransition(existing.kind, existing.status, status, existing.gate_type);
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(`
          UPDATE items SET title=?, description=?, acceptance=?, priority=?, size=?, owner_team=?,
                           created_by=?, execution_kind=?, execution_args=?
           WHERE id=?
        `).run(next.title, next.description, next.acceptance, next.priority, next.size, next.owner_team,
          next.created_by, next.execution_kind, JSON.stringify(next.execution_args ?? {}), id);
        db.prepare(`
          UPDATE item_state SET revision=revision+1, status=?, state_json=?, assignee_harness=?, assignee_agent=?,
                                updated_at=?, closed_at=?, deleted_at=?
           WHERE item_id=?
        `).run(status, JSON.stringify(next.state_json ?? {}), next.assignee_harness, next.assignee_agent,
          t, next.closed_at, next.deleted_at, id);
        if (patch.capabilities !== undefined) {
          db.prepare("DELETE FROM item_tags WHERE item_id=?").run(id);
          for (const tag of patch.capabilities ?? []) {
            db.prepare("INSERT OR IGNORE INTO item_tags(item_id, tag, source, created_at) VALUES (?, ?, ?, ?)")
              .run(id, String(tag), patch.tagSource ?? "assign", t);
          }
        }
        if (statusChanged || patch.event) {
          appendEvent({
            itemId: id,
            attemptId: patch.attemptId ?? null,
            sessionId: patch.sessionId ?? null,
            fromStatus: existing.status,
            toStatus: status,
            kind,
            actor,
            note,
            payload: patch.payload ?? null,
            at: t,
          });
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return itemApi.get(id, { includeDeleted: true });
    },

    drop(id, { reason = null, actor = null, at = null } = {}) {
      const row = getRow(id, { includeDeleted: true });
      if (!row) return null;
      const descendants = itemApi.tree(id, { includeDeleted: true }).filter((r) => r.id !== id);
      const claimed = descendants.filter((r) => r.kind === "task" && (r.attempt_count > 0 || (r.status !== "backlog" && r.status !== "ready")));
      const t = at ?? now();
      const note = reason ? `dropped: ${String(reason).slice(0, 160)}` : `dropped with ${row.kind}`;
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const r of [...descendants, row]) {
          const fresh = getRow(r.id, { includeDeleted: true });
          if (!fresh || fresh.deleted_at != null) continue;
          db.prepare(`
            UPDATE item_state SET revision=revision+1, status='cancelled',
                                  state_json=json_set(state_json, '$.priorStatus', status),
                                  deleted_at=?, closed_at=?, updated_at=?
             WHERE item_id=?
          `).run(t, t, t, r.id);
          appendEvent({
            itemId: r.id,
            fromStatus: fresh.status,
            toStatus: "cancelled",
            kind: r.kind === "task" ? "task.dropped" : `${r.kind}.cancelled`,
            actor, note, at: t,
          });
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return { row, descendants, claimed, at: t };
    },

    restore(id, { actor = null, at = null } = {}) {
      const row = getRow(id, { includeDeleted: true });
      if (!row) return null;
      const t = at ?? now();
      const state = row.state_json && typeof row.state_json === "object" ? row.state_json : jsonIn(row.state_json);
      const prior = state?.priorStatus;
      const status = prior && STATUSES_BY_KIND[row.kind].includes(prior) ? prior : DEFAULT_STATUS[row.kind];
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(`
          UPDATE item_state SET revision=revision+1, status=?,
                                state_json=json_remove(state_json, '$.priorStatus'),
                                deleted_at=NULL, closed_at=NULL, updated_at=?
           WHERE item_id=?
        `).run(status, t, id);
        appendEvent({
          itemId: id, fromStatus: row.status, toStatus: status,
          kind: row.kind === "task" ? "task.restored" : `${row.kind}.restored`,
          actor, note: "restored", at: t,
        });
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return itemApi.get(id);
    },

    kindOf(id) {
      const r = db.prepare("SELECT kind FROM items WHERE id=?").get(id);
      return r?.kind ?? null;
    },

    addTags(id, tags, source = "assign") {
      for (const tag of tags ?? []) {
        db.prepare("INSERT OR IGNORE INTO item_tags(item_id, tag, source, created_at) VALUES (?, ?, ?, ?)")
          .run(id, String(tag), source, now());
      }
    },
  };

  return itemApi;
}
