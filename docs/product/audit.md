# Product audit: pi-minimal-kanban

Scope: `README.md`, `GLOSSARY.md`, `docs/workflow.md`, `docs/task-file.md`,
`docs/adr/0001`–`0008`, and `src/{store,index,command,render,workflow,task-file,paths,schemas}.ts`.
The audit reads the code as shipped; no `src/` file was changed.

Vocabulary follows `GLOSSARY.md` (Board, Project, Workflow, Status, Transition,
Initial status, Terminal status, Task, Task ID, Assignee, Claim, Active status,
Forced assignment, Agent, Handle, Comment, History, Drifted task, Board lock).

Summary of the model as built:

- A Board is files under `<project>/.pi/kanban/` (`src/paths.ts:6-20`).
- A Task is claimed by the Handle that moves it into an Active status
  (`src/store.ts:396-400`); a Terminal status releases it (`src/store.ts:401-405`).
- A Claim is exclusive only in that direction; `force` is the only override
  (`src/store.ts:379-393`).
- There are no leases and no heartbeats, by decision (`docs/adr/0004`:7,
  `docs/adr/0008`:9).

---

## Scenario A — one Agent picks up a Task, works, finishes it

The happy path is coherent. `kanban_create` writes the Task in the Initial
status (`src/store.ts:288-320`), `kanban_move` into an Active status claims it
(`src/store.ts:396-400`), `kanban_move` into a Terminal status releases it and
clears the Assignee (`src/store.ts:401-405`). The Transition is checked inside
the Board lock (`src/store.ts:346-370`), so the claim is a consequence of the
move, as `docs/adr/0008`:3 requires.

Findings:

- **Pickup is not expressible without a status change.** A Task created in a
  non-Active Initial status has no Assignee (`src/store.ts:305-307`). An Agent
  that wants to say "I am taking this" before starting must either call
  `kanban_assign` first or move; the tool guidance prefers the move
  (`src/index.ts:184-185`) but the two paths have different claim semantics.
- **The `from` value reported by `kanban_move` can be stale.** `index.ts` reads
  the Task outside the Board lock purely to label the result
  (`src/index.ts:151`), then `moveTask` re-reads it under the lock
  (`src/store.ts:348`). Correctness is preserved, but the text
  `"${before.status} → ${task.status}"` (`src/index.ts:161`) and
  `structuredContent.from` (`src/index.ts:165`) can disagree with the actual
  Transition under concurrency.
- **`expectedRev` is optional on every mutation** (`src/schemas.ts:15-20`,
  used at `src/store.ts:242-249`), so the compare-and-swap guard is off unless
  the caller opts in. The guidance tells Agents to learn "the task's current
  rev" from `kanban_list` (`src/index.ts:262`), but the list text never prints
  `rev` (`src/render.ts:232-236`); `rev` exists only in `structuredContent`.
  Guidance points at data the text channel does not contain.
- **A Comment invalidates an in-flight rev.** `commentOnTask` bumps `rev`
  (`src/store.ts:531-536`) while contributing nothing to History, by design
  (`docs/adr/0006`). An Agent that comments between another Agent's read and
  move turns that move into a `stale` failure (`src/store.ts:246-252`) for a
  reason unrelated to the work.
- **Completion leaves no completion record.** Entering a Terminal status
  appends a `move` and an `unassign` to History (`src/store.ts:398-405`);
  History is self-reported and explicitly "not an audit trail"
  (`GLOSSARY.md`:71-73). A human asking "who actually finished this" gets the
  last mover, not proof.

---

## Scenario B — two Agents in one Project must not do the same Task twice

The invariant holds in exactly one place: the Transition into or out of an
Active status (`src/store.ts:379-393`, error `wrong_owner` at
`src/store.ts:384-391`). Outside that, coordination is advisory.

Findings:

