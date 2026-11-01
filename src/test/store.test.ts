import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KanbanError } from "../errors.ts";
import {
  assignTask,
  commentOnTask,
  createTask,
  detail,
  initBoard,
  listTaskIds,
  moveTask,
  readBoard,
  readTask,
  validateBoard,
} from "../store.ts";
import { parseTaskFile } from "../task-file.ts";
import { LINEAR_WORKFLOW, bodyOf, fixedClock, makeBoard, taskFile } from "./helpers.ts";

const expectCode = (promise: Promise<unknown>, code: string) => {
  return expect(promise).rejects.toSatisfy(
    (error: unknown) => error instanceof KanbanError && error.details.code === code,
  );
};

describe("createTask", () => {
  it("starts in the initial status, unassigned, at rev 1", async () => {
    const board = makeBoard();
    const clock = fixedClock(["2026-10-30T10:00:00.000Z"]);
    const task = await createTask(board, { title: "Wire the parser", agent: "coder-1" }, clock);

    expect(task.id).toBe("T-0001");
    expect(task.status).toBe("new");
    expect(task.assignee).toBeUndefined();
    expect(task.rev).toBe(1);
    expect(task.history).toEqual([
      { at: "2026-10-30T10:00:00.000Z", action: "create", by: "coder-1", to: "new" },
    ]);
  });

  it("claims the task when the initial status is active", async () => {
    const board = makeBoard(`
initial: working
statuses:
  - id: working
    active: true
  - id: done
    terminal: true
`);
    const task = await createTask(board, { title: "Start immediately", agent: "coder-1" });
    expect(task.assignee).toBe("coder-1");
  });

  it("allocates monotonically increasing ids that are never reused", async () => {
    const board = makeBoard();
    const first = await createTask(board, { title: "one", agent: "a" });
    const second = await createTask(board, { title: "two", agent: "a" });
    expect([first.id, second.id]).toEqual(["T-0001", "T-0002"]);

    // Deleting a task must not free its id.
    const { rmSync } = await import("node:fs");
    rmSync(join(board.tasksDir, `${second.id}.md`));
    const third = await createTask(board, { title: "three", agent: "a" });
    expect(third.id).toBe("T-0003");
    expect(listTaskIds(board)).toEqual(["T-0001", "T-0003"]);
  });

  it("rejects a missing workflow with a hint to init", async () => {
    const board = makeBoard(null);
    await expectCode(createTask(board, { title: "x", agent: "a" }), "no_workflow");
  });

  it("rejects invalid handles and multi-line titles", async () => {
    const board = makeBoard();
    await expectCode(createTask(board, { title: "x", agent: "bad handle" }), "invalid_handle");
    await expectCode(createTask(board, { title: "two\nlines", agent: "a" }), "invalid_task");
    await expectCode(createTask(board, { title: "   ", agent: "a" }), "invalid_task");
  });

  it("writes a readable Markdown task file", async () => {
    const board = makeBoard();
    const task = await createTask(
      board,
      { title: "Document the board", description: "Explain the workflow file.", agent: "coder-1" },
      fixedClock(["2026-10-30T10:00:00.000Z"]),
    );

    const text = readFileSync(task.path, "utf8");
    expect(text).toContain("id: T-0001");
    expect(text).toContain("status: new");
    expect(text).toContain("Explain the workflow file.");
    expect(text.trimEnd().endsWith("Explain the workflow file.")).toBe(true);
  });
});

