#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { main } from "../src/index.mjs";

try {
  execFileSync("git", ["rev-parse", "--show-toplevel"], { stdio: "ignore" });
} catch {
  console.error(`doc-refs: ${process.cwd()} is not inside a git repo`);
  process.exit(2);
}
process.exit(main());
