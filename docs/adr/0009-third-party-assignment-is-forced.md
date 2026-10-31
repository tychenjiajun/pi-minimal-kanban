# Third-party assignment is forced

Status: accepted (0.3.0). Reverses the v0.2 deferral recorded in
`docs/product/v0.3-scope.md` #10.

`assignTask` requires `force: true` whenever the target assignee is not the
caller's own handle — whether or not the task already has an assignee, and
whether or not the caller currently holds it. Assigning a task to yourself on
an unassigned task, clearing your own assignment, and clearing somebody
else's with `force` keep their existing behavior.

The rule is uniform in both directions: **any write to an assignee that is not
yours needs `force`.** The override is the existing one. With `force: true` the
write succeeds and is recorded as `force-assign` + `forced: true` (with an
optional `reason`, see `docs/task-file.md`), which distinguishes it from a
self-claim that records a plain `assign`. No new action name is invented.

v0.2 deferred this because "an assignment outside an active status is a hint, not
a claim", and that reading still holds: `moveTask` does not enforce a
non-active assignee at all, and `stale_claim` still warns rather than blocks.
What changed is only *who may write* the hint. A handle writing another
handle's name is a coordination act the named owner never consented to, and the
board could not express the difference — a third-party `assign` entry read
exactly like the caller claiming the task for itself. Making the write
deliberate costs one flag and leaves the hint model intact; the alternative is
a board where "somebody gave you this" and "you took it" are the same record.

Reusing `wrong_owner` teaches no new code: the caller does not own the write it
is attempting, which is the same failure the code already names. The one
`wrong_owner` variant whose hint does not mention `/kanban release` is the
unassigned case, because no handle holds the task and there is nothing to
release.

## Migration

There is no data migration. Historic third-party `assign` entries stay valid and
readable, keep their `action: assign`, get no `rev` bump and no rewrite, and
`validate` does not flag them: the rule constrains new writes, not the history
that already exists. Boards carry their own files, so a rewrite would have to
touch every task in every checkout to enforce a rule about future intent.

## Consequences

`kanban_assign`'s description says that assigning to a handle other than your
own makes the caller pass `force`, and `promptGuidelines` carries the one
sentence that says it: "Assigning a task to any handle but your own needs
`force: true`; history then records a forced assignment." `USAGE` repeats it in
the handle block, and `README.md`, `docs/workflow.md`, and `GLOSSARY.md`
("Forced assignment") state the same rule.

This is a breaking behavior change for agents that assigned on someone else's
behalf without asking: the call now fails with `wrong_owner` and writes nothing
until it passes `force: true`. The `CHANGELOG` calls it out under
"Compatibility" for 0.3.0.

## Considered Options

- **A config flag** (`requireForceForThirdParty: false`): a board would silently
  answer a coordination question differently per checkout, and every agent
  would have to read the config before it could trust its own history. The rule
  belongs to the format, not to a project's preferences.
- **A warning instead of an error**: a warning that the caller can ignore still
  writes an unconsented assignment, which is the failure. The board cannot
  warn a handle that is not present.
- **A new error code** (`third_party_assign`): one more code every agent has to
  learn for the same condition — the caller may not write a claim it does not
  own. `wrong_owner` already means that, and its hint already names `force`.
