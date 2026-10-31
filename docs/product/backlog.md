# Product backlog: pi-minimal-kanban

Derived from [audit.md](./audit.md). Ordered by priority: P0 first, then P1,
then P2. Vocabulary follows `GLOSSARY.md`.

P0 — the Board's core promise (several Agents sharing one Project without
duplicating work) breaks, or a Task can become permanently stuck.

P1 — an Agent or a person regularly pays an avoidable cost to use the Board.

P2 — polish, diagnostics, and small correctness fixes.

---

## P0

### 1. Make an abandoned Claim visible and releasable

A crashed Agent leaves a Claim behind for good: there are no leases by design
(`docs/adr/0004`:7), Handles are unverified (`src/store.ts:22`), and neither
`/kanban validate` nor `kanban_list` distinguishes a Claim held for two minutes
from one held for two weeks. The next Agent hits `wrong_owner` and must guess
whether the owner is alive. A stale Claim therefore blocks a Task silently, and
the only recovery is an Agent that happens to know about `force: true`. Expose
Claim age where the Claim is read, report long-idle Claims as a distinct
diagnostic (not as a failure), and give a person a documented way to release a
Claim without an Agent.

- [ ] `kanban_list` and `/kanban` show the Claim age (for example `@coder-1 3d`) wherever an Assignee is shown.
- [ ] `/kanban validate` reports a separate `stale_claim` problem when a Claim is older than a configurable threshold, and no longer reports a Claim-free Active status as a problem.
- [ ] The `wrong_owner` error states the Claim age and names the exact call that releases it.
- [ ] `/kanban release <task-id>` releases a Claim (recording a Forced assignment in History) with an explicit confirmation step.
- [ ] Documentation in `README.md` and `docs/adr/0004` describes the release path.

### 2. Enforce the Claim in every non-Terminal Status, not only Active ones

Exclusivity is enforced only when a Transition touches an Active status
(`src/store.ts:379-393`). A Workflow with no Active statuses is explicitly valid
(`docs/workflow.md`:89-90), and in it two Agents can move the same Task
indefinitely with the last write winning. The same race exists one step earlier
in any Workflow: two Agents that both read "unassigned in `new`" may both move a
Task into a non-Active `planning`. This is the exact failure the Board exists to
prevent, and it is unguarded in the default template's first Transition.

- [ ] A Task that already has an Assignee cannot be moved by another Handle in any non-Terminal Status without `force`, regardless of Active flags.
- [ ] Moving an unassigned Task in a non-Terminal Status requires an explicit claim or an `expectedRev` match; a losing writer receives a typed `contended` error naming the winner.
- [ ] Workflows without Active statuses keep working, with a documented statement that exclusivity then rests on Assignment.
- [ ] Tests cover two concurrent movers on the same Task in a non-Active Status.

### 3. Onboard a new Agent from inside the tool surface

An Agent learns the Board only from `promptGuidelines` and from the Workflow
block in `kanban_list` (`src/index.ts:255-263`, `309-320`). The rules that decide
whether work gets duplicated — Claims exist only in Active statuses, a Terminal
status releases the Claim, `force` is a deliberate takeover, and a Handle is
self-asserted — live in `GLOSSARY.md` and `docs/adr/`, which an Agent working in
Pi is not given. Nothing tells a new Agent what to call first, so the first real
interaction is often a rejected `kanban_move`.

- [ ] A board briefing is available on demand (for example `kanban_list` with `briefing: true`, or a `kanban_guide` tool) returning the Workflow, the claim rules, the Handle convention, and the recommended first calls.
- [ ] `kanban_list` on an otherwise empty Board returns the briefing instead of "No matching tasks."
- [ ] Each tool's `promptGuidelines` states the one rule most likely to be violated for that tool, in one sentence.
- [ ] A test asserts the briefing names the Initial status, every Active status, and the `force` rule.

---

## P1

### 4. Bound the context cost of `kanban_list`

Every call returns one line per matching Task (`src/render.ts:232-236`) plus a
Workflow block that is re-sent even when the result is filtered to one Status or
one Assignee (`src/index.ts:309-320`). A 100-Task Board costs roughly 105 lines
per call with no `limit`, `offset`, or summary mode, so an Agent that polls the
Board pays a linear, unbounded context tax. The Workflow does not change between
calls in the same session and does not need to be re-sent to be useful.

