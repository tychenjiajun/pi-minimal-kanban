/**
 * Independent v0.2 acceptance suite (T-0003..T-0007).
 *
 * Written from the outside: the tests drive the real `kanban_*` tools, the
 * exported store functions, and the `/kanban` command against throwaway boards.
 * They are deliberately adversarial rather than a re-run of the unit tests:
 * empty boards, 137-task boards, garbage task files, backdated claims, release
 * refusals, terminal/rev edge cases, and a concurrent claim race.
 *
 * Release criteria: docs/product/v0.2-scope.md.
 * Scenarios: docs/product/design-v0.2.md.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import kanbanExtension from "../index.ts";
import { handleKanbanCommand } from "../command.ts";
import { assignTask, createTask, moveTask, readTask, releaseTask, validateBoard } from "../store.ts";
import { KanbanError } from "../errors.ts";
import { LINEAR_WORKFLOW, makeBoard, newestChangelogVersion, SEMVER, taskFile, versionsAgree } from "./helpers.ts";
import type { BoardLocation } from "../paths.ts";

// ─── Harness ────────────────────────────────────────────────────────────────

interface RegisteredTool {
  name: string;
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

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

async function call(
  tools: Map<string, RegisteredTool>,
  name: string,
  params: Record<string, unknown>,
  cwd: string,
): Promise<ToolResult> {
  return (await tools.get(name)!.execute("call", params, undefined, undefined, {
    cwd,
    ui: { notify: () => undefined },
  } as unknown as ExtensionCommandContext)) as ToolResult;
}

function ctxFor(cwd: string): { ctx: ExtensionCommandContext; messages: string[] } {
  const messages: string[] = [];
  const ctx = {
    cwd,
    ui: { notify: (message: string) => messages.push(message) },
  } as unknown as ExtensionCommandContext;
  return { ctx, messages };
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await errorOf(promise);
  return error instanceof KanbanError ? error.details.code : "resolved";
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;

/** Write one valid task file directly, optionally with a live claim. */
function writeTaskFile(
  board: BoardLocation,
  id: string,
  status: string,
  options: { assignee?: string; claimAt?: string } = {},
): void {
  const at = options.claimAt ?? "2026-10-30T00:00:00.000Z";
  const lines = ["---", `id: ${id}`, `title: Task ${Number(id.slice(2))}`, `status: ${status}`];
  if (options.assignee) lines.push(`assignee: ${options.assignee}`);
  lines.push(`created: ${at}`, `updated: ${at}`, "rev: 3", "history:");
  lines.push(`  - at: ${at}`, "    action: create", "    by: tester", "    to: new");
  if (options.assignee) {
    lines.push(`  - at: ${at}`, "    action: move", `    by: ${options.assignee}`, "    from: new", `    to: ${status}`);
    lines.push(`  - at: ${at}`, "    action: assign", `    by: ${options.assignee}`, `    assignee: ${options.assignee}`);
  }
  lines.push("---", "");
  taskFile(board, id, lines.join("\n"));
}

/** Seed `count` sequential tasks; optionally make one of them a live claim. */
function seedBoard(
  board: BoardLocation,
  count: number,
  claimed?: { index: number; status: string; assignee: string; claimAt: string },
): void {
  for (let index = 1; index <= count; index += 1) {
    const id = `T-${String(index).padStart(4, "0")}`;
    const live = claimed?.index === index ? claimed : undefined;
    writeTaskFile(board, id, live ? live.status : "new", live ? { assignee: live.assignee, claimAt: live.claimAt } : {});
  }
  writeFileSync(join(board.dir, "counter.json"), `${JSON.stringify({ next: count + 1 }, null, 2)}\n`, "utf8");
}

/** Rewrite every timestamp in a task file so its claim looks `msAgo` old. */
function backdateClaim(board: BoardLocation, id: string, msAgo: number): string {
  const at = new Date(Date.now() - msAgo).toISOString();
  const path = join(board.tasksDir, `${id}.md`);
  taskFile(board, id, readFileSync(path, "utf8").replace(ISO, at));
  return at;
}