describe("moveTask", () => {
  it("claims the task when entering an active status", async () => {
    const board = makeBoard();
    const task = await createTask(board, { title: "x", agent: "coder-1" });
    const moved = await moveTask(board, { task: task.id, to: "working", agent: "coder-1" });

    expect(moved.status).toBe("working");
    expect(moved.assignee).toBe("coder-1");
    expect(moved.rev).toBe(2);
    expect(moved.history.map((entry) => entry.action)).toEqual(["create", "move", "assign"]);
    expect(moved.history[1]).toMatchObject({ action: "move", from: "new", to: "working" });
  });

  it("refuses a claim held by another handle", async () => {
    const board = makeBoard();
    const task = await createTask(board, { title: "x", agent: "coder-1" });
    await moveTask(board, { task: task.id, to: "working", agent: "coder-1" });

    await expectCode(moveTask(board, { task: task.id, to: "done", agent: "coder-2" }), "wrong_owner");
  });

  it("lets the owner continue through active statuses", async () => {
    const board = makeBoard();
    const task = await createTask(board, { title: "x", agent: "coder-1" });
    await moveTask(board, { task: task.id, to: "working", agent: "coder-1" });
    const done = await moveTask(board, { task: task.id, to: "done", agent: "coder-1" });

    expect(done.status).toBe("done");
    expect(done.assignee).toBeUndefined();
    expect(done.history.at(-1)).toMatchObject({ action: "unassign", assignee: "coder-1" });
  });

  it("allows a forced takeover and records it", async () => {
    const board = makeBoard();
    const task = await createTask(board, { title: "x", agent: "coder-1" });
    await moveTask(board, { task: task.id, to: "working", agent: "coder-1" });
    const stolen = await moveTask(board, { task: task.id, to: "done", agent: "coder-2", force: true });

    expect(stolen.assignee).toBeUndefined();
    expect(stolen.history.some((entry) => entry.action === "force-assign" && entry.forced === true)).toBe(true);
  });

  it("rejects undeclared and backwards statuses", async () => {
    const board = makeBoard();
    const task = await createTask(board, { title: "x", agent: "a" });
    await expectCode(moveTask(board, { task: task.id, to: "done", agent: "a" }), "invalid_transition");
    await expectCode(moveTask(board, { task: task.id, to: "ghost", agent: "a" }), "invalid_transition");
    await expectCode(moveTask(board, { task: task.id, to: "new", agent: "a" }), "already_in_status");
  });

  it("honours expectedRev", async () => {
    const board = makeBoard();
    const task = await createTask(board, { title: "x", agent: "a" });
    await moveTask(board, { task: task.id, to: "working", agent: "a" });
    await expectCode(moveTask(board, { task: task.id, to: "done", agent: "a", expectedRev: 1 }), "stale");
  });
});

describe("assignTask", () => {
  it("assigns an unclaimed task and releases it", async () => {
    const board = makeBoard();
    const task = await createTask(board, { title: "x", agent: "a" });

    const assigned = await assignTask(board, { task: task.id, assignee: "coder-2", agent: "coder-2" });
    expect(assigned.assignee).toBe("coder-2");

    const released = await assignTask(board, { task: task.id, assignee: null, agent: "coder-2" });
    expect(released.assignee).toBeUndefined();
    expect(released.history.at(-1)).toMatchObject({ action: "unassign", by: "coder-2" });
  });

  it("requires force to take a claimed task", async () => {
    const board = makeBoard();
    const task = await createTask(board, { title: "x", agent: "a" });
    await assignTask(board, { task: task.id, assignee: "coder-1", agent: "coder-1" });

    await expectCode(assignTask(board, { task: task.id, assignee: "coder-2", agent: "coder-2" }), "already_assigned");
    const forced = await assignTask(board, { task: task.id, assignee: "coder-2", agent: "coder-2", force: true });
    expect(forced.assignee).toBe("coder-2");
    expect(forced.history.at(-1)).toMatchObject({ action: "force-assign", forced: true });
  });

  it("requires force to release someone else's claim", async () => {
    const board = makeBoard();
    const task = await createTask(board, { title: "x", agent: "a" });
    await assignTask(board, { task: task.id, assignee: "coder-1", agent: "coder-1" });

    await expectCode(assignTask(board, { task: task.id, assignee: null, agent: "coder-2" }), "wrong_owner");
    const released = await assignTask(board, { task: task.id, assignee: null, agent: "coder-2", force: true });
    expect(released.assignee).toBeUndefined();
  });

  it("rejects assigning a terminal task", async () => {
    const board = makeBoard();
    const task = await createTask(board, { title: "x", agent: "a" });
    await moveTask(board, { task: task.id, to: "working", agent: "a" });
    await moveTask(board, { task: task.id, to: "done", agent: "a" });

    await expectCode(assignTask(board, { task: task.id, assignee: "b", agent: "a" }), "terminal_task");
  });

  it("is a no-op when the assignee already matches", async () => {
    const board = makeBoard();
    const task = await createTask(board, { title: "x", agent: "a" });
    await assignTask(board, { task: task.id, assignee: "b", agent: "b" });
    const again = await assignTask(board, { task: task.id, assignee: "b", agent: "b" });
    expect(again.rev).toBe(2);
  });
});

