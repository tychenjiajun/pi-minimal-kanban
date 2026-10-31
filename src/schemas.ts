import { Type } from "@sinclair/typebox";

const Agent = Type.String({
  minLength: 1,
  maxLength: 64,
  description: "Your handle, e.g. `coder-1`. Recorded in history and used to enforce exclusive claims.",
});

const Project = Type.Optional(
  Type.String({
    description: "Project root or board directory. Defaults to the nearest ancestor with `.git` or `.pi/kanban`.",
  }),
);

const ExpectedRev = Type.Optional(
  Type.Integer({
    minimum: 0,
    description: "Optimistic-concurrency guard: fail unless the task is still at this rev.",
  }),
);

const TaskId = Type.String({ description: "Task id, e.g. T-0001." });

// No `maxLength`: the store's own messages (`reason is 201 characters; the
// limit is 200.`) must reach the agent, not a harness schema error (design §1.3).
const Reason = Type.Optional(
  Type.String({
    minLength: 1,
    description: "Why the takeover happened. Requires `force: true`; stored on the history entry.",
  }),
);

const WorkflowStatus = Type.Object({
  id: Type.String(),
  label: Type.String(),
  active: Type.Boolean(),
  terminal: Type.Boolean(),
});

const TaskSummary = Type.Object({
  id: Type.String(),
  title: Type.String(),
  status: Type.String(),
  assignee: Type.Optional(Type.String()),
  updated: Type.String(),
  rev: Type.Integer(),
  drifted: Type.Boolean(),
  /** True when the task sits in an `active` status, so `assignee` is a claim. */
  active: Type.Optional(Type.Boolean()),
  /** Milliseconds since the claim started; only meaningful when `active`. */
  claimAgeMs: Type.Optional(Type.Integer()),
});

const HistoryEntry = Type.Object({
  at: Type.String(),
  action: Type.String(),
  by: Type.Optional(Type.String()),
  from: Type.Optional(Type.String()),
  to: Type.Optional(Type.String()),
  assignee: Type.Optional(Type.String()),
  forced: Type.Optional(Type.Boolean()),
  reason: Type.Optional(Type.String()),
});

const Comment = Type.Object({
  at: Type.String(),
  by: Type.String(),
  body: Type.String(),
});

const FileError = Type.Object({
  path: Type.String(),
  message: Type.String(),
});

export const TaskDetail = Type.Intersect([
  TaskSummary,
  Type.Object({
    description: Type.String(),
    created: Type.String(),
    history: Type.Array(HistoryEntry),
    comments: Type.Array(Comment),
    path: Type.String(),
  }),
]);

const Failure = Type.Object({
  ok: Type.Literal(false),
  error: Type.String(),
  code: Type.String(),
  hint: Type.Optional(Type.String()),
  root: Type.Optional(Type.String()),
  dir: Type.Optional(Type.String()),
});

const ProjectInfo = Type.Object({
  root: Type.String(),
  dir: Type.String(),
});

// ─── kanban_create ────────────────────────────────────────────────────────────

export const CreateParams = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 200, description: "One-line task title." }),
  description: Type.Optional(
    Type.String({ description: "Markdown body. Omit to start empty and let later agents fill it in." }),
  ),
  agent: Agent,
  project: Project,
});

export const CreateOutput = Type.Object({
  ok: Type.Literal(true),
  task: TaskDetail,
  ...ProjectInfo.properties,
});

// ─── kanban_move ──────────────────────────────────────────────────────────────

export const MoveParams = Type.Object({
  task: TaskId,
  to: Type.String({ description: "Target status id, which must be reachable from the current one." }),
  agent: Agent,
  force: Type.Optional(
    Type.Boolean({
      description:
        "Take over a claim held by another handle. Only for a task whose owner has stopped working on it.",
    }),
  ),
  reason: Reason,
  expectedRev: ExpectedRev,
  project: Project,
});

