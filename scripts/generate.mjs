// specrcheckr — generate the human review workbench (.spec-review/index.html + latest.json)
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  abs,
  allDescendantRefs,
  changedFiles,
  diffJson,
  diffsForExactNode,
  escapeHtml,
  flatten,
  humanSummary,
  inlineMd,
  loadBaseTree,
  matchAny,
  nodeRefs,
  readJson,
  readJsonOrNull,
  resolveBase,
  valueToText,
  withTrails,
} from "./lib.mjs";

const FLAG_GROUP_ORDER = ["blocking", "needs_confirmation", "access", "evidence", "info"];
const FLAG_GROUP_LABEL = {
  blocking: "Blocking",
  needs_confirmation: "Needs confirmation",
  access: "Access / security",
  evidence: "Evidence gaps",
  info: "Informational",
};
const STATUS_VALUES = ["implemented", "observed", "in_progress", "planned", "needs_confirmation", "known_incomplete", "known_divergence"];

const SRC_TEST_RE = /\.test\.|\.spec\.|\/__tests__\//;

export function generate({ config, root }) {
  const baseInfo = resolveBase(config, root);
  const tree = readJson(abs(root, config.featureTree));
  const baseTree = loadBaseTree(config, root, baseInfo);
  const files = changedFiles(config, root, baseInfo);
  const allDiffs = baseTree ? diffJson(baseTree.root, tree.root, "$") : [];

  const behaviorFiles = files.filter((f) => matchAny(f, config.behaviorGlobs));
  const specFiles = files.filter((f) => matchAny(f, config.specGlobs));

  const nodes = flatten(tree.root);
  const fileBelongs = (refs) => files.filter((f) => refs.includes(f));

  // First pass: build per-node models.
  const models = new Map();
  for (const node of nodes) {
    const refs = nodeRefs(node);
    const descRefs = allDescendantRefs(node);
    const changedHere = fileBelongs(refs);
    const changedUnder = fileBelongs(descRefs);
    const exact = diffsForExactNode(allDiffs, node.id);
    const fileTouched = changedHere.length > 0;
    const specChanged = exact.length > 0;
    const directChanged = fileTouched || specChanged;

    const descDiff = exact.find((d) => d.path.endsWith(".description"));
    const mechanics = [];
    for (const [suffix, label] of [[".status", "Status"], [".security", "Security flag"]]) {
      const d = exact.find((x) => x.path.endsWith(suffix));
      if (d) mechanics.push({ label, before: valueToText(d.before), after: valueToText(d.after) });
    }

    const beforeText = descDiff ? (descDiff.before === undefined ? "" : descDiff.before) : node.description;
    const afterText = descDiff ? descDiff.after : node.description;
    let afterSummary = null;
    if (descDiff) afterSummary = humanSummary(afterText);
    else if (mechanics.length) afterSummary = `Updates ${mechanics.map((m) => m.label.toLowerCase()).join(", ")} (exact values in evidence).`;

    const needsHumanSummary = fileTouched && !specChanged;
    const securityChanged = changedHere.some((f) => matchAny(f, config.securityGlobs));
    const accessSensitive = node.security === true || securityChanged;

    models.set(node.id, {
      node,
      refs,
      descRefs,
      changedUnder,
      exact,
      fileTouched,
      specChanged,
      directChanged,
      beforeText,
      afterText,
      afterSummary,
      needsHumanSummary,
      accessSensitive,
      changedFiles: changedUnder,
      changedHere,
    });
  }

  // Second pass: descendant-changed + flags.
  const childIds = new Map();
  for (const node of nodes) childIds.set(node.id, (node.children || []).map((c) => c.id));
  function descendantChanged(id) {
    return (childIds.get(id) || []).some((cid) => models.get(cid)?.directChanged || descendantChanged(cid));
  }

  const flagSummary = [];
  for (const node of nodes) {
    const m = models.get(node.id);
    m.descendantChanged = descendantChanged(node.id);
    const flags = [];
    const status = node.status || "";
    if (status === "known_divergence") flags.push({ group: "blocking", level: "bad", text: "Known divergence" });
    if (m.accessSensitive) flags.push({ group: "access", level: "access", text: "Access / security affected" });
    if (status === "needs_confirmation") flags.push({ group: "needs_confirmation", level: "warn", text: "Needs confirmation" });
    if (status === "known_incomplete") flags.push({ group: "needs_confirmation", level: "warn", text: "Known incomplete" });
    if (m.needsHumanSummary) flags.push({ group: "evidence", level: "warn", text: "Needs human summary" });
    const changedSrc = m.changedHere.filter((f) => !SRC_TEST_RE.test(f));
    const changedTests = m.changedHere.filter((f) => SRC_TEST_RE.test(f));
    if (m.fileTouched && changedSrc.length && !(node.tests || []).length && !changedTests.length) {
      flags.push({ group: "evidence", level: "warn", text: "Changed code without referenced tests" });
    }
    if (m.specChanged && m.fileTouched === false && baseInfo.mode === "git") {
      flags.push({ group: "info", level: "info", text: "Spec changed without a mapped code file" });
    }
    m.flags = flags.sort((a, b) => FLAG_GROUP_ORDER.indexOf(a.group) - FLAG_GROUP_ORDER.indexOf(b.group));
    for (const f of m.flags) flagSummary.push({ nodeId: node.id, trail: node.trail, ...f });
  }

  const touchedNodeIds = nodes.filter((n) => models.get(n.id).directChanged).map((n) => n.id);
  const changedCount = touchedNodeIds.length;

  // ---- render ----
  const rootWithTrails = withTrails(tree.root);
  const defaultNodeId =
    nodes.find((n) => models.get(n.id).directChanged && !(n.children || []).length)?.id ||
    touchedNodeIds[0] ||
    tree.root.id;

  const packet = {
    generated_at: nowStamp(),
    product: config.productName,
    base: baseInfo.mode === "git" ? baseInfo.base : (baseInfo.base || baseInfo.mode),
    head: baseInfo.mode === "git" ? baseInfo.head : "working-tree",
    base_mode: baseInfo.mode,
    base_label: baseInfo.label,
    changed_files: files,
    behavior_files: behaviorFiles,
    spec_files: specFiles,
    touched_nodes: touchedNodeIds,
    flags: flagSummary,
    file_url: null,
  };

  const outputDir = abs(root, config.outputDir);
  const outputHtml = resolve(outputDir, "index.html");
  packet.file_url = `file://${outputHtml}`;

  const html = renderPage({ config, baseInfo, tree, rootWithTrails, nodes, models, flagSummary, behaviorFiles, specFiles, files, changedCount, defaultNodeId, packet });

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(outputHtml, html);
  writeFileSync(resolve(outputDir, "latest.json"), `${JSON.stringify(packet, null, 2)}\n`);
  return { outputHtml, outputDir, packet };
}

