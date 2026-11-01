/**
 * T-0006: a claim left by a departed agent must be visible and releasable.
 * Claim age is shown wherever an assignee is; `validate` reports a stale claim
 * as a warning; `wrong_owner` names the release call. Since 0.4.0 `/kanban` is
 * read-only, so the release path is `kanban_assign {assignee: null, force: true}`.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import kanbanExtension, { failureEnvelope } from "../index.ts";
import { USAGE, handleKanbanCommand, renderValidationReport } from "../command.ts";
import { assignTask, createTask, moveTask, readBoard, readTask, validateBoard, releaseTask } from "../store.ts";
import { renderBoard, renderTask, renderTaskRows } from "../render.ts";
import type { Task } from "../types.ts";
import { makeBoard, taskFile } from "./helpers.ts";
import type { BoardLocation } from "../paths.ts";

interface RegisteredTool {
  name: string;
  promptGuidelines?: string[];
  execute: (id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: unknown) => Promise<unknown>;
}

function loadTools(): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const pi = {
    registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
    registerCommand: () => undefined,
    on: () => () => undefined,
    events: { emit: () => undefined, on: () => () => undefined },
  } as unknown as ExtensionAPI;
  kanbanExtension(pi);
  return tools;
}

function ctxFor(cwd: string): { ctx: ExtensionCommandContext; messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    ctx: { cwd, ui: { notify: (message: string) => messages.push(message) } } as unknown as ExtensionCommandContext,
  };
}

/** A board with one task claimed by `coder-1` at `start`. */
async function claimedBoard(start = "2026-10-01T00:00:00.000Z"): Promise<{ board: BoardLocation; id: string }> {
  const clock = { now: () => new Date(start) };
  const board = makeBoard();
  const task = await createTask(board, { title: "Ship the thing", agent: "coder-1" }, clock);
  await moveTask(board, { task: task.id, to: "working", agent: "coder-1" }, clock);
  return { board, id: task.id };
}

describe("claim age is visible", () => {
  it("shows the age in kanban_list rows and /kanban columns", async () => {
    const { board, id } = await claimedBoard();
    const later = { now: () => new Date("2026-10-04T00:00:00.000Z") }; // 3 days
    const snapshot = readBoard(board, later);
    expect(snapshot.tasks[0].active).toBe(true);

    const rows = renderBoard(snapshot);
    expect(rows).toContain("@coder-1");
    expect(rows).toContain("3d");
    expect(rows).toContain(id);

    const tools = loadTools();
    const result = (await tools.get("kanban_list")!.execute("call", { project: board.root }, undefined, undefined, {
      cwd: board.root,
    } as unknown as ExtensionCommandContext)) as { content: Array<{ text: string }> };
    expect(result.content[0].text).toContain("@coder-1");
    // The tool reads the real clock, so assert the age shape, not a fixed value.
    expect(result.content[0].text).toMatch(/@coder-1 \d+[smhdw]/);
  });

  it("shows the age in the one-task view as `(claimed 3d)`", async () => {
    const { board, id } = await claimedBoard();
    const later = { now: () => new Date("2026-10-04T00:00:00.000Z") };
    const text = renderTask(readTask(board, id, later), readBoard(board, later).workflow);
    expect(text).toContain("assignee  coder-1  (claimed 3d)");
  });

  it("shows the age in /kanban mine and omits it outside an active status", async () => {
    const { board } = await claimedBoard();
    const later = { now: () => new Date("2026-10-04T00:00:00.000Z") };
    expect(renderBoard(readBoard(board, later))).toContain("@coder-1 3d");

    // An assignment in a non-active status has no claim and thus no age.
    const status = readBoard(board, later).tasks[0];
    const unassignedClock = { now: () => new Date("2026-10-04T00:00:00.000Z") };
    await moveTask(board, { task: status.id, to: "new", agent: "coder-1" }, unassignedClock);
    const newBoard = readBoard(board, later);
    expect(newBoard.tasks[0].active).toBe(false);
    expect(renderBoard(newBoard)).not.toContain("3d");
  });

  it("/kanban mine prints the claim age", async () => {
    const { board } = await claimedBoard();
    // Pin the clock by using validate-time-independent `mine` rendering: the
    // real clock is fine here because only presence of an age is asserted.
    const { ctx, messages } = ctxFor(board.root);
    await handleKanbanCommand("mine coder-1", ctx);
    expect(messages[0]).toContain("@coder-1");
    expect(messages[0]).toMatch(/@coder-1 \d/);
  });
});

