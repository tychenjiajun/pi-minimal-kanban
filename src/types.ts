export type HistoryAction = "create" | "move" | "assign" | "force-assign" | "unassign";

export interface HistoryEntry {
  at: string;
  action: HistoryAction;
  by?: string;
  from?: string;
  to?: string;
  assignee?: string;
  /** True when this action replaced another handle's assignment. */
  forced?: boolean;
}

export interface Comment {
  at: string;
  by: string;
  body: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: string;
  assignee?: string;
  created: string;
  updated: string;
  rev: number;
  history: HistoryEntry[];
  comments: Comment[];
  /** Absolute path to the task Markdown file. */
  path: string;
  /** True when `status` is not declared by the current workflow. */
  drifted: boolean;
  /**
   * True when the task sits in an `active` status, so `assignee` is a claim
   * (ADR 0008) and has an age to show. Filled in by `readBoard`/`readTask`.
   */
  active?: boolean;
  /** Milliseconds since the current claim started; present only when `active`. */
  claimAgeMs?: number;
}

export interface StatusDef {
  id: string;
  label: string;
  active: boolean;
  terminal: boolean;
}

export interface Workflow {
  name?: string;
  initial: string;
  statuses: StatusDef[];
  byId: Map<string, StatusDef>;
  transitions: Map<string, Set<string>>;
  sourcePath: string;
  sourceFormat: "yaml" | "json";
}

export interface WorkflowJson {
  name?: string;
  initial: string;
  statuses: Array<{ id: string; label: string; active: boolean; terminal: boolean }>;
  transitions: Record<string, string[]>;
  source: string;
}

export interface TaskSummary {
  id: string;
  title: string;
  status: string;
  assignee?: string;
  updated: string;
  rev: number;
  drifted: boolean;
}

export interface TaskDetail extends TaskSummary {
  description: string;
  created: string;
  history: HistoryEntry[];
  comments: Comment[];
  path: string;
}

/** A task file that could not be read, with the parse error. */
export interface FileError {
  path: string;
  message: string;
}

/**
 * One thing `/kanban validate` reports. `severity` splits hard problems from
 * warnings such as a stale claim, which keeps the report `ok`.
 */
export interface ValidationProblem {
  task?: string;
  code: string;
  message: string;
  severity: "problem" | "warning";
  /** Absolute path of the unreadable task file, when the problem is about one. */
  path?: string;
}

export interface BoardSnapshot {
  root: string;
  dir: string;
  workflow: Workflow | null;
  workflowErrors: string[];
  tasks: Task[];
  /** Unreadable task files; readable tasks are still listed. */
  fileErrors: FileError[];
}

export interface MutationResult {
  root: string;
  dir: string;
  task: Task;
  action: HistoryAction | "comment";
}
