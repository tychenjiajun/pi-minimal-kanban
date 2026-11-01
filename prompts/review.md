---
description: Review the tasks waiting in this project's review statuses
---

Run the reviewer role from the board, not from memory. The goal is to clear the
work sitting in the project's review-like statuses and move each task to where it
actually belongs.

1. **Find the review work.** Start with `kanban_list { briefing: true }` (or
   `kanban_list {}`) to learn the workflow's statuses. Pick the statuses that mean
   review or testing — ids or labels such as `reviewing`, `review`, `testing`,
   `qa`. If the workflow has no review-like status, say so and stop; do not invent
   one. For each such status, `kanban_list { status: "<id>" }`.

2. **Claim by reading, not by forcing.** Reviewable tasks are usually held by
   the author who moved them in. Only a task unassigned, or held by you, is yours
   to move freely. Do not take over another handle's task — a `wrong_owner` is the
   board telling you the author still owns it. If a task must move and you are not
   its owner, that is a `force` + `reason` decision for a human, not a step you
   perform silently to make the list shorter.

3. **Review each one properly.** For each task you own, read it with
   `kanban_list { task: "T-00NN" }`, then read its actual change — the task's
   branch, diff, and the code it touched. Judge the work, not the title: does it
   do what the task says, and does it hold up?

4. **Leave the board in the truth of the review.** `kanban_comment` your findings
   on the task — what passed, what did not, and what must change. Then move it to
   where the verdict belongs: into the terminal status to accept it, or back into
   the working status it came from to send it back, carrying the reason. Move with
   the `rev` you just read as `expectedRev`; if it comes back `stale`, re-read and
   reconcile before retrying. Never hand-edit `status`, `assignee`, or `history`.

Report, briefly, which tasks you reviewed, the verdict on each, and any task you
left alone because someone else owns it. Do not move anything you did not
actually review, and do not review from the title alone.