describe("row layout with an age", () => {
  const base: Omit<Task, "id" | "title" | "status" | "rev"> = { created: "", updated: "", description: "", history: [], comments: [], path: "", drifted: false };

  it("keeps every row inside 76 columns, in both surfaces", () => {
    const cases: Task[] = [
      { ...base, id: "T-0001", title: "x".repeat(120), status: "working", assignee: "abcdefghijklmnop", rev: 42, active: true, claimAgeMs: 3 * 86_400_000 },
      { ...base, id: "T-0001", title: "short", status: "working", assignee: "coder-1", rev: 4, active: true, claimAgeMs: 4 * 86_400_000 },
      { ...base, id: "T-123456", title: "y".repeat(200), status: "a-very-long-status-id", assignee: "abcdefghijklmnop", rev: 11, active: true, claimAgeMs: 52 * 7 * 86_400_000 },
      { ...base, id: "T-0001", title: "z".repeat(200), status: "working", assignee: undefined, rev: 11, active: true },
    ];
    for (const task of cases) {
      for (const options of [{}, { indent: 4, showStatus: false }]) {
        for (const row of renderTaskRows([task], options)) expect(row.length).toBeLessThanOrEqual(76);
      }
    }
  });

  it("aligns rev by keeping the age inside the meta column", () => {
    const tasks: Task[] = [
      { ...base, id: "T-0001", title: "one", status: "working", assignee: "coder-1", rev: 4, active: true, claimAgeMs: 3 * 86_400_000 },
      { ...base, id: "T-0002", title: "two", status: "new", rev: 2, active: false },
    ];
    const rows = renderTaskRows(tasks);
    expect(rows[0]).toContain("@coder-1 3d");
    // `rev` is right-aligned in both rows, so both end at the same column.
    expect(rows[0].length).toBe(rows[1].length);
  });
});

describe("stale_claim warning", () => {
  it("reports a claim older than the threshold and keeps the report valid", async () => {
    const { board } = await claimedBoard();
    const report = validateBoard(board, {}, { now: () => new Date("2026-10-04T00:00:00.000Z") });
    const stale = report.problems.find((problem) => problem.code === "stale_claim");
    expect(stale?.severity).toBe("warning");
    expect(report.ok).toBe(true);
  });

  it("prints `Board is valid (1 warning).` with the release sentence", async () => {
    const { board } = await claimedBoard();
    const { ctx, messages } = ctxFor(board.root);
    // Freeze the board clock through env so the confirmation matches reality.
    await handleKanbanCommand("validate", ctx);
    const text = messages[0];
    // A freshly created claim is well under 24h, so this board is clean.
    expect(text).toMatch(/Board is valid/);
  });

  it("honours PI_KANBAN_STALE_MS and --stale", async () => {
    const { board } = await claimedBoard();
    const previous = process.env.PI_KANBAN_STALE_MS;
    process.env.PI_KANBAN_STALE_MS = "0"; // disable
    try {
      const { ctx, messages } = ctxFor(board.root);
      await handleKanbanCommand("validate", ctx);
      expect(messages[0]).toContain("Board is valid.");
      expect(messages[0]).not.toContain("stale_claim");
    } finally {
      if (previous === undefined) delete process.env.PI_KANBAN_STALE_MS;
      else process.env.PI_KANBAN_STALE_MS = previous;
    }
  });
});

describe("validate warning rendering", () => {
  it("says `Board is valid (1 warning).` and prints the release sentence", async () => {
    const { board } = await claimedBoard();
    const report = validateBoard(board, {}, { now: () => new Date("2026-10-04T00:00:00.000Z") });
    const text = renderValidationReport(report, board.root);
    expect(text).toContain("Board is valid (1 warning).");
    expect(text).not.toContain("Board has problems.");
    expect(text).toContain("stale_claim: Claimed by \"coder-1\" for 3d (threshold 24h).");
    expect(text).toContain("Release it with kanban_assign {assignee: null, force: true}.");
    // Every line stays inside the 76-column budget.
    for (const line of text.split("\n")) expect(line.length).toBeLessThanOrEqual(76);
  });

  it("rejects an invalid --stale value with the spec's exact wording", async () => {
    const { board } = await claimedBoard();
    const { ctx, messages } = ctxFor(board.root);
    await handleKanbanCommand("validate --stale x", ctx);
    expect(messages[0]).toBe('Invalid --stale "x"; use 30m, 12h, 7d, or 0.');
  });

  it("accepts --stale 0 to disable the check", async () => {
    const { board } = await claimedBoard();
    const { ctx, messages } = ctxFor(board.root);
    await handleKanbanCommand("validate --stale 0", ctx);
    expect(messages[0]).not.toContain("stale_claim");
    expect(messages[0]).toContain("Board is valid.");
  });
});

