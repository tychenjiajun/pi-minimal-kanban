/**
 * T-0012: a Forced assignment can say why it happened. `reason` lives on one
 * history entry per call, prints on its own `why` line, and a takeover without
 * one is a `unannotated_forced` warning that still leaves the board valid.
 *
 * Every assertion is a line from `docs/product/design-v0.3.md` §7 (T-0012).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { KanbanError } from "../errors.ts";
import { assignTask, createTask, readTask, releaseTask, validateBoard } from "../store.ts";
import { renderTask } from "../render.ts";
import { handleKanbanCommand, renderValidationReport } from "../command.ts";
import { makeBoard, fixedClock, taskFile } from "./helpers.ts";

/** The typed failure a call must produce, so tests can assert code and text. */
async function errorOf(promise: Promise<unknown>): Promise<KanbanError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof KanbanError) return error;
    throw error;
  }
  throw new Error("expected a KanbanError");
}

function ctxFor(cwd: string) {
  return { cwd, ui: { notify: () => undefined } } as unknown as ExtensionCommandContext;
}

/**
 * A board whose T-0001 is held by coder-3, so the caller's forced write is a
 * real takeover. The injected clock freezes every write at 10:05Z.
 */
async function takeoverBoard() {
  const board = makeBoard();
  const clock = fixedClock(["2026-10-30T09:00:00.000Z", "2026-10-30T10:05:00.000Z"]);
  const task = await createTask(board, { title: "Audit the takeover", agent: "coder-3" }, clock);
  await assignTask(board, { task: task.id, assignee: "coder-3", agent: "coder-3" }, clock);
  return { board, id: task.id, clock };
}

/** The pre-0.3 shape: `forced: true` and no `reason` key anywhere. */
const UNANNOTATED_FILE = `---
id: T-0005
title: Audit a takeover
status: working
assignee: coder-1
created: 2026-10-30T09:00:00.000Z
updated: 2026-10-30T10:05:00.000Z
rev: 3
history:
  - at: 2026-10-30T09:00:00.000Z
    action: create
    by: coder-3
    to: new
  - at: 2026-10-30T10:05:00.000Z
    action: force-assign
    by: coder-1
    assignee: coder-1
    forced: true
---
`;

const ANNOTATED_FILE = UNANNOTATED_FILE.replace(
  "    forced: true\n",
  "    forced: true\n    reason: owner idle 2d\n",
);

const HISTORY_BLOCK = /\nhistory:\n([\s\S]*?)\n---/;

describe("reason is recorded on exactly one entry", () => {
  it("writes a force-assign entry whose last key is reason, once", async () => {
    const { board, id, clock } = await takeoverBoard();

    await assignTask(
      board,
      { task: id, assignee: "coder-2", agent: "coder-1", force: true, reason: "owner idle 2d" },
      clock,
    );

    const entry = readTask(board, id).history.at(-1);
    expect(entry).toMatchObject({
      action: "force-assign",
      by: "coder-1",
      assignee: "coder-2",
      forced: true,
    });
    expect(Object.keys(entry ?? {}).at(-1)).toBe("reason");

    const text = readFileSync(join(board.tasksDir, `${id}.md`), "utf8");
    expect(text.match(/^    reason: owner idle 2d$/gm)).toHaveLength(1);
  });

  it("rejects a reason without force and writes nothing", async () => {
    const { board, id, clock } = await takeoverBoard();
    const before = readFileSync(join(board.tasksDir, `${id}.md`), "utf8");

    const error = await errorOf(
      assignTask(board, { task: id, assignee: "coder-2", agent: "coder-1", reason: "owner idle 2d" }, clock),
    );

    expect(error.details.code).toBe("invalid_argument");
    expect(error.message).toBe("reason requires force: true.");
    expect(readFileSync(join(board.tasksDir, `${id}.md`), "utf8")).toBe(before);
  });

  it("rejects a reason longer than the limit instead of truncating it", async () => {
    const { board, id, clock } = await takeoverBoard();

    const error = await errorOf(
      assignTask(board, { task: id, assignee: "coder-2", agent: "coder-1", force: true, reason: "x".repeat(201) }, clock),
    );

    expect(error.details.code).toBe("invalid_argument");
    expect(error.message).toBe("reason is 201 characters; the limit is 200.");
  });

  it("rejects a multi-line reason and an empty one", async () => {
    const { board, id, clock } = await takeoverBoard();

    const multiline = await errorOf(
      assignTask(board, { task: id, assignee: "coder-2", agent: "coder-1", force: true, reason: "one\ntwo" }, clock),
    );
    expect(multiline.details.code).toBe("invalid_argument");
    expect(multiline.message).toBe("reason must be a single line.");

    const blank = await errorOf(
      assignTask(board, { task: id, assignee: "coder-2", agent: "coder-1", force: true, reason: "   " }, clock),
    );
    expect(blank.details.code).toBe("invalid_argument");
    expect(blank.message).toBe("reason must be 1-200 characters.");
  });
});