// ─── T-0003: agent briefing ─────────────────────────────────────────────────

describe("T-0003: a fresh agent learns the rules from one kanban_list", () => {
  it("names the initial status, active statuses, and force rule on an empty board", async () => {
    const board = makeBoard();
    const tools = loadTools();

    const result = await call(tools, "kanban_list", { project: board.root }, board.root);
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;

    // The literal briefing strings from design-v0.2.md §1.
    expect(text).toContain("initial: new");
    expect(text).toContain("  active  ◆ working");
    expect(text).toContain("  other  ◇ new  ◇ done (terminal)");
    expect(text).toContain("Moving a task into an active status claims it for your handle; only the");
    expect(text).toContain("holder can move or release it. force: true is a deliberate takeover,");
    expect(text).toContain("There are no leases: a claim never expires until someone releases it.");
    expect(text).toContain("Handles are self-asserted, like coder-1. The board does not verify them.");
    expect(text).toContain("kanban_create {title, agent} adds a task in the initial status.");
    expect(text).not.toContain("No matching tasks.");

    // structuredContent carries the same briefing and the workflow it came from.
    const structured = result.structuredContent as {
      briefing?: string;
      workflow?: { initial?: string; statuses?: Array<{ id: string; active: boolean }> };
    };
    expect(structured.briefing).toBe(text);
    expect(structured.workflow?.initial).toBe("new");
    expect(structured.workflow?.statuses?.filter((status) => status.active).map((status) => status.id)).toEqual([
      "working",
    ]);
  });
});

// ─── T-0004: bounded listing ────────────────────────────────────────────────

describe("T-0004: kanban_list bounds a 137-task board", () => {
  it("prints exactly 50 rows plus the 87-row continuation, then rows 51-100 at offset 50", async () => {
    const board = makeBoard();
    seedBoard(board, 137);
    const tools = loadTools();

    const first = await call(tools, "kanban_list", { project: board.root }, board.root);
    const firstText = first.content[0].text;
    const firstRows = firstText.split("\n").filter((line) => /^T-\d{4}\s/.test(line));
    expect(firstRows).toHaveLength(50);
    expect(firstRows[0]).toContain("T-0001");
    expect(firstRows.at(-1)).toContain("T-0050");
    expect(firstText).toContain("... 87 more tasks (of 137). Next: offset 50, or narrow the filters.");
    const firstPage = first.structuredContent as {
      total: number;
      offset: number;
      limit: number;
      returned: number;
      hasMore: boolean;
    };
    expect(firstPage).toMatchObject({ total: 137, offset: 0, limit: 50, returned: 50, hasMore: true });

    const second = await call(tools, "kanban_list", { project: board.root, offset: 50 }, board.root);
    const secondText = second.content[0].text;
    const secondRows = secondText.split("\n").filter((line) => /^T-\d{4}\s/.test(line));
    expect(secondRows).toHaveLength(50);
    expect(secondRows[0]).toContain("T-0051");
    expect(secondRows.at(-1)).toContain("T-0100");
    expect(secondText).toContain("showing 51-100 of 137 (offset 50, limit 50)");
    expect(secondText).toContain("... 37 more tasks (of 137). Next: offset 100, or narrow the filters.");
    const secondPage = second.structuredContent as {
      total: number;
      offset: number;
      limit: number;
      returned: number;
      hasMore: boolean;
    };
    expect(secondPage).toMatchObject({ total: 137, offset: 50, limit: 50, returned: 50, hasMore: true });
  });
});

// ─── T-0005: unreadable task files ──────────────────────────────────────────

