/**
 * pi-minimal-kanban — a file-backed Kanban for Pi agents.
 *
 * Five tools (create, move, assign, comment, list) operate on
 * `<project>/.pi/kanban/`, where the project is the nearest ancestor with
 * `.git` or an existing board. One `/kanban` command renders the board
 * read-only.
 *
 * Claims are enforced by the state machine, not by trust: a task is claimed by
 * the handle that moves it into an `active` status, and only that handle can
 * move or release it without `force`.
 */

import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { KanbanError, type FailureEnvelope } from "./errors.ts";
import { resolveBoard, type BoardLocation } from "./paths.ts";
import { createTask, moveTask, assignTask, commentOnTask, readBoard, readTask, detail, summarize } from "./store.ts";
import { renderBriefing, renderFileErrors, renderOffsetPastEnd, renderPageFooter, renderPageHeader, renderSummary, renderTask, renderTaskRows, renderWorkflowBlock } from "./render.ts";
import { workflowToJson } from "./workflow.ts";
import { completeKanbanCommand, handleKanbanCommand } from "./command.ts";
import {
  AssignOutput,
  AssignParams,
  CommentOutput,
  CommentParams,
  CreateOutput,
  CreateParams,

  ListOutput,
  ListParams,
  MoveOutput,
  MoveParams,
} from "./schemas.ts";

const NAMESPACE = {
  name: "kanban",
  description: "File-backed Kanban board shared by agents working in one project.",
} as const;

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;
const MUTATING = { readOnlyHint: false, openWorldHint: true } as const;

type Structured = AgentToolResult<unknown>["structuredContent"];

function ok(text: string, structuredContent: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details: {}, structuredContent: structuredContent as Structured };
}

/** Any location is better than none: an error must still say which board failed. */
function boardLocationFor(params: { project?: string }, cwd: string): BoardLocation | undefined {
  try {
    return resolveBoard({ cwd, project: params.project });
  } catch {
    try {
      return resolveBoard({ cwd });
    } catch {
      return undefined;
    }
  }
}

function isErrno(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error && typeof (error as NodeJS.ErrnoException).code === "string");
}

/**
 * One envelope for every failure, and therefore one serializer.
 *
 * `KanbanError` keeps its typed code, hint, and details (including `rev`,
 * `expectedRev`, and `status` for `stale`). Anything else is mapped to a typed
 * code with an actionable hint, and every payload names the board it came from.
 */