describe("renderTask prints the reason on its own why line", () => {
  it("keeps the forced line and prints the reason beneath it", async () => {
    const { board, id, clock } = await takeoverBoard();
    await assignTask(
      board,
      { task: id, assignee: "coder-2", agent: "coder-2", force: true, reason: "owner idle 2d" },
      clock,
    );

    const text = renderTask(readTask(board, id), null);
    const lines = text.split("\n");
    const at = lines.indexOf("    2026-10-30 10:05:00Z @coder-2  force-assign coder-2 (forced)");

    expect(at).toBeGreaterThan(-1);
    expect(lines[at + 1]).toBe("      why  owner idle 2d");
    // The history block is what the 76-column budget covers; the `file` row
    // carries an absolute temp path by design.
    const history = lines.slice(lines.indexOf("  History"));
    for (const line of history) expect(line.length).toBeLessThanOrEqual(76);
  });

  it("truncates a 200-character reason to one 76-column line ending in ...", async () => {
    const { board, id, clock } = await takeoverBoard();
    await assignTask(
      board,
      { task: id, assignee: "coder-2", agent: "coder-2", force: true, reason: "r".repeat(200) },
      clock,
    );

    const why = renderTask(readTask(board, id), null)
      .split("\n")
      .filter((line) => line.startsWith("      why  "));

    expect(why).toHaveLength(1);
    expect(why[0].length).toBe(76);
    expect(why[0].endsWith("...")).toBe(true);
  });
});

describe("validate reports an unannotated takeover as a warning", () => {
  it("reports exactly one unannotated_forced warning and keeps the board valid", () => {
    const board = makeBoard();
    taskFile(board, "T-0005", UNANNOTATED_FILE);

    const report = validateBoard(board, {}, fixedClock(["2026-10-30T10:06:00.000Z"]));

    expect(report.problems).toHaveLength(1);
    expect(report.problems[0].code).toBe("unannotated_forced");
    expect(report.problems[0].severity).toBe("warning");
    expect(report.problems[0].message).toBe(
      'Forced assignment by "coder-1" on 2026-10-30 has no reason. Add one next time with kanban_assign {force: true, reason: "..."}.',
    );
    expect(report.ok).toBe(true);
  });

  it("prints the header and the three-line warning block inside 76 columns", async () => {
    const board = makeBoard();
    taskFile(board, "T-0005", UNANNOTATED_FILE);
    const messages: string[] = [];
    const ctx = {
      cwd: board.root,
      ui: { notify: (message: string) => messages.push(message) },
    } as unknown as ExtensionCommandContext;

    await handleKanbanCommand("validate --stale 0", ctx);

    expect(messages[0]).toContain("Board is valid (1 warning).");
    // Design §1.6's block wrapped at 76 columns, which is the unchanged
    // `wrapValidate` width; only the break points differ from the illustration.
    expect(messages[0]).toContain(
      [
        '  ⚠ T-0005  unannotated_forced: Forced assignment by "coder-1" on 2026-10-30',
        "            has no reason. Add one next time with kanban_assign {force:",
        '            true, reason: "..."}.',
      ].join("\n"),
    );
    for (const line of messages[0].split("\n")) expect(line.length).toBeLessThanOrEqual(76);
  });

  it("stays silent when the takeover carries a reason", () => {
    const board = makeBoard();
    taskFile(board, "T-0005", ANNOTATED_FILE);

    const report = validateBoard(board, {}, fixedClock(["2026-10-30T10:06:00.000Z"]));

    expect(report.ok).toBe(true);
    expect(report.problems.map((problem) => problem.code)).not.toContain("unannotated_forced");
    expect(renderValidationReport(report, board.root)).toContain("Board is valid.");
  });
});

