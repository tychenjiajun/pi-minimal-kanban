# Coordination details

Deeper material for `SKILL.md`. Everything here is the shipped behaviour of the
five kanban tools; nothing is a new rule. Vocabulary is `GLOSSARY.md`.

## The claim lifecycle

A task moves through a claim like this:

```
create (initial status, unassigned)
  └─ move into an active ◆ status  → plain `assign`, claimed for the caller
       ├─ move while the task is active → owner only; another needs force
       ├─ release (kanban_assign null, self) → `unassign`, task stays put
       └─ move into a terminal status → `unassign`, assignee cleared
```

- **Entering an active status claims.** The caller becomes the assignee and the
  history records a plain `assign`; no flag is needed because the new assignee is
  the caller.
- **The claim binds in both directions.** While the task sits in an active status,
  any other handle that tries to move it — forward or out — gets `wrong_owner`
  and nothing is written. A move *into* an active status is also contested when
  somebody else is already assigned: the target being active makes it a claim, so
  the mover needs `force`.
- **Leaving active does not always release.** Only a terminal status clears the
  assignee. Moving from an active status to a non-active, non-terminal status
  keeps the assignee as an **assignment**, not a claim: it has no claim age, but
  it still blocks a different handle from moving the task into an active status.
  Release it explicitly if you are done.
- **Terminal ends everything.** Entering a terminal status writes `unassign`,
  clears the assignee, and a terminal task cannot be assigned until it is moved
  back out.
- **Nothing expires.** The board never clears a claim on a timer. A stale claim is
  reported, not released; an agent that left the project blocks the task until
  someone takes it over or releases it.

Claim age is measured from the last `assign`/`force-assign` to the current
assignee, so it appears wherever the assignee appears (`@coder-1 3d`). An
assignee in a non-active status is an assignment, not a claim, and has no age.

## Handoff patterns

**Release, then let the next agent claim.** The cleanest handoff when you are
done. Releasing your own assignment needs no flag:

```
kanban_assign { task: "T-0003", assignee: null, agent: "coder-1", expectedRev: 8 }
```

The task stays in its current status, unassigned. `coder-2` then claims it by
moving it into an active status, which is a plain `assign`.

**Queue it for a named handle.** If the task should sit in a non-active status
until the next owner starts, move it there first, then hand it over explicitly.
Assigning to a handle that is not yours needs `force`, so this is a takeover
record even though no work was displaced:

```
kanban_assign { task: "T-0003", assignee: "coder-2", agent: "coder-1",
                force: true, reason: "handoff: ready for review", expectedRev: 8 }
```

**Direct takeover.** When the current owner is gone or has been preempted, change
hands in place with `force` and a `reason` (see below). The task keeps its status
and `rev` advances.

Do not use a stale `expectedRev` for a handoff. Read the task immediately before
the write; a handoff that fails with `stale` means the other agent is still
writing, and you should reconcile rather than retry blindly.

## Reading a takeover's `why`

A forced assignment is a `force-assign` history entry with `forced: true`; a
forced move records that entry and then the `move`. If the caller supplied a
`reason`, it is stored on the `force-assign` entry. In the task detail view the
reason prints under the entry as a `why` line:

```
history
  ...
  2026-10-30T10:05  force-assign  by coder-2
    why  owner idle 2d
```

Read it to decide whether the new owner is legitimate:

- `owner idle 2d`, `owner crashed`, `preempted by incident` — a normal takeover.
- An entry with no `why` is still valid and still readable; `/kanban validate`
  reports it once per task as an `unannotated_forced` **warning**. This is how
  boards written before 0.3.0 look: visible, not fatal, and no history is
  rewritten.
- A `reason` can never appear without `force`. A call that passes `reason` but
  not `force` fails with `invalid_argument` and writes nothing, so a reason is
  always evidence that a takeover happened.

`kanban_list { task: "T-0003" }` returns the same history in structured form
(`structuredContent.tasks[0].history`), so a script can inspect `action`,
`forced`, and `reason` without parsing prose.

## Recovering a stale owner

A claim older than the threshold is a **warning**, never an automatic release.
The threshold is 24 h by default; `/kanban validate` can shorten or lengthen it,
and `PI_KANBAN_STALE_MS` sets the default:

```
/kanban validate                 # 24 h default
/kanban validate --stale 12h     # warn about claims older than 12 h
/kanban validate --stale 0       # disable the stale check
```

A `stale_claim` warning names the task, the assignee, and the age. An assignment
older than the threshold in a non-active status is reported with distinct
wording, because it is the assignment — not a claim — that blocks the move that
would create one.

To recover, read the task and take it over or release it. Releasing another
handle's claim needs `force`:

```
kanban_assign { task: "T-0003", assignee: null, agent: "coder-2",
                force: true, reason: "owner idle 2d", expectedRev: 6 }
```

Then the task is unassigned in place, and any handle can claim it by moving it
into an active status. If you would rather own it immediately, assign it to
yourself with `force` and the same `reason`; that is a takeover, not a release.

Before any of this, check that the owner is actually gone. `/kanban validate` is
inspection only; it tells you the claim is old, not that the agent will not
return.

## The `rev` and `expectedRev` workflow

Every mutation increments the task's `rev`. Every read shows it. `expectedRev` is
optimistic concurrency: the write applies only if the task is still at the `rev`
you read, otherwise it fails with `stale` and writes nothing. That turns a silent
lost update into a visible retry.

The loop is: **read, decide, write with the rev you read, reconcile on `stale`.**

A concrete example. `coder-1` and `coder-2` both see `T-0003` in `new` at
`rev 4`, unassigned:

```
kanban_list { task: "T-0003" }
  → status new  unassigned  rev 4
```

`coder-2` claims it first by moving it into `planning`:

```
kanban_move { task: "T-0003", to: "planning", agent: "coder-2", expectedRev: 4 }
  → ok, rev 5, now claimed by @coder-2
```

`coder-1` then tries to move it on the stale read:

```
kanban_move { task: "T-0003", to: "planning", agent: "coder-1", expectedRev: 4 }
  → Error [stale]: Task T-0003 is at rev 5 (status "planning"), but the call expected rev 4. Re-read the task and retry.
```

Nothing was overwritten. `coder-1` re-reads, sees `rev 5` in `planning` held by
`@coder-2`, and decides: leave it, or take over with `force` and a `reason` that
explains why the task should move. Either way the next write uses `expectedRev: 5`
(or whatever the fresh read returned).

Rules of thumb:

- Use `expectedRev` whenever another agent might write the same task. Omit it
  only when you are the sole writer and the read is immediately before the write.
- On `stale`, re-read before retrying. Do not retry with the same rev — it will
  fail again.
- A `stale` error is a coordination signal, not a bug: another agent advanced the
  task while you were deciding.
- `expectedRev` is accepted by `kanban_move`, `kanban_assign`, and
  `kanban_comment`. `kanban_create` and `kanban_list` do not take it.
