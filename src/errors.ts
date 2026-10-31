/**
 * Typed error for every failure the kanban can report. `code` is stable enough
 * for other extensions to branch on, and `hint` gives the agent an actionable
 * next step rather than a bare failure.
 */
export interface KanbanErrorDetails {
  readonly code:
    | "no_workflow"
    | "invalid_workflow"
    | "invalid_task"
    | "id_mismatch"
    | "counter_low"
    | "invalid_transition"
    | "already_in_status"
    | "no_such_task"
    | "already_assigned"
    | "not_assigned"
    | "wrong_owner"
    | "terminal_task"
    | "invalid_handle"
    | "invalid_id"
    | "invalid_argument"
    | "drifted"
    | "stale"
    | "locked"
    | "io";
  readonly hint?: string;
  [key: string]: unknown;
}

export class KanbanError extends Error {
  readonly details: KanbanErrorDetails;

  constructor(code: KanbanErrorDetails["code"], message: string, hint?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "KanbanError";
    this.details = { code, hint, ...details } as KanbanErrorDetails;
  }
}

/**
 * Shape of every error payload a tool returns. One serializer in `index.ts`
 * builds it from either a `KanbanError` or an unexpected exception, so there is
 * no second path (and no `toJSON`) to drift out of sync.
 */
export interface FailureEnvelope {
  ok: false;
  error: string;
  code: string;
  hint?: string;
  root?: string;
  dir?: string;
  [key: string]: unknown;
}

export function isKanbanError(error: unknown): error is KanbanError {
  return error instanceof KanbanError;
}