function nowStamp() {
  // Date is only used for display; keep it best-effort.
  try {
    return new Date().toISOString();
  } catch {
    return "";
  }
}

// ===========================================================================
// Rendering
// ===========================================================================

function statusClass(status) {
  return `s-${String(status || "unknown").replaceAll(/[^a-z_]/gi, "_")}`;
}

function refLink(ref) {
  return `<code>${escapeHtml(ref)}</code>`;
}

function refList(items, empty) {
  const u = [...new Set(items)];
  if (!u.length) return `<p class="muted small">${escapeHtml(empty)}</p>`;
  return `<ul class="ref-list">${u.map((i) => `<li>${refLink(i)}</li>`).join("")}</ul>`;
}

function flagPill(f) {
  return `<span class="flag flag-${f.level}">${escapeHtml(f.text)}</span>`;
}

function chips(items) {
  const u = [...new Set(items)].filter(Boolean);
  if (!u.length) return "";
  return `<div class="chips">${u.map((i) => `<span class="chip">${escapeHtml(i)}</span>`).join("")}</div>`;
}

function section(title, body, tone = "") {
  return `<section class="detail-section ${tone}"><h3>${escapeHtml(title)}</h3>${body}</section>`;
}

function summaryHtml(value, fallback) {
  const s = humanSummary(value);
  return s ? inlineMd(s) : `<span class="muted">${escapeHtml(fallback)}</span>`;
}

function afterHtml(m) {
  if (m.needsHumanSummary) {
    return `<span class="muted"><strong>Needs human summary.</strong> This feature has code changes but no matching spec edit. Confirm the spec already describes this, or add a short summary before approving.</span>`;
  }
  if (m.directChanged && m.afterSummary) return inlineMd(m.afterSummary);
  if (m.directChanged) return `<span class="muted">Changed, but no spec text or field change was detected — confirm what behavior this changes.</span>`;
  if (m.descendantChanged) return `<span class="muted">No direct change here. Review the changed sub-features nested under this one.</span>`;
  return `<span class="muted">Unchanged in this review.</span>`;
}

function whatApproving(m) {
  if (!m.directChanged && !m.descendantChanged) return `<p class="muted">Nothing changes here — no approval needed for this feature.</p>`;
  if (!m.directChanged && m.descendantChanged) return `<p>This feature itself is unchanged. Approve the changed <strong>sub-features</strong> nested under it in the tree.</p>`;
  const fileCount = m.changedFiles.length;
  const fieldCount = m.exact.length;
  let lead = `You are approving <strong>${fileCount} changed file(s)</strong> and <strong>${fieldCount} spec change(s)</strong> for this feature.`;
  if (m.needsHumanSummary) lead += ` <span class="inline-warn">No spec summary describes this change yet — confirm the intended behavior first.</span>`;
  return `<p>${lead}</p>`;
}

function accessBody(m) {
  if (!m.accessSensitive) return "";
  const note = m.node.security ? "Marked security-sensitive in the feature tree." : "A changed file matched your security globs.";
  return `<p>${escapeHtml(note)} Give access, permissions, and data-exposure changes extra scrutiny.</p>`;
}

function gapsBody(node) {
  const items = [];
  if (node.status === "needs_confirmation") items.push("Status is needs_confirmation — intent is not yet locked.");
  if (node.status === "known_incomplete") items.push("Status is known_incomplete — this area is broadly unfinished.");
  if (node.status === "known_divergence") items.push("Status is known_divergence — current behavior conflicts with intent.");
  if (!items.length) return "";
  return `<ul class="note-list">${items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`;
}

function evidenceBody(m, allDiffsForNode) {
  const node = m.node;
  const diffBlock = m.exact.length
    ? `<table class="mechanics"><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>${m.exact
        .map((d) => `<tr><td>${escapeHtml(d.path.split(".").pop())}</td><td><code>${escapeHtml(valueToText(d.before))}</code></td><td><code>${escapeHtml(valueToText(d.after))}</code></td></tr>`)
        .join("")}</tbody></table>`
    : `<p class="muted small">No spec field change mapped to this feature.</p>`;
  return `
    <details class="ev-drawer"><summary>Full description (current spec text)</summary><p class="prose">${node.description ? inlineMd(node.description) : '<span class="muted">none</span>'}</p></details>
    <details class="ev-drawer"><summary>Full before / after spec text</summary>
      <div class="ba">
        <div class="ba-col before"><span class="ba-label">Before</span><p class="prose">${m.beforeText ? inlineMd(m.beforeText) : '<span class="muted">(not previously described)</span>'}</p></div>
        <div class="ba-col after"><span class="ba-label">After</span><p class="prose">${inlineMd(m.afterText)}</p></div>
      </div>
    </details>
    <details class="ev-drawer"><summary>Spec field changes</summary>${diffBlock}</details>
    <div class="ev-grid">
      <div><h4>Source</h4>${refList(node.source || [], "none listed")}</div>
      <div><h4>Tests</h4>${refList(node.tests || [], "none listed")}</div>
      <div><h4>Docs</h4>${refList(node.docs || [], "none listed")}</div>
      <div><h4>Changed files mapped here</h4>${refList(m.changedFiles, "none")}</div>
    </div>`;
}

