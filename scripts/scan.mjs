// specrcheckr — denylist scan. A publish tripwire: fail if any banned term
// appears in the repo's files. Catches proprietary/internal content before it
// goes public. Combine a built-in list with `denylist` in your config.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Built-in terms that must never appear in this public tool.
const BUILTIN_DENYLIST = [
  "nullsheet",
  "reconboard",
  "mcp-spec-review",
  "codex-handoff",
  "relevantuse.com",
  "rsvp",
  "sxjwthizlrsdujxjoond",
  "rodjfqtxfyqaatailxem",
  "onbhtbsrokzxwphiipxu",
];

const SKIP_DIRS = new Set([".git", "node_modules", ".spec-review", "dist", "build"]);
// Files allowed to mention denylist terms (this scanner defines them).
const ALLOW_FILES = new Set(["scripts/scan.mjs"]);
const NUL = String.fromCharCode(0);

export function scan({ config, root }) {
  const terms = [...new Set([...BUILTIN_DENYLIST, ...(config.denylist || [])].map((t) => t.toLowerCase()))];
  const hits = [];

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const rel = relative(root, full);
      if (ALLOW_FILES.has(rel)) continue;
      let text;
      try {
        if (statSync(full).size > 2 * 1024 * 1024) continue;
        text = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      if (text.includes(NUL)) continue; // skip binary files
      const lower = text.toLowerCase();
      for (const term of terms) {
        let idx = lower.indexOf(term);
        while (idx !== -1) {
          const line = text.slice(0, idx).split("\n").length;
          hits.push({ file: rel, term, line });
          idx = lower.indexOf(term, idx + term.length);
        }
      }
    }
  }
  walk(root);

  if (hits.length) {
    console.error(`specrcheckr: DENYLIST SCAN FAILED — ${hits.length} match(es):`);
    for (const h of hits.slice(0, 100)) console.error(`  - ${h.file}:${h.line}  contains "${h.term}"`);
    if (hits.length > 100) console.error(`  … and ${hits.length - 100} more`);
    return 1;
  }
  console.log(`specrcheckr: denylist scan clean (${terms.length} term(s) checked).`);
  return 0;
}