export const MoveOutput = Type.Object({
  ok: Type.Literal(true),
  task: TaskDetail,
  from: Type.String(),
  ...ProjectInfo.properties,
});

// ─── kanban_assign ────────────────────────────────────────────────────────────

export const AssignParams = Type.Object({
  task: TaskId,
  assignee: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()], {
    description:
      "Handle to assign, or null to release. Exactly one handle may hold a task; assigning it to a handle other than your own needs `force: true`.",
  }),
  agent: Agent,
  force: Type.Optional(
    Type.Boolean({
      description:
        "Take the task from, or release, another handle's claim, or assign it to a handle that is not yours. Recorded as a forced assignment.",
    }),
  ),
  reason: Reason,
  expectedRev: ExpectedRev,
  project: Project,
});

export const AssignOutput = Type.Object({
  ok: Type.Literal(true),
  task: TaskDetail,
  ...ProjectInfo.properties,
});

// ─── kanban_comment ───────────────────────────────────────────────────────────

export const CommentParams = Type.Object({
  task: TaskId,
  body: Type.String({ minLength: 1, maxLength: 20_000, description: "Markdown comment text." }),
  agent: Agent,
  expectedRev: ExpectedRev,
  project: Project,
});

export const CommentOutput = Type.Object({
  ok: Type.Literal(true),
  task: TaskDetail,
  comment: Comment,
  ...ProjectInfo.properties,
});

// ─── kanban_list ──────────────────────────────────────────────────────────────

export const ListParams = Type.Object({
  task: Type.Optional(Type.String({ description: "Return one task in full detail instead of the summary list." })),
  status: Type.Optional(Type.String({ description: "Only tasks in this status id." })),
  assignee: Type.Optional(Type.String({ description: "Only tasks assigned to this handle." })),
  includeTerminal: Type.Optional(
    Type.Boolean({ default: true, description: "Include tasks in terminal statuses (default true)." }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 500,
      default: 50,
      description: "Maximum task rows to print (default 50, max 500). The workflow block is always printed.",
    }),
  ),
  offset: Type.Optional(
    Type.Integer({ minimum: 0, default: 0, description: "Rows to skip after filtering and sorting (default 0)." }),
  ),
  summary: Type.Optional(
    Type.Boolean({ default: false, description: "Return per-status counts instead of task rows." }),
  ),
  briefing: Type.Optional(
    Type.Boolean({
      default: false,
      description: "Return the board briefing (rules and first calls) instead of tasks. Wins over every other parameter.",
    }),
  ),
  project: Project,
});

export const ListOutput = Type.Union([
  Type.Object({
    ok: Type.Literal(true),
    tasks: Type.Array(TaskDetail),
    fileErrors: Type.Array(FileError),
    root: Type.String(),
    dir: Type.String(),
  }),
  Type.Object({
    ok: Type.Literal(true),
    tasks: Type.Array(TaskSummary),
    workflow: Type.Union([
      Type.Null(),
      Type.Object({
        name: Type.Optional(Type.String()),
        initial: Type.String(),
        statuses: Type.Array(WorkflowStatus),
        transitions: Type.Record(Type.String(), Type.Array(Type.String())),
        source: Type.String(),
      }),
    ]),
    workflowErrors: Type.Array(Type.String()),
    /** Task files that could not be read; the readable tasks are still listed. */
    fileErrors: Type.Array(FileError),
    /** Post-filter counts, so an agent can page without counting text lines. */
    total: Type.Optional(Type.Integer()),
    offset: Type.Optional(Type.Integer()),
    limit: Type.Optional(Type.Integer()),
    returned: Type.Optional(Type.Integer()),
    hasMore: Type.Optional(Type.Boolean()),
    /** Alias of `hasMore`, kept for callers that already use the name. */
    truncated: Type.Optional(Type.Boolean()),
    briefing: Type.Optional(Type.String()),
    root: Type.String(),
    dir: Type.String(),
  }),
]);

export { Failure };
export type FailureShape = typeof Failure;