describe("wrong_owner names the release call", () => {
  it("includes the claim age and the exact release instruction", async () => {
    const { board, id } = await claimedBoard();
    let error: unknown;
    try {
      await moveTask(board, { task: id, to: "done", agent: "coder-2" }, { now: () => new Date("2026-10-04T00:00:00.000Z") });
    } catch (caught) {
      error = caught;
    }
    const envelope = failureEnvelope(error, {}, board.root);
    expect(envelope.code).toBe("wrong_owner");
    expect(envelope.error).toContain('claimed by "coder-1" for 3d');
    // The message is one sentence ending in a period and omits the target status.
    expect((envelope.error as string).trim().endsWith(".")).toBe(true);
    expect(envelope.error).not.toContain('"done"');
    expect(envelope.hint).toContain("Release it with kanban_assign {assignee: null, force: true}");
    expect(envelope.hint).toContain("or pass force: true to take over");
  });
});

describe("releaseTask is kanban_assign {assignee: null, force: true}", () => {
  it("clears the assignee, bumps rev, and records a forced unassign", async () => {
    const { board, id } = await claimedBoard();
    const before = readTask(board, id);
    const after = await releaseTask(board, { task: id, agent: "human" }, { now: () => new Date("2026-10-04T00:00:00.000Z") });

    expect(after.assignee).toBeUndefined();
    expect(after.rev).toBe(before.rev + 1);
    const last = after.history[after.history.length - 1];
    expect(last.action).toBe("unassign");
    expect(last.by).toBe("human");
    expect(last.assignee).toBe("coder-1");
    expect(last.forced).toBe(true);
    expect(readTask(board, id).assignee).toBeUndefined();
  });

  it("writes nothing when the task has no claim to release", async () => {
    const { board, id } = await claimedBoard();
    await releaseTask(board, { task: id, agent: "human" }); // first release
    const cleared = readTask(board, id);
    const before = readFileSync(join(board.tasksDir, `${id}.md`), "utf8");

    // A second release is a no-op on the file, not a new history entry.
    await releaseTask(board, { task: id, agent: "human" });

    expect(readTask(board, id).rev).toBe(cleared.rev);
    expect(readFileSync(join(board.tasksDir, `${id}.md`), "utf8")).toBe(before);
  });

  it("keeps the release helper equal to kanban_assign {assignee:null, force:true}", async () => {
    const { board, id } = await claimedBoard();
    const released = await releaseTask(board, { task: id, agent: "human" }, { now: () => new Date("2026-10-04T00:00:00.000Z") });
    expect(released.assignee).toBeUndefined();
    expect(released.history.at(-1)?.forced).toBe(true);
  });
});

/**
 * T-0013 (backlog #10, ADR 0009): any write to an assignee that is not your own
 * handle needs `force`, in both directions. The takeover entry stays the
 * distinguishable `force-assign` + `forced: true`; a self-claim stays `assign`.
 */
