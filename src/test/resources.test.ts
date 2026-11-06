/**
 * T-0028 (0.4.0): the package now ships a skill and a prompt, and `/kanban` is
 * read-only. These tests pin the shipped resources as data — frontmatter,
 * routing quality of the skill description, and `package.json` wiring — so a
 * rename or a dropped `files` entry fails here rather than after publish.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { USAGE } from "../command.ts";

/** The package root, two levels above `src/test/`. */
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const read = (relative: string) => readFileSync(join(ROOT, relative), "utf8");

/** `---\n<yaml>\n---\n<body>` — the shape both pi skills and prompts use. */
function frontmatter(relative: string): { data: Record<string, unknown>; body: string } {
  const text = read(relative);
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  expect(match, `${relative} must start with a --- frontmatter block`).not.toBeNull();
  return { data: parseYaml(match![1]) as Record<string, unknown>, body: match![2] };
}

const nonEmptyFile = (relative: string) => {
  const path = join(ROOT, relative);
  expect(existsSync(path), `${relative} must exist`).toBe(true);
  expect(statSync(path).isFile()).toBe(true);
  expect(readFileSync(path, "utf8").trim().length).toBeGreaterThan(0);
};

describe("skills/kanban/SKILL.md", () => {
  const SKILL = "skills/kanban/SKILL.md";

  it("has pi skill frontmatter with the name that matches its directory", () => {
    const { data } = frontmatter(SKILL);
    expect(data.name).toBe("kanban");
    expect(typeof data.name).toBe("string");
  });

  it("has a description short enough to route on and specific enough to fire", () => {
    const { data } = frontmatter(SKILL);
    const description = data.description;
    expect(typeof description).toBe("string");
    const text = description as string;
    expect(text.trim().length).toBeGreaterThan(0);
    // pi truncates skill descriptions past 1024 characters.
    expect(text.length).toBeLessThanOrEqual(1024);
    // Routing quality: the description must name the board and the coordinating
    // job, not just "kanban".
    expect(text.toLowerCase()).toMatch(/board/);
    expect(text.toLowerCase()).toMatch(/coordinat|multi-agent|agents/);
  });

  it("keeps the two reference files, both non-empty", () => {
    nonEmptyFile("skills/kanban/references/coordination.md");
    nonEmptyFile("skills/kanban/references/workflow-authoring.md");
  });

  it("points at its own body rather than restating the tool schemas", () => {
    const { body } = frontmatter(SKILL);
    expect(body.length).toBeGreaterThan(200);
    expect(body).toContain("kanban_list");
  });
});

describe("prompts/standup.md", () => {
  const PROMPT = "prompts/standup.md";

  it("declares a description and an argument hint that takes a handle", () => {
    nonEmptyFile(PROMPT);
    const { data } = frontmatter(PROMPT);
    expect(typeof data.description).toBe("string");
    expect((data.description as string).trim().length).toBeGreaterThan(0);
    expect(typeof data["argument-hint"]).toBe("string");
    expect(data["argument-hint"] as string).toContain("handle");
  });

  it("builds the standup from kanban_list, not from memory", () => {
    const { body } = frontmatter(PROMPT);
    expect(body).toContain("kanban_list");
    expect(body).toContain("${1}");
  });
});

describe("skills/kanban-setup/SKILL.md", () => {
  const SKILL = "skills/kanban-setup/SKILL.md";

  it("has pi skill frontmatter with the name that matches its directory", () => {
    nonEmptyFile(SKILL);
    const { data } = frontmatter(SKILL);
    expect(data.name).toBe("kanban-setup");
    expect(typeof data.name).toBe("string");
  });

  it("describes both the job and when to load it, within the 1024 limit", () => {
    const { data } = frontmatter(SKILL);
    const text = data.description as string;
    expect(typeof text).toBe("string");
    expect(text.trim().length).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(1024);
    expect(text.toLowerCase()).toMatch(/workflow/);
    expect(text.toLowerCase()).toMatch(/use when/);
  });

  it("sets a board up with file writes, not by running a slash command", () => {
    const { body } = frontmatter(SKILL);
    expect(body).toContain("\.pi/kanban/workflow.yaml");
    expect(body).toContain("kanban_list");
    // The skill must not tell the agent to invoke a human slash command.
    expect(body).not.toMatch(/run\s+`?\/kanban/);
    expect(body).not.toMatch(/\/kanban init/);
    expect(body).not.toMatch(/\/kanban validate/);
  });

  it("points at the authoring rules it depends on", () => {
    const { body } = frontmatter(SKILL);
    expect(body).toContain("../kanban/references/workflow-authoring.md");
  });
});

describe("prompts/review.md", () => {
  const PROMPT = "prompts/review.md";

  it("declares a description and takes no arguments", () => {
    nonEmptyFile(PROMPT);
    const { data } = frontmatter(PROMPT);
    expect(typeof data.description).toBe("string");
    expect((data.description as string).trim().length).toBeGreaterThan(0);
    expect(data["argument-hint"]).toBeUndefined();
  });

  it("runs the reviewer role through the board and its tools, not slash commands", () => {
    const { body } = frontmatter(PROMPT);
    expect(body).toContain("kanban_list");
    expect(body).toContain("kanban_comment");
    expect(body).toContain("wrong_owner");
    expect(body).not.toMatch(/\/kanban init/);
    expect(body).not.toMatch(/\/kanban validate/);
  });
});

describe("package.json ships the resources", () => {
  let pkg: {
    version: string;
    files: string[];
    pi: { extensions: string[]; skills: string[]; prompts: string[] };
  };

  beforeEach(() => {
    pkg = JSON.parse(read("package.json")) as typeof pkg;
  });

  it("matches the newest CHANGELOG entry", () => {
    // Pinning a literal version here breaks every release; the invariant that
    // matters is package.json and the changelog agreeing on the newest entry.
    const heading = read("CHANGELOG.md").match(/^## (\d+\.\d+\.\d+)/m);
    expect(heading?.[1]).toBeDefined();
    expect(pkg.version).toBe(heading?.[1]);
  });

  it("ships every prompt file the glob will discover", () => {
    expect(pkg.pi.prompts).toEqual(["./prompts/*.md"]);
  });

  it("declares pi.skills and pi.prompts next to the extension", () => {
    expect(Array.isArray(pkg.pi.skills)).toBe(true);
    expect(pkg.pi.skills.length).toBeGreaterThan(0);
    expect(Array.isArray(pkg.pi.prompts)).toBe(true);
    expect(pkg.pi.prompts.length).toBeGreaterThan(0);
    expect(pkg.pi.extensions).toContain("./src/index.ts");
    // The declared roots really exist in the package.
    expect(existsSync(join(ROOT, "skills/kanban/SKILL.md"))).toBe(true);
    expect(existsSync(join(ROOT, "skills/kanban-setup/SKILL.md"))).toBe(true);
    expect(existsSync(join(ROOT, "prompts/standup.md"))).toBe(true);
    expect(existsSync(join(ROOT, "prompts/review.md"))).toBe(true);
  });

  it("includes skills/** and prompts/** in the published files", () => {
    expect(pkg.files).toContain("skills/**");
    expect(pkg.files).toContain("prompts/**");
  });
});

describe("/kanban is inspection-only", () => {
  it("names neither removed mutating subcommand in USAGE", () => {
    expect(USAGE).not.toContain("repair-ids");
    // `A terminal status releases the claim` is prose; no invocation is named.
    expect(USAGE).not.toContain("/kanban release");
    expect(USAGE).not.toContain("/kanban repair-ids");
  });
});