function detailPanel(node, models) {
  const m = models.get(node.id);
  const stateKey = node.status === "needs_confirmation" ? "needs-review" : m.directChanged ? "changed" : m.descendantChanged ? "contains" : "unchanged";
  const stateLabel = { "needs-review": "Needs review", changed: "Changed", contains: "Contains changes", unchanged: "Unchanged" }[stateKey];
  const access = accessBody(m);
  const gaps = gapsBody(node);
  return `
    <article class="detail" data-detail-id="${escapeHtml(node.id)}" hidden>
      <header class="detail-head">
        <div class="detail-breadcrumb">${node.trail.map((p) => escapeHtml(p)).join(" <span>›</span> ")}</div>
        <div class="detail-title-row">
          <h2>${escapeHtml(node.label || node.id)}</h2>
          <div class="detail-badges">
            <span class="state state-${stateKey}">${escapeHtml(stateLabel)}</span>
            <span class="status-pill ${statusClass(node.status)}">${escapeHtml(node.status || "unknown")}</span>
          </div>
        </div>
        ${m.flags.length ? `<div class="flag-row">${m.flags.map(flagPill).join("")}</div>` : ""}
        <p class="impact-line"><code class="detail-id">${escapeHtml(node.id)}</code></p>
      </header>
      ${section("Before → after", `<div class="ba"><div class="ba-col before"><span class="ba-label">What it did before</span><p>${summaryHtml(m.beforeText, "No prior behavior described.")}</p></div><div class="ba-col after"><span class="ba-label">What changes</span><p>${afterHtml(m)}</p></div></div>`, m.directChanged ? "tone-changed" : "")}
      ${section("What you are approving", whatApproving(m))}
      ${access ? section("Access & identity", access, "tone-access") : ""}
      ${gaps ? section("Known gaps / incomplete", gaps) : ""}
      <section class="detail-section decision node-review" data-node-id="${escapeHtml(node.id)}">
        <h3>Your decision &amp; comments</h3>
        <div class="btnrow">
          <button type="button" class="btn approve" data-node-decision="approved">Approve</button>
          <button type="button" class="btn revise" data-node-decision="revise">Request revision</button>
          <button type="button" class="btn ghost" data-node-comment-toggle>+ Comment</button>
          <span class="node-decision-state" data-node-state>No decision</span>
        </div>
        <div class="node-comment" hidden>
          <label><strong>Comment for this feature</strong><textarea data-node-comment placeholder=""></textarea></label>
          <div class="btnrow"><button type="button" class="btn small" data-node-comment-save>Save comment</button><span class="muted small" data-node-comment-state>No comment saved</span></div>
        </div>
      </section>
      <details class="detail-section evidence"><summary><h3>Evidence &amp; machine-readable detail</h3></summary>${evidenceBody(m)}</details>
    </article>`;
}

function treeRow(node, models) {
  const m = models.get(node.id);
  const hasChildren = (node.children || []).length > 0;
  const dot = m.directChanged ? "dot changed" : m.descendantChanged ? "dot contains" : "dot";
  return `
    <li class="tree-item" data-node-id="${escapeHtml(node.id)}" data-changed="${m.directChanged ? 1 : 0}">
      <div class="tree-row" data-tree-select="${escapeHtml(node.id)}" tabindex="0" role="button">
        ${hasChildren ? `<button type="button" class="tree-toggle" data-tree-toggle aria-label="toggle">▾</button>` : `<span class="tree-toggle leaf">•</span>`}
        <span class="${dot}"></span>
        <span class="tree-label">${escapeHtml(node.label || node.id)}</span>
        <span class="tree-status ${statusClass(node.status)}">${escapeHtml(node.status || "—")}</span>
        ${m.flags.length ? `<span class="tree-flag">${m.flags.length}</span>` : ""}
      </div>
      ${hasChildren ? `<ul class="tree-children">${node.children.map((c) => treeRow(c, models)).join("")}</ul>` : ""}
    </li>`;
}

function flagsSummaryPanel(flagSummary) {
  if (!flagSummary.length) return `<p class="muted small">No review flags were raised.</p>`;
  const buckets = new Map();
  for (const f of flagSummary) {
    if (!buckets.has(f.group)) buckets.set(f.group, new Map());
    const t = buckets.get(f.group);
    if (!t.has(f.text)) t.set(f.text, []);
    t.get(f.text).push(f);
  }
  const open = new Set(["blocking", "needs_confirmation", "access"]);
  const out = FLAG_GROUP_ORDER.filter((g) => buckets.has(g)).map((g) => {
    const t = buckets.get(g);
    const total = [...t.values()].reduce((s, a) => s + a.length, 0);
    const body = [...t.entries()].map(([text, ns]) => `<div class="flag-line"><span class="flag flag-${ns[0].level}">${escapeHtml(text)}</span><ul class="flag-nodes">${ns.map((n) => `<li><a href="#" data-jump="${escapeHtml(n.nodeId)}">${escapeHtml(n.trail.slice(1).join(" › ") || n.trail.join(" › "))}</a></li>`).join("")}</ul></div>`).join("");
    return `<details class="flag-bucket flag-bucket-${g}"${open.has(g) ? " open" : ""}><summary><span class="bucket-name">${escapeHtml(FLAG_GROUP_LABEL[g])}</span> <span class="flag-count">${total}</span></summary><div class="flag-bucket-body">${body}</div></details>`;
  });
  return `<div class="flag-buckets">${out.join("")}</div>`;
}