- [ ] `kanban_list` accepts `limit` and `offset`, returns at most the requested number of rows, and states how many rows were omitted.
- [ ] A `summary: true` mode returns per-Status counts and Claimed counts without listing Tasks.
- [ ] The Workflow block is printed only when the Workflow changed since the previous call in the same session, or when explicitly requested.
- [ ] Default output for a Board with more than 50 matching Tasks truncates with a pointer to the filters.

### 5. Keep the Board readable when one Task file is broken

`readTasks` parses every file and `toTask` throws on a missing `id`, `title`, or
`status` (`src/store.ts:50-68`, `158-162`). One hand-edited Task file therefore
blanks `kanban_list`, `/kanban`, `/kanban --json`, and `validate` for the whole
Board, which is the outcome `docs/adr/0007`:5 was written to prevent — that ADR
covers Status drift only, not file-level damage.

- [ ] A Task file that cannot be parsed is reported as a single problem row and excluded from the Board instead of aborting the read.
- [ ] `/kanban` renders every readable Task and lists the unreadable files with their paths in the warning block.
- [ ] `kanban_list` returns readable Tasks plus a per-file error list in `structuredContent`.
- [ ] `/kanban validate` reports each unreadable file with its path and the parse error.
- [ ] A test covers a Board with one valid and one malformed Task file.

### 6. Give `/kanban` a scale story

The default view collapses Terminal columns (`src/render.ts:68-75`) but prints
every Task in every open column (`src/render.ts:116-123`), and `--json` serializes
full Task detail for all Tasks (`src/command.ts:105-114`). A person watching a
100+ Task Board gets a wall of text they must scroll, and `--json` can be
multi-megabyte. There is also no age or sort information, so "is this moving?"
is unanswerable.

- [ ] Each open column shows at most a head limit (default 10) with an explicit "... and N more" line, and a flag to expand one column.
- [ ] `/kanban --json` honours `--limit` and omits description, History, and Comments unless `--full` is passed.
- [ ] `/kanban mine <handle>` is offered in the default view footer, and `/kanban` accepts several filters at once.
- [ ] Task rows can be sorted by last `updated` and show age when it exceeds a threshold.

### 7. Make `rev` visible and make optimistic concurrency usable

Guidance tells Agents to learn "the task's current rev" from `kanban_list`
(`src/index.ts:262`), and the `stale` hint tells them to re-read with
`kanban_list` (`src/store.ts:249`), but the list text never prints `rev`
(`src/render.ts:232-236`). `expectedRev` is also optional everywhere
(`src/schemas.ts:15-20`), so the compare-and-swap at `src/store.ts:242-249` never
runs. The guard exists but cannot be reached from the channel the instructions
point at, and a Comment bumps `rev` (`src/store.ts:531-536`), turning unrelated
comments into `stale` failures.

- [ ] `kanban_list` text includes `rev` on every Task row.
- [ ] `renderTask` and `/kanban <task-id>` show `rev` (the task view already shows it; the list does not).
- [ ] Guidance in `kanban_move`, `kanban_assign`, and `kanban_comment` states when `expectedRev` should be passed, and the default is documented.
- [ ] `stale` errors repeat the observed and expected rev and the current Status.

### 8. Make tool errors complete and trustworthy

The error envelope is good (`src/index.ts:50-70`, `src/errors.ts:28-40`), but
non-`KanbanError` exceptions collapse to code `io` with no hint
(`src/index.ts:53-58`), no error names the Board it came from,
`already_in_status` omits claim information (`src/store.ts:353-355`), and the
Handle validation message contradicts its own regex (`src/store.ts:10` vs `:28`).
`KanbanError.toJSON()` (`src/errors.ts:37-39`) is dead code beside a duplicate
serialization in `fail()`.

- [ ] Unknown exceptions map to a typed code (`io`, `parse`, `permission`) with a hint naming the file involved.
- [ ] Every error payload includes the Board `dir` and `root`.
- [ ] `already_in_status` reports the current Assignee and whether the caller already holds the Claim.
- [ ] The `assertHandle` message matches its regex, including the first-character rule.
- [ ] `fail()` serializes via one shared function, and `toJSON()` is removed or used.

---

## P2

### 9. Record why a Forced assignment happened

