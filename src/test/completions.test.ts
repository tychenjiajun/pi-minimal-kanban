/**
 * T-0014: `/kanban` argument completions list subcommands, task ids, and the
 * handles seen on the board, from the location `src/index.ts` caches for the
 * session. A completion never throws, never writes, never takes the lock, and
 * never returns an empty list.
 *
 * Every assertion is a line from `docs/product/design-v0.3.md` §7 (T-0014).
 */
import { describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { completeKanbanCommand } from "../command.ts";
import { createTask } from "../store.ts";
import { makeBoard, taskFile } from "./helpers.ts";

/** Declares `planning`, `working`, and `done`, so fixtures can use them. */
const WORKFLOW = `name: linear
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
  - id: done
    label: Done
    terminal: true
transitions:
  new: [planning]
  planning: [working]
  working: [done]
  done: [working]
`;

/** The six labels `/kanban` completes with no board: §7 T-0014 #3. */
const SUBCOMMAND_LABELS = ["init", "validate", "--all", "--json", "status", "mine"];

const labels = (items: Array<{ label: string }>) => items.map((item) => item.label);

function taskMarkdown(id: string, title: string, status: string, assignee?: string, history = ""): string {
  const owner = assignee ? `assignee: ${assignee}\n` : "";
  return `---
id: ${id}
title: ${title}
status: ${status}
${owner}created: 2026-10-30T09:00:00.000Z
updated: 2026-10-30T10:05:00.000Z
rev: 1
history:
  - at: 2026-10-30T09:00:00.000Z
    action: create
    by: pm
    to: ${status}
${history}---
`;
}

describe("task ids and handles complete", () => {
  it("completes T-0001 with its status and title in the description", () => {
    const board = makeBoard(WORKFLOW);
    taskFile(board, "T-0001", taskMarkdown("T-0001", "Fix duplicate ids after a merge", "planning"));

    const item = completeKanbanCommand("T-0", board).find((entry) => entry.label === "T-0001");
    expect(item).toBeDefined();
    expect(item!.description).toBe("planning · Fix duplicate ids after a merge");
  });

  it("counts the tasks a handle currently holds", () => {
    const board = makeBoard(WORKFLOW);
    taskFile(board, "T-0001", taskMarkdown("T-0001", "First", "working", "coder-1"));
    taskFile(board, "T-0002", taskMarkdown("T-0002", "Second", "working", "coder-1"));

    const item = completeKanbanCommand("coder", board).find((entry) => entry.label === "coder-1");
    expect(item).toBeDefined();
    expect(item!.description).toBe("2 tasks");
  });

  it("prints 1 task for a handle that holds exactly one", () => {
    const board = makeBoard(WORKFLOW);
    taskFile(board, "T-0001", taskMarkdown("T-0001", "First", "working", "coder-1"));

    const item = completeKanbanCommand("coder", board).find((entry) => entry.label === "coder-1");
    expect(item!.description).toBe("1 task");
  });

  it("prints 0 tasks for a handle seen only in history", () => {
    const board = makeBoard(WORKFLOW);
    taskFile(
      board,
      "T-0001",
      taskMarkdown(
        "T-0001",
        "First",
        "working",
        "coder-1",
        "  - at: 2026-10-30T10:05:00.000Z\n    action: move\n    by: triage-bot\n    from: new\n    to: working\n",
      ),
    );

    const item = completeKanbanCommand("triage", board).find((entry) => entry.label === "triage-bot");
    expect(item).toBeDefined();
    expect(item!.description).toBe("0 tasks");
  });

  it("marks a drifted task with the warning marker inside the status", () => {
    const board = makeBoard(WORKFLOW);
    taskFile(board, "T-0001", taskMarkdown("T-0001", "Lost its status", "phantom"));

    const item = completeKanbanCommand("T-0", board).find((entry) => entry.label === "T-0001");
    expect(item!.description).toBe("phantom ⚠ · Lost its status");
  });

  it("truncates a long description to 64 characters with three dots", () => {
    const board = makeBoard(WORKFLOW);
    const title = "A title that is deliberately far too long to fit into one completion description";
    taskFile(board, "T-0001", taskMarkdown("T-0001", title, "planning"));

    const item = completeKanbanCommand("T-0", board).find((entry) => entry.label === "T-0001");
    expect(item!.description.length).toBe(64);
    expect(item!.description.endsWith("...")).toBe(true);
    expect(item!.description.startsWith("planning · A title")).toBe(true);
  });

  it("completes @cod as handles only", () => {
    const board = makeBoard(WORKFLOW);
    taskFile(board, "T-0001", taskMarkdown("T-0001", "First", "working", "coder-1"));

    const items = completeKanbanCommand("@cod", board);
    expect(labels(items)).toEqual(["coder-1"]);
    expect(labels(items).some((label) => label.startsWith("T-"))).toBe(false);
  });

  it("does not complete on a substring match", () => {
    const board = makeBoard(WORKFLOW);
    taskFile(board, "T-0001", taskMarkdown("T-0001", "First", "working", "coder-1"));

    // `1` is a prefix of nothing; a substring rule would list half the board.
    expect(labels(completeKanbanCommand("1", board))).toEqual(SUBCOMMAND_LABELS);
  });

  it("returns subcommands before task ids and handles", () => {
    const board = makeBoard(WORKFLOW);
    taskFile(board, "T-0001", taskMarkdown("T-0001", "First", "working", "coder-1"));

    const items = completeKanbanCommand("", board);
    expect(labels(items).slice(0, SUBCOMMAND_LABELS.length)).toEqual(SUBCOMMAND_LABELS);
    expect(labels(items)[SUBCOMMAND_LABELS.length]).toBe("T-0001");
    expect(labels(items)).toContain("coder-1");
  });

  it("lists one item per handle when it is both the assignee and a history by", () => {
    const board = makeBoard(WORKFLOW);
    taskFile(
      board,
      "T-0001",
      taskMarkdown(
        "T-0001",
        "First",
        "working",
        "coder-1",
        "  - at: 2026-10-30T10:05:00.000Z\n    action: assign\n    by: coder-1\n    assignee: coder-1\n",
      ),
    );

    const items = completeKanbanCommand("", board).filter((item) => item.label.toLowerCase() === "coder-1");
    expect(items).toHaveLength(1);
    expect(items[0].description).toBe("1 task");
  });
});

describe("order, caps, and the prefix rule", () => {
  it("caps task ids at 20, ascending by number", () => {
    const board = makeBoard(WORKFLOW);
    for (let i = 1; i <= 25; i += 1) {
      const id = `T-${String(i).padStart(4, "0")}`;
      taskFile(board, id, taskMarkdown(id, `Task ${i}`, "planning"));
    }

    const items = completeKanbanCommand("T-", board);
    expect(items).toHaveLength(20);
    expect(items[0].label).toBe("T-0001");
    expect(items[19].label).toBe("T-0020");
  });

  it("caps handles at 10 and sorts them case-insensitively", () => {
    const board = makeBoard(WORKFLOW);
    for (let i = 1; i <= 15; i += 1) {
      const id = `T-${String(i).padStart(4, "0")}`;
      taskFile(board, id, taskMarkdown(id, `Task ${i}`, "planning", `Holder-${String(i).padStart(2, "0")}`));
    }

    const items = completeKanbanCommand("Holder", board);
    expect(items).toHaveLength(10);
    expect(labels(items)).toEqual([
      "Holder-01",
      "Holder-02",
      "Holder-03",
      "Holder-04",
      "Holder-05",
      "Holder-06",
      "Holder-07",
      "Holder-08",
      "Holder-09",
      "Holder-10",
    ]);
  });

  it("matches a prefix case-insensitively", () => {
    const board = makeBoard(WORKFLOW);
    taskFile(board, "T-0001", taskMarkdown("T-0001", "First", "working", "building-2"));

    expect(labels(completeKanbanCommand("t-0", board))).toContain("T-0001");
    expect(labels(completeKanbanCommand("building", board))).toContain("building-2");
  });

  it("keeps the existing -- flag filter", () => {
    const board = makeBoard(WORKFLOW);
    taskFile(board, "T-0001", taskMarkdown("T-0001", "First", "planning"));

    expect(labels(completeKanbanCommand("--", board))).toEqual(["--all", "--json"]);
    expect(labels(completeKanbanCommand("--j", board))).toEqual(["--json"]);
  });

  it("no longer offers the removed mutating subcommands", () => {
    const board = makeBoard(WORKFLOW);
    // 0.4.0 made `/kanban` read-only: release and repair-ids are gone, so a
    // prefix that used to match them falls back to the plain subcommand group.
    expect(labels(completeKanbanCommand("re", board))).toEqual(SUBCOMMAND_LABELS);
    expect(labels(completeKanbanCommand("repair", board))).not.toContain("repair-ids");
    expect(labels(completeKanbanCommand("rel", board))).not.toContain("release");
  });
});

describe("the never-empty, never-throwing invariant", () => {
  it("returns the 6 subcommands with no cached location", () => {
    expect(labels(completeKanbanCommand("", undefined))).toEqual(SUBCOMMAND_LABELS);
  });

  it("returns the 6 subcommands for a task prefix with no cached location", () => {
    expect(labels(completeKanbanCommand("T-0", undefined))).toEqual(SUBCOMMAND_LABELS);
  });

  it("falls back to the 6 subcommands when nothing matches", () => {
    const board = makeBoard(WORKFLOW);
    taskFile(board, "T-0001", taskMarkdown("T-0001", "First", "planning"));

    expect(labels(completeKanbanCommand("zz", board))).toEqual(SUBCOMMAND_LABELS);
  });

  it("returns the 6 subcommands for a location whose tasks directory does not exist", () => {
    const board = makeBoard(WORKFLOW);
    rmSync(board.tasksDir, { recursive: true, force: true });

    expect(labels(completeKanbanCommand("", board))).toEqual(SUBCOMMAND_LABELS);
    expect(labels(completeKanbanCommand("T-0", board))).toEqual(SUBCOMMAND_LABELS);
  });

  it("returns the 6 subcommands for a board with zero tasks", () => {
    const board = makeBoard(WORKFLOW);
    expect(labels(completeKanbanCommand("", board))).toEqual(SUBCOMMAND_LABELS);
  });

  it("keeps the readable tasks when one file is malformed, and says nothing about it", () => {
    const board = makeBoard(WORKFLOW);
    taskFile(board, "T-0001", taskMarkdown("T-0001", "Fine", "planning"));
    taskFile(board, "T-0002", "not a kanban task at all\n");

    const items = completeKanbanCommand("T-0", board);
    expect(labels(items)).toEqual(["T-0001"]);
    for (const item of items) expect(item.description).not.toContain("could not be read");
  });

  it("returns the 6 subcommands when every task file is unreadable", () => {
    const board = makeBoard(WORKFLOW);
    taskFile(board, "T-0001", "garbage\n");
    taskFile(board, "T-0002", "---\nid: T-0002\n---\n");

    expect(labels(completeKanbanCommand("T-0", board))).toEqual(SUBCOMMAND_LABELS);
  });

  it("never throws for a missing workflow, an empty board, or an unreadable tasks dir", () => {
    const noWorkflow = makeBoard(null);
    taskFile(noWorkflow, "T-0001", taskMarkdown("T-0001", "Fine", "planning"));
    expect(() => completeKanbanCommand("T-0", noWorkflow)).not.toThrow();
    expect(labels(completeKanbanCommand("T-0", noWorkflow))).toContain("T-0001");

    expect(() => completeKanbanCommand("T-0", makeBoard(WORKFLOW))).not.toThrow();

    const unreadable = makeBoard(WORKFLOW);
    taskFile(unreadable, "T-0001", taskMarkdown("T-0001", "Fine", "planning"));
    chmodSync(unreadable.tasksDir, 0o000);
    try {
      expect(() => completeKanbanCommand("T-0", unreadable)).not.toThrow();
    } finally {
      chmodSync(unreadable.tasksDir, 0o755);
    }
  });

  it("reads a board the store already wrote, without taking the lock or touching mtimes", async () => {
    const board = makeBoard(WORKFLOW);
    await createTask(board, { title: "Written by the store", agent: "coder-1" });
    const path = join(board.tasksDir, "T-0001.md");
    const before = statSync(path).mtimeMs;
    const bytes = readFileSync(path, "utf8");

    expect(labels(completeKanbanCommand("T-0", board))).toContain("T-0001");
    expect(existsSync(join(board.dir, ".lock"))).toBe(false);
    expect(statSync(path).mtimeMs).toBe(before);
    expect(readFileSync(path, "utf8")).toBe(bytes);
  });

  it("never writes: every completion leaves the board byte-identical", () => {
    const board = makeBoard(WORKFLOW);
    const path = join(board.tasksDir, "T-0001.md");
    writeFileSync(path, taskMarkdown("T-0001", "Fine", "planning"), "utf8");
    const snapshot = readFileSync(path, "utf8");

    completeKanbanCommand("", board);
    completeKanbanCommand("T-0", board);
    completeKanbanCommand("@cod", board);

    expect(readFileSync(path, "utf8")).toBe(snapshot);
    expect(existsSync(join(board.dir, ".lock"))).toBe(false);
  });

  it("survives a tasks path that is a file, not a directory", () => {
    const board = makeBoard(WORKFLOW);
    rmSync(board.tasksDir, { recursive: true, force: true });
    mkdirSync(board.dir, { recursive: true });
    writeFileSync(board.tasksDir, "not a directory", "utf8");

    expect(() => completeKanbanCommand("T-0", board)).not.toThrow();
    expect(labels(completeKanbanCommand("T-0", board))).toEqual(SUBCOMMAND_LABELS);
  });
});
