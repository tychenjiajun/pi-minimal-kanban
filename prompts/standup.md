---
description: Produce a short board standup for one handle or the whole project
argument-hint: "[handle]"
---

Build a standup from the board, not from memory. The optional handle is `${1}`;
if it is empty, cover the whole board.

Start with `kanban_list {}` (or `kanban_list { briefing: true }` if this is your
first look) so you know the workflow's statuses, who holds what, and the claim
ages. Then gather only the slices you need:

- **Claimed / in progress.** For a handle, `kanban_list { assignee: "${1}" }`
  (only pass `assignee` when `${1}` is non-empty). For the whole board, list
  every task and group by assignee. Keep the claim age shown next to each
  assignee (`@coder-1 3d`); it is measured from when the claim started. Say what
  each task is and how long it has been held.
- **Reviewable.** Read the workflow block from the first `kanban_list` and pick
  the statuses that mean review or testing (ids or labels such as `reviewing`,
  `review`, `testing`, `qa`). List `kanban_list { status: "<that-status>" }` and
  call out tasks not held by the handle, since those are the ones another agent
  can pick up. If the workflow has no review-like status, say so instead of
  inventing one.
- **Done recently.** List terminal tasks (`kanban_list { status: "<terminal>" }`,
  using the terminal status id from the first list's workflow block). Rows are
  ordered by id, so favour the highest-numbered tasks and read a candidate with
  `kanban_list { task: "T-00NN" }` when you need its `updated` time to confirm
  it is recent. Report the ones from this window, not the whole archive.
- **Stale claims.** Flag any claim older than 24 h using the claim age already in
  the rows. A claim never expires on its own, so a stale one is a decision for a
  human or a takeover, not a cleanup you perform silently. Do not try to run a
  stale-check command; the age in each row is the signal, and reporting it is
  enough.

Write it short and scannable — a heading per section and one bullet per task,
with the task id, status, owner, and claim age. If you had to take over or
release anything while gathering, say which task, from whom, and why. Do not
restate the board, do not list every task on a large board, and do not move
anything just to make the standup look tidy.
