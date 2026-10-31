import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findProjectRoot, resolveBoard } from "../paths.ts";

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "kanban-paths-"));
  mkdirSync(join(root, ".git"));
  return root;
}

describe("findProjectRoot", () => {
  it("finds the nearest ancestor with .git", () => {
    const root = project();
    const nested = join(root, "packages/api/src");
    mkdirSync(nested, { recursive: true });
    expect(findProjectRoot(nested)).toBe(root);
  });

  it("finds a nested project's own board before an outer repo", () => {
    const outer = project();
    const inner = join(outer, "vendored");
    mkdirSync(join(inner, ".pi/kanban"), { recursive: true });
    expect(findProjectRoot(inner)).toBe(inner);
  });

  it("returns undefined when nothing marks a project", () => {
    const loose = mkdtempSync(join(tmpdir(), "kanban-loose-"));
    expect(findProjectRoot(loose)).toBeUndefined();
  });
});

describe("resolveBoard", () => {
  it("walks up from cwd to the project root", () => {
    const root = project();
    const nested = join(root, "src");
    mkdirSync(nested);
    const board = resolveBoard({ cwd: nested, env: {} });
    expect(board.root).toBe(root);
    expect(board.dir).toBe(join(root, ".pi/kanban"));
    expect(board.source).toBe("project-root");
  });

  it("accepts a project root as an explicit argument", () => {
    const root = project();
    const board = resolveBoard({ cwd: tmpdir(), project: root, env: {} });
    expect(board.dir).toBe(join(root, ".pi/kanban"));
    expect(board.source).toBe("explicit");
  });

  it("treats `.pi/kanban` as the board dir itself", () => {
    const root = project();
    mkdirSync(join(root, ".pi/kanban"), { recursive: true });
    const board = resolveBoard({ cwd: tmpdir(), project: join(root, ".pi/kanban"), env: {} });
    expect(board.root).toBe(root);
    expect(board.dir).toBe(join(root, ".pi/kanban"));
  });

  it("treats a directory containing a workflow as a board dir", () => {
    const root = project();
    const dir = join(root, ".pi/kanban");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "workflow.json"), "{}", "utf8");
    const board = resolveBoard({ cwd: tmpdir(), project: dir, env: {} });
    expect(board.dir).toBe(dir);
  });

  it("honours PI_KANBAN_DIR", () => {
    const root = project();
    const custom = join(tmpdir(), "kanban-custom");
    const board = resolveBoard({ cwd: root, env: { PI_KANBAN_DIR: custom } });
    expect(board.dir).toBe(custom);
    expect(board.source).toBe("env");
  });

  it("falls back to cwd so a new board can be initialised", () => {
    const loose = mkdtempSync(join(tmpdir(), "kanban-loose-"));
    const board = resolveBoard({ cwd: loose, env: {} });
    expect(board.dir).toBe(join(loose, ".pi/kanban"));
  });

  it("rejects a missing explicit project", () => {
    expect(() => resolveBoard({ cwd: tmpdir(), project: "/definitely/not/here", env: {} })).toThrow(/does not exist/);
  });
});