describe("T-0005: one malformed task file must not blank the board", () => {
  it("lists readable tasks, names the broken file, reports unreadable_task, and fails a direct read", async () => {
    const board = makeBoard();
    writeTaskFile(board, "T-0001", "new");
    taskFile(board, "T-0002", "this is garbage, not a kanban task file\n");
    writeFileSync(join(board.dir, "counter.json"), `${JSON.stringify({ next: 3 }, null, 2)}\n`, "utf8");
    const tools = loadTools();

    const listed = await call(tools, "kanban_list", { project: board.root }, board.root);
    const text = listed.content[0].text;
    expect(listed.isError).toBeFalsy();
    expect(text).toMatch(/^T-0001\s/m);
    expect(text).not.toMatch(/^T-0002\s/m); // listed only as a warning, never as a row
    expect(text).toContain("1 task file could not be read; the board shows the rest.");
    expect(text).toContain("T-0002.md");

    const structured = listed.structuredContent as {
      tasks: Array<{ id: string }>;
      fileErrors: Array<{ path: string; message: string }>;
    };
    expect(structured.tasks.map((task) => task.id)).toEqual(["T-0001"]);
    expect(structured.fileErrors).toHaveLength(1);
    expect(structured.fileErrors[0].path.endsWith("T-0002.md")).toBe(true);

    const report = validateBoard(board);
    const problem = report.problems.find((entry) => entry.task === "T-0002");
    expect(problem?.code).toBe("unreadable_task");
    expect(problem?.path?.endsWith("T-0002.md")).toBe(true);
    expect(report.ok).toBe(false);

    const { ctx, messages } = ctxFor(board.root);
    await handleKanbanCommand("validate", ctx);
    expect(messages[0]).toContain("unreadable_task");
    expect(messages[0]).toContain("T-0002");

    expect(() => readTask(board, "T-0002")).toThrow(/frontmatter/);
    const direct = await call(tools, "kanban_list", { task: "T-0002", project: board.root }, board.root);
    expect(direct.isError).toBe(true);
    expect(direct.structuredContent?.code).toBe("invalid_task");
    expect(String(direct.structuredContent?.error)).toMatch(/T-0002/);
    expect(direct.content[0].text).toContain("Error [invalid_task]");
  });
});

// ─── T-0006: stale claims and release ───────────────────────────────────────

describe("T-0006: stale claims are visible and releasable", () => {
  it("warns stale_claim for a >24h claim, keeps the report valid, and releases it via kanban_assign", async () => {
    const board = makeBoard();
    const task = await createTask(board, { title: "Abandoned work", agent: "coder-1" });
    await moveTask(board, { task: task.id, to: "working", agent: "coder-1" });
    // Build the stale claim by rewriting the file's history timestamps.
    backdateClaim(board, task.id, 3 * 86_400_000);

    const report = validateBoard(board);
    const stale = report.problems.find((problem) => problem.code === "stale_claim");
    expect(stale?.severity).toBe("warning");
    expect(stale?.message).toContain('Claimed by "coder-1" for 3d');
    expect(stale?.message).toContain("Release it with kanban_assign {assignee: null, force: true}.");
    expect(stale?.message).not.toContain("/kanban release");
    expect(report.ok).toBe(true);

    const { ctx, messages } = ctxFor(board.root);
    await handleKanbanCommand("validate", ctx);
    expect(messages[0]).toContain("stale_claim");
    expect(messages[0]).toContain("Board is valid (1 warning).");
    expect(messages[0]).not.toContain("Board has problems.");

    const before = readTask(board, task.id);
    expect(before.assignee).toBe("coder-1");

    // `/kanban` is read-only: the release is the store call the hint names.
    const after = await releaseTask(board, { task: task.id, agent: "human" });
    expect(after.assignee).toBeUndefined();
    expect(after.rev).toBe(before.rev + 1);
    const last = after.history.at(-1);
    expect(last?.action).toBe("unassign");
    expect(last?.forced).toBe(true);
    expect(last?.by).toBe("human");
  });

  it("treats /kanban release as an unknown task id and writes nothing", async () => {
    const board = makeBoard();
    const unclaimed = await createTask(board, { title: "Nobody owns me", agent: "coder-1" });
    const unclaimedPath = join(board.tasksDir, `${unclaimed.id}.md`);
    const unclaimedBefore = readFileSync(unclaimedPath, "utf8");

    for (const input of [`release ${unclaimed.id}`, `release ${unclaimed.id} --yes`]) {
      const { ctx, messages } = ctxFor(board.root);
      await handleKanbanCommand(input, ctx);
      // The subcommand is gone, so `release` parses as a task id and is rejected.
      expect(messages[0]).toBe('Invalid task id "release".\n\nUse the form T-0001.');
    }
    expect(readFileSync(unclaimedPath, "utf8")).toBe(unclaimedBefore);

    // A terminal task is unassigned on entry, so a release is a no-op anyway.
    const terminal = await createTask(board, { title: "Finished work", agent: "coder-1" });
    await moveTask(board, { task: terminal.id, to: "working", agent: "coder-1" });
    await moveTask(board, { task: terminal.id, to: "done", agent: "coder-1" });
    const terminalPath = join(board.tasksDir, `${terminal.id}.md`);
    const terminalBefore = readFileSync(terminalPath, "utf8");
    const cleared = readTask(board, terminal.id);

    await releaseTask(board, { task: terminal.id, agent: "human" });

    expect(readTask(board, terminal.id).assignee).toBeUndefined();
    expect(readTask(board, terminal.id).rev).toBe(cleared.rev);
    expect(readFileSync(terminalPath, "utf8")).toBe(terminalBefore);
  });
});

