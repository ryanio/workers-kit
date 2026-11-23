// Fails when a package in packages/ is missing from the places that list every
// package: the root README (its entry in the package list and its install line)
// and the root AGENTS.md. A private package needs only the AGENTS.md entry,
// since it is not installable yet.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const readme = readFileSync(join(ROOT, "README.md"), "utf8");
const agents = readFileSync(join(ROOT, "AGENTS.md"), "utf8");

const problems = [];
for (const dir of readdirSync(join(ROOT, "packages"))) {
  let manifest;
  try {
    manifest = JSON.parse(
      readFileSync(join(ROOT, "packages", dir, "package.json"), "utf8"),
    );
  } catch {
    continue;
  }
  const { name } = manifest;
  if (!agents.includes(`[\`packages/${dir}\`](packages/${dir}/AGENTS.md)`)) {
    problems.push(`AGENTS.md does not list packages/${dir}`);
  }
  if (manifest.private === true) continue;
  if (!readme.includes(`\n- [${name}](packages/${dir}#readme) `)) {
    problems.push(`README.md has no entry for ${name} in the package list`);
  }
  if (
    !readme.includes(`npm install ${name}\n`) &&
    !readme.includes(`npm install --save-dev ${name}\n`)
  ) {
    problems.push(`README.md has no "npm install ${name}" line`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`package list: ${problem}`);
  process.exit(1);
}
console.log("package list: README.md and AGENTS.md name every package");
