import { expect, test } from "bun:test";
import { dirname, join, relative } from "node:path";
import { Glob } from "bun";

const SOURCE = join(import.meta.dir, "../src");
/** Modules in dependency order: a module may use only the modules before it. */
const MODULES = [
  "accounts",
  "workspaces",
  "llm",
  "threads",
  "integrations",
  "search",
  "settings",
];
/** The files of a module that route or render; the other files are its service. */
const UI_FILES = new Set(["web.ts", "api.ts", "pages.ts", "shell.ts"]);
/** What other modules may render from a module, next to its entry file. */
const SHARED_UI_FILES = new Set(["pages.ts", "shell.ts"]);
/** The route helpers that module routes and pages use. */
const ROUTE_KIT = new Set(["app/http.ts", "app/web.ts", "app/api.ts"]);

test("modules import only what the module rules allow", async () => {
  const violations: string[] = [];
  for await (const file of new Glob("**/*.ts").scan(SOURCE)) {
    if (file.endsWith(".test.ts")) {
      continue;
    }
    const text = await Bun.file(join(SOURCE, file)).text();
    for (const [, specifier] of text.matchAll(/from "(\.[^"]+)"/g)) {
      const target = relative(SOURCE, join(SOURCE, dirname(file), specifier!));
      if (!(target.startsWith("..") || allowed(file, target))) {
        violations.push(`${file} imports ${target}`);
      }
    }
  }
  expect(violations).toEqual([]);
});

function allowed(file: string, target: string): boolean {
  if (file === "main.ts" || file === "app/routes.ts") {
    return true;
  }
  if (target.startsWith("platform/")) {
    return true;
  }
  if (file.startsWith("platform/")) {
    return false;
  }
  if (file === "app/app.ts") {
    return isServiceFile(target);
  }
  if (ROUTE_KIT.has(file)) {
    return ROUTE_KIT.has(target) || target === "app/app.ts";
  }
  const [module, name] = file.split("/") as [string, string];
  const [targetModule, targetName] = target.split("/") as [string, string];
  const ui = UI_FILES.has(name);
  if (targetModule === "app") {
    return ui && ROUTE_KIT.has(target);
  }
  if (targetModule === module) {
    return ui || !UI_FILES.has(targetName);
  }
  if (MODULES.indexOf(targetModule) >= MODULES.indexOf(module)) {
    return false;
  }
  return (
    targetName === `${targetModule}.ts` ||
    (ui && SHARED_UI_FILES.has(targetName))
  );
}

function isServiceFile(path: string): boolean {
  const [module, name] = path.split("/") as [string, string];
  return MODULES.includes(module) && !UI_FILES.has(name);
}

test("the rules catch a module that reaches past its neighbours", () => {
  expect(allowed("workspaces/workspaces.ts", "threads/threads.ts")).toBe(false);
  expect(allowed("threads/threads.ts", "workspaces/workspaces.ts")).toBe(true);
  expect(allowed("search/search.ts", "threads/pages.ts")).toBe(false);
  expect(allowed("search/web.ts", "workspaces/shell.ts")).toBe(true);
  expect(allowed("settings/pages.ts", "llm/web.ts")).toBe(false);
  expect(allowed("llm/llm.ts", "app/web.ts")).toBe(false);
  expect(allowed("platform/auth.ts", "workspaces/workspaces.ts")).toBe(false);
  expect(allowed("app/app.ts", "search/embedder.ts")).toBe(true);
  expect(allowed("app/app.ts", "search/web.ts")).toBe(false);
});