describe("commentOnTask", () => {
  it("appends a comment without touching history", async () => {
    const board = makeBoard();
    const task = await createTask(board, { title: "x", agent: "a" });
    const clock = fixedClock(["2026-10-30T11:00:00.000Z"]);
    const commented = await commentOnTask(board, { task: task.id, body: "First **note**.", agent: "coder-2" }, clock);

    expect(commented.comments).toEqual([{ at: "2026-10-30T11:00:00.000Z", by: "coder-2", body: "First **note**." }]);
    expect(commented.history).toHaveLength(1);
    expect(commented.rev).toBe(2);
  });

  it("round-trips multiple comments, including Markdown headings", async () => {
    const board = makeBoard();
    const task = await createTask(board, { title: "x", agent: "a" });
    await commentOnTask(board, { task: task.id, body: "## Plan\n\n- one\n- two", agent: "a" });
    await commentOnTask(board, { task: task.id, body: "Second.", agent: "b" });

    const reread = readTask(board, task.id);
    expect(reread.comments.map((comment) => comment.by)).toEqual(["a", "b"]);
    expect(reread.comments[0].body).toBe("## Plan\n\n- one\n- two");
    expect(reread.description).toBe("");
  });

  it("rejects a comment that looks like a sentinel", async () => {
    const board = makeBoard();
    const task = await createTask(board, { title: "x", agent: "a" });
    await expectCode(
      commentOnTask(board, { task: task.id, body: "<!-- kanban:comment at=x by=y -->\nhi", agent: "a" }),
      "invalid_task",
    );
  });
});

describe("drift recovery", () => {
  it("keeps listing a task whose status was removed from the workflow", async () => {
    const board = makeBoard();
    const task = await createTask(board, { title: "x", agent: "a" });
    await moveTask(board, { task: task.id, to: "working", agent: "a" });

    // Remove "working" from the workflow.
    writeFileSync(
      join(board.dir, "workflow.yaml"),
      `statuses:\n  - id: new\n  - id: done\n    terminal: true\ntransitions:\n  new: [done]\n  done: [new]\n`,
      "utf8",
    );

    const board2 = readBoard(board);
    expect(board2.workflow).not.toBeNull();
    const drifted = board2.tasks[0];
    expect(drifted.drifted).toBe(true);
    expect(drifted.status).toBe("working");
  });

  it("lets a drifted task move to any declared status", async () => {
    const board = makeBoard();
    const task = await createTask(board, { title: "x", agent: "a" });
    await moveTask(board, { task: task.id, to: "working", agent: "a" });
    writeFileSync(
      join(board.dir, "workflow.yaml"),
      `statuses:\n  - id: new\n  - id: done\n    terminal: true\ntransitions:\n  new: [done]\n  done: [new]\n`,
      "utf8",
    );

    const recovered = await moveTask(board, { task: task.id, to: "done", agent: "a" });
    expect(recovered.status).toBe("done");
    expect(recovered.drifted).toBe(false);
  });

  it("never moves a task into an undeclared status", async () => {
    const board = makeBoard();
    const task = await createTask(board, { title: "x", agent: "a" });
    writeFileSync(join(board.dir, "workflow.yaml"), `statuses: [new, done]\n`, "utf8");
    await expectCode(moveTask(board, { task: task.id, to: "ghost", agent: "a" }), "invalid_transition");
  });
});

describe("hand edits", () => {
  it("preserves unknown frontmatter keys across a tool write", async () => {
    const board = makeBoard();
    const task = await createTask(board, { title: "x", description: "Body.", agent: "a" });

    const text = readFileSync(task.path, "utf8").replace("status: new", "status: new\nowner_team: platform");
    writeFileSync(task.path, text, "utf8");

    await commentOnTask(board, { task: task.id, body: "note", agent: "a" });
    const after = readFileSync(task.path, "utf8");
    expect(after).toContain("owner_team: platform");
    expect(after).toContain("Body.");
    expect(after).toContain("note");
  });

  it("keeps the description when a comment is appended", async () => {
    const board = makeBoard();
    const task = await createTask(board, { title: "x", description: "Line one.\n\nLine two.", agent: "a" });
    await commentOnTask(board, { task: task.id, body: "hi", agent: "a" });
    expect(bodyOf(board, task.id)).toContain("Line one.\n\nLine two.");
  });

  it("rejects a task file whose id does not match its filename", async () => {
    const board = makeBoard();
    taskFile(
      board,
      "T-0009",
      `---\nid: T-0001\ntitle: Mismatch\nstatus: new\ncreated: 2026-10-30T10:00:00.000Z\nupdated: 2026-10-30T10:00:00.000Z\nrev: 1\nhistory: []\n---\n`,
    );
    expect(() => readTask(board, "T-0009")).toThrow(/filename/);
  });
});

describe("initBoard", () => {
  it("writes a starter workflow once and is idempotent", async () => {
    const board = makeBoard(null);
    const first = await initBoard(board);
    expect(first.created).toBe(true);
    const again = await initBoard(board);
    expect(again.created).toBe(false);
    expect(readBoard(board).workflow).not.toBeNull();
  });

  it("does not overwrite an existing workflow", async () => {
    const board = makeBoard(LINEAR_WORKFLOW);
    const result = await initBoard(board);
    expect(result.created).toBe(false);
    expect(readFileSync(join(board.dir, "workflow.yaml"), "utf8")).toBe(LINEAR_WORKFLOW);
  });
});