function machineDrawer({ packet, files, behaviorFiles, specFiles, touched }) {
  return `<details class="machine"><summary><strong>Machine-readable evidence</strong> <span class="muted small">for AI agents — full lists &amp; packet metadata</span></summary><div class="machine-body">
    <div class="machine-grid">
      <div><h4>Changed files (${files.length})</h4>${refList(files, "none")}</div>
      <div><h4>Behavior-sensitive (${behaviorFiles.length})</h4>${refList(behaviorFiles, "none")}</div>
      <div><h4>Spec files (${specFiles.length})</h4>${refList(specFiles, "none")}</div>
      <div><h4>Changed features (${touched.length})</h4>${touched.length ? `<ul class="ref-list">${touched.map((id) => `<li><a href="#" data-jump="${escapeHtml(id)}"><code>${escapeHtml(id)}</code></a></li>`).join("")}</ul>` : `<p class="muted small">none</p>`}</div>
    </div>
    <h4>Packet metadata</h4>
    <pre class="packet">${escapeHtml(JSON.stringify({ ...packet, flags: `${packet.flags.length} flag(s)` }, null, 2))}</pre>
  </div></details>`;
}

function renderPage(ctx) {
  const { config, baseInfo, rootWithTrails, nodes, models, flagSummary, behaviorFiles, specFiles, files, changedCount, defaultNodeId, packet } = ctx;
  const flaggedNodes = new Set(flagSummary.map((f) => f.nodeId)).size;
  const savedState = { decision: null, comments: "", node_reviews: {} };

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(config.productName)} — specrcheckr review</title>
<style>${CSS}</style>
</head><body>
<header class="topbar">
  <div class="brand"><span class="dot-brand"></span><b>specrcheckr</b> <span class="sub">${escapeHtml(config.productName)}</span></div>
  <div class="scope-chips">
    ${scopeChip("Changed files", String(files.length))}
    ${scopeChip("Changed features", String(changedCount), "accent")}
    ${scopeChip("Flags", String(flagSummary.length), flagSummary.length ? "warn" : "")}
  </div>
  <div class="decision-cluster">
    <span class="save-pill" id="save-pill">No decision saved</span>
    <button type="button" class="btn primary" id="g-approve">Approve all</button>
    <button type="button" class="btn warn" id="g-revise">Request revision</button>
  </div>
</header>
<div class="scope-bar">
  <div class="scope-line">
    <p class="scope-statement"><b>Reviewing</b> ${escapeHtml(baseInfo.label)}. Decide each changed feature below — per-feature decisions are the approval record.</p>
    <div class="rollup" id="decision-rollup" aria-live="polite"></div>
  </div>
  <details class="callout flags"${flagSummary.length ? " open" : ""}>
    <summary>Review flags <span class="count">${flagSummary.length || ""}</span></summary>
    <div class="callout-body">${flagsSummaryPanel(flagSummary)}</div>
  </details>
</div>
<div class="app">
  <aside class="tree-pane">
    <div class="tree-head"><h3>Feature tree</h3><button type="button" class="btn small ghost" id="collapse-all">Collapse all</button></div>
    <ul class="tree">${treeRow(rootWithTrails, models)}</ul>
  </aside>
  <main class="detail-pane" id="detail-pane">
    ${nodes.map((n) => detailPanel(n, models)).join("")}
    <div class="detail-foot">
      <details class="optional-note"><summary>Optional overall note</summary><div class="optional-note-body">
        <p class="muted small">Per-feature comments are the primary record. This single field is saved as the overall approval note.</p>
        <textarea id="global-comments" placeholder=""></textarea>
        <p class="muted small" id="global-save-result">Not yet saved.</p>
      </div></details>
      ${machineDrawer({ packet, files, behaviorFiles, specFiles, touched: packet.touched_nodes })}
    </div>
  </main>
</div>
<script>
  const review = ${JSON.stringify({ base: packet.base, head: packet.head })};
  const saved = ${JSON.stringify(savedState)};
  const defaultNodeId = ${JSON.stringify(defaultNodeId)};
  const changedNodeCount = ${JSON.stringify(changedCount)};
  const flaggedNodeCount = ${JSON.stringify(flaggedNodes)};
  ${CLIENT_JS}
</script>
</body></html>`;
}

function scopeChip(label, value, tone = "") {
  return `<div class="scope-chip ${tone}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

