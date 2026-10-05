/**
 * The demos get only DEMO_NAMESPACES of the catalog. A component reaching another renders its keys
 * raw, so this walks every module a demo can load - into the controller, as the aliases do - and
 * collects the namespaces they ask for.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { expect, test } from "bun:test";
import catalog from "@cpm/controller/messages/en.json";
import { DEMO_NAMESPACES } from "../../src/demos/catalog";

const site = resolve(import.meta.dir, "../..");
const controller = resolve(site, "../controller");
const extensions = [".ts", ".tsx"];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

function file(base: string): string | null {
  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const ext of extensions) if (existsSync(base + ext)) return base + ext;
  for (const ext of extensions)
    if (existsSync(join(base, `index${ext}`))) return join(base, `index${ext}`);
  return null;
}

/** The aliases in astro.config.mjs that reach the controller; shims resolve as plain files. */
function resolveSpecifier(from: string, spec: string): string | null {
  if (spec.startsWith(".")) return file(resolve(dirname(from), spec));
  if (spec.startsWith("@cpm/controller/")) return file(join(controller, spec.slice(16)));
  if (spec.startsWith("@/components/"))
    return file(join(controller, "src/components", spec.slice(13)));
  if (spec.startsWith("@/lib/")) return file(join(controller, "src/lib", spec.slice(6)));
  if (spec.startsWith("@/src/")) return file(join(controller, "src", spec.slice(6)));
  return null;
}

const imports =
  /(?:import|export)\s+(?!type\b)[^;]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|import\s*["']([^"']+)["']/g;

function demoGraph(): Set<string> {
  const seen = new Set(sources(join(site, "src/demos")));
  const queue = [...seen];
  while (queue.length > 0) {
    const from = queue.pop() as string;
    for (const match of readFileSync(from, "utf8").matchAll(imports)) {
      const target = resolveSpecifier(from, match[1] ?? match[2] ?? match[3]);
      if (!target || seen.has(target)) continue;
      seen.add(target);
      queue.push(target);
    }
  }
  return seen;
}

test("the demos are given every namespace they read", () => {
  const known = new Set(Object.keys(catalog));
  const used = new Map<string, string>();
  for (const path of demoGraph()) {
    const code = readFileSync(path, "utf8");
    const where = relative(site, path).replaceAll("\\", "/");
    for (const match of code.matchAll(/useTranslations\(\s*["'`]([^"'`]+)/g)) {
      used.set(match[1].split(".")[0], where);
    }
    // A root translator names the namespace in each key.
    if (/useTranslations\(\s*\)|createTranslator\(/.test(code)) {
      for (const match of code.matchAll(/\bt\w*\(\s*["'`]([a-zA-Z]+)\./g)) {
        if (known.has(match[1])) used.set(match[1], where);
      }
    }
  }
  const missing = [...used].filter(([namespace]) => !DEMO_NAMESPACES.includes(namespace));
  expect(missing).toEqual([]);
  // Not vacuous: the walk reached the controller's components.
  expect(used.size).toBeGreaterThan(10);
});
