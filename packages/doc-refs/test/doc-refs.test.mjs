import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { check, extract, globToRegExp, trackedTree } from "../src/index.mjs";

const FILES = [
  "AGENTS.md",
  "apps/api/AGENTS.md",
  "apps/api/src/lib/auth.ts",
  "apps/api/scripts/seed.ts",
  "docs/guide.md",
  ".claude/commands/push.md",
  ".agents/skills/sentry/SKILL.md",
  "plans/archived/old.md",
  "docs/sentry-log.md",
];

function run(docs, config, gitIgnored) {
  const files = [
    ...FILES,
    ...Object.keys(docs).filter((d) => !FILES.includes(d)),
  ];
  const { has } = trackedTree(files);
  const read = (f) => docs[f] ?? "";
  return check({ files, read, has, config, gitIgnored }).broken.map(
    (b) => `${b.doc}:${b.line} ${b.token}`,
  );
}

test("a moved file is reported, an existing one is not", () => {
  assert.deepEqual(
    run({
      "AGENTS.md": "See `apps/api/src/lib/auth.ts` and `apps/api/src/auth.ts`.",
    }),
    ["AGENTS.md:1 apps/api/src/auth.ts"],
  );
});

test("a path in a sub-folder doc resolves from that folder or the repo root", () => {
  assert.deepEqual(
    run({
      "apps/api/AGENTS.md":
        "`scripts/seed.ts`, `src/lib/auth.ts`, `scripts/gone.ts`",
    }),
    ["apps/api/AGENTS.md:1 scripts/gone.ts"],
  );
});

test("a token whose first segment is not in the repo is not treated as a path", () => {
  assert.deepEqual(
    run({
      "AGENTS.md": "`users/{uid}/meals`, `data/queue.json`, `owner/repo`",
    }),
    [],
  );
});

test("relative links resolve from the doc folder, URLs and anchors are skipped", () => {
  const doc =
    "[a](../AGENTS.md) [b](../missing.md) [c](https://x.dev) [d](#top) [e](guide.md#part)";
  assert.deepEqual(run({ "docs/README.md": doc }), [
    "docs/README.md:1 ../missing.md",
  ]);
});

test("fenced blocks and placeholders are skipped", () => {
  const doc =
    "```\n`apps/api/gone.ts`\n```\n`apps/api/.../x.ts` `docs/YYYY-MM-DD.md` `apps/<app>/x.ts`";
  assert.deepEqual(run({ "AGENTS.md": doc }), []);
});

test("a fence after a blank line ends at its own closing fence", () => {
  const doc =
    "Intro\n\n```bash\nnpm test\n```\n\n`apps/api/gone.ts`\n\n```md\nx\n```\n";
  assert.deepEqual(run({ "AGENTS.md": doc }), ["AGENTS.md:7 apps/api/gone.ts"]);
});

test("line-number suffixes and module specifiers resolve", () => {
  const doc =
    "`apps/api/src/lib/auth.ts:12-30` `apps/api/src/lib/auth.js` `apps/api/src/lib/auth`";
  assert.deepEqual(run({ "AGENTS.md": doc }), []);
});

test("slash names are checked only in command and skill docs", () => {
  const doc = "`/push` `/sentry` `/code-review` `/gone` `/pricing`";
  assert.deepEqual(
    run({ ".claude/commands/deploy.md": doc }, { externalSlash: ["pricing"] }),
    [".claude/commands/deploy.md:1 /gone"],
  );
  assert.deepEqual(run({ "AGENTS.md": doc }), []);
});

test("logs and archives are not scanned", () => {
  assert.deepEqual(
    run({
      "plans/archived/old.md": "`apps/gone.ts`",
      "docs/sentry-log.md": "`apps/gone.ts`",
    }),
    [],
  );
});

test("config ignore and gitignored paths pass", () => {
  const doc =
    "`apps/api/.env.local` `apps/api/dist/out.js` `apps/api/example.ts`";
  const gitIgnored = (paths) =>
    new Set(paths.filter((p) => p.includes("/dist/")));
  assert.deepEqual(
    run({ "AGENTS.md": doc }, { ignore: ["apps/api/example.ts"] }, gitIgnored),
    [],
  );
});