- **A Project may legitimately have no Active statuses.** `docs/workflow.md`:89-90
  declares such a Workflow valid. With it, `target.active` and
  `currentStatus?.active` are both false (`src/store.ts:380`), so `contested`
  claims are never enforced: two Agents can move the same Task back and forth
  and the last write wins silently. The intended control becomes `kanban_assign`
  alone, which does enforce exclusivity in any non-Terminal status
  (`src/store.ts:466-482`).
- **The same gap exists one step before the claim.** Two Agents that both read
  "unassigned in `new`" may both move a Task into a non-Active `planning`
  status. `docs/adr/0008`:5 argues that a plain `assignee` label fails because
  "two agents that read 'unassigned' at the same time would both proceed"; that
  race is unguarded until the status is Active.
- **Third-party claims are allowed without `force`.** If a Task has no
  Assignee, `assignTask` lets any Agent assign it to *another* Handle with no
  `force` (`src/store.ts:483-488`), recording a normal `assign` entry. An Agent
  can therefore hand work to an Agent that never agreed to it, and the History
  cannot distinguish that from a self-claim.
- **A Forced assignment records no reason.** The history entry carries
  `forced: true` (`src/store.ts:390`) and nothing else. A later reader cannot
  tell "the owner crashed" from "the owner was preempted".
- **Boards are per checkout, and nothing in a tool response says so.**
  `docs/adr/0001`:5 and `docs/adr/0008`:11 state that Agents in separate git
  worktrees carry separate Boards and cannot see each other's Claims. The only
  notice is repository documentation; `kanban_list` output
  (`src/index.ts:283-330`) never mentions the Board's checkout scope.
- **Task ID collisions across branches are a manual repair.** `README.md`:96-97
  and `docs/adr/0005`:5 accept renumbering after a merge. Nothing detects a
  duplicate or renumbered Task ID; `counter.json` is per worktree
  (`src/store.ts:182-206`).
- **Drifted tasks quietly become movable by anyone.** A Task whose Status is
  not declared may be moved to any declared Status (`src/store.ts:357-359`).
  This is the intended recovery path (`docs/adr/0007`:3), but it also means a
  drifted Task in what used to be an Active Status has no Claim protection
  beyond the `currentStatus?.active` check, which is false for drifted tasks.

---

## Scenario C — a person checks progress in a terminal with `/kanban`

`/kanban` is read-only and renders plain text into the transcript
(`src/command.ts:13-15`, `143`). The default view is well shaped: open columns
in Workflow order, Terminal columns collapsed to a count
(`src/render.ts:64-75`), a summary line (`src/render.ts:92-100`), and a separate
warning group for Drifted tasks (`src/render.ts:77-85`).

Findings:

- **Open columns are unbounded.** `renderColumn` prints every Task in the column
  (`src/render.ts:116-123`). A Board with 100 open Tasks prints 100+ lines with
  no head limit and no "and N more". Only Terminal columns are collapsed.
- **`/kanban --json` dumps full Task detail.** The payload maps `detail()` over
  every Task (`src/command.ts:105-114`), including description, complete
  History, and every Comment (`src/store.ts:658-667`). A 100-Task Board with
  chatty Comments is a multi-megabyte transcript entry with no `--limit` and no
  way to select fields.
- **A broken Workflow degrades to counts only.** When the Workflow cannot be
  read, the board renders per-status counts and no Task IDs, no owners, no
  columns (`src/render.ts:49-56`), after a warning block
  (`src/render.ts:43-47`). `docs/adr/0002`:9 asks that `/kanban` stay readable so
  the failure is diagnosable; counts alone tell a person that something is wrong
  but not which Task is where.
- **One malformed Task file blanks the whole Board.** `readTasks` parses every
  file and `toTask` throws on a missing `id`, `title`, or `status`
  (`src/store.ts:50-68`, `158-162`). The command catches it and prints one error
  (`src/command.ts:144-150`), so a person with 99 good Tasks and one hand-edited
  file sees `Error [invalid_task]: …` instead of the Board. This contradicts the
  recoverability principle in `docs/adr/0007`:5, which only covers Status drift.
