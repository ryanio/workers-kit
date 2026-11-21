#!/usr/bin/env node
// Each package's AGENTS.md names the apps that depend on it, and the release
// rule reads that list: after a release, move the consumers onto the new
// version. A stale list means a skipped sweep, which is how three of them went
// wrong at once. So the list is derived from the apps' own package.json files
// rather than remembered, and this fails when the two disagree.
//
// It checks that every app depending on a package is named, not that nothing
// else is: a package before its first release names the apps that should move
// onto it, and that list is worth keeping.
//
// The apps are siblings of this checkout (~/dev/*), which CI does not have. A
// run that finds no dependency on any of our packages has nothing to compare
// and passes with a note, so this only really checks on a machine with the
// apps on it. `--write` rewrites the lines instead of failing.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SIBLINGS = resolve(ROOT, "..");
/** Deep enough for `apps/<app>` and `packages/<pkg>` in a monorepo. */
const MAX_DEPTH = 3;
const SKIP = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  ".wrangler",
  ".output",
  ".next",
  "worktrees",
  ".claude",
  "old",
]);

const ours = readdirSync(join(ROOT, "packages")).flatMap((dir) => {
  const manifest = join(ROOT, "packages", dir, "package.json");
  try {
    return [{ dir, name: JSON.parse(readFileSync(manifest, "utf8")).name }];
  } catch {
    return [];
  }
});
const names = new Set(ours.map((pkg) => pkg.name));

/** Every dependency name declared anywhere under `dir`, to `MAX_DEPTH`. */
function dependenciesIn(dir, depth = 0) {
  const found = new Set();
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name === "package.json") {
      try {
        const manifest = JSON.parse(
          readFileSync(join(dir, entry.name), "utf8"),
        );
        for (const field of [
          "dependencies",
          "devDependencies",
          "peerDependencies",
        ]) {
          for (const name of Object.keys(manifest[field] ?? {})) {
            if (names.has(name)) {
              found.add(name);
            }
          }
        }
      } catch {
        // A manifest that will not parse is the app's problem, not ours.
      }
    }
    if (
      entry.isDirectory() &&
      depth < MAX_DEPTH &&
      !SKIP.has(entry.name) &&
      !entry.name.startsWith(".")
    ) {
      for (const name of dependenciesIn(join(dir, entry.name), depth + 1)) {
        found.add(name);
      }
    }
  }
  return found;
}

const consumers = new Map(ours.map((pkg) => [pkg.name, []]));
for (const entry of readdirSync(SIBLINGS, { withFileTypes: true })) {
  if (
    !entry.isDirectory() ||
    entry.name.startsWith(".") ||
    SKIP.has(entry.name) ||
    resolve(SIBLINGS, entry.name) === ROOT
  ) {
    continue;
  }
  const app = join(SIBLINGS, entry.name);
  try {
    statSync(join(app, "package.json"));
  } catch {
    continue;
  }
  for (const name of dependenciesIn(app)) {
    consumers.get(name)?.push(entry.name);
  }
}

const total = [...consumers.values()].reduce((n, list) => n + list.length, 0);
if (total === 0) {
  console.log(
    "consumers: no apps beside this checkout, nothing to check (CI does this)",
  );
  process.exit(0);
}

/** "a, b and c (all in `~/dev`)." */
function sentence(apps) {
  const list =
    apps.length === 1
      ? apps[0]
      : `${apps.slice(0, -1).join(", ")} and ${apps.at(-1)}`;
  return `${list} (all in \`~/dev\`).`;
}

const write = process.argv.includes("--write");
const problems = [];
const skipped = [];

for (const { dir, name } of ours) {
  const path = join(ROOT, "packages", dir, "AGENTS.md");
  const text = readFileSync(path, "utf8");
  const line = /^- Consumers: (.*)$/m.exec(text);
  if (!line) {
    problems.push(`packages/${dir}/AGENTS.md has no "- Consumers:" line`);
    continue;
  }
  const apps = (consumers.get(name) ?? []).sort();
  const had = line[1] ?? "";

  // Nothing depends on it yet, so there is nothing to contradict. A package
  // before its first release names the apps that *should* move onto it, which
  // is the one thing this must not overwrite.
  if (apps.length === 0) {
    skipped.push(dir);
    continue;
  }

  // What matters is that every app depending on the package is named: an app
  // left off is an app the post-release sweep misses. The line may well name
  // more, which is how a package reads before anything has adopted it.
  const missing = apps.filter((app) => !new RegExp(`\\b${app}\\b`).test(had));
  if (missing.length === 0) {
    continue;
  }
  if (write) {
    // Only the list is generated; the instruction after it is the package's
    // own and is kept as it is.
    const rest = had.slice(had.indexOf(")") + 1).replace(/^\.\s*/, "");
    const replaced = `- Consumers: ${sentence(apps)}${rest ? ` ${rest}` : ""}`;
    writeFileSync(path, text.replace(line[0], replaced));
    console.log(`consumers: rewrote packages/${dir}/AGENTS.md`);
    continue;
  }
  problems.push(
    `packages/${dir}/AGENTS.md does not name ${missing.join(", ")}\n    says:  ${had}\n    found: ${sentence(apps)}`,
  );
}

if (problems.length > 0) {
  console.error(
    `consumers: ${problems.length} list${problems.length === 1 ? "" : "s"} out of date\n  ${problems.join("\n  ")}\nRun \`npm run check:consumers -- --write\` to update them.`,
  );
  process.exit(1);
}
const checked = ours.length - skipped.length;
const note =
  skipped.length > 0 ? `, ${skipped.join(" and ")} not adopted yet` : "";
console.log(
  `consumers: ${checked} list${checked === 1 ? "" : "s"} name every app that depends on them${note}`,
);