describe("validateBoard", () => {
  it("reports drifted, terminal-but-assigned, and invalid workflow states", async () => {
    const board = makeBoard();
    expect(validateBoard(board).ok).toBe(true);

    // Hand-edit into an impossible state: terminal status, still assigned.
    taskFile(
      board,
      "T-0001",
      `---\nid: T-0001\ntitle: Hand edited\nstatus: done\nassignee: ghost\ncreated: 2026-10-30T10:00:00.000Z\nupdated: 2026-10-30T10:00:00.000Z\nrev: 1\nhistory: []\n---\n`,
    );

    const report = validateBoard(board);
    expect(report.ok).toBe(false);
    expect(report.problems.map((problem) => problem.code)).toContain("terminal_assigned");
  });

  it("treats an active task with no assignee as a normal state", async () => {
    const board = makeBoard();
    taskFile(
      board,
      "T-0001",
      `---\nid: T-0001\ntitle: Nobody home\nstatus: working\ncreated: 2026-10-30T10:00:00.000Z\nupdated: 2026-10-30T10:00:00.000Z\nrev: 1\nhistory: []\n---\n`,
    );
    const report = validateBoard(board);
    // Design §4 / backlog item 1: `active_unassigned` is gone, so a release
    // does not leave a permanent problem behind.
    expect(report.problems.map((problem) => problem.code)).not.toContain("active_unassigned");
    expect(report.ok).toBe(true);
  });

  it("reports a stale claim as a warning that keeps the board valid", async () => {
    const board = makeBoard();
    taskFile(
      board,
      "T-0001",
      [
        "---",
        "id: T-0001",
        "title: Abandoned claim",
        "status: working",
        "assignee: coder-1",
        "created: 2026-10-01T00:00:00.000Z",
        "updated: 2026-10-01T00:00:00.000Z",
        "rev: 2",
        "history:",
        "  - at: 2026-10-01T00:00:00.000Z",
        "    action: assign",
        "    by: coder-1",
        "    assignee: coder-1",
        "---",
      ].join("\n") + "\n",
    );
    // 3 days later, against the default 24h threshold.
    const now = { now: () => new Date("2026-10-04T00:00:00.000Z") };
    const report = validateBoard(board, {}, now);

    const stale = report.problems.find((problem) => problem.code === "stale_claim");
    expect(stale).toBeDefined();
    expect(stale?.severity).toBe("warning");
    expect(stale?.message).toContain('Claimed by "coder-1" for 3d');
    expect(stale?.message).toContain("(threshold 24h)");
    expect(stale?.message).toContain("Release it with kanban_assign {assignee: null, force: true}.");
    expect(stale?.message).not.toContain("/kanban release");
    // A warning alone never flips the report.
    expect(report.ok).toBe(true);
  });

  it("honours a custom stale threshold and disables the check at zero", async () => {
    const board = makeBoard();
    taskFile(
      board,
      "T-0001",
      `---\nid: T-0001\ntitle: Fresh claim\nstatus: working\nassignee: coder-1\ncreated: 2026-10-30T22:00:00.000Z\nupdated: 2026-10-30T22:00:00.000Z\nrev: 2\nhistory:\n  - at: 2026-10-30T22:00:00.000Z\n    action: assign\n    by: coder-1\n    assignee: coder-1\n---\n`,
    );
    const now = { now: () => new Date("2026-10-31T00:00:00.000Z") }; // 2h old
    expect(validateBoard(board, { staleAfterMs: 86_400_000 }, now).problems.map((p) => p.code)).not.toContain(
      "stale_claim",
    );
    expect(validateBoard(board, { staleAfterMs: 3_600_000 }, now).problems.map((p) => p.code)).toContain(
      "stale_claim",
    );
    expect(validateBoard(board, { staleAfterMs: 0 }, now).problems.map((p) => p.code)).not.toContain(
      "stale_claim",
    );
  });
});

describe("detail", () => {
  it("includes history and comments as structured data", async () => {
    const board = makeBoard();
    const task = await createTask(board, { title: "x", agent: "a" });
    await commentOnTask(board, { task: task.id, body: "hello", agent: "a" });
    const view = detail(readTask(board, task.id));
    expect(view.comments[0].body).toBe("hello");
    expect(view.history[0].action).toBe("create");
    expect(view.path.endsWith("T-0001.md")).toBe(true);
  });
});

describe("task file parsing", () => {
  it("fails with a readable message when frontmatter is missing", async () => {
    const board = makeBoard();
    taskFile(board, "T-0001", "just text\n");
    expect(() => parseTaskFile(readFileSync(join(board.tasksDir, "T-0001.md"), "utf8"), "T-0001.md")).toThrow(
      /frontmatter/,
    );
  });
});