- **No completion-rate view.** The summary line reports total, open, done, and
  claimed (`src/render.ts:92-100`). There is no per-column age, no "claimed for
  3 days", and no sort beyond Workflow order, so "is this progressing?" is not
  answerable from the Board alone.
- **Command completions do not offer Task IDs or Handles.**
  `completeKanbanCommand` returns only subcommands and flags
  (`src/command.ts:167-180`), although its docstring says "subcommands, then
  task ids" (`src/command.ts:166`). `/kanban mine <handle>` therefore requires
  typing a Handle from memory.
- **A person cannot act from the terminal.** The command "never edits the board"
  (`README.md`:84). Releasing a stale Claim requires an Agent call with
  `force: true` (`src/store.ts:466-478`) or a hand edit, and hand edits of
  `status`/`assignee` are documented as unsupported (`docs/task-file.md`:67-70).

---

## Cross-cutting findings

### How a new Agent discovers the Workflow and the rules

- There is no session-start briefing: the extension deliberately does nothing on
  session start (`src/index.ts:353-354`). An Agent learns the Board only from
  tool descriptions and `promptGuidelines` (`src/index.ts:96-102`, `135-142`,
  `181-185`, `219-223`, `255-263`) and from `kanban_list`'s Workflow block
  (`src/index.ts:309-320`).
- `kanban_list` does print the Workflow, the Initial status, Active/Terminal
  flags, and outgoing Transitions (`src/index.ts:313-320`). That is the single
  best onboarding surface, and it is adequate for planning a legal move.
- Nothing surfaces the rules that matter most: that a Claim exists only in an
  Active status, that a Terminal status releases it, that `force` is a
  deliberate takeover, or the Handle convention. These live in
  `GLOSSARY.md`, `docs/adr/`, and one tool description
  (`src/index.ts:135-137`). An Agent that never reads the repository does not
  get them.
- `/kanban help` (`src/command.ts:27-37`, `62-65`) is written for a person and
  states no rules.

### Stuck Tasks: missing Transition, or a Handle that no longer exists

- **Missing Transition.** `moveTask` rejects an undeclared move with
  `invalid_transition`, naming the allowed targets
  (`src/store.ts:361-370`). If a non-Terminal Status has no outgoing Transition,
  the Workflow file itself is invalid (`docs/workflow.md`:53), so this state is
  only reachable by editing the Workflow under a live Board. A Drifted task can
  be moved to any declared Status (`src/store.ts:357-359`), which is a real
  recovery path. Honest limit: if the Workflow removed the only way out of a
  currently Active Status, the Task is still claimed, and the caller must know
  to pass `force` (`src/store.ts:381-393`).
- **Handle that no longer exists.** Handles are self-asserted and unverified
  (`src/store.ts:22`, `docs/adr/0004`:3), so the Board cannot know an Agent is
  gone. The Claim persists indefinitely and the next Agent gets `wrong_owner`
  with the hint "Ask the owner to move it, or pass force: true"
  (`src/store.ts:384-391`).
- **`/kanban validate` cannot see a stale Claim.** It reports `drifted`,
  `terminal_assigned`, and `active_unassigned` (`src/store.ts:614-645`). A
  long-idle Claim is not a reported problem, and "Active status with no
  Assignee" is reported as a problem even though it is a normal, recoverable
  state. A person has no in-product signal that a Claim is abandoned.

### 100+ Tasks

- Every read parses every Task file: `readTasks` maps all IDs through `toTask`
  (`src/store.ts:159-162`). `kanban_list` in single-Task mode also calls
  `readBoard` to obtain the Workflow (`src/index.ts:273-275`), so showing one
  Task costs a full Board scan.
- There is no index, cache, or pagination anywhere. That is defensible at 100
  Tasks and becomes linear cost at 1,000.
- Only two bulk reducers exist: `status` / `assignee` filters and
  `includeTerminal: false` (`src/schemas.ts:160-168`). Neither limits the number
  of rows returned.

