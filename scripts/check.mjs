// specrcheckr — the gate. Pass/fail a push or CI step based on saved approval.
// Exit 0 = approved & current; exit 1 = missing / stale / not approved / has revisions.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { abs, readJsonOrNull } from "./lib.mjs";
import { generate } from "./generate.mjs";

export function check({ config, root }) {
  // Regenerate so the packet reflects the current diff before we judge approval.
  const { outputDir } = generate({ config, root });
  const latest = readJsonOrNull(resolve(outputDir, "latest.json"));
  const approvalPath = resolve(outputDir, "approval.json");

  if (process.env.SPECRCHECKR_BYPASS === "1") {
    console.log("specrcheckr: gate bypassed by SPECRCHECKR_BYPASS=1.");
    return 0;
  }

  // Nothing behavior-relevant changed → nothing to approve.
  if (!latest || (latest.touched_nodes.length === 0 && latest.changed_files.length === 0)) {
    console.log("specrcheckr: no changed features to review — passing.");
    return 0;
  }

  if (!existsSync(approvalPath)) return fail("No approval found. Run `specrcheckr serve`, decide, and save.", latest);
  const approval = readJsonOrNull(approvalPath);
  if (!approval || approval.base !== latest.base || approval.head !== latest.head) {
    return fail("Approval is stale (does not match the current diff). Re-review and save.", latest);
  }
  if (approval.decision !== "approved") return fail("Latest saved decision is not 'approved'.", latest);

  const revised = Object.entries(approval.node_reviews || {})
    .filter(([, r]) => r && r.decision === "revise")
    .map(([id]) => id);
  if (revised.length) return fail(`These features are marked 'revise': ${revised.join(", ")}`, latest);

  console.log("specrcheckr: review approved and current. Gate passed.");
  return 0;
}

function fail(reason, latest) {
  console.error(`specrcheckr: GATE FAILED — ${reason}`);
  if (latest) {
    console.error("");
    console.error(`Changed features (${latest.touched_nodes.length}): ${latest.touched_nodes.join(", ") || "none"}`);
    console.error("Run `specrcheckr serve`, review each, save, then retry.");
  }
  return 1;
}