export function failureEnvelope(
  error: unknown,
  params: { project?: string },
  cwd: string,
): FailureEnvelope {
  const location = boardLocationFor(params, cwd);
  const place = location ? { root: location.root, dir: location.dir } : {};

  if (error instanceof KanbanError) {
    const { code, hint, ...rest } = error.details;
    return {
      ok: false,
      error: error.message,
      code,
      ...rest,
      ...(hint ? { hint } : {}),
      ...place,
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  if (isErrno(error)) {
    return {
      ok: false,
      error: message,
      code: "io",
      hint: "The board files could not be read or written; check permissions and free space, then retry.",
      ...place,
    };
  }
  if (/locked by another process/i.test(message)) {
    return {
      ok: false,
      error: message,
      code: "locked",
      hint: "Another writer holds the board lock. Retry in a moment; do not delete the lock while its owner may be alive.",
      ...place,
    };
  }
  return {
    ok: false,
    error: message,
    code: "internal",
    hint: "This is not a board-state problem. Retry the call; if it persists, report the error text.",
    ...place,
  };
}

function fail(error: unknown, params: { project?: string }, cwd: string): AgentToolResult<unknown> {
  const envelope = failureEnvelope(error, params, cwd);
  // A bad argument is the whole message: `Error [invalid_argument]: Invalid
  // --stale "x"; use 30m, 12h, 7d, or 0.` (design §4) carries no hint line.
  const hint =
    envelope.code === "invalid_argument" || typeof envelope.hint !== "string" ? "" : `\n${envelope.hint}`;
  return {
    content: [{ type: "text" as const, text: `Error [${envelope.code}]: ${envelope.error}${hint}` }],
    details: {},
    structuredContent: envelope as Structured,
    isError: true,
  };
}

function locate(params: { project?: string }, cwd: string): BoardLocation {
  return resolveBoard({ cwd, project: params.project });
}

/** Text summary shared by create/move/assign/comment. */
function taskLine(task: ReturnType<typeof detail>): string {
  const owner = task.assignee ? `  @${task.assignee}` : "";
  return `${task.id}  ${task.status}  ${task.title}${owner}`;
}

export default function kanbanExtension(pi: ExtensionAPI) {
  const notifyChange = (location: BoardLocation, taskId: string, action: string): void => {
    pi.events.emit("kanban:task_changed", {
      project: location.root,
      board: location.dir,
      taskId,
      action,
    });
  };

  pi.registerTool(
    defineTool({
      name: "kanban_create",
      label: "Kanban Create",
      description:
        "Create a task on the project's kanban board. The task starts in the workflow's initial status and is unassigned unless that status is active.",
      promptSnippet: "Create a task on the project kanban board",
      promptGuidelines: [
        "Use kanban_create to record work that spans more than one agent or outlives the current turn.",
        "Pass your own handle as `agent`; it is recorded in history and used to enforce exclusive claims.",
      ],
      parameters: CreateParams,
      outputSchema: CreateOutput,
      namespace: NAMESPACE,
      annotations: MUTATING,
      executionMode: "sequential",
      async execute(_id, params, _signal, _onUpdate, ctx) {
        try {
          const location = locate(params, ctx.cwd);
          const task = await createTask(location, {
            title: params.title,
            description: params.description,
            agent: params.agent,
          });
          notifyChange(location, task.id, "create");
          const detailView = detail(task);
          return ok(`Created ${taskLine(detailView)}`, {
            ok: true,
            task: detailView,
            root: location.root,
            dir: location.dir,
          });
        } catch (error) {
          return fail(error, params, ctx.cwd);
        }
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "kanban_move",
      label: "Kanban Move",
      description:
        "Move a task to another status along a transition declared by the project's workflow. Moving into an active status claims the task; moving into a terminal status releases the assignee.",
      promptSnippet: "Move a kanban task along a declared workflow transition",
      promptGuidelines: [
        "Call kanban_list first to see the task's current status and the statuses its workflow allows.",
        "Only the claiming agent may move a task that is already in an active status; `force` takes over deliberately.",
        "Pass `expectedRev` from the last kanban_list read when another agent may have written since; a stale rev fails the call instead of overwriting.",
      ],
      parameters: MoveParams,
      outputSchema: MoveOutput,
      namespace: NAMESPACE,
      annotations: MUTATING,
      executionMode: "sequential",
      async execute(_id, params, _signal, _onUpdate, ctx) {
        try {
          const location = locate(params, ctx.cwd);
          const task = await moveTask(location, {
            task: params.task,
            to: params.to,
            agent: params.agent,
            force: params.force,
            expectedRev: params.expectedRev,
          });
          notifyChange(location, task.id, "move");
          const detailView = detail(task);
          // `from` comes from the task read inside the board lock, so the tool
          // never needs a second, racy read before the move.
          return ok(`${task.from} → ${task.status}  ${task.id}  ${task.title}`, {
            ok: true,
            task: detailView,
            from: task.from,
            root: location.root,
            dir: location.dir,
          });
        } catch (error) {
          return fail(error, params, ctx.cwd);
        }
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "kanban_assign",
      label: "Kanban Assign",
      description:
        "Set or clear the single assignee of a task. Another handle's claim can only be taken or released with `force`.",
      promptSnippet: "Assign or release a kanban task's single owner",
      promptGuidelines: [
        "A task has at most one assignee; assigning an owned task fails unless you pass `force`.",
        "Prefer moving the task into an active status, which claims it for you, over assigning and then moving.",
        "Pass `expectedRev` when you are releasing or taking over a task another handle may have changed since your last read.",
      ],
      parameters: AssignParams,
      outputSchema: AssignOutput,
      namespace: NAMESPACE,
      annotations: MUTATING,
      executionMode: "sequential",
      async execute(_id, params, _signal, _onUpdate, ctx) {
        try {
          const location = locate(params, ctx.cwd);
          const task = await assignTask(location, {
            task: params.task,
            assignee: params.assignee,
            agent: params.agent,
            force: params.force,
            expectedRev: params.expectedRev,
          });
          notifyChange(location, task.id, params.assignee === null ? "unassign" : "assign");
          const detailView = detail(task);
          const text =
            params.assignee === null
              ? `Released ${task.id}${task.assignee ? ` (now @${task.assignee})` : ""}`
              : `Assigned ${task.id} to @${task.assignee}`;
          return ok(text, { ok: true, task: detailView, root: location.root, dir: location.dir });
        } catch (error) {
          return fail(error, params, ctx.cwd);
        }
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "kanban_comment",
      label: "Kanban Comment",
      description: "Append a comment to a task's thread.",
      promptSnippet: "Comment on a kanban task",
      promptGuidelines: [
        "Leave a comment when you need to record progress, a blocker, or a handoff without changing status.",
        "Pass `expectedRev` if another agent may have moved or assigned the task since your last kanban_list read.",
      ],
      parameters: CommentParams,
      outputSchema: CommentOutput,
      namespace: NAMESPACE,
      annotations: MUTATING,
      executionMode: "sequential",
      async execute(_id, params, _signal, _onUpdate, ctx) {
        try {
          const location = locate(params, ctx.cwd);
          const task = await commentOnTask(location, {
            task: params.task,
            body: params.body,
            agent: params.agent,
            expectedRev: params.expectedRev,
          });
          notifyChange(location, task.id, "comment");
          const comment = task.comments[task.comments.length - 1];
          return ok(`Commented on ${task.id} (${task.comments.length} comment${task.comments.length === 1 ? "" : "s"})`, {
            ok: true,
            task: detail(task),
            comment,
            root: location.root,
            dir: location.dir,
          });
        } catch (error) {
          return fail(error, params, ctx.cwd);
        }
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "kanban_list",
      label: "Kanban List",
      description:
        "List tasks on the board, or read one task in full. Includes the workflow's statuses and transitions so you can see which moves are legal.",
      promptSnippet: "List kanban tasks or read one task's details",
      promptGuidelines: [
        "Use kanban_list before kanban_move to learn the workflow's transitions and the task's current rev.",
        "Pass `task` to get description, history, and comments for a single task.",
        "Pass `briefing: true` (or list an empty board) when you do not yet know the board's rules; it prints the claim rules and the first calls.",
        "Rows are paged: `limit` defaults to 50, and the footer tells you the next `offset`.",
      ],
      parameters: ListParams,
      outputSchema: ListOutput,
      namespace: NAMESPACE,
      annotations: READ_ONLY,
      async execute(_id, params, _signal, _onUpdate, ctx) {
        try {
          const location = locate(params, ctx.cwd);
          const board = readBoard(location);
          const statusFilter = params.status?.trim();
          const assigneeFilter = params.assignee?.trim();
          const includeTerminal = params.includeTerminal !== false;
          const filtered = board.tasks.filter((task) => {
            if (statusFilter && task.status !== statusFilter) return false;
            if (assigneeFilter && task.assignee !== assigneeFilter) return false;
            if (!includeTerminal && board.workflow?.byId.get(task.status)?.terminal) return false;
            return true;
          });
          const workflow = board.workflow ? workflowToJson(board.workflow) : null;
          const total = filtered.length;
          // Read once: the briefing repeats these warnings instead of hiding them.
          const fileWarnings = renderFileErrors(board.fileErrors, { mode: "both", cwd: ctx.cwd });

          // Ordering is stable and follows the workflow: declared status order,
          // then task id ascending. A drifted task sorts after every declared
          // status so it cannot be mistaken for a column.
          if (board.workflow) {
            const rank = new Map(board.workflow.statuses.map((status, index) => [status.id, index]));
            const driftedRank = rank.size;
            filtered.sort((a, b) => {
              const byStatus =
                (rank.get(a.status) ?? driftedRank) - (rank.get(b.status) ?? driftedRank);
              return byStatus !== 0 ? byStatus : Number(a.id.slice(2)) - Number(b.id.slice(2));
            });
          }

          // The briefing wins over every other parameter, and an empty board is
          // a briefing rather than "No matching tasks." A request for one task
          // by id still gets the no_such_task error it asked for. An unreadable
          // task file is not an empty board: that has to go through the normal
          // path, which names the file.
          const emptyBoard =
            board.tasks.length === 0 && board.fileErrors.length === 0 && !statusFilter && !assigneeFilter;
          if (params.briefing === true || (emptyBoard && !params.task)) {
            const briefing = [...fileWarnings, ...(fileWarnings.length > 0 ? [""] : []), renderBriefing(board, ctx.cwd)];
            const text = briefing.join("\n");
            return ok(text, {
              ok: true,
              tasks: [],
              briefing: text,
              workflow,
              workflowErrors: board.workflowErrors,
              fileErrors: board.fileErrors,
              // The real post-filter total: `briefing: true` must not tell a
              // consumer that a 137-task board is empty.
              total,
              root: location.root,
              dir: location.dir,
            });
          }

          if (params.task) {
            const task = readTask(location, params.task);
            return ok(renderTask(task, board.workflow), {
              ok: true,
              tasks: [detail(task)],
              fileErrors: board.fileErrors,
              root: location.root,
              dir: location.dir,
            });
          }

          if (params.summary === true) {
            return ok(renderSummary(board, filtered, board.workflow, ctx.cwd), {
              ok: true,
              tasks: [],
              workflow,
              workflowErrors: board.workflowErrors,
              fileErrors: board.fileErrors,
              total,
              offset: 0,
              limit: 0,
              returned: 0,
              hasMore: false,
              truncated: false,
              root: location.root,
              dir: location.dir,
            });
          }

          const limit = Math.min(Math.max(params.limit ?? 50, 1), 500);
          const offset = Math.max(params.offset ?? 0, 0);
          const page = filtered.slice(offset, offset + limit);
          const paging = { total, offset, limit, returned: page.length };

          const warnings: string[] = [...fileWarnings];
          if (board.workflowErrors.length > 0) {
            if (warnings.length > 0) warnings.push("");
            warnings.push(`⚠ Workflow problem (reads still work, mutations will fail):`);
            for (const error of board.workflowErrors) warnings.push(`  ${error}`);
          }

          const body: string[] = [];
          if (total === 0) {
            body.push("No matching tasks.", "  Try another status, assignee, or includeTerminal: false.");
          } else if (offset >= total) {
            body.push(renderOffsetPastEnd(total, offset));
          } else {
            const header = renderPageHeader(paging);
            if (header) body.push(header);
            body.push(...renderTaskRows(page, { width: 76 }));
            const footer = renderPageFooter(paging);
            if (footer) body.push(footer);
          }

          const lines = [...warnings];
          if (lines.length > 0) lines.push("");
          lines.push(...body);

          // The tool's contract promises the workflow, so print it: an agent with
          // only kanban_list must still be able to plan a legal move. Its size
          // follows the workflow, never the board.
          const workflowBlock = renderWorkflowBlock(board.workflow);
          if (workflowBlock.length > 0) {
            lines.push("", ...workflowBlock);
          }

          return ok(lines.join("\n"), {
            ok: true,
            tasks: page.map(summarize),
            workflow,
            workflowErrors: board.workflowErrors,
            fileErrors: board.fileErrors,
            total,
            offset,
            limit,
            returned: page.length,
            hasMore: offset + page.length < total,
            truncated: offset + page.length < total,
            root: location.root,
            dir: location.dir,
          });
        } catch (error) {
          return fail(error, params, ctx.cwd);
        }
      },
    }),
  );

  pi.registerCommand("kanban", {
    description: "View the project kanban board",
    getArgumentCompletions: (prefix) =>
      completeKanbanCommand(prefix).map((item) => ({
        value: item.label,
        label: item.label,
        description: item.description,
      })),
    handler: handleKanbanCommand,
  });

  // The board is files, so nothing needs restoring on session start. Rendering
  // happens on demand, which keeps `/reload` and `/resume` free of side effects.
}