### How much text `kanban_list` returns into an Agent's context

For `N` matching Tasks the text is `N` lines of at most ~70 characters
(`src/render.ts:232-236`), plus a constant Workflow block of about `S + 2` lines
(`src/index.ts:309-320`), plus `structuredContent` repeating every summary
(`src/index.ts:322-330`). A 100-Task Board with a five-Status Workflow is
roughly 105 lines, on the order of 7–9 KB, per call. Two properties make this
worse than the raw size:

- The Workflow block is re-sent on every call, including calls filtered to one
  Status or one Assignee where the Agent already knows the Workflow.
- There is no `limit`, `offset`, or "summary only" mode, so an Agent that polls
  the Board pays the full cost every time.

### Quality of tool error messages

The error channel is better than average: every failure returns
`Error [code]: message` plus an optional hint, with a matching structured
`{ ok: false, error, code, hint }` (`src/index.ts:50-70`), and `KanbanError`
carries a code, a message, and a hint by construction (`src/errors.ts:28-40`).
The main paths are specific and actionable — `no_such_task`
(`src/store.ts:150-152`), `wrong_owner` (`src/store.ts:384-391`), `stale`
(`src/store.ts:246-252`), and the invalid-Workflow error, which lists every
problem it found (`src/workflow.ts:226-234`).

Gaps:

- Any non-`KanbanError` exception collapses to code `io` with a raw message and
  no hint (`src/index.ts:53-58`). A YAML parse failure in a Task file or an
  `EACCES` on the Board directory arrives as an unlabelled failure.
- `KanbanError.toJSON()` (`src/errors.ts:37-39`) is unused; `fail()` re-derives
  the same shape (`src/index.ts:53-58`). Two serializations of one contract can
  drift.
- `invalid_transition` for an unknown Status lists the declared Statuses but
  gives a generic hint (`src/store.ts:340-348`).
- `already_in_status` does not say whether the Task is claimed or by whom
  (`src/store.ts:353-355`), so the caller cannot tell "already mine" from
  "someone else's".
- No error names the Board path or root, so with several Boards in play the
  Agent cannot tell which Board answered.
- `assertHandle` says "1–64 characters from A–Z, a–z, 0–9, dot, underscore, or
  hyphen" (`src/store.ts:28`), but the regex also requires the first character to
  be alphanumeric (`src/store.ts:10`). A Handle like `.coder` is rejected with a
  message that says the dot is allowed.
- The `stale` hint says "Read the task again with `kanban_list` before retrying"
  (`src/store.ts:249`), but the list text does not print `rev`
  (`src/render.ts:232-236`), so following the hint does not produce the value
  the retry needs.

---

## Behaviors judged incorrect

| Where | Behavior | Why it is wrong |
|---|---|---|
| `src/index.ts:151` | `kanban_move` reads the Task outside the Board lock for the `from` label | Reported Transition can disagree with the one just applied |
| `src/index.ts:262` + `src/render.ts:235` | Guidance says read `rev` from `kanban_list`; list text omits `rev` | Unfollowable instruction; `expectedRev` is unusable from text output |
| `src/store.ts:483-488` | Assigning an unassigned Task to a third party needs no `force` | Contradicts `docs/adr/0008`:3 ("claimed by the handle that moves it") |
| `src/store.ts:466-478` | Stale claims are invisible to `validate` and unreleasable from `/kanban` | A departed Handle blocks a Task with no in-product recovery |
| `src/store.ts:158-162` | One malformed Task file fails every read | Contradicts the recoverability principle of `docs/adr/0007` |
| `src/store.ts:28` vs `:10` | Handle rule message does not match the regex | Rejects handles the message says are valid |
| `src/store.ts:614-645` | `active_unassigned` reported as a problem | Normal, recoverable state is reported as a defect |
| `src/command.ts:166` | Docstring promises "subcommands, then task ids" | Completions return no Task IDs |
