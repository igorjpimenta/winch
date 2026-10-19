// deps.js — dependency mutations with DAG cycle prevention.
//
// `addDep(store, from, to)` rejects with `{ok:false, code:"cycle", path:[...]}`
// if accepting the edge would create a cycle. We DFS forward from `to` over
// the existing dep graph; if we reach `from`, the new edge would close a
// loop. Depth-limited to avoid pathological graphs (500 nodes is plenty for
// any human-scale backlog; cycles in real data show up far earlier).

const MAX_DFS_NODES = 500;

function reachable(store, startId, targetId) {
  if (startId === targetId) return [startId];
  const seen = new Set([startId]);
  const stack = [[startId, [startId]]];
  let visited = 0;
  while (stack.length) {
    const [cur, trail] = stack.pop();
    if (++visited > MAX_DFS_NODES) return null;
    const out = store.dep.listOutgoing(cur);
    for (const edge of out) {
      if (seen.has(edge.to_id)) continue;
      if (edge.to_id === targetId) return [...trail, edge.to_id];
      seen.add(edge.to_id);
      stack.push([edge.to_id, [...trail, edge.to_id]]);
    }
  }
  return null;
}

/**
 * Add `from depends on to`. Rejects:
 *   - missing items
 *   - self-edge
 *   - duplicate edge (treated as ok / no-op)
 *   - would-be cycle
 */
export function addDep(store, fromId, toId) {
  if (fromId === toId) return { ok: false, code: "self_edge" };
  const fromKind = store.itemKindOf(fromId);
  const toKind   = store.itemKindOf(toId);
  if (!fromKind) return { ok: false, code: "from_not_found", id: fromId };
  if (!toKind)   return { ok: false, code: "to_not_found",   id: toId };

  // Would the new edge `from → to` create a cycle? It does iff there's an
  // existing path `to → ... → from`. DFS from `to` looking for `from`.
  // `reachable` returns the trail [toId, ..., fromId]; the cycle is closed
  // by the new edge `fromId → toId`, so prepend `fromId` to make it readable.
  const cyclePath = reachable(store, toId, fromId);
  if (cyclePath) return { ok: false, code: "cycle", path: [fromId, ...cyclePath] };

  store.dep.addRaw({ fromId, fromKind, toId, toKind });
  return { ok: true };
}

export function removeDep(store, fromId, toId) {
  return store.dep.remove({ fromId, toId }) ? { ok: true } : { ok: false, code: "not_found" };
}

/**
 * Are all dependencies of `id` resolved? Returns true iff every outgoing
 * `id → other` has `other.status` in DONE_STATUSES for its kind.
 */
export function depsResolved(store, id) {
  const out = store.dep.listOutgoing(id);
  for (const edge of out) {
    const item = ({ epic: store.epic.get, story: store.story.get, task: store.task.get })[edge.to_kind](edge.to_id);
    if (!item) return false; // missing dep target = block (safer than ignoring)
    if (item.status !== "done" && item.status !== "cancelled") return false;
  }
  return true;
}
