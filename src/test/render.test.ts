import { describe, expect, it } from "vitest";
import { createTask, moveTask, commentOnTask, readBoard, readTask, assignTask } from "../store.ts";
import { renderBoard, renderTask, renderTaskLine } from "../render.ts";
import { makeBoard } from "./helpers.ts";

describe("renderBoard", () => {
  it("lists non-terminal columns and collapses terminal ones", async () => {
    const board = makeBoard();
    const a = await createTask(board, { title: "First task", agent: "coder-1" });
    const b = await createTask(board, { title: "Second task", agent: "coder-2" });
    await moveTask(board, { task: b.id, to: "working", agent: "coder-2" });

    const text = renderBoard(readBoard(board), { width: 70 });
    expect(text).toContain("◇ New");
    expect(text).toContain("◆ Working");
    expect(text).toContain(a.id);
    expect(text).toContain("@coder-2");
    expect(text).toContain("Done"); // collapsed, but still named
    expect(text).not.toContain("done  ·");
  });

  it("expands terminal columns with --all", async () => {
    const board = makeBoard();
    const task = await createTask(board, { title: "Finished thing", agent: "a" });
    await moveTask(board, { task: task.id, to: "working", agent: "a" });
    await moveTask(board, { task: task.id, to: "done", agent: "a" });

    const collapsed = renderBoard(readBoard(board));
    expect(collapsed).not.toContain("Finished thing");
    const expanded = renderBoard(readBoard(board), { all: true });
    expect(expanded).toContain("Finished thing");
  });

  it("shows drifted tasks in their own group", async () => {
    const board = makeBoard();
    const task = await createTask(board, { title: "Orphan", agent: "a" });
    await moveTask(board, { task: task.id, to: "working", agent: "a" });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      `${board.dir}/workflow.yaml`,
      `statuses:\n  - id: new\n  - id: done\n    terminal: true\n`,
      "utf8",
    );

    const text = renderBoard(readBoard(board));
    expect(text).toContain("Drifted");
    expect(text).toContain("Orphan");
    // The §2 row: the raw status id stays visible with the drift marker, and the
    // drifted block keeps `rev` and the claim cell like every other row.
    expect(text).toMatch(/T-0001  working ⚠  Orphan +@a  rev 2/);
  });

  it("still prints tasks when the workflow is missing", async () => {
    const board = makeBoard(null);
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(board.tasksDir, { recursive: true });
    writeFileSync(
      `${board.tasksDir}/T-0001.md`,
      `---\nid: T-0001\ntitle: No workflow\nstatus: new\ncreated: 2026-10-30T10:00:00.000Z\nupdated: 2026-10-30T10:00:00.000Z\nrev: 1\nhistory: []\n---\n`,
      "utf8",
    );

    const text = renderBoard(readBoard(board));
    expect(text).toContain("Workflow problem");
    expect(text).toContain("No workflow");
    expect(text).toContain("/kanban init");
  });
});

describe("renderTask", () => {
  it("shows status, assignee, next transitions, history, and comments", async () => {
    const board = makeBoard();
    const task = await createTask(board, { title: "Detail me", description: "Some body text.", agent: "coder-1" });
    await moveTask(board, { task: task.id, to: "working", agent: "coder-1" });
    await commentOnTask(board, { task: task.id, body: "Looks fine to me.", agent: "reviewer" });

    const snapshot = readBoard(board);
    const text = renderTask(readTask(board, task.id), snapshot.workflow);

    expect(text).toContain("Detail me");
    expect(text).toContain("Some body text.");
    expect(text).toContain("@coder-1");
    expect(text).toContain("new, done");
    expect(text).toContain("Looks fine to me.");
    expect(text).toContain("@reviewer");
  });

  it("marks a drifted task's status", async () => {
    const board = makeBoard();
    const task = await createTask(board, { title: "Drift", agent: "a" });
    await moveTask(board, { task: task.id, to: "working", agent: "a" });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${board.dir}/workflow.yaml`, `statuses: [new, done]\n`, "utf8");

    const text = renderTask(readTask(board, task.id), readBoard(board).workflow);
    expect(text).toContain("not in workflow");
  });
});

describe("renderTaskLine", () => {
  it("is a single line with status, title, and owner", async () => {
    const board = makeBoard();
    const task = await createTask(board, { title: "A long enough title to be truncated eventually", agent: "a" });
    await assignTask(board, { task: task.id, assignee: "coder-1", agent: "a" });
    const line = renderTaskLine(readTask(board, task.id));
    expect(line.split("\n")).toHaveLength(1);
    expect(line).toContain("T-0001");
    expect(line).toContain("new");
    expect(line).toContain("@coder-1");
  });
});
