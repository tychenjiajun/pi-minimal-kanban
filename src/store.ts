import { existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { KanbanError } from "./errors.ts";
import { atomicWrite, ensureDir, readText, withBoardLock } from "./fs.ts";
import { FILES, WORKFLOW_FILE_CANDIDATES, type BoardLocation } from "./paths.ts";
import { isTaskId, parseTaskFile, serializeTaskFile, taskFileName, type CommentBlock } from "./task-file.ts";
import { allowedTargets, canTransition, readWorkflow, readWorkflowTolerant, describeStatuses } from "./workflow.ts";
import { formatAge, formatThreshold } from "./render.ts";
import type { BoardSnapshot, Comment, FileError, HistoryEntry, StatusDef, Task, ValidationProblem, Workflow } from "./types.ts";

const HANDLE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TASK_FILE = /^T-(\d{4,})\.md$/;
const MAX_TITLE = 200;
const MAX_COMMENT = 20_000;
const MAX_DESCRIPTION = 200_000;
const MAX_REASON = 200;

export interface Clock {
  now(): Date;
}

/** Default age after which an active claim is reported as a `stale_claim` warning. */
export const DEFAULT_STALE_CLAIM_MS = 86_400_000;

const systemClock: Clock = { now: () => new Date() };

/** Validate an agent handle. Handles are self-asserted, not authenticated. */
export function assertHandle(handle: string, field = "agent"): string {
  const trimmed = handle?.trim() ?? "";
  if (!HANDLE.test(trimmed)) {
    // The message states the first-character rule too, because the regex
    // rejects a leading dot, underscore, or hyphen.
    throw new KanbanError(
      "invalid_handle",
      `Invalid ${field} "${handle}": use 1-64 characters from A-Z, a-z, 0-9, dot, underscore, or hyphen, starting with a letter or digit.`,
      "Pick a short handle such as `coder-1`. The board records handles but does not verify them.",
    );
  }
  return trimmed;
}

export function assertTaskId(id: string): string {
  const trimmed = id?.trim() ?? "";
  if (!isTaskId(trimmed)) {
    throw new KanbanError("invalid_id", `Invalid task id "${id}".`, "Use the form T-0001.");
  }
  return trimmed;
}

// ─── Claim age ───────────────────────────────────────────────────────────────

/** ISO time the current claim started: the last assign/force-assign to the
 * current assignee, falling back to `updated` (design §0.1). */
export function claimStart(task: Task): string {
  if (task.assignee) {
    for (let i = task.history.length - 1; i >= 0; i -= 1) {
      const entry = task.history[i];
      if (
        (entry.action === "assign" || entry.action === "force-assign") &&
        entry.assignee === task.assignee &&
        entry.at
      ) {
        return entry.at;
      }
    }
  }
  return task.updated;
}

/** Milliseconds since the current claim started, floored at zero. */
export function claimAgeMs(task: Task, now: Date): number {
  const start = new Date(claimStart(task)).getTime();
  if (Number.isNaN(start)) return 0;
  return Math.max(0, now.getTime() - start);
}

/**
 * Add the derived `active` and `claimAgeMs` fields. A claim exists only while
 * the task sits in an active status (ADR 0008), so a non-active assignment has
 * no age to show.
 */
function withClaimAge(task: Task, workflow: Workflow | null, clock: Clock): Task {
  const active = Boolean(workflow?.byId.get(task.status)?.active);
  return { ...task, active, claimAgeMs: claimAgeMs(task, clock.now()) };
}

// ─── Reading ─────────────────────────────────────────────────────────────────

function taskPath(location: BoardLocation, id: string): string {
  return join(location.tasksDir, taskFileName(id));
}

/** Convert parsed frontmatter + body into a Task, validating required fields. */
function toTask(path: string, id: string, workflow: Workflow | null, clock: Clock): Task {
  const parsed = parseTaskFile(readText(path), path);
  const fm = parsed.frontmatter;

  const fileId = fm.id;
  if (typeof fileId !== "string") {
    throw new KanbanError("invalid_task", `${path} has no string "id" in frontmatter.`, `Set \`id: ${id}\`.`);
  }
  if (fileId !== id) {
    throw new KanbanError(
      "id_mismatch",
      `${path} declares id "${fileId}" but the filename is ${id}.`,
      "Keep the filename and the frontmatter id in sync; a task id never changes.",
      { task: fileId, filenameId: id, path },
    );
  }
  const title = typeof fm.title === "string" ? fm.title.trim() : "";
  if (!title) {
    throw new KanbanError("invalid_task", `${path} has no "title".`, "Add a non-empty title to the frontmatter.");
  }
  const status = typeof fm.status === "string" ? fm.status.trim() : "";
  if (!status) {
    throw new KanbanError("invalid_task", `${path} has no "status".`, "Set a status declared by the workflow.");
  }

  const assignee = typeof fm.assignee === "string" && fm.assignee.trim() ? fm.assignee.trim() : undefined;
  const created = isoString(fm.created, clock);
  const updated = isoString(fm.updated, clock);
  const rev = typeof fm.rev === "number" && Number.isFinite(fm.rev) ? fm.rev : 0;

  return {
    id,
    title,
    description: parsed.description,
    status,
    assignee,
    created,
    updated,
    rev,
    history: parseHistory(fm.history),
    comments: parsed.comments,
    path,
    drifted: workflow ? !workflow.byId.has(status) : false,
  };
}

function isoString(value: unknown, clock: Clock): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return clock.now().toISOString();
}

