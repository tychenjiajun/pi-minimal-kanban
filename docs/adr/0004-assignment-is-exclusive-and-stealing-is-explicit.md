# Assignment is exclusive, and stealing is explicit

A task has at most one assignee. Assigning an already-assigned task fails unless the caller passes `force`, and a forced assignment is recorded in the task's history as a steal. The assignee is an opaque handle; the extension does not verify that it names an agent, because it cannot.

This decision covers explicit assignment. How a claim is created and ended by a status transition is recorded in [ADR 0008](0008-claims-are-part-of-the-state-machine.md), and why assigning a task to a handle other than your own also needs `force` is recorded in [ADR 0009](0009-third-party-assignment-is-forced.md).

Two agents editing the same task in parallel is the failure this board exists to prevent, so a second assignment must be a deliberate act rather than a last-write-wins overwrite. There are no leases or heartbeats: a crashed agent leaves its task assigned, and releasing it is an explicit act by a human or another agent. Expiry would silently unassign work that is still in progress, which is a worse failure than a stale claim.

## The one human-initiated release

A departed owner would otherwise make a task unreachable, so there is exactly
one shortcut, and it is still a deliberate act:

- Every view that shows an assignee shows how long the claim has lasted
  (`@coder-1 3d`, `assignee  coder-1  (claimed 3d)`), so a quiet claim is
  visible rather than silent.
- `/kanban validate` reports a claim older than a threshold (24 h by default,
  `--stale 12h` or `PI_KANBAN_STALE_MS`/`PI_KANBAN_STALE_CLAIM_MS`) as a **`stale_claim` warning**.
  A warning never flips the report: the board stays valid, and a live agent
  that merely has not called a tool recently is not accused of anything.
- `/kanban release <task-id>` is the one mutating `/kanban` subcommand. It is
  sugar for `kanban_assign {task, assignee: null, force: true}`, so it obeys
  the same rule as any other forced unassignment: it records
  `{action: "unassign", forced: true}` in history, never changes the status,
  and never sets an assignee. Without `--yes` it prints a confirmation and
  writes nothing, in the TUI and in headless/RPC modes alike.
- Agents have the same path: `kanban_assign {task, assignee: null,
  force: true}`. Every `wrong_owner` and `already_assigned` refusal names both
  the claim age and that call, so an agent blocked by a dead owner is told how
  to proceed.

Nothing expires on a timer. The threshold only decides when a human is warned;
the release itself is always a person or an agent deciding to do it.

## The board lock

Every mutation runs under a `mkdir`-based board lock (`.pi/kanban/.lock/`).
Exclusivity must hold across processes, so the lock is entered, recovered and
released without ever deleting a directory the process did not move:

- **Entry is atomic.** The lock is built as `<lock>.entry.<token>/` with its
  `owner.json` inside and renamed onto `.lock`; a rename onto a non-empty
  directory fails, so a lock directory never exists half-built and two processes
  cannot both create it.
- **Recovery renames before it verifies.** The recoverer renames `.lock` to a
  unique `<lock>.steal.<random>/` tombstone, re-reads the tombstone's
  `owner.json`, and removes it only if the token there is the ownership it judged
  stale. If the lock changed hands it is renamed back — never over a directory
  the recoverer did not move — and left alone. A directory with no readable
  `owner.json` is never deleted on the strength of a failed read; it waits for
  its own grace period.
- **Recovery cleans up after itself.** A tombstone whose `owner.json` is gone,
  whose pid is dead on this host, or that is older than the grace period is
  reaped on the next acquisition; otherwise one crash would block every write.
- **Release is symmetric.** `release()` moves its own lock aside, deletes it only
  when the moved directory still carries its token, puts it back otherwise, and
  deletes its own tombstone if a recovery had moved the lock aside.
- **Deletes are rename-then-remove.** Directories are renamed to
  `.lock.trash.<random>/` before deletion, so `rm -r` never races a concurrent
  writer and two deleters cannot collide.

A steal by age is still a deliberate act of the recoverer: a live owner that
stalls longer than the stale threshold can have its lock taken, which is why the
threshold is generous (two minutes by default) and why nothing else expires on a
timer. Only the lock directory is stolen, never the claim on a task.

## Considered Options

- **Leases with heartbeat expiry**: handles crashes automatically, but a long-running task with no heartbeat window is indistinguishable from a dead agent.
- **Multiple assignees per task**: removes the invariant that makes the board useful for coordination.
- **Automatic expiry of stale claims**: rejected for the reason above; it is indistinguishable from unassigning an agent that is still working. See ADR 0008.
