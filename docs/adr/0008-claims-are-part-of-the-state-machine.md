# Claims are part of the state machine

A task is claimed by the handle that moves it into an `active` status. While it sits in an active status, only that handle may move it or release it; another handle needs `force`. Entering a terminal status releases the claim.

An `assignee` field alone would be a label, not an invariant: two agents that read "unassigned" at the same time would both proceed. Tying the claim to the transition that starts work makes the claim a consequence of the move, which is performed under the board lock. The alternative — a `claims/` file or a claim inferred from history — either adds a second source of truth or makes "who owns the planning phase" ambiguous in multi-stage workflows.

## Consequences

`force` is the only way to take over or release someone else's claim. There are no leases or heartbeats: a crashed agent leaves a claim behind, and releasing it is a deliberate act. Silent expiry would be worse, because an agent that is still working but has not called a tool recently is indistinguishable from a dead one.

Claims are enforced within one checkout. Two agents in separate git worktrees have separate boards and cannot see each other's claims.

## Considered Options

- **`assignee` as a plain label**: no enforcement, so it cannot prevent concurrent work.
- **A separate `claims/` file per task**: a second source of truth next to the task file.
- **Ownership inferred from history**: loses pre-work assignment and blurs stage ownership.
- **Leases with heartbeat expiry**: silently unassigns work that is still in progress.
