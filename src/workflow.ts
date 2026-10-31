import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { KanbanError } from "./errors.ts";
import { FILES, WORKFLOW_FILE_CANDIDATES } from "./paths.ts";
import type { StatusDef, Workflow, WorkflowJson } from "./types.ts";

const STATUS_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export interface WorkflowReadResult {
  workflow: Workflow | null;
  errors: string[];
  path?: string;
  format?: "yaml" | "json";
}

interface RawStatus {
  id?: unknown;
  label?: unknown;
  active?: unknown;
  terminal?: unknown;
}

interface RawWorkflow {
  name?: unknown;
  initial?: unknown;
  statuses?: unknown;
  transitions?: unknown;
}

/** Locate the single workflow file for a board. */
export function findWorkflowFile(boardDir: string): { path: string; format: "yaml" | "json" } | { errors: string[] } {
  const found = WORKFLOW_FILE_CANDIDATES.filter((name) => existsSync(join(boardDir, name)));
  if (found.length === 0) {
    return {
      errors: [
        `No workflow file in ${boardDir}. Expected ${FILES.workflowYaml}, ${FILES.workflowYml}, or ${FILES.workflowJson}.`,
        "Run `/kanban init` to create a starter workflow.",
      ],
    };
  }
  if (found.length > 1) {
    return { errors: [`Multiple workflow files in ${boardDir}: ${found.join(", ")}. Keep exactly one.`] };
  }
  const path = join(boardDir, found[0]);
  return { path, format: found[0].endsWith(".json") ? "json" : "yaml" };
}

/**
 * Parse and validate a workflow document. Returns all errors at once so an
 * invalid file can be reported in one `/kanban validate` pass.
 */
export function parseWorkflow(text: string, format: "yaml" | "json", sourcePath: string): WorkflowReadResult {
  let raw: unknown;
  try {
    raw = format === "json" ? JSON.parse(text) : parseYaml(text);
  } catch (error) {
    return {
      workflow: null,
      errors: [`Invalid ${format.toUpperCase()} in ${basename(sourcePath)}: ${error instanceof Error ? error.message : String(error)}`],
      path: sourcePath,
      format,
    };
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { workflow: null, errors: [`${basename(sourcePath)} must contain an object with "statuses".`], path: sourcePath, format };
  }

  const data = raw as RawWorkflow;
  const errors: string[] = [];
  const statuses: StatusDef[] = [];
  const seen = new Set<string>();

  if (!Array.isArray(data.statuses) || data.statuses.length === 0) {
    errors.push('"statuses" must be a non-empty list.');
  } else {
    let allShorthand = true;
    for (const [index, entry] of data.statuses.entries()) {
      if (typeof entry !== "string") allShorthand = false;
      const parsed = parseStatus(entry, index, errors);
      if (!parsed) continue;
      if (seen.has(parsed.id)) {
        errors.push(`Duplicate status id "${parsed.id}".`);
        continue;
      }
      seen.add(parsed.id);
      if (parsed.active && parsed.terminal) {
        errors.push(`Status "${parsed.id}" cannot be both active and terminal.`);
      }
      statuses.push(parsed);
    }

    // Pure shorthand (`statuses: [new, working, done]`) has no place to declare
    // a terminal status, so the last one is terminal by definition.
    if (allShorthand && statuses.length > 0 && !statuses.some((status) => status.terminal)) {
      statuses[statuses.length - 1] = { ...statuses[statuses.length - 1], terminal: true };
    }
  }

  if (statuses.length > 0 && !statuses.some((status) => status.terminal)) {
    errors.push("At least one status must be terminal: true.");
  }

  const byId = new Map(statuses.map((status) => [status.id, status]));

  let initial = typeof data.initial === "string" ? data.initial : undefined;
  if (initial && !byId.has(initial)) errors.push(`"initial" refers to unknown status "${initial}".`);
  if (!initial && statuses.length > 0) initial = statuses[0].id;
  if (initial && byId.get(initial)?.terminal) errors.push(`The initial status "${initial}" cannot be terminal.`);

  const transitions = new Map<string, Set<string>>();
  if (data.transitions !== undefined) {
    if (!data.transitions || typeof data.transitions !== "object" || Array.isArray(data.transitions)) {
      errors.push('"transitions" must be an object mapping status ids to lists of status ids.');
    } else {
      for (const [from, targets] of Object.entries(data.transitions as Record<string, unknown>)) {
        if (!byId.has(from)) {
          errors.push(`Transition source "${from}" is not a declared status.`);
          continue;
        }
        if (!Array.isArray(targets)) {
          errors.push(`Transitions for "${from}" must be a list.`);
          continue;
        }
        const set = new Set<string>();
        for (const target of targets) {
          if (typeof target !== "string" || !byId.has(target)) {
            errors.push(`Transition "${from}" -> "${String(target)}" targets an unknown status.`);
            continue;
          }
          if (target === from) {
            errors.push(`Transition "${from}" cannot point to itself.`);
            continue;
          }
          set.add(target);
        }
        transitions.set(from, set);      }
    }
  } else if (statuses.length > 0 && errors.length === 0) {
    // Linear shorthand: adjacent statuses, both directions.
    for (let i = 0; i < statuses.length - 1; i += 1) {
      const a = statuses[i].id;
      const b = statuses[i + 1].id;
      addEdge(transitions, a, b);
      addEdge(transitions, b, a);
    }
  }

  if (statuses.length > 0 && (data.transitions !== undefined || errors.length === 0)) {
    for (const status of statuses) {
      const outgoing = transitions.get(status.id) ?? new Set<string>();
      if (!status.terminal && outgoing.size === 0) {
        errors.push(`Status "${status.id}" is not terminal but has no outgoing transition.`);
      }
    }
  }

  if (errors.length > 0) {
    return { workflow: null, errors, path: sourcePath, format };
  }

  return {
    workflow: {
      name: typeof data.name === "string" ? data.name : undefined,
      initial: initial as string,
      statuses,
      byId,
      transitions,
      sourcePath,
      sourceFormat: format,
    },
    errors: [],
    path: sourcePath,
    format,
  };
}

