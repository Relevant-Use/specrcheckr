#!/usr/bin/env node
// specrcheckr CLI — review | serve | check | validate | scan | init
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { loadConfig } from "../scripts/lib.mjs";
import { generate } from "../scripts/generate.mjs";
import { serve } from "../scripts/serve.mjs";
import { check } from "../scripts/check.mjs";
import { validate } from "../scripts/validate.mjs";
import { scan } from "../scripts/scan.mjs";

const args = process.argv.slice(2);
const cmd = args[0];
const ci = args.indexOf("--config");
const configArg = ci >= 0 ? args[ci + 1] : undefined;

function usage() {
  console.log(`specrcheckr — a spec-first change-approval gate

Usage:
  specrcheckr <command> [--config <path>]

Commands:
  init        Scaffold a config + starter feature tree in this repo
  review      Generate the review page (.spec-review/index.html)
  serve       Generate + serve the page and save decisions
  check       Pass/fail gate based on the saved approval (for CI / pre-push)
  validate    Validate your feature tree against the schema
  scan        Denylist scan (fail if banned terms appear in the repo)

Docs: README.md (start here, written for AI assistants) and MANUAL-SETUP.md`);
}

function doInit() {
  const cwd = process.cwd();
  const configPath = resolve(cwd, "specrcheckr.config.json");
  const treePath = resolve(cwd, "docs/specs/feature-tree.json");
  let wrote = [];

  if (!existsSync(configPath)) {
    const cfg = {
      productName: basename(cwd),
      featureTree: "docs/specs/feature-tree.json",
      baseRef: "origin/main",
      baseTree: null,
      behaviorGlobs: ["src/**", "app/**", "lib/**", "components/**", "pages/**", "server/**"],
      specGlobs: ["docs/specs/**"],
      securityGlobs: ["**/auth/**", "**/*rls*", "**/middleware.*"],
      outputDir: ".spec-review",
      denylist: [],
    };
    writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
    wrote.push("specrcheckr.config.json");
  }

  if (!existsSync(treePath)) {
    mkdirSync(dirname(treePath), { recursive: true });
    const starter = {
      version: "1",
      root: {
        id: "product",
        label: basename(cwd),
        description: "TODO: one sentence describing what this product does. Replace this whole tree with your real features (an AI assistant can draft it from your codebase).",
        status: "implemented",
        children: [],
      },
    };
    writeFileSync(treePath, `${JSON.stringify(starter, null, 2)}\n`);
    wrote.push("docs/specs/feature-tree.json (starter)");
  }

  const giPath = resolve(cwd, ".gitignore");
  const gi = existsSync(giPath) ? readFileSync(giPath, "utf8") : "";
  if (!gi.includes(".spec-review")) {
    writeFileSync(giPath, `${gi}${gi && !gi.endsWith("\n") ? "\n" : ""}.spec-review/\n`);
    wrote.push(".gitignore (+ .spec-review/)");
  }

  if (wrote.length) {
    console.log("specrcheckr init — created:");
    for (const w of wrote) console.log(`  - ${w}`);
  } else {
    console.log("specrcheckr init — already set up (nothing to create).");
  }
  console.log("\nNext: fill out docs/specs/feature-tree.json, then run `specrcheckr review`.");
  return 0;
}

try {
  if (cmd === "init") process.exit(doInit());
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    usage();
    process.exit(cmd ? 0 : 1);
  }

  const ctx = loadConfig(configArg);

  switch (cmd) {
    case "review": {
      const { packet } = generate(ctx);
      console.log("specrcheckr: review packet generated:");
      console.log(`  ${packet.file_url}`);
      console.log(`  ${packet.touched_nodes.length} changed feature(s), ${packet.flags.length} flag(s).`);
      process.exit(0);
      break;
    }
    case "serve":
      serve(ctx);
      break;
    case "check":
      process.exit(check(ctx));
      break;
    case "validate":
      process.exit(validate(ctx));
      break;
    case "scan":
      process.exit(scan(ctx));
      break;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      usage();
      process.exit(1);
  }
} catch (err) {
  console.error(`specrcheckr error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
