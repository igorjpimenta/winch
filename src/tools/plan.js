// plan.js — create and reshape the plan: plan, append, drop, restore.
import { addDep } from "../deps.js";
import { ok, err } from "./shared.js";

export function createPlanTools({ store, logger }) {
  return {
    async backlog_plan(args, identity, cfg) {
      const epicIn = args?.epic;
      const storiesIn = args?.stories;
      if (!epicIn?.title || !Array.isArray(storiesIn) || storiesIn.length === 0) {
        return err("backlog_plan: epic.title and at least one story are required", "rejected");
      }
      // Validate keys and dependency direction before writing anything:
      // backward-only edges make the plan acyclic without a graph search,
      // and a bad key must not leave half a plan behind.
      const flat = [];
      storiesIn.forEach((s, si) => {
        (s?.tasks ?? []).forEach((t, ti) => {
          flat.push({ storyIndex: si, taskIndex: ti, key: t?.key ?? `s${si}t${ti}`, dependsOn: t?.dependsOn ?? [], title: t?.title });
        });
      });
      const keyIndex = new Map();
      for (let i = 0; i < flat.length; i++) {
        if (keyIndex.has(flat[i].key)) return err(`backlog_plan: duplicate task key: ${flat[i].key}`, "rejected");
        keyIndex.set(flat[i].key, i);
      }
      for (const item of flat) {
        for (const dep of item.dependsOn) {
          if (!keyIndex.has(dep)) return err(`backlog_plan: unknown dependsOn key: ${dep} (in ${item.key})`, "rejected");
          if (keyIndex.get(dep) >= keyIndex.get(item.key)) {
            return err(`backlog_plan: dependsOn must point backward: ${item.key} -> ${dep}`, "rejected");
          }
        }
      }
      let epic = null;
      const createdIds = [];
      try {
        epic = store.epic.create({
          title: epicIn.title,
          description: epicIn.description,
          acceptance: epicIn.acceptance,
          status: "backlog",
          priority: epicIn.priority ?? 50,
          createdBy: identity.agent,
        });
        createdIds.push(epic.id);
        const idByKey = new Map();
        const stories = storiesIn.map((s, si) => {
          const story = store.story.create({
            epicId: epic.id,
            title: s.title,
            description: s.description,
            acceptance: s.acceptance,
            status: "backlog",
            priority: s.priority ?? epic.priority,
            capabilities: s.capabilities,
          });
          createdIds.push(story.id);
          const tasks = (s.tasks ?? []).map((t, ti) => {
            const key = t.key ?? `s${si}t${ti}`;
            const task = store.task.create({
              storyId: story.id,
              title: t.title,
              description: t.description,
              status: "backlog",
              executionKind: t.executionKind ?? "manual",
              executionArgs: t.executionArgs,
              capabilities: t.capabilities ?? s.capabilities,
            });
            createdIds.push(task.id);
            idByKey.set(key, task.id);
            return { id: task.id, key, title: task.title };
          });
          return { id: story.id, title: story.title, acceptance: story.acceptance ?? null, tasks };
        });
        let dependencies = 0;
        for (const item of flat) {
          for (const dep of item.dependsOn) {
            const res = addDep(store, idByKey.get(item.key), idByKey.get(dep));
            if (!res.ok) throw new Error(`dependency ${item.key} -> ${dep} rejected: ${res.code}`);
            dependencies++;
          }
        }
        logger?.info?.(`backlog: ${identity.harness}:${identity.agent} planned ${epic.id} (${flat.length} tasks)`);
        return ok(
          JSON.stringify({ epic: { id: epic.id, title: epic.title }, stories, dependencies }),
          { status: "ok", agentId: identity.agent, epicId: epic.id, tasks: flat.length }
        );
      } catch (e) {
        // The epic is the root; deleting it cascades everything written under it.
        if (epic?.id) {
          for (const id of createdIds) store.db.prepare("DELETE FROM item_events WHERE item_id=?").run(id);
          store.db.prepare("DELETE FROM items WHERE id=?").run(epic.id);
        }
        logger?.warn?.(`backlog_plan failed: ${e?.message}`);
        return err(`backlog_plan failed: ${e?.message}`, "error");
      }
    },

    async backlog_append(args, identity, cfg) {
      const epic = args?.epicId ? store.epic.get(args.epicId) : null;
      const story = args?.storyId ? store.story.get(args.storyId) : null;
      if (args?.epicId && !epic) return err(`backlog_append: epic not found: ${args.epicId}`, "not_found");
      if (args?.storyId && !story) return err(`backlog_append: story not found: ${args.storyId}`, "not_found");
      if (args?.stories?.length && !epic) return err("backlog_append: epicId is required to add stories", "rejected");
      if (args?.tasks?.length && !story) return err("backlog_append: storyId is required to add tasks", "rejected");
      if (!args?.stories?.length && !args?.tasks?.length) {
        return err("backlog_append: pass stories[] or tasks[]", "rejected");
      }
      // Appending after a close is a review finding: reopen the containers so
      // the new work can actually be claimed.
      if (epic && (epic.status === "done" || epic.status === "cancelled")) {
        store.epic.update(epic.id, { status: "in_progress" });
      }
      if (story && (story.status === "done" || story.status === "cancelled")) {
        store.story.update(story.id, { status: story.assignee_agent ? "ready" : "backlog" });
      }
      const created = { stories: [], tasks: [] };
      const idByKey = new Map();
      const actor = `${identity.harness}:${identity.agent}`;
      try {
        (args.stories ?? []).forEach((st, si) => {
          if (!st?.title) throw new Error("every story needs a title");
          const row = store.story.create({
            epicId: epic.id,
            title: st.title,
            description: st.description,
            acceptance: st.acceptance,
            status: "backlog",
            priority: st.priority ?? epic.priority,
            capabilities: st.capabilities,
          });
          created.stories.push({ id: row.id, title: row.title });
          (st.tasks ?? []).forEach((t, ti) => {
            if (!t?.title) throw new Error("every task needs a title");
            const key = t.key ?? `s${si}t${ti}`;
            if (idByKey.has(key)) throw new Error(`duplicate key: ${key}`);
            idByKey.set(key, { task: null, deferred: { storyId: row.id, t, si, ti } });
          });
        });
        (args.tasks ?? []).forEach((t, i) => {
          if (!t?.title) throw new Error("every task needs a title");
          const key = t.key ?? `a${i}`;
          if (idByKey.has(key)) throw new Error(`duplicate key: ${key}`);
          idByKey.set(key, { task: null, deferred: { storyId: story.id, t, si: -1, ti: i } });
        });
        // Create every task after the stories exist, then resolve edges, so a
        // bad dependency key rolls the whole call back instead of half-writing.
        for (const [key, entry] of idByKey) {
          const { storyId, t } = entry.deferred;
          const parent = store.story.get(storyId);
          const row = store.task.create({
            storyId,
            title: t.title,
            description: t.description,
            status: "backlog",
            executionKind: t.executionKind ?? "manual",
            executionArgs: t.executionArgs,
            capabilities: t.capabilities ?? parent?.capabilities,
            assigned: t.assigned ?? null,
            assigneeHarness: t.assigned ? identity.harness : null,
          });
          entry.task = row;
          created.tasks.push({ id: row.id, key, title: row.title, storyId, status: row.status, assigned: row.assignee_agent });
        }
        for (const [key, entry] of idByKey) {
          for (const dep of entry.deferred.t.dependsOn ?? []) {
            const target = idByKey.get(dep)?.task?.id ?? (store.itemKindOf(dep) ? dep : null);
            if (!target) throw new Error(`unknown dependsOn: ${dep}`);
            const res = addDep(store, entry.task.id, target);
            if (!res.ok) throw new Error(`dependency ${key} -> ${dep} rejected: ${res.code}`);
          }
        }
        // task.appended tells a dispatcher this work arrived after the plan;
        // task.created (from plan) stays planner noise.
        for (const t of created.tasks) {
          store.event.append({
            itemId: t.id, fromStatus: t.status, toStatus: t.status, kind: "task.appended",
            actor, note: t.title.slice(0, 120),
          });
        }
        return ok(
          JSON.stringify({ ok: true, epicId: epic?.id ?? null, stories: created.stories, tasks: created.tasks }),
          { status: "ok", agentId: identity.agent, stories: created.stories.length, tasks: created.tasks.length }
        );
      } catch (e) {
        for (const t of created.tasks) {
          store.db.prepare("DELETE FROM item_events WHERE item_id=?").run(t.id);
          store.db.prepare("DELETE FROM items WHERE id=?").run(t.id);
        }
        for (const st of created.stories) {
          store.db.prepare("DELETE FROM item_events WHERE item_id=?").run(st.id);
          store.db.prepare("DELETE FROM items WHERE id=?").run(st.id);
        }
        logger?.warn?.(`backlog_append failed: ${e?.message}`);
        return err(`backlog_append failed: ${e?.message}`, "error");
      }
    },

    async backlog_drop(args, identity, cfg) {
      const id = args?.id;
      if (!id) return err("backlog_drop: id is required", "rejected");
      const kind = store.itemKindOf(id);
      const row = kind ? store.item.get(id, { includeDeleted: true }) : null;
      if (!kind || !row) return err(`backlog_drop: not found: ${id}`, "not_found");
      const tree = store.item.tree(id, { includeDeleted: true });
      const tasks = tree.filter((r) => r.kind === "task");
      // Dropping is reversible, but it must never hide work someone has done:
      // the guard covers every descendant, not just the row named in the call.
      const claimed = tasks.filter((t) => t.attempt_count > 0 || (t.status !== "backlog" && t.status !== "ready" && t.status !== "cancelled"));
      if (claimed.length > 0) {
        return err(
          `${id} cannot be dropped: ${claimed.length} task(s) under it were already claimed (${claimed.map((t) => t.id).join(", ")}).`,
          "not_droppable",
          { id, tasks: claimed.map((t) => t.id) }
        );
      }
      try {
        const actor = `${identity.harness}:${identity.agent}`;
        const result = store.item.drop(id, { reason: args?.reason ?? null, actor });
        logger?.info?.(`backlog: ${actor} dropped ${id} (${tasks.length} task(s), soft)`);
        return ok(JSON.stringify({ ok: true, dropped: { kind, id, reversible: true }, tasks: tasks.map((t) => t.id) }), {
          status: "ok", agentId: identity.agent, level: kind, id,
        });
      } catch (e) {
        logger?.warn?.(`backlog_drop failed: ${e?.message}`);
        return err(`backlog_drop failed: ${e?.message}`, "error");
      }
    },

    async backlog_restore(args, identity, cfg) {
      const id = args?.id;
      if (!id) return err("backlog_restore: id is required", "rejected");
      const kind = store.itemKindOf(id);
      const row = kind ? store.item.get(id, { includeDeleted: true }) : null;
      if (!kind || !row) return err(`backlog_restore: not found: ${id}`, "not_found");
      if (row.deleted_at == null && row.status !== "cancelled") {
        return err(`${id} is ${row.status}, not dropped.`, "not_dropped");
      }
      try {
        const actor = `${identity.harness}:${identity.agent}`;
        const tree = store.item.tree(id, { includeDeleted: true });
        // Restore top-down so a child never outlives its cancelled parent.
        for (const r of tree) {
          if (r.deleted_at != null || r.status === "cancelled") store.item.restore(r.id, { actor });
        }
        logger?.info?.(`backlog: ${actor} restored ${id} (${tree.filter((r) => r.kind === "task").length} task(s))`);
        return ok(JSON.stringify({ ok: true, restored: { kind, id }, tasks: tree.filter((r) => r.kind === "task").map((r) => r.id) }), {
          status: "ok", agentId: identity.agent, level: kind, id,
        });
      } catch (e) {
        logger?.warn?.(`backlog_restore failed: ${e?.message}`);
        return err(`backlog_restore failed: ${e?.message}`, "error");
      }
    },
  };
}
