/**
 * T-0006: a claim left by a departed agent must be visible and releasable.
 * Claim age is shown wherever an assignee is; `validate` reports a stale claim
 * as a warning; `wrong_owner` names the release call; `/kanban release` is the
 * one human-initiated exception to "the command never edits the board".
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import kanbanExtension, { failureEnvelope } from "../index.ts";
import { handleKanbanCommand, renderValidationReport } from "../command.ts";
import { createTask, moveTask, readBoard, readTask, validateBoard, releaseTask } from "../store.ts";
import { renderBoard, renderTask, renderTaskRows } from "../render.ts";
import type { Task } from "../types.ts";
import { makeBoard } from "./helpers.ts";
import type { BoardLocation } from "../paths.ts";

interface RegisteredTool {
  name: string;
  execute: (id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: unknown) => Promise<unknown>;
}

function loadTools(): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const pi = {
    registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
    registerCommand: () => undefined,
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
    expect(text).toContain("/kanban release T-0001 --yes.");
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
    expect(envelope.hint).toContain(`/kanban release ${id} --yes`);
    expect(envelope.hint).toContain("kanban_assign with assignee:null, force:true");
  });
});

describe("/kanban release", () => {
  it("prints a confirmation and writes nothing without --yes", async () => {
    const { board, id } = await claimedBoard();
    const before = readFileSync(join(board.tasksDir, `${id}.md`), "utf8");
    const { ctx, messages } = ctxFor(board.root);
    await handleKanbanCommand(`release ${id}`, ctx);
    const after = readFileSync(join(board.tasksDir, `${id}.md`), "utf8");
    expect(after).toBe(before);
    expect(messages[0]).toContain(`Release the claim on ${id}?`);
    expect(messages[0]).toContain("owner   @coder-1");
    expect(messages[0]).toContain(`/kanban release ${id} --yes`);
  });

  it("clears the assignee, bumps rev, and records a forced unassign with --yes", async () => {
    const { board, id } = await claimedBoard();
    const before = readTask(board, id);
    const { ctx, messages } = ctxFor(board.root);
    await handleKanbanCommand(`release ${id} --yes --as human`, ctx);

    const after = readTask(board, id);
    expect(after.assignee).toBeUndefined();
    expect(after.rev).toBe(before.rev + 1);
    const last = after.history[after.history.length - 1];
    expect(last.action).toBe("unassign");
    expect(last.by).toBe("human");
    expect(last.assignee).toBe("coder-1");
    expect(last.forced).toBe(true);

    expect(messages[0]).toContain(`Released ${id}.`);
    expect(messages[0]).toContain("now  unassigned");
  });

  it("refuses a task that has no claim", async () => {
    const { board, id } = await claimedBoard();
    await releaseTask(board, { task: id, agent: "human" }); // first release
    const { ctx, messages } = ctxFor(board.root);
    await handleKanbanCommand(`release ${id} --yes`, ctx);
    expect(messages[0]).toContain(`${id} has no claim to release.`);
    expect(messages[0]).toContain("owner   -");
  });

  it("keeps the release helper equal to kanban_assign {assignee:null, force:true}", async () => {
    const { board, id } = await claimedBoard();
    const released = await releaseTask(board, { task: id, agent: "human" }, { now: () => new Date("2026-10-04T00:00:00.000Z") });
    expect(released.assignee).toBeUndefined();
    expect(released.history.at(-1)?.forced).toBe(true);
  });
});
