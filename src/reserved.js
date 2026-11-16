// Reserved assignment identities. They name human work, never a caller:
// `human` is an assignee sentinel and `human_in_the_loop` is the harness
// stamped with it. Both are refused as caller layers by identity.js.

export const HUMAN_AGENT = "human";
export const HUMAN_HARNESS = "human_in_the_loop";

export function isReservedLayer(layer, value) {
  if (typeof value !== "string") return false;
  const v = value.trim();
  return (
    (layer === "harness" && v === HUMAN_HARNESS) ||
    (layer === "agent" && v === HUMAN_AGENT)
  );
}

export function resolveAssignmentPair(agent, harness) {
  if (agent === HUMAN_AGENT) return { agent, harness: HUMAN_HARNESS };
  if (harness === HUMAN_HARNESS) {
    throw new Error(`reserved assignment harness: ${HUMAN_HARNESS}`);
  }
  return { agent, harness: harness ?? null };
}