const CSS = `
:root{color-scheme:light dark;--bg:#f3f6f5;--panel:#fff;--panel-2:#f6faf9;--sunken:#e9efee;--text:#14201e;--muted:#54625f;--faint:#869391;--line:#dde6e4;--line-2:#cad6d3;--accent:#0f766e;--accent-soft:#d6efeb;--on-accent:#ffffff;--green:#157f43;--green-soft:#dcf3e3;--amber:#8a5a07;--amber-soft:#f7ecd3;--red:#bb2d22;--red-soft:#fbe5e1;--purple:#7c3aed;--purple-soft:#ece3fb;--shadow:0 1px 2px rgba(15,32,30,.06),0 4px 16px rgba(15,32,30,.06);--radius:11px;}
@media(prefers-color-scheme:dark){:root{--bg:#0a1211;--panel:#111c1a;--panel-2:#16221f;--sunken:#0d1615;--text:#e7efed;--muted:#92a29e;--faint:#677a76;--line:#21322f;--line-2:#314440;--accent:#2dd4bf;--accent-soft:#0f342f;--on-accent:#04231f;--green:#46d986;--green-soft:#0f2a1c;--amber:#fbbf24;--amber-soft:#2a2310;--red:#f6726b;--red-soft:#2c1614;--purple:#b794f6;--purple-soft:#201a35;--shadow:0 1px 2px rgba(0,0,0,.45),0 6px 20px rgba(0,0,0,.4);}}
*{box-sizing:border-box}html,body{width:100%;max-width:100%;overflow-x:hidden}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;background:var(--sunken);border:1px solid var(--line);border-radius:5px;padding:1px 5px;overflow-wrap:anywhere;word-break:break-word}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
h2,h3,h4{margin:0}p{margin:0}.muted{color:var(--muted)}.small{font-size:12px}
.topbar{position:sticky;top:0;z-index:30;display:flex;flex-wrap:wrap;gap:14px 18px;align-items:center;justify-content:space-between;padding:12px clamp(14px,3vw,28px);background:color-mix(in srgb,var(--panel),transparent 6%);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:baseline;gap:9px;font-weight:600}.brand .dot-brand{width:9px;height:9px;border-radius:50%;background:var(--accent);display:inline-block}.brand b{font-weight:800;letter-spacing:-.01em}.brand .sub{color:var(--muted);font-weight:600}
.scope-chips{display:flex;flex-wrap:wrap;gap:8px}.scope-chip{display:grid;gap:1px;padding:5px 11px;border:1px solid var(--line);border-radius:9px;background:var(--panel-2);min-width:64px}.scope-chip span{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--faint);font-weight:700}.scope-chip strong{font-size:16px;line-height:1.1;font-variant-numeric:tabular-nums}.scope-chip.accent strong{color:var(--accent)}.scope-chip.warn strong{color:var(--amber)}
.decision-cluster{display:flex;align-items:center;gap:9px;flex-wrap:wrap}.save-pill{font-size:12px;font-weight:700;padding:5px 11px;border-radius:999px;border:1px solid var(--line);color:var(--muted);white-space:nowrap}.save-pill.unsaved{color:var(--amber);border-color:color-mix(in srgb,var(--amber),var(--line) 50%);background:var(--amber-soft)}.save-pill.saved{color:var(--green);border-color:color-mix(in srgb,var(--green),var(--line) 50%);background:var(--green-soft)}
.btn{border:1px solid var(--line-2);border-radius:8px;background:var(--panel);color:var(--text);padding:7px 13px;font:inherit;font-weight:650;cursor:pointer;white-space:nowrap}.btn:hover{background:var(--sunken)}.btn.small{padding:5px 9px;font-size:12px}.btn.ghost{background:transparent}.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}.btn.warn{color:var(--amber);border-color:color-mix(in srgb,var(--amber),var(--line) 40%)}.btn.approve.is-active{background:var(--green);border-color:var(--green);color:#fff}.btn.revise.is-active{background:var(--red);border-color:var(--red);color:#fff}
.scope-bar{padding:12px clamp(14px,3vw,28px);display:grid;gap:10px;max-width:1500px;margin:0 auto}
.scope-line{display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center;justify-content:space-between}.scope-statement{color:var(--muted);font-size:13px;flex:1 1 420px}.scope-statement b{color:var(--text)}
.rollup{display:flex;gap:6px;flex-wrap:wrap;font-size:12px;font-weight:700}.rollup span{padding:4px 10px;border-radius:999px;border:1px solid var(--line);background:var(--panel-2);white-space:nowrap}.rollup span.r-approved{color:var(--green);background:var(--green-soft)}.rollup span.r-revise{color:var(--red);background:var(--red-soft)}.rollup span.r-flagged{color:var(--amber);background:var(--amber-soft)}
details.callout{border:1px solid var(--line);border-radius:var(--radius);background:var(--panel);box-shadow:var(--shadow)}details.callout>summary{cursor:pointer;padding:11px 14px;font-weight:700;display:flex;align-items:center;gap:8px;list-style:none}details.callout>summary::-webkit-details-marker{display:none}details.callout>summary::before{content:"▸";color:var(--muted)}details.callout[open]>summary::before{content:"▾"}details.callout .callout-body{padding:0 14px 14px}.callout.flags>summary .count{margin-left:auto;font-size:12px;color:var(--amber);font-weight:800}
.flag-buckets{display:grid;gap:8px}details.flag-bucket{border:1px solid var(--line);border-left-width:3px;border-radius:8px;background:var(--panel-2)}details.flag-bucket>summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:8px;padding:8px 11px;font-weight:700}details.flag-bucket>summary::-webkit-details-marker{display:none}details.flag-bucket>summary::before{content:"▸";color:var(--muted);font-size:11px}details.flag-bucket[open]>summary::before{content:"▾"}.flag-bucket .bucket-name{flex:1}.flag-bucket .flag-count{font-size:12px;font-weight:800;min-width:20px;height:20px;padding:0 6px;border-radius:999px;background:var(--sunken);color:var(--muted);display:inline-flex;align-items:center;justify-content:center}.flag-bucket-blocking{border-left-color:var(--red)}.flag-bucket-blocking .flag-count{background:var(--red-soft);color:var(--red)}.flag-bucket-needs_confirmation{border-left-color:var(--amber)}.flag-bucket-needs_confirmation .flag-count{background:var(--amber-soft);color:var(--amber)}.flag-bucket-access{border-left-color:var(--purple)}.flag-bucket-access .flag-count{background:var(--purple-soft);color:var(--purple)}.flag-bucket-evidence{border-left-color:var(--amber)}.flag-bucket-info{border-left-color:var(--accent)}.flag-bucket-body{padding:0 11px 10px;display:grid;gap:8px}.flag-line{display:grid;gap:4px}.flag-nodes{list-style:none;margin:0;padding:0 0 0 2px;display:grid;gap:3px;font-size:12px}.flag-nodes a{color:var(--text)}
.app{display:grid;grid-template-columns:minmax(260px,330px) minmax(0,1fr);gap:16px;align-items:start;padding:4px clamp(14px,3vw,28px) 28px;max-width:1500px;margin:0 auto;width:100%}
.tree-pane{max-height:60vh;overflow-y:auto;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);padding:8px}
.tree-head{display:flex;align-items:center;justify-content:space-between;padding:6px 8px 8px}.tree-head h3{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--faint)}
ul.tree,ul.tree-children{list-style:none;margin:0;padding:0}ul.tree-children{margin-left:11px;border-left:1px solid var(--line);padding-left:4px}
.tree-row{display:flex;align-items:center;gap:6px;padding:5px 7px;border-radius:7px;cursor:pointer;user-select:none}.tree-row:hover{background:var(--sunken)}.tree-item.active>.tree-row{background:var(--accent-soft);box-shadow:inset 2px 0 0 var(--accent)}
.tree-toggle{border:0;background:none;color:var(--muted);cursor:pointer;font-size:11px;width:15px;height:15px;display:inline-flex;align-items:center;justify-content:center;flex:none;padding:0;border-radius:4px}.tree-toggle:hover{background:var(--line)}.tree-toggle.leaf{color:var(--faint);cursor:default;font-size:8px}.tree-item.collapsed>ul.tree-children{display:none}.tree-item.collapsed>.tree-row .tree-toggle:not(.leaf){transform:rotate(-90deg)}
.dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--line-2)}.dot.changed{background:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}.dot.contains{background:color-mix(in srgb,var(--accent),var(--line-2) 55%)}
.tree-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:550}
.tree-status{font-size:10px;font-weight:700;padding:1px 6px;border-radius:999px;white-space:nowrap;border:1px solid color-mix(in srgb,var(--sc,var(--muted)),transparent 65%);color:var(--sc,var(--muted));background:color-mix(in srgb,var(--sc,var(--muted)),transparent 90%)}
.tree-flag{font-size:10px;font-weight:800;min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:var(--amber-soft);color:var(--amber);display:inline-flex;align-items:center;justify-content:center}
.s-implemented{--sc:var(--green)}.s-observed{--sc:var(--faint)}.s-in_progress{--sc:var(--accent)}.s-planned{--sc:var(--faint)}.s-needs_confirmation{--sc:var(--amber)}.s-known_incomplete{--sc:var(--amber)}.s-known_divergence{--sc:var(--red)}
.detail-pane{min-width:0;display:grid;gap:16px;align-content:start}.detail-foot{display:grid;gap:12px}
.detail{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);padding:clamp(16px,2.4vw,26px);min-width:0}
.detail-head{display:grid;gap:8px;padding-bottom:14px;border-bottom:1px solid var(--line);margin-bottom:4px}
.detail-breadcrumb{font-size:12px;color:var(--muted);font-weight:600}.detail-breadcrumb span{color:var(--faint);margin:0 2px}
.detail-title-row{display:flex;flex-wrap:wrap;gap:10px 14px;align-items:center;justify-content:space-between}.detail-title-row h2{font-size:clamp(20px,3vw,27px);letter-spacing:-.02em;line-height:1.15}
.detail-badges{display:flex;gap:7px;flex-wrap:wrap}.state{font-size:11px;font-weight:800;padding:3px 10px;border-radius:999px;text-transform:uppercase;letter-spacing:.04em}.state-changed{background:var(--accent-soft);color:var(--accent)}.state-contains{background:var(--sunken);color:var(--muted)}.state-unchanged{background:var(--sunken);color:var(--faint)}.state-needs-review{background:var(--amber-soft);color:var(--amber)}
.status-pill{font-size:11px;font-weight:700;padding:3px 10px;border-radius:999px;border:1px solid color-mix(in srgb,var(--sc,var(--muted)),transparent 60%);color:var(--sc,var(--muted));background:color-mix(in srgb,var(--sc,var(--muted)),transparent 90%)}
.detail-id{color:var(--muted)}.flag-row{display:flex;flex-wrap:wrap;gap:6px}.impact-line{color:var(--muted);font-size:12px}
.inline-warn{color:var(--amber);font-weight:700}
.flag{font-size:11px;font-weight:700;padding:2px 9px;border-radius:999px}.flag-warn{background:var(--amber-soft);color:var(--amber)}.flag-bad{background:var(--red-soft);color:var(--red)}.flag-access{background:var(--purple-soft);color:var(--purple)}.flag-info{background:var(--accent-soft);color:var(--accent)}
.detail-section{padding:16px 0;border-bottom:1px solid var(--line);display:grid;gap:10px}.detail-section:last-of-type{border-bottom:0}.detail-section>h3{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--faint);font-weight:800}
.detail-section.tone-changed{border-left:3px solid var(--accent);padding-left:14px;margin-left:-14px;background:linear-gradient(90deg,var(--accent-soft),transparent 40%);border-radius:0 8px 8px 0}.detail-section.tone-access{border-left:3px solid var(--purple);padding-left:14px;margin-left:-14px}
.prose{line-height:1.6;max-width:78ch;overflow-wrap:anywhere}
.ba{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:10px}.ba-col{border:1px solid var(--line);border-radius:9px;padding:11px;background:var(--panel-2)}.ba-col p{line-height:1.55;overflow-wrap:anywhere}.ba-label{display:inline-block;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;padding:1px 7px;border-radius:999px}.ba-col.before{border-left:3px solid var(--red)}.ba-col.before .ba-label{background:var(--red-soft);color:var(--red)}.ba-col.after{border-left:3px solid var(--green)}.ba-col.after .ba-label{background:var(--green-soft);color:var(--green)}
table.mechanics{width:100%;border-collapse:collapse;font-size:12px;display:block;overflow-x:auto}table.mechanics th{text-align:left;color:var(--faint);font-size:10px;text-transform:uppercase;padding:4px 8px}table.mechanics td{border-top:1px solid var(--line);padding:7px 8px;vertical-align:top}table.mechanics td code{white-space:pre-wrap;word-break:break-word}
.chips{display:flex;flex-wrap:wrap;gap:6px}.chip{font-size:12px;font-weight:600;padding:2px 9px;border-radius:7px;background:var(--sunken);border:1px solid var(--line)}
.note-list{margin:0;padding-left:18px;display:grid;gap:5px}.note-list li{line-height:1.5;overflow-wrap:anywhere}
.btnrow{display:flex;flex-wrap:wrap;gap:8px;align-items:center}textarea{width:100%;min-height:84px;resize:vertical;border:1px solid var(--line-2);border-radius:9px;background:var(--panel-2);color:var(--text);padding:10px;font:inherit}
.node-decision-state{font-size:12px;font-weight:700;color:var(--muted)}.node-decision-state.is-approved{color:var(--green)}.node-decision-state.is-revise{color:var(--red)}
.node-comment{display:grid;gap:8px;margin-top:4px;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--sunken)}.node-comment label{display:grid;gap:6px}
.detail-section.decision{background:var(--panel-2);border:1px solid var(--line);border-radius:10px;padding:14px;margin-top:4px}
details.evidence{border-top:1px solid var(--line)}details.evidence>summary{cursor:pointer;list-style:none;padding:14px 0 4px}details.evidence>summary::-webkit-details-marker{display:none}details.evidence>summary h3{display:inline}details.evidence>summary::before{content:"▸ ";color:var(--muted)}details.evidence[open]>summary::before{content:"▾ "}
.ev-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:14px;margin:12px 0}.ev-grid h4{font-size:11px;text-transform:uppercase;color:var(--faint);margin-bottom:6px}.ref-list{list-style:none;margin:0;padding:0;display:grid;gap:4px}.ref-list li{overflow-wrap:anywhere}
.ev-drawer{border:1px solid var(--line);border-radius:9px;padding:10px 12px;margin-top:8px;background:var(--panel-2)}.ev-drawer>summary{cursor:pointer;font-weight:650}
pre{white-space:pre-wrap;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:10px;margin:0;background:var(--sunken);font-size:11.5px;max-width:100%;overflow-wrap:anywhere;word-break:break-word}
details.optional-note>summary{cursor:pointer;list-style:none;font-size:12px;font-weight:650;color:var(--muted);padding:6px 0}details.optional-note>summary::-webkit-details-marker{display:none}details.optional-note>summary::before{content:"▸ "}details.optional-note[open]>summary::before{content:"▾ "}.optional-note-body{display:grid;gap:8px;max-width:720px}
.machine{border:0}.machine>summary{cursor:pointer;list-style:none;padding:13px 16px;border:1px solid var(--line);border-radius:var(--radius);background:var(--panel);box-shadow:var(--shadow);display:flex;gap:8px;align-items:center}.machine>summary::-webkit-details-marker{display:none}.machine>summary::before{content:"▸";color:var(--muted)}.machine[open]>summary::before{content:"▾"}.machine-body{border:1px solid var(--line);border-top:0;border-radius:0 0 var(--radius) var(--radius);padding:16px;background:var(--panel);display:grid;gap:12px}.machine-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr));gap:16px}.machine-grid h4,.machine-body>h4{font-size:11px;text-transform:uppercase;color:var(--faint);margin-bottom:6px}pre.packet{max-height:320px}
@media(max-width:920px){.app{grid-template-columns:1fr}.tree-pane{max-height:46vh}}
@media(max-width:560px){.scope-chip{min-width:0;flex:1 1 70px}.detail-section.tone-changed,.detail-section.tone-access{margin-left:0}}
@media(min-width:921px){html,body{height:100%}body{height:100dvh;overflow:hidden;display:flex;flex-direction:column}.topbar,.scope-bar{flex:0 0 auto}.callout .callout-body{max-height:40vh;overflow:auto}.app{flex:1 1 auto;min-height:0;padding-top:8px;padding-bottom:0;overflow:hidden}.tree-pane{height:100%;max-height:none;min-height:0}.detail-pane{height:100%;min-height:0;overflow-y:auto;padding:0 8px 24px 0}}
`;

