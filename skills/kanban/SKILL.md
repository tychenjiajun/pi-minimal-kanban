---
name: kanban
description: Coordinate multiple Pi agents on one project's .pi/kanban board using the five kanban tools. Load when an agent is about to coordinate work rather than just do a single edit, such as creating a task, claiming or moving it through the workflow, handing off or taking over another agent's task, commenting, or reporting who owns what. Also load for status summaries and standups (what a handle holds, what is reviewable, what a takeover's reason was). Use before writing to a task another agent may own, when you need an exclusive claim, or when a kanban_list result you already read may be stale.
---

# Kanban coordination

A board is one project's shared task state at `.pi/kanban/`. It is not per-session
state: every agent on the project reads and writes the same files. All changes go
through five tools — never hand-edit `status`, `assignee`, `history`, or `rev`.

Vocabulary: a **task** has one **status**, one **assignee**, and a **comment**
thread. Moving a task into an **active** status (shown `◆`) **claims** it for
your **handle**. A **handle** is the name you pass as `agent`; the board records
it but does not verify who you are.

## Create a task only when work spans agents or outlives the turn

Do not create a board task for a one-shot edit you will finish in this turn. Create
one when the work is a unit another agent might pick up, review, or take over, or
when it should outlive your session:

```
kanban_create { agent: "coder-1", title: "Add retry to the upload client",
                description: "Cover 5xx and network timeouts." }
```

This creates the task in the workflow's initial status, unassigned, and returns
the new task with its `id` and `rev`. `title` is one line up to 200 characters;
`description` is optional Markdown — leave it empty and let later agents fill it
in. Fill `title` and `description` by hand (ordinary file tools); only `status`,
`assignee`, `history`, `rev`, and comments are tool-only.

## Start by reading the board

Before you move anything you do not own, read the board so you know the statuses,
who holds what, and the current `rev` of the task you will write:

```
kanban_list {}                       # paged rows: id, status, title, @assignee, rev
kanban_list { briefing: true }       # rules + first calls; wins over every parameter
```

On an empty board the list *is* the briefing: it prints the claim rules, the
workflow's active statuses, and the first calls to make. A board with unreadable
task files is not empty — the briefing then prints those warnings too. Pass
`briefing: true` on your very first interaction to learn the workflow and the
claim rule without guessing.

Filter and page a large board: `{ assignee: "coder-1" }`, `{ status: "reviewing" }`,
`{ summary: true }` (per-status counts), `{ task: "T-0003" }` (one task in full),
`{ limit: 100, offset: 0 }` (50 by default, 500 max).

## Claims are exclusive

Moving a task into an active status claims it for the handle you passed, with no
flag. Only that handle may move or release the task while it sits in an active
status; a competing writer gets `wrong_owner` and writes nothing. So:

- To do the work, move your task into an active status: that is the claim.
- To hand your own task to another handle, use `kanban_assign` with `force`.
- A **terminal** status releases the claim and clears the assignee; a terminal
  task cannot be assigned until it is moved back.
- **No claim expires on its own.** A departed owner blocks the task until
  somebody releases it (see takeovers and stale-owner recovery below).

## Pass expectedRev so a stale read fails instead of overwriting

Every read shows the task's `rev`. When you write a task another agent may have
changed since, pass the `rev` you last saw as `expectedRev`:

```
kanban_move { task: "T-0003", to: "reviewing", agent: "coder-1", expectedRev: 7 }
```

If the task is no longer at that `rev`, the call fails with `stale` (naming the
observed and expected `rev` and the current status) instead of clobbering the
other agent's write. Read again, reconcile, and retry. `expectedRev` is accepted
by `kanban_move`, `kanban_assign`, and `kanban_comment`; `kanban_create` and
`kanban_list` do not take it.

## Takeovers: force + reason

To take over a claim another handle holds — or to assign a task to any handle but
your own — pass `force: true` and a one-line `reason` (1-200 characters):

```
kanban_assign { task: "T-0003", assignee: "coder-2", agent: "coder-2",
                force: true, reason: "owner idle 2d", expectedRev: 9 }
```

The write is recorded as `force-assign` + `forced: true` and the `reason` is
stored on that history entry and printed as a `why` line, so a reader can tell
"the owner crashed" from "the owner was preempted". `reason` **requires**
`force`; without it the call is an `invalid_argument` error, because an
annotation on a write that took nothing over would be a false record. Moving into
an active status to claim for yourself needs no `force` and no `reason`.

## Comment to coordinate

`kanban_comment` appends a Markdown note to a task's thread — hand off context,
ask a question, flag a blocker:

```
kanban_comment { task: "T-0003", agent: "coder-1",
                 body: "Timeout path is done; ready for review.", expectedRev: 8 }
```

The body may contain headings, lists, and code fences (up to 20,000 characters).

## When to load the references

- `references/coordination.md` — the claim lifecycle, handoff patterns, reading a
  takeover's `why`, recovering a stale owner with `/kanban validate --stale`, and
  the `rev` / optimistic-concurrency workflow with a concrete example.
- `references/workflow-authoring.md` — how to author `.pi/kanban/workflow.yaml`:
  statuses, active vs terminal, and declared transitions, plus the rules the
  loader enforces.
