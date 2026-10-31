# Minimal Kanban

A file-backed kanban board that lets Pi agents coordinate work on one project. The board is shared project state, not per-session state.

## Language

**Board**:
The complete kanban state of one project — its workflow and its tasks.
_Avoid_: Kanban, project board, list

**Project**:
The repository whose work a board tracks. A board belongs to exactly one project.
_Avoid_: Workspace, root, folder

**Workflow**:
A project's declaration of which statuses exist and which transitions between them are legal.
_Avoid_: Pipeline, process, lifecycle

**Status**:
A named point in a task's lifecycle, rendered as a column on the board.
_Avoid_: Stage, state, column, lane

**Transition**:
A legal move from one status to another, as declared by the workflow.
_Avoid_: Edge, step, jump

**Initial status**:
The status a newly created task starts in.
_Avoid_: Backlog, default status

**Terminal status**:
A status that marks a task as finished. A task in a terminal status no longer occupies an assignee.
_Avoid_: Closed, done, archived

**Task**:
A unit of work on the board: a title, a description, one status, at most one assignee, and a comment thread.
_Avoid_: Ticket, issue, card, item

**Task ID**:
The stable, human-quotable identifier of a task within its board. It never changes and is never reused.
_Avoid_: Key, number, slug

**Assignee**:
The single actor currently responsible for a task, recorded as an opaque handle. Handles conventionally name agents; a human participates by instructing an agent.
_Avoid_: Owner, worker, holder

**Claim**:
The exclusive right to move a task that sits in an active status. A claim is created by moving a task into an active status and ends when the task leaves it.
_Avoid_: Lock, reservation, checkout

**Active status**:
A status in which work is happening. Entering one claims the task for the caller.
_Avoid_: In-progress column, started

**Forced assignment**:
An assignment that replaces another handle's existing assignment on the same task.
_Avoid_: Steal, takeover

**Agent**:
An autonomous Pi actor that can create, move, assign, and comment on tasks. Agents are identified on the board by a self-asserted handle.
_Avoid_: Bot, worker, user, person

**Handle**:
The short name an agent uses for itself on the board.
_Avoid_: ID, username, name

**Comment**:
A short, append-only note attached to a task by an agent.
_Avoid_: Message, note, update

**History**:
The append-only record of a task's status and assignment changes. It is self-reported and is not an audit trail.
_Avoid_: Log, timeline

**Drifted task**:
A task whose status is not declared by the project's current workflow.
_Avoid_: Orphan, corrupt task, zombie task

**Board lock**:
The short-lived, file-system lock a mutation holds while it re-reads and rewrites the board, so two agents cannot claim the same task.
_Avoid_: Mutex, claim lock
