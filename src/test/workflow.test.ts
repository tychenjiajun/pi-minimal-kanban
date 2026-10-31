import { describe, expect, it } from "vitest";
import { parseWorkflow } from "../workflow.ts";

const ok = (text: string, format: "yaml" | "json" = "yaml") => parseWorkflow(text, format, "/board/workflow.yaml");

describe("workflow parsing", () => {
  it("accepts the linear shorthand with adjacent two-way moves", () => {
    const result = ok(`initial: new\nstatuses: [new, working, done]\n`);
    expect(result.errors).toEqual([]);
    const workflow = result.workflow!;
    expect(workflow.initial).toBe("new");
    expect(workflow.transitions.get("new")).toEqual(new Set(["working"]));
    expect(workflow.transitions.get("working")).toEqual(new Set(["new", "done"]));
  });

  it("defaults initial to the first status", () => {
    const result = ok(`statuses: [a, b]\n`);
    expect(result.workflow!.initial).toBe("a");
  });

  it("honours explicit transitions and active/terminal flags", () => {
    const result = ok(`
initial: new
statuses:
  - id: new
  - id: planning
    active: true
  - id: working
    active: true
  - id: done
    terminal: true
transitions:
  new: [planning]
  planning: [working]
  working: [done]
  done: [working]
`);
    expect(result.errors).toEqual([]);
    const workflow = result.workflow!;
    expect(workflow.byId.get("planning")!.active).toBe(true);
    expect(workflow.byId.get("done")!.terminal).toBe(true);
    expect(workflow.transitions.get("working")).toEqual(new Set(["done"]));
  });

  it("rejects a status both active and terminal", () => {
    const result = ok(`
statuses:
  - id: new
  - id: done
    active: true
    terminal: true
transitions:
  new: [done]
`);
    expect(result.errors.join("\n")).toContain("cannot be both active and terminal");
  });

  it("requires at least one terminal status when statuses are explicit objects", () => {
    const result = ok(`statuses:\n  - id: new\n  - id: working\ntransitions:\n  new: [working]\n  working: [new]\n`);
    expect(result.errors.join("\n")).toContain("At least one status must be terminal");
  });

  it("treats the last shorthand status as terminal", () => {
    const result = ok(`statuses: [new, working]\n`);
    expect(result.errors).toEqual([]);
    expect(result.workflow!.byId.get("working")!.terminal).toBe(true);
  });

  it("rejects transitions to undeclared statuses", () => {
    const result = ok(`
statuses:
  - id: new
  - id: done
    terminal: true
transitions:
  new: [done, ghost]
  done: [new]
`);
    expect(result.errors.join("\n")).toContain('targets an unknown status');
  });

  it("rejects a non-terminal status with no outgoing transition", () => {
    const result = ok(`
statuses:
  - id: new
  - id: working
  - id: done
    terminal: true
transitions:
  new: [done]
  done: [new]
`);
    expect(result.errors.join("\n")).toContain('"working" is not terminal but has no outgoing transition');
  });

  it("rejects an initial status that is terminal", () => {
    const result = ok(`
initial: done
statuses:
  - id: done
    terminal: true
`);
    expect(result.errors.join("\n")).toContain("cannot be terminal");
  });

  it("reports YAML syntax errors without throwing", () => {
    const result = ok("statuses: [\n");
    expect(result.workflow).toBeNull();
    expect(result.errors[0]).toContain("Invalid YAML");
  });

  it("accepts JSON workflows", () => {
    const result = ok(
      JSON.stringify({
        initial: "todo",
        statuses: [{ id: "todo" }, { id: "finished", terminal: true }],
        transitions: { todo: ["finished"], finished: ["todo"] },
      }),
      "json",
    );
    expect(result.errors).toEqual([]);
    expect(result.workflow!.byId.get("finished")!.terminal).toBe(true);
  });

  it("rejects duplicate status ids", () => {
    const result = ok(`statuses: [a, a]\n`);
    expect(result.errors.join("\n")).toContain("Duplicate status id");
  });

  it("rejects self-transitions", () => {
    const result = ok(`
statuses:
  - id: new
  - id: done
    terminal: true
transitions:
  new: [new, done]
  done: [new]
`);
    expect(result.errors.join("\n")).toContain("cannot point to itself");
  });
});
