// Planner execution lease. Tasks use backlog_claim as their CAS; planner wakes
// (story/append/review) have no task row, so this is the one-winner guard.
import { ok, err } from "./shared.js";

export function createAcceptWakeTools({ store, logger }) {
  return {
    async backlog_accept_wake(args, identity, cfg) {
      const id = typeof args?.admissionId === "string" ? args.admissionId.trim() : "";
      const attemptNo = Number(args?.attemptNo);
      const consumerId = identity.consumer;
      const leaseEpoch = Number(args?.leaseEpoch);
      if (!id || !Number.isInteger(attemptNo)) return err("backlog_accept_wake: admissionId and attemptNo are required", "rejected");
      if (!consumerId) return err("backlog_accept_wake: caller has no consumer id", "rejected");
      try {
        const result = store.admission.acceptWake({
          id, attemptNo, consumerId, leaseEpoch,
          leaseMs: Math.max(cfg.dispatchConsumerTtlMs ?? 90000, cfg.dispatchOfferMs ?? 120000),
        });
        if (result?.error === "not_live") return err(`${id} attempt ${attemptNo} is not live; re-read recover.`, "stale_lease", { admissionId: id, attemptNo });
        if (result?.error === "wrong_kind") return err(`${id} is a task wake; use backlog_claim.`, "rejected", { admissionId: id });
        if (result?.error === "stale_lease") return err(`${id} is leased by another consumer or epoch.`, "stale_lease", { admissionId: id, attemptNo });
        if (result?.error) return err(`backlog_accept_wake failed: ${result.error}`, "error", { admissionId: id });
        return ok(JSON.stringify({ ok: true, ...result }), { status: "ok", admissionId: id, attemptNo, leaseEpoch: result.leaseEpoch });
      } catch (e) {
        logger?.warn?.(`backlog_accept_wake failed: ${e?.message}`);
        return err(`backlog_accept_wake failed: ${e?.message}`, "error", { admissionId: id });
      }
    },
  };
}