// ─── T-0007: claim and rev correctness ──────────────────────────────────────

const RACE_WORKFLOW = `name: race
initial: new
statuses:
  - id: new
  - id: working
    active: true
  - id: reviewing
    active: true
  - id: done
    terminal: true
transitions:
  new: [working, reviewing]
  working: [new, reviewing]
  reviewing: [new, working]
`;

type MoveOutcome = Awaited<ReturnType<typeof moveTask>>;

describe("T-0007: claim and rev correctness", () => {
  it("names the claim age and the exact release call in wrong_owner", async () => {
    const board = makeBoard();
    const task = await createTask(board, { title: "Owned work", agent: "coder-1" });
    await moveTask(board, { task: task.id, to: "working", agent: "coder-1" });
    backdateClaim(board, task.id, 3 * 86_400_000);

    // A second handle tries to move the claimed task out of an active status.
    const error = await errorOf(moveTask(board, { task: task.id, to: "done", agent: "coder-2" }));
    expect(error).toBeInstanceOf(KanbanError);
    const kanban = error as KanbanError;
    expect(kanban.details.code).toBe("wrong_owner");
    expect(kanban.message).toContain('claimed by "coder-1" for 3d');
    expect(kanban.details.hint).toContain("Release it with kanban_assign {assignee: null, force: true}");
    expect(kanban.details.hint).not.toContain("/kanban release");
  });

  it("refuses to assign a terminal task and clears the assignee when entering a terminal status", async () => {
    const board = makeBoard();
    const task = await createTask(board, { title: "Terminal work", agent: "coder-1" });
    await moveTask(board, { task: task.id, to: "working", agent: "coder-1" });
    expect(readTask(board, task.id).assignee).toBe("coder-1");

    const done = await moveTask(board, { task: task.id, to: "done", agent: "coder-1" });
    expect(done.status).toBe("done");
    expect(done.assignee).toBeUndefined();
    expect(done.history.at(-1)?.action).toBe("unassign");

    const code = await codeOf(assignTask(board, { task: task.id, assignee: "coder-2", agent: "coder-2" }));
    expect(code).toBe("terminal_task");
  });

  it("fails an expectedRev mismatch with the observed and expected rev", async () => {
    const board = makeBoard();
    const task = await createTask(board, { title: "Revved work", agent: "coder-1" });
    const expectedRev = task.rev + 10;

    const error = await errorOf(moveTask(board, { task: task.id, to: "working", agent: "coder-1", expectedRev }));
    expect(error).toBeInstanceOf(KanbanError);
    const kanban = error as KanbanError;
    expect(kanban.details.code).toBe("stale");
    expect(kanban.message).toContain(`rev ${task.rev}`);
    expect(kanban.message).toContain(`expected rev ${expectedRev}`);
    expect(kanban.details.rev).toBe(task.rev);
    expect(kanban.details.expectedRev).toBe(expectedRev);
  });

  it("lets exactly one handle win a claim race; the loser gets wrong_owner", async () => {
    const board = makeBoard(RACE_WORKFLOW);
    const task = await createTask(board, { title: "Contested work", agent: "seed" });

    // Both handles race to claim the same unclaimed task by moving it into an
    // active status. The board lock serialises them; exactly one must win.
    const results = await Promise.all([
      moveTask(board, { task: task.id, to: "working", agent: "alpha" }).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
      moveTask(board, { task: task.id, to: "reviewing", agent: "beta" }).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
    ]);

    const winners = results.filter((result) => result.ok);
    const losers = results.filter((result) => !result.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    const loserError = losers[0].error;
    expect(loserError).toBeInstanceOf(KanbanError);
    const loser = loserError as KanbanError;
    expect(loser.details.code).toBe("wrong_owner");
    expect(loser.details.hint).toContain("Release it with kanban_assign {assignee: null, force: true}");

    const winner = winners[0].value as MoveOutcome;
    const after = readTask(board, task.id);
    expect(after.status).toBe(winner.status);
    expect(after.assignee).toBe(winner.assignee);
    expect(after.history.filter((entry) => entry.action === "assign")).toHaveLength(1);
  });

  it("reports already_in_status, not wrong_owner, when both racers target the same status", async () => {
    // Spec ambiguity: the release brief says the race loser should get
    // `wrong_owner`. When both handles target the *same* status, moveTask
    // checks "already in target status" before the claim check and reports
    // `already_in_status`. The existing cross-process concurrency test accepts
    // either code; both outcomes still leave exactly one claim. A loser that
    // targets a different status gets `wrong_owner` (previous test).
    const board = makeBoard();
    const task = await createTask(board, { title: "Same target", agent: "seed" });

    const results = await Promise.all([
      moveTask(board, { task: task.id, to: "working", agent: "alpha" }).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
      moveTask(board, { task: task.id, to: "working", agent: "beta" }).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    const loser = (results.find((result) => !result.ok) as { error: unknown }).error;
    expect(loser).toBeInstanceOf(KanbanError);
    expect(["wrong_owner", "already_in_status"]).toContain((loser as KanbanError).details.code);

    const after = readTask(board, task.id);
    expect(after.status).toBe("working");
    expect(after.history.filter((entry) => entry.action === "assign")).toHaveLength(1);
  });
});

// ─── Release criteria: packaged version ──────────────────────────────────────

describe("release criteria: packaged version", () => {
  // Release rule: the packaged version tracks the newest CHANGELOG release and is
  // well-formed semver (docs/product/v0.3-scope.md). Asserting that invariant,
  // rather than one release's literal, keeps this green on every future bump.
  it("matches the newest CHANGELOG release", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    const changelog = readFileSync(new URL("../../CHANGELOG.md", import.meta.url), "utf8");
    const newest = newestChangelogVersion(changelog);

    expect(newest).toBeDefined();
    expect(packageJson.version).toMatch(SEMVER);
    expect(versionsAgree(packageJson.version, changelog)).toBe(true);
  });

  it("flags a packaged version that drifts from the newest CHANGELOG release", () => {
    // The comparison is fed disagreeing fixtures; the real files are never touched.
    expect(versionsAgree("1.0.0", "## 0.9.9")).toBe(false);
    expect(versionsAgree("1.0.0", "## 1.0.0")).toBe(true);
  });
});

// ─── Cross-cutting: the human board on a large project ──────────────────────

describe("cross-cutting: /kanban renders a large board and its claim ages", () => {
  it("renders a 120-task board without throwing and shows the age in the active column", async () => {
    const board = makeBoard();
    const claimAt = new Date(Date.now() - 3 * 86_400_000).toISOString();
    seedBoard(board, 120, { index: 1, status: "working", assignee: "coder-1", claimAt });

    const { ctx, messages } = ctxFor(board.root);
    await expect(handleKanbanCommand("", ctx)).resolves.toBeUndefined();

    const text = messages[0];
    expect(text).toContain("120 tasks");
    expect(text).toContain("◆ Working");
    expect(text).toContain("T-0001");
    // The age renders as `@coder-1 3d` inside the active column.
    expect(text).toMatch(/@coder-1 3d/);
  });
});