A Forced assignment records `forced: true` and nothing else
(`src/store.ts:390`). A later reader cannot distinguish "the owner crashed" from
"the owner was preempted", which is the distinction a person needs when auditing
a takeover. History is already documented as self-reported (`GLOSSARY.md`:71-73),
so a recorded reason is an improvement in legibility, not in trust.

- [x] `kanban_assign` and `kanban_move` accept an optional `reason` when `force` is true.
- [x] History entries for Forced assignments render the reason in `/kanban <task-id>`.
- [x] A Forced assignment without a reason is accepted but flagged in `validate` as unannotated.

### 10. Stop silent third-party assignment

If a Task has no Assignee, `assignTask` lets any Agent assign it to a different
Handle without `force` (`src/store.ts:483-488`), recording a normal `assign`
entry. Setting an Assignee for someone else is a coordination act that the owner
never consented to, and the Board cannot express the difference.

- [x] Assigning a Task to a Handle other than the caller's requires `force`.
- [x] The tool description and `promptGuidelines` state the rule in one sentence.
- [x] The resulting History entry is distinguishable from a self-claim.

### 11. Remove the unlocked read in `kanban_move`

`index.ts` reads the Task before calling `moveTask`, purely to label the result
(`src/index.ts:151`), so the reported `from` Status
(`src/index.ts:161-166`) can disagree with the Transition actually applied under
the Board lock.

- [ ] `moveTask` returns the observed `from` Status from inside the Board lock.
- [ ] `index.ts` no longer reads the Task before the call.
- [ ] A test with a concurrent move asserts the reported `from` matches the applied Transition.

### 12. Finish the `/kanban` command surface

`completeKanbanCommand` claims to return "subcommands, then task ids"
(`src/command.ts:166`) but returns no Task IDs and no Handles
(`src/command.ts:167-180`), so `/kanban mine <handle>` and `/kanban <task-id>`
require recall. `/kanban help` (`src/command.ts:27-37`) states no rules.

- [x] Completions include Task IDs (with Status and title) and observed Handles.
- [x] `/kanban help` states the Claim rule, the Terminal-status rule, and the Handle convention.
- [x] A test asserts completions include a Task ID present on the Board.

### 13. Detect duplicate Task IDs after a merge

Boards are committed and merge conflicts on `counter.json` are resolved by hand
(`docs/adr/0005`:5, `README.md`:96-97). A renumbering mistake leaves a Task ID
that is referenced in conversation but no longer matches, and nothing detects it.

- [x] `/kanban validate` reports a Task whose `id` frontmatter does not match its filename.
- [x] `validate` reports a `counter.json` value that is not greater than the highest existing Task ID.
- [x] `/kanban repair-ids --dry-run` lists the renumbering it would perform.

---

## Post-0.3.0, from the v0.3.0 review

Found by `reviewer-v03` while reviewing v0.3.0. None of these block the release;
they are recorded so the findings do not live only in a task comment.

### 14. A shared `fakePi()` for the test harnesses

Eight test files build their own `ExtensionAPI` stub. Adding any member to
`pi.*` (v0.3.0 added `pi.on`) breaks all of them at once with
`pi.on is not a function`, which reads as 47 unrelated failures.

- [ ] `src/test/helpers.ts` exports one `fakePi()` stub every test file uses.
- [ ] Adding a hook to the extension touches no test file.

### 15. `parseArgs` accepts a valued flag with no value

`/kanban repair-ids --as` sets `as` to `""` and reaches `resolveOperator("")`,
which refuses with an `invalid_handle` message quoting an empty string.

- [ ] A valued flag with no value is an `invalid_argument` naming the flag.
- [ ] `/kanban release T-0001 --as` and `--stale` behave the same way.

### 16. `validate` counts the highest id from readable tasks only

`validateBoard` computes `highest` from readable Tasks, so a board whose
highest-id file is corrupted can report `counter_low` spuriously.
`planRepairIds` uses filenames instead, so the two can disagree.

- [ ] `validate` derives the highest id the same way `repair-ids` does.
- [ ] A corrupted highest-id file does not produce `counter_low`.

### 17. Completions read every task file

`completeKanbanCommand` reads all Task files and then caps at 500. Correct, but
O(tasks) on every keystroke of a completion prefix.

- [ ] A board with 2000 tasks completes a prefix in under 50 ms.