test("a gitignored path resolved from the doc folder passes", () => {
  const doc = "`src/generated/index.ts` `../scripts/gen.ts` `src/gone.ts`";
  const asked = [];
  const gitIgnored = (paths) => {
    asked.push(...paths);
    return new Set(
      paths.filter(
        (p) =>
          p.startsWith("apps/api/src/generated/") ||
          p === "apps/scripts/gen.ts",
      ),
    );
  };
  assert.deepEqual(run({ "apps/api/AGENTS.md": doc }, {}, gitIgnored), [
    "apps/api/AGENTS.md:1 src/gone.ts",
  ]);
  assert.ok(
    !asked.includes("src/generated/index.ts"),
    "a token whose first segment is not top level is not asked from the root",
  );
});

test("a path through a tracked symlink resolves", () => {
  const tree = trackedTree([
    ".agents/skills/sentry/SKILL.md",
    ".claude/skills",
  ]);
  assert.equal(tree.has(".agents/skills/sentry/SKILL.md"), true);
  assert.equal(tree.has(".agents/skills/"), true);
  assert.equal(tree.has(".agents/skills/nope.md"), false);
});

test("extract numbers lines", () => {
  assert.deepEqual(
    extract("one\n`a/b.ts`\n[x](y.md)").map((r) => [r.kind, r.line]),
    [
      ["tick", 2],
      ["link", 3],
    ],
  );
});

test("globs", () => {
  assert.equal(globToRegExp("**/AGENTS.md").test("AGENTS.md"), true);
  assert.equal(globToRegExp("**/AGENTS.md").test("a/b/AGENTS.md"), true);
  assert.equal(globToRegExp("docs/*.md").test("docs/a/b.md"), false);
});

test("text rules: a required string, a forbidden pattern in a code block, a rule that matches nothing", () => {
  const config = {
    text: [
      {
        docs: [".agents/skills/sentry/SKILL.md"],
        require: ["dataset=tracemetrics"],
        forbid: ["metrics/(query|meta)/"],
      },
      { docs: ["docs/gone.md"], require: ["x"] },
    ],
  };
  assert.deepEqual(
    run(
      {
        ".agents/skills/sentry/SKILL.md":
          "Query it.\n```\ncurl sentry.io/api/0/metrics/query/\n```\n",
      },
      config,
    ),
    [
      ".agents/skills/sentry/SKILL.md:0 dataset=tracemetrics",
      ".agents/skills/sentry/SKILL.md:3 metrics/query/",
      "doc-refs.config.json:0 docs/gone.md",
    ],
  );
  assert.deepEqual(
    run(
      { ".agents/skills/sentry/SKILL.md": "Use `dataset=tracemetrics`." },
      { text: [config.text[0]] },
    ),
    [],
  );
});

const BIN = fileURLToPath(new URL("../bin/doc-refs.mjs", import.meta.url));

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), "doc-refs-cli-"));
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(root, dirname(f)), { recursive: true });
    writeFileSync(join(root, f), text);
  }
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  return root;
}

const cli = (cwd, ...args) =>
  spawnSync("node", [BIN, ...args], { cwd, encoding: "utf8" });

test("the bin checks the repo holding the current directory, with the config at its root", () => {
  const root = repo({
    "AGENTS.md": "See `src/gone.ts` and `src/lost.ts`.\n",
    "src/here.ts": "",
    "doc-refs.config.json": JSON.stringify({ ignore: ["src/lost.ts"] }),
  });
  const run = cli(join(root, "src"));
  assert.equal(run.status, 1);
  assert.match(run.stderr, /AGENTS\.md:1 {2}`src\/gone\.ts`/);
  assert.doesNotMatch(run.stderr, /lost/);

  const report = cli(root, "--report");
  assert.equal(report.status, 0);
  assert.match(report.stderr, /1 broken/);
});

test("the bin passes a repo whose references all resolve", () => {
  const run = cli(
    repo({ "AGENTS.md": "See `src/here.ts`.\n", "src/here.ts": "" }),
  );
  assert.equal(run.status, 0);
  assert.match(run.stdout, /0 broken of 1 references in 1 docs/);
});

test("the bin explains a directory outside any git repo", () => {
  const run = cli(mkdtempSync(join(tmpdir(), "doc-refs-nogit-")));
  assert.equal(run.status, 2);
  assert.match(run.stderr, /not inside a git repo/);
});
