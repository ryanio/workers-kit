import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Runs against the built dist/, which is what ships.
const DIST = join(import.meta.dirname, "..", "dist");
const builtJs = readdirSync(DIST).filter((name) => name.endsWith(".js"));

describe("built package", () => {
  it("keeps node: imports out of everything but the secret check", () => {
    for (const name of builtJs.filter((n) => !n.startsWith("check-bundle"))) {
      expect(readFileSync(join(DIST, name), "utf8"), name).not.toMatch(
        /from\s+["']node:|import\(["']node:/,
      );
    }
  });

  it("never imports cloudflare:workers by a literal specifier", () => {
    for (const name of builtJs) {
      expect(readFileSync(join(DIST, name), "utf8"), name).not.toMatch(
        /(from\s+|import\()["']cloudflare:workers["']/,
      );
    }
  });

  it("resolves every export, including from require", () => {
    const require = createRequire(
      join(import.meta.dirname, "..", "package.json"),
    );
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"),
    );
    for (const subpath of Object.keys(pkg.exports)) {
      const specifier =
        subpath === "." ? "workers-start" : `workers-start/${subpath.slice(2)}`;
      expect(require.resolve(specifier), specifier).toBeTruthy();
    }
  });

  it("keeps optional peers out of the root entry's types", () => {
    // An app without @sentry/core or react imports the root entry too, and a
    // declaration that names a missing peer fails its tsc (TS2307).
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"),
    );
    const peers = Object.keys(pkg.peerDependencies ?? {});
    const seen = new Set<string>();
    const reached: string[] = [];
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(join(DIST, file), "utf8");
      for (const [, spec] of text.matchAll(/from\s+["']([^"']+)["']/g)) {
        if (!spec) continue;
        if (spec.startsWith("./"))
          walk(spec.slice(2).replace(/\.js$/, ".d.ts"));
        else reached.push(spec);
      }
    };
    walk("index.d.ts");
    expect(reached.filter((spec) => peers.includes(spec))).toEqual([]);
  });
});