function addEdge(transitions: Map<string, Set<string>>, from: string, to: string): void {
  const set = transitions.get(from) ?? new Set<string>();
  set.add(to);
  transitions.set(from, set);
}

function parseStatus(entry: unknown, index: number, errors: string[]): StatusDef | undefined {
  if (typeof entry === "string") {
    if (!STATUS_ID.test(entry)) {
      errors.push(`Status "${entry}" must match ${STATUS_ID.source}.`);
      return undefined;
    }
    return { id: entry, label: entry, active: false, terminal: false };
  }

  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    errors.push(`Status at index ${index} must be a string or an object.`);
    return undefined;
  }

  const raw = entry as RawStatus;
  if (typeof raw.id !== "string" || !STATUS_ID.test(raw.id)) {
    errors.push(`Status at index ${index} needs an "id" matching ${STATUS_ID.source}.`);
    return undefined;
  }
  if (raw.label !== undefined && typeof raw.label !== "string") {
    errors.push(`Status "${raw.id}" has a non-string "label".`);
  }
  if (raw.active !== undefined && typeof raw.active !== "boolean") {
    errors.push(`Status "${raw.id}" has a non-boolean "active".`);
  }
  if (raw.terminal !== undefined && typeof raw.terminal !== "boolean") {
    errors.push(`Status "${raw.id}" has a non-boolean "terminal".`);
  }

  return {
    id: raw.id,
    label: typeof raw.label === "string" ? raw.label : raw.id,
    active: raw.active === true,
    terminal: raw.terminal === true,
  };
}

/** Read and validate the board's workflow. Missing or invalid is an error. */
export function readWorkflow(boardDir: string): Workflow {
  const result = readWorkflowTolerant(boardDir);
  if (result.workflow) return result.workflow;

  const missing = result.errors.some((error) => error.startsWith("No workflow file"));
  throw new KanbanError(
    missing ? "no_workflow" : "invalid_workflow",
    result.errors.join("\n"),
    missing ? "Run `/kanban init` to create a workflow." : "Fix the workflow file, then retry.",
    { path: result.path },
  );
}

/**
 * Read the workflow without throwing. `workflow` is null when the file is
 * missing, ambiguous, or invalid; `errors` explains why.
 */
export function readWorkflowTolerant(boardDir: string): WorkflowReadResult {
  const located = findWorkflowFile(boardDir);
  if ("errors" in located) return { workflow: null, errors: located.errors };

  let text: string;
  try {
    text = readFileSync(located.path, "utf8");
  } catch (error) {
    return {
      workflow: null,
      errors: [`Could not read ${located.path}: ${error instanceof Error ? error.message : String(error)}`],
      path: located.path,
      format: located.format,
    };
  }
  return parseWorkflow(text, located.format, located.path);
}

/** Allowed targets for a status, in workflow order. */
export function allowedTargets(workflow: Workflow, from: string): string[] {
  const set = workflow.transitions.get(from);
  if (!set) return [];
  return workflow.statuses.filter((status) => set.has(status.id)).map((status) => status.id);
}

export function canTransition(workflow: Workflow, from: string, to: string): boolean {
  return workflow.transitions.get(from)?.has(to) ?? false;
}

/** JSON-safe workflow shape for tools and `/kanban --json`. */
export function workflowToJson(workflow: Workflow): WorkflowJson {
  const transitions: Record<string, string[]> = {};
  for (const status of workflow.statuses) {
    transitions[status.id] = allowedTargets(workflow, status.id);
  }
  return {
    name: workflow.name,
    initial: workflow.initial,
    statuses: workflow.statuses.map((status) => ({ ...status })),
    transitions,
    source: workflow.sourcePath,
  };
}

/** Text list of statuses, useful in errors and UI. */
export function describeStatuses(workflow: Workflow): string {
  return workflow.statuses.map((status) => `${status.id}${status.active ? " (active)" : ""}${status.terminal ? " (terminal)" : ""}`).join(", ");
}