function parseHistory(value: unknown): HistoryEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: HistoryEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    const action = raw.action;
    if (
      action !== "create" &&
      action !== "move" &&
      action !== "assign" &&
      action !== "force-assign" &&
      action !== "unassign"
    ) {
      continue;
    }
    entries.push({
      at: typeof raw.at === "string" ? raw.at : "",
      action,
      by: typeof raw.by === "string" ? raw.by : undefined,
      from: typeof raw.from === "string" ? raw.from : undefined,
      to: typeof raw.to === "string" ? raw.to : undefined,
      assignee: typeof raw.assignee === "string" ? raw.assignee : undefined,
      forced: raw.forced === true ? true : undefined,
      // Last key, and only when non-empty, so a file without a reason
      // re-serializes byte for byte (design §1.1).
      reason: typeof raw.reason === "string" && raw.reason.trim() ? raw.reason : undefined,
    });
  }
  return entries;
}

/** IDs of every task file, sorted numerically. */
export function listTaskIds(location: BoardLocation): string[] {
  let names: string[];
  try {
    names = readdirSync(location.tasksDir);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  return names
    .map((name) => TASK_FILE.exec(name)?.[1])
    .filter((digits): digits is string => digits !== undefined)
    .map((digits) => `T-${digits}`)
    .sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
}

/** Read one task without throwing on a missing workflow (drift is tolerated). */
export function readTask(location: BoardLocation, id: string, clock: Clock = systemClock): Task {
  const normalized = assertTaskId(id);
  const path = taskPath(location, normalized);
  if (!existsSync(path)) {
    throw new KanbanError("no_such_task", `No task ${normalized} on this board.`, "Run `kanban_list` to see task ids.", {
      task: normalized,
    });
  }
  const { workflow } = readWorkflowTolerant(location.dir);
  return withClaimAge(toTask(path, normalized, workflow, clock), workflow, clock);
}

export interface TaskReadResult {
  tasks: Task[];
  fileErrors: FileError[];
}

/**
 * Read every readable task. A single broken file is excluded and reported in
 * `fileErrors` with its path and parse error, so one bad file never blanks the
 * whole board. Reading a task directly by id (`readTask`) still throws.
 */
export function readTasks(location: BoardLocation, clock: Clock = systemClock): TaskReadResult {
  const { workflow } = readWorkflowTolerant(location.dir);
  return readTasksWith(location, workflow, clock);
}

function readTasksWith(location: BoardLocation, workflow: Workflow | null, clock: Clock): TaskReadResult {
  const tasks: Task[] = [];
  const fileErrors: FileError[] = [];
  for (const id of listTaskIds(location)) {
    const path = taskPath(location, id);
    try {
      tasks.push(withClaimAge(toTask(path, id, workflow, clock), workflow, clock));
    } catch (error) {
      fileErrors.push({ path, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { tasks, fileErrors };
}

/** Read the board, tolerating a missing or invalid workflow and broken files. */
export function readBoard(location: BoardLocation, clock: Clock = systemClock): BoardSnapshot {
  const workflowResult = readWorkflowTolerant(location.dir);
  const { tasks, fileErrors } = readTasksWith(location, workflowResult.workflow, clock);
  return {
    root: location.root,
    dir: location.dir,
    workflow: workflowResult.workflow,
    workflowErrors: workflowResult.errors,
    tasks,
    fileErrors,
  };
}

// ─── ID allocation ───────────────────────────────────────────────────────────

interface Counter {
  next: number;
}

function readCounter(location: BoardLocation): number {
  const path = join(location.dir, FILES.counter);
  if (!existsSync(path)) return 1;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Counter>;
    if (typeof parsed.next === "number" && Number.isInteger(parsed.next) && parsed.next > 0) return parsed.next;
  } catch {
    /* fall back to filenames */
  }
  return 1;
}

/**
 * Reserve the next task ID. The counter is written before the task file, so an
 * ID that was issued is never issued again, even if the create later fails.
 * Callers must already hold the board lock.
 */
function reserveTaskId(location: BoardLocation): string {
  const existing = listTaskIds(location).map((id) => Number(id.slice(2)));
  const highest = existing.length > 0 ? Math.max(...existing) : 0;
  const next = Math.max(readCounter(location), highest + 1);
  atomicWrite(join(location.dir, FILES.counter), `${JSON.stringify({ next: next + 1 }, null, 2)}\n`);
  return `T-${String(next).padStart(4, "0")}`;
}

// ─── Writing ─────────────────────────────────────────────────────────────────

function serialize(task: Task): string {
  const frontmatter: Record<string, unknown> = {
    id: task.id,
    title: task.title,
    status: task.status,
  };
  if (task.assignee) frontmatter.assignee = task.assignee;
  frontmatter.created = task.created;
  frontmatter.updated = task.updated;
  frontmatter.rev = task.rev;
  frontmatter.history = task.history;

  const existingRaw = existsSync(task.path) ? readExistingFrontmatter(task.path) : undefined;
  return serializeTaskFile(
    { frontmatter, description: task.description, comments: task.comments },
    existingRaw,
  );
}

function readExistingFrontmatter(path: string): string | undefined {
  try {
    return parseTaskFile(readFileSync(path, "utf8"), path).rawFrontmatter;
  } catch {
    return undefined;
  }
}

function writeTask(task: Task): void {
  ensureDir(join(task.path, ".."));
  atomicWrite(task.path, serialize(task));
}

/**
 * Compare-and-swap guard for concurrent writers.
 *
 * The message and details always carry the observed rev, the expected rev, and
 * the status the task is actually in, so a caller can retry without guessing.
 */
function assertFresh(task: Task, expectedRev: number | undefined): void {
  if (expectedRev === undefined) return;
  if (task.rev !== expectedRev) {
    throw new KanbanError(
      "stale",
      `Task ${task.id} is at rev ${task.rev} (status "${task.status}"), but the call expected rev ${expectedRev}. Re-read the task and retry.`,
      "Read the task again with kanban_list before retrying, and pass the rev you just read.",
      { task: task.id, rev: task.rev, expectedRev, status: task.status },
    );
  }
}

/**
 * The release sentence shared by `wrong_owner` and `already_assigned` hints
 * (design §4). The message stays one sentence and never names the caller's
 * target status; the hint is one paragraph naming both release paths.
 */
function releaseHint(task: Task, agent: string): string {
  // Exact hint text from design §4: names the release command and the exact
  // force call an agent can make.
  void agent;
  return `Release it with /kanban release ${task.id} --yes, or pass force: true to take over. An agent can call kanban_assign with assignee:null, force:true.`;
}

/** ` for 3d`: every refusal names how long the task has been held (design §4). */
function claimedFor(task: Task, clock: Clock): string {
  // Not limited to active statuses: a wrong_owner or already_assigned refusal
  // must always say how old the assignment is, active claim or not.
  return ` for ${formatAge(claimAgeMs(task, clock.now()))}`;
}

/**
 * Trim and validate a takeover reason (design §1.3). The caller must already
 * have asked for `force`: an annotation without a takeover would be a false
 * record, so the flag is required before anything reaches the file.
 */
export function normalizeReason(reason: string, force: boolean | undefined): string {
  if (!force) {
    throw new KanbanError("invalid_argument", "reason requires force: true.");
  }
  const text = reason.trim();
  if (text.length === 0) {
    throw new KanbanError("invalid_argument", "reason must be 1-200 characters.");
  }
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    throw new KanbanError("invalid_argument", "reason must be a single line.");
  }
  if (text.length > MAX_REASON) {
    throw new KanbanError(
      "invalid_argument",
      `reason is ${text.length} characters; the limit is ${MAX_REASON}.`,
    );
  }
  return text;
}

/**
 * Attach the reason to exactly one appended entry: the first forced entry, or
 * the first entry when the call wrote no takeover (design §1.2).
 */
function attachReason(history: HistoryEntry[], reason: string | undefined): HistoryEntry[] {
  if (!reason || history.length === 0) return history;
  const forced = history.findIndex((entry) => entry.forced === true);
  const target = forced === -1 ? 0 : forced;
  return history.map((entry, index) => (index === target ? { ...entry, reason } : entry));
}

// ─── Mutations ───────────────────────────────────────────────────────────────

export interface CreateInput {
  title: string;
  description?: string;
  agent: string;
  expectedRev?: never;
}

/** Create a task in the workflow's initial status. */
export async function createTask(
  location: BoardLocation,
  input: CreateInput,
  clock: Clock = systemClock,
): Promise<Task> {
  const agent = assertHandle(input.agent);
  const title = (input.title ?? "").trim();
  if (!title) throw new KanbanError("invalid_task", "A task needs a title.", "Pass a short, single-line title.");
  if (title.length > MAX_TITLE) {
    throw new KanbanError("invalid_task", `Title is ${title.length} characters; the limit is ${MAX_TITLE}.`, "Shorten the title and put detail in the description.");
  }
  if (/[\r\n]/.test(title)) {
    throw new KanbanError("invalid_task", "A title must be a single line.", "Put multi-line detail in the description.");
  }
  const description = input.description ?? "";
  if (description.length > MAX_DESCRIPTION) {
    throw new KanbanError("invalid_task", `Description is ${description.length} characters; the limit is ${MAX_DESCRIPTION}.`, "Split the work into smaller tasks.");
  }

  return withBoardLock(join(location.dir, FILES.lock), () => {
    const workflow = readWorkflow(location.dir);
    const id = reserveTaskId(location);
    const now = clock.now();
    const at = now.toISOString();
    const initial = workflow.byId.get(workflow.initial) as StatusDef;

    const history: HistoryEntry[] = [{ at, action: "create", by: agent, to: workflow.initial }];
    const assignee = initial.active ? agent : undefined;
    if (assignee) history.push({ at, action: "assign", by: agent, assignee: agent });

    const task: Task = {
      id,
      title,
      description,
      status: workflow.initial,
      assignee,
      created: at,
      updated: at,
      rev: 1,
      history,
      comments: [],
      path: taskPath(location, id),
      drifted: false,
    };
    writeTask(task);
    return withClaimAge(task, workflow, clock);
  });
}

export interface MoveInput {
  task: string;
  to: string;
  agent: string;
  force?: boolean;
  reason?: string;
  expectedRev?: number;
}

/**
 * A completed move. It is a `Task` plus the status the task came from, captured
 * inside the board lock so the tool never has to read the task before moving it.
 */
export type MoveResult = Task & { from: string };

/**
 * Move a task along a declared transition.
 *
 * Active statuses are claims: entering one auto-claims the task for the caller,
 * and only the current assignee may move a task that is already active. Entering
 * a terminal status releases the assignee.
 *
 * Everything is decided from the task read inside the lock; the returned value
 * carries `from`, the status observed there.
 */
export async function moveTask(
  location: BoardLocation,
  input: MoveInput,
  clock: Clock = systemClock,
): Promise<MoveResult> {
  const agent = assertHandle(input.agent);
  const id = assertTaskId(input.task);
  const to = (input.to ?? "").trim();
  // Argument errors win over board-state errors, and neither takes the lock.
  const reason = input.reason === undefined ? undefined : normalizeReason(input.reason, input.force);

  return withBoardLock(join(location.dir, FILES.lock), () => {
    const workflow = readWorkflow(location.dir);
    const target = workflow.byId.get(to);
    if (!target) {
      throw new KanbanError(
        "invalid_transition",
        `Unknown status "${to}". Declared statuses: ${describeStatuses(workflow)}.`,
        "Use a status declared in the workflow file.",
        { task: id, to },
      );
    }

    const task = readTask(location, id, clock);
    assertFresh(task, input.expectedRev);

    if (task.status === to) {
      const heldByCaller = task.assignee === agent;
      const owner = task.assignee ? `"${task.assignee}"` : "nobody";
      throw new KanbanError(
        "already_in_status",
        `Task ${id} is already in "${to}", assigned to ${owner}; "${agent}" ${heldByCaller ? "holds" : "does not hold"} the claim.`,
        heldByCaller
          ? "Pick a different target status; you already hold this task."
          : "Pick a different target status, or pass force: true to take over.",
        { task: id, to, assignee: task.assignee, claimedByCaller: heldByCaller },
      );
    }

    // A drift task has no declared edges: allow any declared target so it can
    // be recovered, but still enforce the claim rules below.
    if (!task.drifted && !canTransition(workflow, task.status, to)) {
      const allowed = allowedTargets(workflow, task.status);
      throw new KanbanError(
        "invalid_transition",
        `"${task.status}" cannot move to "${to}". Allowed: ${allowed.length > 0 ? allowed.join(", ") : "nothing"}.`,
        allowed.length > 0 ? `Move to one of: ${allowed.join(", ")}.` : "This status is a dead end; fix the workflow.",
        { task: id, from: task.status, to, allowed },
      );
    }

    const now = clock.now();
    const at = now.toISOString();
    const history: HistoryEntry[] = [];
    const currentStatus = workflow.byId.get(task.status);

    // A claim is exclusive in both directions: while a task sits in an active
    // status, only its owner (or a forced caller) may move it out.
    let assignee = task.assignee;
    const contested = Boolean(assignee && assignee !== agent);
    const claimBound = Boolean(target.active || currentStatus?.active);
    if (contested && claimBound) {
      if (!input.force) {
        throw new KanbanError(
          "wrong_owner",
          `Task ${id} is claimed by "${assignee}"${claimedFor(task, clock)}; "${agent}" cannot move it, because that would take the claim.`,
          releaseHint(task, agent),
          { task: id, assignee, agent, to },
        );
      }
      history.push({ at, action: "force-assign", by: agent, assignee: agent, forced: true });
      assignee = agent;
    }

    history.push({ at, action: "move", by: agent, from: task.status, to });

    if (target.active && !assignee) {
      assignee = agent;
      history.push({ at, action: "assign", by: agent, assignee: agent });
    }

    if (target.terminal && assignee) {
      history.push({ at, action: "unassign", by: agent, assignee });
      assignee = undefined;
    }

    const next: Task = {
      ...task,
      status: to,
      assignee,
      updated: at,
      rev: task.rev + 1,
      history: [...task.history, ...attachReason(history, reason)],
      drifted: false,
    };
    writeTask(next);
    return { ...withClaimAge(next, workflow, clock), from: task.status };
  });
}

export interface AssignInput {
  task: string;
  assignee: string | null;
  agent: string;
  force?: boolean;
  reason?: string;
  expectedRev?: number;
}

/**
 * Set or clear the single assignee.
 *
 * Any write to an assignee that is not the caller's own handle needs `force`,
 * in both directions: taking another handle's task, and assigning a task to a
 * third handle (ADR 0009). Releasing your own assignment does not.
 */
export async function assignTask(
  location: BoardLocation,
  input: AssignInput,
  clock: Clock = systemClock,
): Promise<Task> {
  const agent = assertHandle(input.agent);
  const id = assertTaskId(input.task);
  const wanted = input.assignee === null || input.assignee === undefined ? null : assertHandle(input.assignee, "assignee");
  // Argument errors win over board-state errors, and neither takes the lock.
  const reason = input.reason === undefined ? undefined : normalizeReason(input.reason, input.force);

  return withBoardLock(join(location.dir, FILES.lock), () => {
    const workflow = readWorkflow(location.dir);
    const task = readTask(location, id, clock);
    assertFresh(task, input.expectedRev);

    const current = task.assignee ?? null;
    if (current === wanted) return task;

    if (wanted !== null) {
      const status = workflow.byId.get(task.status);
      if (status?.terminal) {
        throw new KanbanError(
          "terminal_task",
          `Task ${id} is in terminal status "${task.status}".`,
          "Move it back to an open status before assigning it.",
          { task: id, status: task.status },
        );
      }
    }

    const now = clock.now();
    const at = now.toISOString();
    // A new entry receives the reason unless it is a deliberate release of your
    // own assignment: `reason` annotates a forced write, and an `unassign` can
    // never be one here (design §1.2).
    const newHistory: HistoryEntry[] = [];

    // Writing another handle's name is a coordination act, not a self-claim, so
    // it is deliberate whatever the task held before (ADR 0009, design §2.1).
    // The no-op above stays first, so a retried call is still idempotent.
    if (wanted !== null && wanted !== agent && !input.force) {
      throw new KanbanError(
        "wrong_owner",
        current
          ? `Task ${id} is assigned to "${current}"; "${agent}" cannot assign it to "${wanted}" without force.`
          : `Task ${id} is unassigned; "${agent}" cannot assign it to "${wanted}" without force.`,
        `Pass force: true to make this assignment; history records it as a forced assignment by "${agent}".`,
        { task: id, assignee: wanted, agent },
      );
    }

    if (wanted === null) {
      if (current && current !== agent && !input.force) {
        throw new KanbanError(
          "wrong_owner",
          `Task ${id} is claimed by "${current}"${claimedFor(task, clock)}; "${agent}" cannot clear it without force.`,
          releaseHint(task, agent),
          { task: id, assignee: current, agent },
        );
      }
      newHistory.push({ at, action: "unassign", by: agent, assignee: current ?? undefined, ...(current && current !== agent ? { forced: true } : {}) });
    } else if (current && current !== agent && !input.force) {
      throw new KanbanError(
        "already_assigned",
        `Task ${id} is already assigned to "${current}"${claimedFor(task, clock)}.`,
        releaseHint(task, agent),
        { task: id, assignee: current, agent },
      );
    } else if (input.force && (wanted !== agent || Boolean(current && current !== wanted))) {
      // A forced write is a takeover when it takes someone else's task and a
      // third-party assignment when it names another handle; both record the
      // same distinguishable entry (design §2.1).
      newHistory.push({ at, action: "force-assign", by: agent, assignee: wanted, forced: true });
    } else {
      newHistory.push({ at, action: "assign", by: agent, assignee: wanted });
    }

    const annotated = newHistory[0]?.action === "unassign" ? newHistory : attachReason(newHistory, reason);
    const next: Task = {
      ...task,
      assignee: wanted ?? undefined,
      updated: at,
      rev: task.rev + 1,
      history: [...task.history, ...annotated],
    };
    writeTask(next);
    return withClaimAge(next, workflow, clock);
  });
}

/**
 * Release a claim: `kanban_assign {assignee: null, force: true}` sugar, used by
 * `/kanban release`. Records a forced unassignment in history (ADR 0004).
 */
export interface ReleaseInput {
  task: string;
  agent: string;
  expectedRev?: number;
}

export async function releaseTask(
  location: BoardLocation,
  input: ReleaseInput,
  clock: Clock = systemClock,
): Promise<Task> {
  return assignTask(location, { task: input.task, assignee: null, agent: input.agent, force: true, expectedRev: input.expectedRev }, clock);
}

/**
 * Parse a stale-claim threshold: `<n>` followed by `m`, `h`, `d`, or `w`, a
 * bare integer in milliseconds, or `0` to disable. Invalid input is a hard
 * error (design §4).
 */
export function parseStaleDuration(value: string): number {
  const text = value.trim();
  const match = /^(\d+)([mhdw])?$/.exec(text);
  if (!match) {
    throw new KanbanError(
      "invalid_argument",
      `Invalid --stale "${value}"; use 30m, 12h, 7d, or 0.`,
      "Pass a duration such as --stale 24h, or 0 to disable the check.",
    );
  }
  const amount = Number(match[1]);
  const unit = match[2];
  if (!unit) return amount;
  const scale = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : 604_800_000;
  return amount * scale;
}

export interface CommentInput {
  task: string;
  body: string;
  agent: string;
  expectedRev?: number;
}

/** Append a comment. Comments are not duplicated into history. */
export async function commentOnTask(
  location: BoardLocation,
  input: CommentInput,
  clock: Clock = systemClock,
): Promise<Task> {
  const agent = assertHandle(input.agent);
  const id = assertTaskId(input.task);
  const body = (input.body ?? "").trim();
  if (!body) throw new KanbanError("invalid_task", "A comment needs a body.", "Pass the note you want to leave.");
  if (body.length > MAX_COMMENT) {
    throw new KanbanError("invalid_task", `Comment is ${body.length} characters; the limit is ${MAX_COMMENT}.`, "Shorten the comment or attach a file reference.");
  }
  if (body.split("\n").some((line) => /^<!--\s*kanban:comment\b/.test(line.trim()))) {
    throw new KanbanError("invalid_task", "A comment body cannot contain a kanban comment sentinel.", "Remove the `<!-- kanban:comment ... -->` line.");
  }

  return withBoardLock(join(location.dir, FILES.lock), () => {
    const task = readTask(location, id, clock);
    assertFresh(task, input.expectedRev);
    const at = clock.now().toISOString();
    const comment: CommentBlock = { at, by: agent, body };
    const next: Task = {
      ...task,
      updated: at,
      rev: task.rev + 1,
      comments: [...task.comments, comment],
    };
    writeTask(next);
    const { workflow } = readWorkflowTolerant(location.dir);
    return withClaimAge(next, workflow, clock);
  });
}

// ─── Init and validation ─────────────────────────────────────────────────────

const STARTER_WORKFLOW = `# Workflow for this project's kanban board.
#
# Statuses are the columns. Transitions declare the legal moves.
#   active: true    -> entering the status claims the task for one agent
#   terminal: true  -> entering the status releases the assignee
#
# Omit "transitions" for a simple linear workflow: every adjacent pair of
# statuses becomes a two-way move.

name: default
initial: new

statuses:
  - id: new
    label: New
  - id: planning
    label: Planning
    active: true
  - id: working
    label: Working
    active: true
  - id: reviewing
    label: Reviewing
    active: true
  - id: done
    label: Done
    terminal: true

transitions:
  new: [planning, working]
  planning: [new, working]
  working: [planning, reviewing]
  reviewing: [working, done]
  done: [working]
`;

export interface InitResult {
  dir: string;
  workflowPath: string;
  created: boolean;
}

/** Create the board directory and a starter workflow. Never overwrites. */
export async function initBoard(location: BoardLocation): Promise<InitResult> {
  ensureDir(location.tasksDir);
  const existing = WORKFLOW_FILE_CANDIDATES.map((name) => join(location.dir, name)).find((path) => existsSync(path));
  if (existing) {
    return { dir: location.dir, workflowPath: existing, created: false };
  }
  return withBoardLock(join(location.dir, FILES.lock), () => {
    const again = WORKFLOW_FILE_CANDIDATES.map((name) => join(location.dir, name)).find((path) => existsSync(path));
    if (again) return { dir: location.dir, workflowPath: again, created: false };
    const path = join(location.dir, FILES.workflowYaml);
    atomicWrite(path, STARTER_WORKFLOW);
    return { dir: location.dir, workflowPath: path, created: true };
  });
}

export interface ValidateOptions {
  /** Age after which an active claim is a `stale_claim` warning. Default 24h; `0` disables. */
  staleAfterMs?: number;
}

export interface ValidationReport {
  ok: boolean;
  dir: string;
  workflowErrors: string[];
  problems: ValidationProblem[];
}

/** The raw `counter.json` value, or undefined when the file is absent or invalid. */
export function readCounterValue(location: BoardLocation): number | undefined {
  const path = join(location.dir, FILES.counter);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Counter>;
    return typeof parsed.next === "number" && Number.isInteger(parsed.next) ? parsed.next : undefined;
  } catch {
    return undefined;
  }
}

/** A `stale_claim` warning, or undefined when the hold is fresh or absent. */
function staleClaimProblem(
  task: Task,
  workflow: Workflow | null,
  staleAfterMs: number = DEFAULT_STALE_CLAIM_MS,
  clock: Clock,
): ValidationProblem | undefined {
  if (!workflow || staleAfterMs <= 0 || !task.assignee) return undefined;
  const status = workflow.byId.get(task.status);
  // A terminal task cannot hold anything: `terminal_assigned` already says so.
  if (status?.terminal) return undefined;
  const age = claimAgeMs(task, clock.now());
  // Strictly older than the threshold, matching "older than 24h".
  if (age <= staleAfterMs) return undefined;
  const threshold = formatThreshold(staleAfterMs);
  const release = `Release it with /kanban release ${task.id} --yes.`;
  // An active status is a real claim; anywhere else it is only an assignment,
  // and the warning has to say why that still matters: it blocks the move that
  // would create the claim.
  const message = status?.active
    ? `Claimed by "${task.assignee}" for ${formatAge(age)} (threshold ${threshold}). ${release}`
    : `Assigned to "${task.assignee}" for ${formatAge(age)} (threshold ${threshold}), which blocks moving the task into an active status. ${release}`;
  return {
    task: task.id,
    code: "stale_claim",
    severity: "warning",
    message,
  };
}

/**
 * An `unannotated_forced` warning, or undefined when every takeover has a
 * reason. One finding per task, not per entry, so a board cannot flood the
 * report (design §1.6).
 */
function unannotatedForcedProblem(task: Task): ValidationProblem | undefined {
  const unannotated = task.history.filter((entry) => entry.action === "force-assign" && !entry.reason?.trim());
  if (unannotated.length === 0) return undefined;
  const first = unannotated[0];
  const who = first.by ?? "-";
  const date = first.at.slice(0, 10);
  const advice = `Add one next time with kanban_assign {force: true, reason: "..."}.`;
  const message =
    unannotated.length === 1
      ? `Forced assignment by "${who}" on ${date} has no reason. ${advice}`
      : `${unannotated.length} forced assignments have no reason; the first is by "${who}" on ${date}. ${advice}`;
  return { task: task.id, code: "unannotated_forced", severity: "warning", message };
}

/**
 * Check the board for states that confuse agents: an invalid workflow,
 * drifted tasks, terminal tasks still claimed, stale claims (warning), and
 * unreadable task files.
 *
 * Task files are read one by one so a single broken file is reported instead of
 * aborting the whole report.
 */
export function validateBoard(
  location: BoardLocation,
  options: ValidateOptions = {},
  clock: Clock = systemClock,
): ValidationReport {
  const workflowResult = readWorkflowTolerant(location.dir);
  const workflow = workflowResult.workflow;
  const problems: ValidationProblem[] = [];
  const tasks: Task[] = [];

  for (const id of listTaskIds(location)) {
    const path = taskPath(location, id);
    try {
      tasks.push(toTask(path, id, workflow, clock));
    } catch (error) {
      // A file that cannot be parsed or validated is reported and excluded.
      // `id_mismatch` keeps its specific code (ADR/T-0007); everything else is
      // `unreadable_task`.
      const kanban = error instanceof KanbanError ? error : undefined;
      const code = kanban?.details.code === "id_mismatch" ? "id_mismatch" : "unreadable_task";
      problems.push({
        task: id,
        code,
        severity: "problem",
        message: error instanceof Error ? error.message : String(error),
        path,
      });
    }
  }

  for (const task of tasks) {
    if (task.drifted) {
      problems.push({
        task: task.id,
        code: "drifted",
        severity: "problem",
        message: `Status "${task.status}" is not declared by the workflow.`,
      });
    }
    if (workflow) {
      const status = workflow.byId.get(task.status);
      if (task.assignee && status?.terminal) {
        problems.push({
          task: task.id,
          code: "terminal_assigned",
          severity: "problem",
          message: `Terminal task is still assigned to "${task.assignee}".`,
        });
      }
      // An active task with no assignee is normal (e.g. after a release), so
      // there is no `active_unassigned` problem (design §4).
    }
    const stale = staleClaimProblem(task, workflow, options.staleAfterMs, clock);
    if (stale) problems.push(stale);
    // After `stale_claim`, matching the order design §1.6 fixes.
    const unannotated = unannotatedForcedProblem(task);
    if (unannotated) problems.push(unannotated);
  }

  // A counter at or below the highest issued id silently hands out a live id.
  const counter = readCounterValue(location);
  const highest = tasks.length > 0 ? Math.max(...tasks.map((task) => Number(task.id.slice(2)))) : 0;
  if (counter !== undefined && highest > 0 && counter <= highest) {
    problems.push({
      code: "counter_low",
      severity: "problem",
      message: `counter.json says the next id is ${counter}, which is not greater than the highest existing id T-${String(highest).padStart(4, "0")}; a create would reuse an id.`,
    });
  }

  const hasProblem = problems.some((problem) => problem.severity === "problem");
  return {
    ok: workflowResult.errors.length === 0 && !hasProblem,
    dir: location.dir,
    workflowErrors: workflowResult.errors,
    problems,
  };
}

// ─── ID repair ────────────────────────────────────────────────────────────────

/** One rename `repair-ids` would make, from the filename to the declared id. */
export interface IdRepair {
  filenameId: string;
  declaredId: string;
  path: string;
  target: string;
}

export interface RepairPlan {
  dir: string;
  /** filenameId ascending. */
  renames: IdRepair[];
  counter?: { from: number; to: number };
  skipped: Array<{ path: string; message: string }>;
}

/** What `repair-ids` refuses to do, and why. Rendered by `src/command.ts`. */
export type RepairRefusal =
  | { kind: "duplicate"; entries: Array<{ filename: string; declaredId: string }> }
  | { kind: "target_exists"; entry: { filename: string; declaredId: string; existing: string } };

/** Files an interrupted run left behind; never a task, so they are surfaced. */
const REPAIR_TEMP = /^\.repair\..*\.md$/;

/** The frontmatter `id`, or the reason it cannot be used (design §5.1). */
function readDeclaredId(path: string): { declaredId?: string; problem?: string } {
  let text: string;
  try {
    text = readText(path);
  } catch {
    return { problem: "cannot be read" };
  }
  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = parseTaskFile(text, path).frontmatter;
  } catch {
    return { problem: "not a readable task file" };
  }
  const id = frontmatter.id;
  if (typeof id !== "string") return { problem: `no string "id" in frontmatter` };
  return { declaredId: id };
}

/** `.repair.<token>.<filenameId>.md` files a crashed run left in `tasks/`. */
function leftoverRepairs(location: BoardLocation): string[] {
  try {
    return readdirSync(location.tasksDir).filter((name) => REPAIR_TEMP.test(name)).sort();
  } catch {
    return [];
  }
}

/**
 * The highest id on the board once the plan is applied: the filenames that
 * exist plus the ids the plan renames to.
 */
function highestPlannedId(location: BoardLocation, renames: IdRepair[]): number {
  const ids = [
    ...listTaskIds(location).map((id) => Number(id.slice(2))),
    ...renames.map((rename) => Number(rename.declaredId.slice(2))),
  ];
  return ids.length > 0 ? Math.max(...ids) : 0;
}

/**
 * Compute the repair plan. Read only: it takes no board lock, like `validate`
 * (design §5.1). The filename is the identity source of truth, and a file whose
 * frontmatter `id` differs is repaired **to** the declared id.
 */
export function planRepairIds(location: BoardLocation): RepairPlan {
  const skipped: RepairPlan["skipped"] = [];
  const renames: IdRepair[] = [];

  for (const filenameId of listTaskIds(location)) {
    const path = taskPath(location, filenameId);
    const { declaredId, problem } = readDeclaredId(path);
    if (declaredId === undefined) {
      skipped.push({ path, message: problem ?? `no string "id" in frontmatter` });
      continue;
    }
    // A non-canonical id cannot become a filename any tool reads, so it needs a
    // hand edit rather than a rename that would hide the task.
    if (!isTaskId(declaredId)) {
      skipped.push({ path, message: `invalid id "${declaredId}" in frontmatter` });
      continue;
    }
    if (declaredId === filenameId) continue;
    renames.push({
      filenameId,
      declaredId,
      path,
      target: join(location.tasksDir, taskFileName(declaredId)),
    });
  }

  for (const name of leftoverRepairs(location)) {
    skipped.push({ path: join(location.tasksDir, name), message: "interrupted repair: restore or delete by hand" });
  }

  const highest = highestPlannedId(location, renames);
  const from = readCounter(location);
  return {
    dir: location.dir,
    renames,
    counter: from <= highest ? { from, to: highest + 1 } : undefined,
    skipped,
  };
}

/**
 * A refusal the plan cannot be applied through: two files declaring one id, or
 * a rename target that exists and is not itself moving away (design §5.4).
 */
export function repairRefusal(plan: RepairPlan): RepairRefusal | undefined {
  const byTarget = new Map<string, IdRepair[]>();
  for (const rename of plan.renames) {
    const group = byTarget.get(rename.target) ?? [];
    group.push(rename);
    byTarget.set(rename.target, group);
  }
  for (const group of byTarget.values()) {
    if (group.length > 1) {
      return {
        kind: "duplicate",
        entries: group.map((rename) => ({ filename: taskFileName(rename.filenameId), declaredId: rename.declaredId })),
      };
    }
  }

  // A swap is fine: both targets are sources, and both move aside first.
  const sources = new Set(plan.renames.map((rename) => rename.path));
  for (const rename of plan.renames) {
    if (existsSync(rename.target) && !sources.has(rename.target)) {
      return {
        kind: "target_exists",
        entry: {
          filename: taskFileName(rename.filenameId),
          declaredId: rename.declaredId,
          existing: taskFileName(rename.declaredId),
        },
      };
    }
  }
  return undefined;
}

/**
 * Apply the repair under the board lock: re-plan, then both rename passes, then
 * the counter. It takes no plan argument, so a printed plan is never applied
 * blind (design §5.1, §5.5). A refusal or an empty plan writes nothing.
 */
export async function repairIds(
  location: BoardLocation,
  agent: string,
): Promise<{ plan: RepairPlan; applied: boolean }> {
  assertHandle(agent);
  return withBoardLock(join(location.dir, FILES.lock), () => {
    const plan = planRepairIds(location);
    if (repairRefusal(plan)) return { plan, applied: false };
    if (plan.renames.length === 0 && !plan.counter) return { plan, applied: false };

    // Two passes so a swap or a chain cannot collide. One token per run names
    // every staged file, so an interrupted run is recognisable and skipped.
    const token = randomBytes(6).toString("hex");
    const staged = plan.renames.map((rename) => ({
      rename,
      temp: join(location.tasksDir, `.repair.${token}.${rename.filenameId}.md`),
    }));
    for (const { rename, temp } of staged) renameSync(rename.path, temp);
    for (const { rename, temp } of staged) renameSync(temp, rename.target);

    // Never lowered: a counter above the highest id is not rewritten at all.
    if (plan.counter) {
      atomicWrite(join(location.dir, FILES.counter), `${JSON.stringify({ next: plan.counter.to }, null, 2)}\n`);
    }
    return { plan, applied: true };
  });
}

/** Task summaries for tools and the `/kanban` view. */
export function summarize(task: Task) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    assignee: task.assignee,
    updated: task.updated,
    rev: task.rev,
    drifted: task.drifted,
    active: task.active ?? false,
    /** Milliseconds since the claim started; only meaningful when `active`. */
    claimAgeMs: task.claimAgeMs ?? 0,
  };
}

export function detail(task: Task) {
  return {
    ...summarize(task),
    description: task.description,
    created: task.created,
    history: task.history,
    comments: task.comments.map((comment): Comment => ({ at: comment.at, by: comment.by, body: comment.body })),
    path: task.path,
  };
}
