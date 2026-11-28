#!/usr/bin/env node
/**
 * workers-start-seo-audit <origin> [--probe pattern ...] [--private-host url ...] [--sitemap url ...] [--limit n] [--json]
 *
 * Exits 1 when the deployed site's indexing signals disagree. Run it after a
 * deploy or on a schedule.
 */

import { auditSite, type SeoAuditOptions } from "./seo-audit.js";

const USAGE = `Usage: workers-start-seo-audit <origin> [options]

  --probe <pattern>     A route that loads by id, such as /blog/$slug. Its literal
                        pattern and a made-up id must answer 404 or noindex. Repeatable.
  --private-host <url>  A host that is not for search, such as an API. Its robots.txt
                        must disallow /. Repeatable.
  --sitemap <url>       Sitemap to read instead of robots.txt's. Repeatable.
  --limit <n>           Sitemap URLs to check. Default 500.
  --json                Print the findings as JSON.`;

function parseArgs(
  argv: string[],
): (SeoAuditOptions & { json: boolean }) | null {
  const probes: string[] = [];
  const privateHosts: string[] = [];
  const sitemaps: string[] = [];
  let origin: string | undefined;
  let limit: number | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--probe") probes.push(value());
    else if (arg === "--private-host") privateHosts.push(value());
    else if (arg === "--sitemap") sitemaps.push(value());
    else if (arg === "--limit") limit = Number(value());
    else if (arg === "--json") json = true;
    else if (arg === "--help" || arg === "-h") return null;
    else if (arg?.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else if (origin === undefined) origin = arg;
    else throw new Error(`unexpected argument ${arg}`);
  }
  if (!origin) return null;
  return {
    origin,
    probes,
    privateHosts,
    json,
    ...(sitemaps.length > 0 ? { sitemaps } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

async function main(): Promise<number> {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(
      `${error instanceof Error ? error.message : error}\n\n${USAGE}`,
    );
    return 2;
  }
  if (!args) {
    console.log(USAGE);
    return 2;
  }
  const { json, ...options } = args;
  const { findings, checked } = await auditSite(options);
  if (json) {
    console.log(JSON.stringify({ checked, findings }, null, 2));
  } else {
    for (const f of findings)
      console.log(`${f.rule}  ${f.url}\n  ${f.message}`);
    console.log(
      `${checked} sitemap URLs checked, ${findings.length} finding${findings.length === 1 ? "" : "s"}`,
    );
  }
  return findings.length > 0 ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error);
    process.exitCode = 2;
  },
);
