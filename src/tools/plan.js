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
      try {
        epic = store.epic.create({
          title: epicIn.title,
          description: epicIn.description,
          acceptance: epicIn.acceptance,
          status: "planned",
          priority: epicIn.priority ?? 50,
          createdBy: identity.agent,
        });
        const idByKey = new Map();
        const stories = storiesIn.map((s, si) => {
          const story = store.story.create({
            epicId: epic.id,
            title: s.title,
            description: s.description,
            acceptance: s.acceptance,
            status: "ready",
            priority: s.priority ?? epic.priority,
            capabilities: s.capabilities,
          });
          const tasks = (s.tasks ?? []).map((t, ti) => {
            const key = t.key ?? `s${si}t${ti}`;
            const task = store.task.create({
              storyId: story.id,
              title: t.title,
              description: t.description,
              status: "todo",
              executionKind: t.executionKind ?? "manual",
              executionArgs: t.executionArgs,
              capabilities: t.capabilities ?? s.capabilities,
            });
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
        // Creating the epic is the first write; cascade removes anything
        // written under it, so a failure leaves the store as it was.
        if (epic?.id) store.db.prepare("DELETE FROM epics WHERE id=?").run(epic.id);
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
        store.story.update(story.id, { status: "ready" });
      }
      const created = { stories: [], tasks: [] };
      const idByKey = new Map();
      const at = Date.now();
      try {
        (args.stories ?? []).forEach((st, si) => {
          if (!st?.title) throw new Error("every story needs a title");
          const row = store.story.create({
            epicId: epic.id,
            title: st.title,
            description: st.description,
            acceptance: st.acceptance,
            status: "ready",
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
            status: "todo",
            executionKind: t.executionKind ?? "manual",
            executionArgs: t.executionArgs,
            capabilities: t.capabilities ?? parent?.capabilities,
            assigned: t.assigned ?? null,
          });
          entry.task = row;
          created.tasks.push({ id: row.id, key, title: row.title, storyId, assigned: row.assigned });
        }
        for (const [key, entry] of idByKey) {
          for (const dep of entry.deferred.t.dependsOn ?? []) {
            const target = idByKey.get(dep)?.task?.id ?? (/^(TASK|STORY|EPIC)-/.test(dep) ? dep : null);
            if (!target) throw new Error(`unknown dependsOn: ${dep}`);
            const res = addDep(store, entry.task.id, target);
            if (!res.ok) throw new Error(`dependency ${key} -> ${dep} rejected: ${res.code}`);
          }
        }
        // task.appended tells a dispatcher this work arrived after the plan;
        // task.created (from plan) stays planner noise.
        for (const t of created.tasks) {
          store.db.prepare("INSERT INTO events(task_id,from_status,to_status,kind,actor,note,at) VALUES(?,?,?,?,?,?,?)")
            .run(t.id, "todo", "todo", "task.appended", `${identity.harness}:${identity.agent}`, t.title.slice(0, 120), at);
        }
        return ok(
          JSON.stringify({ ok: true, epicId: epic?.id ?? null, stories: created.stories, tasks: created.tasks }),
          { status: "ok", agentId: identity.agent, stories: created.stories.length, tasks: created.tasks.length }
        );
      } catch (e) {
        for (const t of created.tasks) store.db.prepare("DELETE FROM tasks WHERE id=?").run(t.id);
        for (const st of created.stories) store.db.prepare("DELETE FROM stories WHERE id=?").run(st.id);
        logger?.warn?.(`backlog_append failed: ${e?.message}`);
        return err(`backlog_append failed: ${e?.message}`, "error");
      }
    },

    async backlog_drop(args, identity, cfg) {
      const id = args?.id;
      if (!id) return err("backlog_drop: id is required", "rejected");
      const kind = store.itemKindOf(id);
      if (!kind) return err(`backlog_drop: not found: ${id}`, "not_found");
      const epic = kind === "epic" ? store.epic.get(id) : null;
      const story = kind === "story" ? store.story.get(id) : null;
      const task = kind === "task" ? store.task.get(id) : null;
      if ((kind === "epic" && !epic) || (kind === "story" && !story) || (kind === "task" && !task)) {
        return err(`backlog_drop: not found: ${id}`, "not_found");
      }
      const storyIds = kind === "epic"
        ? store.story.list({ epicId: id }).map((s) => s.id)
        : kind === "story" ? [id] : [];
      const tasks = kind === "task" ? [task] : storyIds.flatMap((sid) => store.task.list({ storyId: sid }));
      // Dropping is reversible, but it must never hide work someone has done:
      // the guard covers every descendant, not just the row named in the call.
      const claimed = tasks.filter((t) => t.claimed_at != null || (t.attempt_count ?? 0) > 0 || (t.status !== "todo" && t.status !== "cancelled"));
      if (claimed.length > 0) {
        return err(
          `${id} cannot be dropped: ${claimed.length} task(s) under it were already claimed (${claimed.map((t) => t.id).join(", ")}).`,
          "not_droppable",
          { id, tasks: claimed.map((t) => t.id) }
        );
      }
      try {
        const at = Date.now();
        const note = args?.reason ? `dropped: ${String(args.reason).slice(0, 160)}` : `dropped with ${kind}`;
        const actor = `${identity.harness}:${identity.agent}`;
        store.db.exec("BEGIN IMMEDIATE");
        try {
          for (const t of tasks) {
            if (t.status === "cancelled") continue;
            store.db.prepare("UPDATE tasks SET status='cancelled', updated_at=?, closed_at=? WHERE id=?").run(at, at, t.id);
            store.db.prepare("INSERT INTO events(task_id,from_status,to_status,kind,actor,note,at) VALUES(?,?,?,?,?,?,?)")
              .run(t.id, t.status, "cancelled", "task.dropped", actor, note, at);
          }
          for (const sid of storyIds) {
            const row = store.story.get(sid);
            if (row.status === "cancelled") continue;
            store.db.prepare("UPDATE stories SET status='cancelled', updated_at=?, closed_at=? WHERE id=?").run(at, at, sid);
          }
          if (kind === "epic") {
            store.db.prepare("UPDATE epics SET status='cancelled', updated_at=?, closed_at=? WHERE id=?").run(at, at, id);
          }
          store.db.exec("COMMIT");
        } catch (e) {
          store.db.exec("ROLLBACK");
          throw e;
        }
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
      if (!kind) return err(`backlog_restore: not found: ${id}`, "not_found");
      const epic = kind === "epic" ? store.epic.get(id) : null;
      const story = kind === "story" ? store.story.get(id) : null;
      const task = kind === "task" ? store.task.get(id) : null;
      if ((kind === "epic" && !epic) || (kind === "story" && !story) || (kind === "task" && !task)) {
        return err(`backlog_restore: not found: ${id}`, "not_found");
      }
      const storyIds = kind === "epic"
        ? store.story.list({ epicId: id }).filter((s) => s.status === "cancelled").map((s) => s.id)
        : kind === "story" && story.status === "cancelled" ? [id] : [];
      const tasks = (kind === "task"
        ? [task].filter((t) => t.status === "cancelled")
        : storyIds.flatMap((sid) => store.task.list({ storyId: sid }))
      ).filter((t) => t.status === "cancelled");
      if (kind === "epic" && epic.status !== "cancelled") return err(`${id} is ${epic.status}, not dropped.`, "not_dropped");
      if (kind === "story" && story.status !== "cancelled") return err(`${id} is ${story.status}, not dropped.`, "not_dropped");
      if (kind === "task" && task.status !== "cancelled") return err(`${id} is ${task.status}, not dropped.`, "not_dropped");
      try {
        const at = Date.now();
        const actor = `${identity.harness}:${identity.agent}`;
        store.db.exec("BEGIN IMMEDIATE");
        try {
          for (const t of tasks) {
            store.db.prepare("UPDATE tasks SET status='todo', updated_at=?, closed_at=NULL WHERE id=?").run(at, t.id);
            store.db.prepare("INSERT INTO events(task_id,from_status,to_status,kind,actor,note,at) VALUES(?,?,?,?,?,?,?)")
              .run(t.id, "cancelled", "todo", "task.restored", actor, "restored", at);
          }
          for (const sid of storyIds) {
            store.db.prepare("UPDATE stories SET status='ready', updated_at=?, closed_at=NULL WHERE id=?").run(at, sid);
          }
          if (kind === "epic") {
            store.db.prepare("UPDATE epics SET status='planned', updated_at=?, closed_at=NULL WHERE id=?").run(at, id);
          }
          store.db.exec("COMMIT");
        } catch (e) {
          store.db.exec("ROLLBACK");
          throw e;
        }
        logger?.info?.(`backlog: ${actor} restored ${id} (${tasks.length} task(s))`);
        return ok(JSON.stringify({ ok: true, restored: { kind, id }, tasks: tasks.map((t) => t.id) }), {
          status: "ok", agentId: identity.agent, level: kind, id,
        });
      } catch (e) {
        logger?.warn?.(`backlog_restore failed: ${e?.message}`);
        return err(`backlog_restore failed: ${e?.message}`, "error");
      }
    },
  };
}
