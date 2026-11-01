# Task file format

Every task is one Markdown file at `.pi/kanban/tasks/T-0001.md`.

```md
---
id: T-0001
title: Add retry to the upload client
status: working
assignee: coder-1
created: 2026-10-30T10:00:00.000Z
updated: 2026-10-30T11:20:00.000Z
rev: 4
history:
  - at: 2026-10-30T10:00:00.000Z
    action: create
    by: coder-1
    to: new
  - at: 2026-10-30T10:05:00.000Z
    action: move
    by: coder-1
    from: new
    to: working
  - at: 2026-10-30T10:05:00.000Z
    action: assign
    by: coder-1
    assignee: coder-1
---

Retries should cover 5xx responses and network timeouts.

<!-- kanban:comment at=2026-10-30T11:20:00.000Z by=reviewer -->
Please add a test for the timeout path.
```

## Frontmatter

| Key | Required | Meaning |
|---|---|---|
| `id` | yes | Must equal the filename (`T-0001.md` → `T-0001`). |
| `title` | yes | A single line, up to 200 characters. |
| `status` | yes | A status id from the workflow. |
| `assignee` | no | The one handle holding the task. Absent means unassigned. |
| `created` | yes | ISO 8601 timestamp. |
| `updated` | yes | ISO 8601 timestamp, rewritten on every mutation. |
| `rev` | yes | Integer, incremented on every mutation. Use it with `expectedRev`. |
| `history` | yes | Append-only list of `create`, `move`, `assign`, `force-assign`, and `unassign`. |
| `history[].reason` | no | Why a forced takeover happened: one line, 1-200 characters. Written by `kanban_assign`/`kanban_move` when `force` is true. |

An `unassign` entry written by a forced `kanban_assign` (or, before 0.4.0, by
`/kanban release`) carries `forced: true`, so the history shows the release was
not the owner's own act. A `force-assign` may also carry `reason`: the last key of
the entry, printed under the entry as a `why` line in `/kanban <task-id>`. A file
written before 0.3.0 has no `reason` key, still parses, and re-serializes
unchanged; a takeover without one is only a `unannotated_forced` warning in
`validate`.

The claim age shown in `/kanban` and `kanban_list` is measured from the
last `assign`/`force-assign` to the current assignee, so hand-editing `assignee`
without a matching history entry makes the age fall back to `updated`.

Unknown keys are preserved on rewrite, so a hand-added `owner_team: platform`
survives tool calls.

## Body

Everything before the first comment sentinel is the **description**. Then each
comment is a sentinel followed by its Markdown:

```md
<!-- kanban:comment at=<ISO timestamp> by=<handle> -->
comment body
```

A comment body may contain headings, lists, code fences, and blank lines. It may
not contain a line that starts with another sentinel.

## What is tool-only, and what is not

| Field | Edited by |
|---|---|
| `title`, description | ordinary file tools (`edit`, `write`) |
| `status`, `assignee`, `history`, `rev` | the kanban tools only |
| comments | `kanban_comment` only |

Hand-editing status or assignee bypasses the transition and claim checks;
`/kanban validate` reports impossible combinations such as a terminal task that
still has an assignee, a frontmatter `id` that disagrees with its filename, a
claim older than the stale threshold, and a `counter.json` value that would
reissue an existing id.

## Broken files

A task file that cannot be parsed is excluded from the board, not fatal: the
other tasks still list, `kanban_list` adds a warning block and
`structuredContent.fileErrors`, `/kanban` names the unreadable files, and
`/kanban validate` reports each as `unreadable_task` with its path. Reading that
one task by id (`kanban_list {task: "T-0002"}`) still fails with the parse error.

## ID allocation

`.pi/kanban/counter.json` holds the next id to issue. Ids are sequential
(`T-0001`, `T-0002`, …) and never reused, even if a task file is deleted. The
counter advances under the board lock before the task file is written. A counter
that is not greater than the highest existing id is a board problem, and
`/kanban validate` reports it as `counter_low`.

## Concurrency

`.pi/kanban/.lock/` is a lock directory, not a file: `mkdir` is atomic across
processes, and the directory holds `owner.json` (pid, token, timestamp, host) for
stale-lock recovery. Every mutation re-reads the task under the lock before
writing.

**Entry is all-or-nothing.** An acquirer builds a complete
`.lock.entry.<token>/` directory — `owner.json` already inside — and renames it
onto `.lock`. A rename onto a directory that is not empty fails, so exactly one
process can take the path, and the lock directory never exists without its
`owner.json`. That is what makes recovery safe: there is no window in which a
half-built lock can be replaced.

A lock left by a crashed process is recovered when its pid is gone (same host),
when it is older than two minutes, or — for a directory with no readable
`owner.json` — when the directory itself is older than five seconds.

**Recovery never deletes a lock blindly.** The recoverer renames the lock
directory to a unique `.lock.steal.<random>/` tombstone (atomic, so exactly one
process wins), then re-reads the tombstone's `owner.json`: it is removed only if
that token is the ownership that was judged stale. A lock that changed hands in
between is renamed back — never onto a directory the recoverer did not move —
and left alone. While a tombstone exists the lock path is not authoritative, so
a process that has just renamed its entry directory in checks for tombstones
first and gives its directory back if one is visible.

**Tombstones are reaped**, or one crash would block the board forever: a
tombstone is removed when its `owner.json` is gone, when its pid is dead on this
host, or when it is older than the five-second grace. A tombstone whose owner is
alive and recent is kept, because that recovery may be about to put the lock
back. When acquiring still fails, the timeout error names the tombstone that is
actually blocking, not just `.lock`.

`release()` uses the same rename-verify-delete as recovery: it moves the lock
aside, deletes it only if the moved directory still carries its own token, and
puts it back otherwise. When a recovery had moved this lock aside, `release`
also deletes its own tombstone on the way out, because a tombstone with a live
pid is not reapable and would stall other writers. A missing or unreadable
`owner.json` is left to the five-second no-owner path, never deleted on a guess.
Deletes themselves are rename-then-remove (`.lock.trash.<random>/`), so `rm -r`
never races a directory another process is writing into.

## Git

Boards are meant to be committed. Keep `tasks/`, `workflow.yaml`, and
`counter.json` in version control. Two branches that both create tasks can
allocate the same id; renumber the later task and update its references.