const CLIENT_JS = `
const nodeReviews = JSON.parse(JSON.stringify(saved.node_reviews || {}));
let lastSavedSnapshot = null;
const savePill = document.getElementById("save-pill");
const globalComments = document.getElementById("global-comments");
globalComments.value = saved.comments || "";
const rollup = document.getElementById("decision-rollup");
const detailPane = document.getElementById("detail-pane");
function ensure(id){ if(!nodeReviews[id]) nodeReviews[id]={}; return nodeReviews[id]; }
function snapshot(d){ return JSON.stringify({decision:d||saved.decision||null,comments:globalComments.value,node_reviews:nodeReviews}); }
const initialSnapshot = snapshot(null);
function updateRollup(){
  let a=0,r=0; for(const id in nodeReviews){ if(nodeReviews[id].decision==="approved")a++; else if(nodeReviews[id].decision==="revise")r++; }
  const undecided=Math.max(0,changedNodeCount-a-r);
  rollup.innerHTML='<span class="r-approved">'+a+' approved</span><span class="r-revise">'+r+' revision'+(r===1?'':'s')+'</span><span>'+undecided+' of '+changedNodeCount+' changed undecided</span>'+(flaggedNodeCount?'<span class="r-flagged">'+flaggedNodeCount+' flagged</span>':'');
}
function refreshSavePill(){
  const cur=snapshot(null); const base=lastSavedSnapshot!==null?lastSavedSnapshot:initialSnapshot;
  if(cur!==base){savePill.textContent="Unsaved changes";savePill.className="save-pill unsaved";}
  else if(saved.decision){savePill.textContent="Saved: "+saved.decision;savePill.className="save-pill saved";}
  else{savePill.textContent="No decision saved";savePill.className="save-pill";}
}
function cssEscape(s){return s.replace(/[^a-zA-Z0-9_-]/g,function(c){return "\\\\"+c;});}
function selectNode(id){
  document.querySelectorAll(".tree-item").forEach(function(i){i.classList.toggle("active",i.dataset.nodeId===id);});
  document.querySelectorAll(".detail").forEach(function(d){d.hidden=d.dataset.detailId!==id;});
  var item=document.querySelector('.tree-item[data-node-id="'+cssEscape(id)+'"]');
  var p=item?item.parentElement.closest(".tree-item"):null;
  while(p){p.classList.remove("collapsed");p=p.parentElement.closest(".tree-item");}
  if(window.matchMedia("(min-width:921px)").matches) detailPane.scrollTo({top:0});
  else if(item) detailPane.scrollIntoView({behavior:"smooth",block:"start"});
}
document.querySelectorAll("[data-tree-select]").forEach(function(row){
  row.addEventListener("click",function(e){ if(e.target.closest("[data-tree-toggle]"))return; selectNode(row.dataset.treeSelect); });
  row.addEventListener("keydown",function(e){ if(e.key==="Enter"||e.key===" "){e.preventDefault();selectNode(row.dataset.treeSelect);} });
});
document.querySelectorAll("[data-tree-toggle]").forEach(function(b){ b.addEventListener("click",function(e){e.stopPropagation();b.closest(".tree-item").classList.toggle("collapsed");}); });
document.getElementById("collapse-all").addEventListener("click",function(){
  var anyOpen=[].slice.call(document.querySelectorAll(".tree-item")).some(function(i){return i.querySelector(".tree-children")&&!i.classList.contains("collapsed");});
  document.querySelectorAll(".tree-item").forEach(function(i){ if(i.querySelector(".tree-children")) i.classList.toggle("collapsed",anyOpen); });
  document.getElementById("collapse-all").textContent=anyOpen?"Expand all":"Collapse all";
});
document.querySelectorAll("[data-jump]").forEach(function(l){ l.addEventListener("click",function(e){e.preventDefault();selectNode(l.dataset.jump);}); });
function updateStates(){
  document.querySelectorAll(".detail").forEach(function(d){
    var id=d.dataset.detailId, r=nodeReviews[id]||{}, sec=d.querySelector(".node-review");
    if(sec){
      var st=sec.querySelector("[data-node-state]");
      if(st){ st.textContent=r.decision?(r.decision==="approved"?"Approved":"Revision requested"):"No decision"; st.className="node-decision-state"+(r.decision==="approved"?" is-approved":r.decision==="revise"?" is-revise":""); }
      sec.querySelectorAll("[data-node-decision]").forEach(function(b){b.classList.toggle("is-active",b.dataset.nodeDecision===r.decision);});
      var cf=sec.querySelector("[data-node-comment]"); if(cf&&document.activeElement!==cf)cf.value=r.comment||"";
      var cs=sec.querySelector("[data-node-comment-state]"); if(cs)cs.textContent=r.comment?"Comment saved":"No comment saved";
      var ct=sec.querySelector("[data-node-comment-toggle]"); if(ct)ct.textContent=r.comment?"Edit comment":"+ Comment";
    }
  });
  document.querySelectorAll(".tree-item").forEach(function(i){
    var r=nodeReviews[i.dataset.nodeId]||{}, ex=i.querySelector(".tree-row .tree-decision"); if(ex)ex.remove();
    if(r.decision){ var m=document.createElement("span"); m.className="tree-decision"; m.textContent=r.decision==="approved"?"✓":"⚠"; m.style.cssText="font-weight:800;font-size:12px;color:"+(r.decision==="approved"?"var(--green)":"var(--red)"); i.querySelector(".tree-row").appendChild(m); }
  });
  updateRollup(); refreshSavePill();
}
document.querySelectorAll("[data-node-decision]").forEach(function(b){ b.addEventListener("click",function(){ var id=b.closest(".node-review").dataset.nodeId, r=ensure(id); r.decision=r.decision===b.dataset.nodeDecision?undefined:b.dataset.nodeDecision; if(r.decision===undefined)delete r.decision; updateStates(); }); });
document.querySelectorAll("[data-node-comment-toggle]").forEach(function(b){ b.addEventListener("click",function(){ var p=b.closest(".node-review").querySelector(".node-comment"); p.hidden=!p.hidden; if(!p.hidden)p.querySelector("[data-node-comment]").focus(); }); });
document.querySelectorAll("[data-node-comment-save]").forEach(function(b){ b.addEventListener("click",function(){ var s=b.closest(".node-review"), r=ensure(s.dataset.nodeId); r.comment=s.querySelector("[data-node-comment]").value; updateStates(); }); });
globalComments.addEventListener("input",refreshSavePill);
async function save(decision){
  var result=document.getElementById("global-save-result");
  if(location.protocol==="file:"){ result.textContent="View-only as a file. Run the serve command and use the http://127.0.0.1 URL to save."; savePill.textContent="View-only (file://)"; return; }
  try{
    var res=await fetch("/approval",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({base:review.base,head:review.head,decision:decision,comments:globalComments.value,node_reviews:nodeReviews})});
    if(!res.ok){result.textContent="Save failed: "+(await res.text());return;}
    var out=await res.json(); saved.decision=out.decision; lastSavedSnapshot=snapshot(out.decision); result.textContent="Saved "+out.decision+" at "+out.saved_at+"."; refreshSavePill();
  }catch(err){ result.textContent="Save error: "+err.message; }
}
document.getElementById("g-approve").addEventListener("click",function(){save("approved");});
document.getElementById("g-revise").addEventListener("click",function(){save("revise");});
document.querySelectorAll(".tree-item").forEach(function(i){ if(i.dataset.changed==="0"&&i.querySelector(".tree-children")&&!i.querySelector('.tree-item[data-changed="1"]')) i.classList.add("collapsed"); });
selectNode(defaultNodeId); updateStates(); refreshSavePill();
`;