describe("files written before 0.3.0", () => {
  it("parses a file without a reason and preserves its history byte for byte", async () => {
    const board = makeBoard();
    taskFile(board, "T-0005", UNANNOTATED_FILE);

    const parsed = readTask(board, "T-0005");
    expect(parsed.history.at(-1)).toMatchObject({ action: "force-assign", forced: true });
    expect(parsed.history.at(-1)?.reason).toBeUndefined();

    // Any rewrite re-serializes the whole history; the old entries must not gain
    // a key, reorder, or change wording.
    await releaseTask(board, { task: "T-0005", agent: "human" });
    const text = readFileSync(join(board.tasksDir, "T-0005.md"), "utf8");
    const block = HISTORY_BLOCK.exec(text)?.[1] ?? "";
    expect(block).toContain(
      [
        "  - at: 2026-10-30T10:05:00.000Z",
        "    action: force-assign",
        "    by: coder-1",
        "    assignee: coder-1",
        "    forced: true",
        "  - at: ",
      ].join("\n"),
    );
  });

  it("never flags a forced unassign, even on an unannotated old file", async () => {
    const board = makeBoard();
    // The 0.2.0 shape: a plain self-claim, no `forced` entry, no `reason` key.
    taskFile(
      board,
      "T-0001",
      `---
id: T-0001
title: Held over from 0.2.0
status: working
assignee: coder-1
created: 2026-10-30T09:00:00.000Z
updated: 2026-10-30T09:05:00.000Z
rev: 3
history:
  - at: 2026-10-30T09:00:00.000Z
    action: create
    by: coder-1
    to: new
  - at: 2026-10-30T09:05:00.000Z
    action: move
    by: coder-1
    from: new
    to: working
  - at: 2026-10-30T09:05:00.000Z
    action: assign
    by: coder-1
    assignee: coder-1
---
`,
    );
    const messages: string[] = [];
    const ctx = {
      cwd: board.root,
      ui: { notify: (message: string) => messages.push(message) },
    } as unknown as ExtensionCommandContext;

    await handleKanbanCommand("release T-0001 --yes --as human", ctx);
    await handleKanbanCommand("validate --stale 0", ctx);

    const report = validateBoard(board, { staleAfterMs: 0 });
    expect(report.problems.map((problem) => problem.code)).not.toContain("unannotated_forced");
    expect(report.ok).toBe(true);
    expect(readTask(board, "T-0001").history.at(-1)).toMatchObject({ action: "unassign", forced: true });
  });
});

describe("the reason key exists on every surface that writes or reads it", () => {
  /** Slice one `export const X = Type.Object({ ... });` block out of a source file. */
  function schemaBlock(source: string, name: string): string {
    const start = source.indexOf(`export const ${name} = Type.Object({`);
    return source.slice(start, source.indexOf("\n});", start));
  }

  it("declares reason on AssignParams, MoveParams, and HistoryEntry", () => {
    const schemas = readFileSync(new URL("../schemas.ts", import.meta.url), "utf8");
    const types = readFileSync(new URL("../types.ts", import.meta.url), "utf8");

    expect(schemaBlock(schemas, "AssignParams")).toContain("reason: Reason");
    expect(schemaBlock(schemas, "MoveParams")).toContain("reason: Reason");
    expect(types).toMatch(/interface HistoryEntry \{[\s\S]*?reason\?: string;/);
  });
});
