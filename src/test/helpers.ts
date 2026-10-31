import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveBoard, type BoardLocation } from "../paths.ts";
import { FILES } from "../paths.ts";

export const LINEAR_WORKFLOW = `name: linear
initial: new
statuses:
  - id: new
    label: New
  - id: working
    label: Working
    active: true
  - id: done
    label: Done
    terminal: true
transitions:
  new: [working]
  working: [new, done]
  done: [working]
`;

/** A board in a fresh temp dir with the given workflow text. */
export function makeBoard(workflow: string | null = LINEAR_WORKFLOW): BoardLocation {
  const root = mkdtempSync(join(tmpdir(), "kanban-"));
  const dir = join(root, ".pi/kanban");
  mkdirSync(join(dir, FILES.tasks), { recursive: true });
  if (workflow !== null) {
    writeFileSync(join(dir, FILES.workflowYaml), workflow, "utf8");
  }
  return resolveBoard({ cwd: root, env: {} });
}

/** The parsed YAML-ish frontmatter of a task file, for assertions. */
export function frontmatterOf(location: BoardLocation, id: string): Record<string, unknown> {
  const text = readFileSync(join(location.tasksDir, `${id}.md`), "utf8");
  const end = text.indexOf("\n---", 4);
  const raw = text.slice(4, end + 1);
  const out: Record<string, unknown> = {};
  let current: string | undefined;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    if (/^\S/.test(line)) {
      const [key, ...rest] = line.split(":");
      const value = rest.join(":").trim();
      current = key;
      if (value) out[key] = value;
    } else if (current && line.trim().startsWith("- ")) {
      // Nested list items are not needed by these tests.
    }
  }
  return out;
}

export function bodyOf(location: BoardLocation, id: string): string {
  const text = readFileSync(join(location.tasksDir, `${id}.md`), "utf8");
  const end = text.indexOf("\n---", 4);
  return text.slice(end + 4);
}

export function fixedClock(times: string[]) {
  let index = 0;
  return {
    now: () => {
      const value = times[Math.min(index, times.length - 1)];
      index += 1;
      return new Date(value);
    },
  };
}

export function taskFile(location: BoardLocation, id: string, content: string): void {
  mkdirSync(dirname(join(location.tasksDir, `${id}.md`)), { recursive: true });
  writeFileSync(join(location.tasksDir, `${id}.md`), content, "utf8");
}
