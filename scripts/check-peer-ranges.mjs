// Fails when a package's peer range admits more than one line of a library:
// a `>=`, `*`, `||` or `x` range, anything but a caret, or a bare `^0`, which
// spans every 0.x minor. A sibling package in this repo may be peered
// `>=<tested> <1`.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const dirs = readdirSync(join(root, "packages"));
const siblings = new Set(
  dirs.map(
    (dir) =>
      JSON.parse(
        readFileSync(join(root, "packages", dir, "package.json"), "utf8"),
      ).name,
  ),
);

/** Why a range spans more than one line, or null when it names one. */
function spread(range, sibling) {
  if (sibling && /^>=\d+\.\d+\.\d+ <1$/.test(range)) return null;
  if (/\|\||\*|\bx\b|^>|^</.test(range)) return "spans more than one line";
  if (!/^\^\d+(\.\d+){0,2}$/.test(range)) return "is not a caret range";
  if (/^\^0(\.\d+)?$/.test(range) && !/^\^0\.\d+/.test(range))
    return "spans every 0.x minor";
  return null;
}

const problems = [];
for (const dir of dirs) {
  const pkg = JSON.parse(
    readFileSync(join(root, "packages", dir, "package.json"), "utf8"),
  );
  for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
    const why = spread(range, siblings.has(name));
    if (why) problems.push(`${pkg.name}: peer ${name} "${range}" ${why}`);
  }
}
if (problems.length) {
  console.error(problems.join("\n"));
  console.error(
    "Peer one line of each library (AGENTS.md, Rules): `^11`, `^19`, `^0.63`.",
  );
  process.exit(1);
}
console.log(`peers: every peer range names one line`);