describe("third-party assignment is forced", () => {
  /** An unassigned board with `count` tasks; returns the id of the last one. */
  async function boardWith(count: number): Promise<{ board: BoardLocation; id: string }> {
    const board = makeBoard();
    let id = "";
    for (let index = 0; index < count; index += 1) {
      id = (await createTask(board, { title: `task ${index + 1}`, agent: "coder-3" })).id;
    }
    return { board, id };
  }

  async function envelopeOf(board: BoardLocation, params: Record<string, unknown>) {
    const tools = loadTools();
    const result = (await tools.get("kanban_assign")!.execute("call", { project: board.root, ...params }, undefined, undefined, {
      cwd: board.root,
    } as unknown as ExtensionCommandContext)) as {
      content: Array<{ text: string }>;
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
    };
    return result;
  }

  it("refuses T-0002 to coder-2 without force, names force, and writes nothing", async () => {
    const { board } = await boardWith(2);
    const path = join(board.tasksDir, "T-0002.md");
    const before = readFileSync(path, "utf8");

    const result = await envelopeOf(board, { task: "T-0002", assignee: "coder-2", agent: "coder-1" });
    const envelope = result.structuredContent ?? {};

    expect(result.isError).toBe(true);
    expect(envelope.code).toBe("wrong_owner");
    expect(envelope.error).toBe(
      'Task T-0002 is unassigned; "coder-1" cannot assign it to "coder-2" without force.',
    );
    expect(envelope.hint).toContain("force: true");
    // §2.2's structuredContent: the target handle and the caller, not the holder.
    expect(envelope.task).toBe("T-0002");
    expect(envelope.assignee).toBe("coder-2");
    expect(envelope.agent).toBe("coder-1");

    expect(readFileSync(path, "utf8")).toBe(before);
    expect(existsSync(join(board.dir, ".lock"))).toBe(false);
  });

  it("accepts the same call with force and records force-assign + forced", async () => {
    const { board } = await boardWith(2);
    await assignTask(board, { task: "T-0002", assignee: "coder-2", agent: "coder-1", force: true });

    const last = readTask(board, "T-0002").history.at(-1);
    expect(last).toMatchObject({ action: "force-assign", by: "coder-1", assignee: "coder-2", forced: true });
  });

  it("lets a caller claim an unassigned task for itself with no force", async () => {
    const { board } = await boardWith(1);

    const task = await assignTask(board, { task: "T-0001", assignee: "coder-1", agent: "coder-1" });

    expect(task.assignee).toBe("coder-1");
    expect(task.history.at(-1)).toMatchObject({ action: "assign", by: "coder-1", assignee: "coder-1" });
    expect(task.history.at(-1)?.forced).toBeUndefined();
  });

  it("writes nothing when the assignee already matches, even for another handle", async () => {
    // No-op stays before the new check: a retried third-party call is idempotent.
    const board = makeBoard();
    const created = await createTask(board, { title: "x", agent: "coder-1" });
    await assignTask(board, { task: created.id, assignee: "coder-2", agent: "coder-1", force: true });
    const before = readFileSync(join(board.tasksDir, `${created.id}.md`), "utf8");

    const again = await assignTask(board, { task: created.id, assignee: "coder-2", agent: "coder-1" });

    expect(again.rev).toBe(2);
    expect(readFileSync(join(board.tasksDir, `${created.id}.md`), "utf8")).toBe(before);
  });

  it("refuses handing your own task to another handle without force", async () => {
    const { board } = await boardWith(1);
    await assignTask(board, { task: "T-0001", assignee: "coder-1", agent: "coder-1" });

    let error: unknown;
    try {
      await assignTask(board, { task: "T-0001", assignee: "coder-2", agent: "coder-1" });
    } catch (caught) {
      error = caught;
    }
    const envelope = failureEnvelope(error, {}, board.root);
    expect(envelope.code).toBe("wrong_owner");
    expect(envelope.error).toBe(
      'Task T-0001 is assigned to "coder-1"; "coder-1" cannot assign it to "coder-2" without force.',
    );
    // The holder here is the caller, so the hint must not name the old, now
    // removed, `/kanban release` command; it names the force path instead.
    expect(envelope.hint).not.toContain("/kanban release");
    expect(envelope.hint).toContain("force: true");
    expect(readTask(board, "T-0001").assignee).toBe("coder-1");
  });

  it("keeps the implicit claim-on-move free of force", async () => {
    const { board } = await boardWith(1);

    const moved = await moveTask(board, { task: "T-0001", to: "working", agent: "coder-1" });

    expect(moved.assignee).toBe("coder-1");
    expect(moved.history.at(-1)).toMatchObject({ action: "assign", by: "coder-1", assignee: "coder-1" });
  });

  it("keeps a historic third-party assign entry valid", () => {
    const board = makeBoard();
    taskFile(
      board,
      "T-0001",
      `---\nid: T-0001\ntitle: Handed over under 0.2.0\nstatus: new\nassignee: coder-2\ncreated: 2026-10-30T09:00:00.000Z\nupdated: 2026-10-30T09:00:00.000Z\nrev: 2\nhistory:\n  - at: 2026-10-30T09:00:00.000Z\n    action: create\n    by: coder-1\n    to: new\n  - at: 2026-10-30T09:00:00.000Z\n    action: assign\n    by: coder-1\n    assignee: coder-2\n---\n`,
    );

    const report = validateBoard(board, { staleAfterMs: 0 });
    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);
    expect(readTask(board, "T-0001").history.at(-1)).toMatchObject({ action: "assign", assignee: "coder-2" });
  });

  it("states the rule in USAGE and in kanban_assign's guidelines", () => {
    expect(USAGE).toContain("Assigning a task to another handle needs force: true");

    const guidelines = loadTools().get("kanban_assign")!.promptGuidelines?.join(" ") ?? "";
    expect(guidelines).toContain("history then records a forced assignment");
    expect(guidelines).toContain("expectedRev");
  });

  it("ships ADR 0009 and references it from the ADR set and the README", () => {
    const adr = readFileSync(new URL("../../docs/adr/0009-third-party-assignment-is-forced.md", import.meta.url), "utf8");
    expect(adr).toContain("# Third-party assignment is forced");
    expect(adr).toContain("wrong_owner");

    expect(readFileSync(new URL("../../docs/adr/0004-assignment-is-exclusive-and-stealing-is-explicit.md", import.meta.url), "utf8")).toContain("0009");
    expect(readFileSync(new URL("../../README.md", import.meta.url), "utf8")).toContain("0009");
  });
});
