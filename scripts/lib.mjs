// specrcheckr shared library — config loading, git helpers, glob matching,
// feature-tree diffing, and plain-English summarisation. Zero dependencies.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export const DEFAULT_CONFIG = {
  productName: "My Product",
  featureTree: "docs/specs/feature-tree.json",
  baseRef: "origin/main",
  baseTree: null,
  behaviorGlobs: ["src/**", "app/**", "lib/**", "components/**", "pages/**", "server/**"],
  specGlobs: ["docs/specs/**"],
  securityGlobs: [],
  outputDir: ".spec-review",
  denylist: [],
};

// ---------------------------------------------------------------------------
// Files / JSON
// ---------------------------------------------------------------------------

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function readJsonOrNull(path) {
  try {
    return readJson(path);
  } catch {
    return null;
  }
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Resolve the config file and the project root (the directory the config lives in).
// All paths in the config are interpreted relative to that root.
export function loadConfig(configArg) {
  const candidates = configArg
    ? [configArg]
    : ["specrcheckr.config.json", ".specrcheckr.json", "specrcheckr.config.js"];
  for (const candidate of candidates) {
    const path = isAbsolute(candidate) ? candidate : resolve(process.cwd(), candidate);
    if (existsSync(path)) {
      const raw = path.endsWith(".js")
        ? null // .js configs are not supported in zero-dep mode; use JSON.
        : readJsonOrNull(path);
      if (!raw) continue;
      return {
        config: { ...DEFAULT_CONFIG, ...raw },
        root: dirname(path),
        configPath: path,
      };
    }
  }
  // No config file: run against cwd with defaults.
  return { config: { ...DEFAULT_CONFIG }, root: process.cwd(), configPath: null };
}

export function abs(root, p) {
  return isAbsolute(p) ? p : resolve(root, p);
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

export function gitOrNull(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function lines(text) {
  return text ? text.split("\n").filter(Boolean) : [];
}

// ---------------------------------------------------------------------------
// Glob matching (supports ** , * , ?)
// ---------------------------------------------------------------------------

export function globToRegExp(glob) {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${re}$`);
}

export function matchAny(file, globs) {
  return (globs || []).some((glob) => globToRegExp(glob).test(file));
}

// ---------------------------------------------------------------------------
// Base resolution + changed files
// ---------------------------------------------------------------------------

// Decide what we diff against: an explicit baseline tree file (demo/offline),
// or git (real repo). Returns { mode, base, head, label }.
export function resolveBase(config, root) {
  if (config.baseTree) {
    const path = abs(root, config.baseTree);
    if (existsSync(path)) {
      return { mode: "file", base: path, label: `baseline file (${config.baseTree})` };
    }
  }
  const head = gitOrNull(["rev-parse", "HEAD"], root);
  if (!head) return { mode: "none", label: "no git history and no baseline tree" };
  const ref = config.baseRef || "origin/main";
  const base = gitOrNull(["merge-base", ref, "HEAD"], root) || gitOrNull(["rev-parse", ref], root);
  if (!base) return { mode: "none", head, label: `base ref '${ref}' not found` };
  return { mode: "git", base, head, label: `${base.slice(0, 8)} → working tree` };
}

export function changedFiles(config, root, baseInfo) {
  if (baseInfo.mode !== "git") return [];
  const tracked = lines(gitOrNull(["diff", "--name-only", baseInfo.base], root));
  const untracked = lines(gitOrNull(["ls-files", "--others", "--exclude-standard"], root));
  return [...new Set([...tracked, ...untracked])].sort();
}

export function loadBaseTree(config, root, baseInfo) {
  if (baseInfo.mode === "file") return readJsonOrNull(baseInfo.base);
  if (baseInfo.mode === "git") {
    const raw = gitOrNull(["show", `${baseInfo.base}:${config.featureTree}`], root);
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Feature tree traversal
// ---------------------------------------------------------------------------

export function flatten(root) {
  const out = [];
  function visit(node, trail, parentId, depth) {
    const nextTrail = [...trail, node.label || node.id];
    out.push({ ...node, trail: nextTrail, parentId, depth });
    for (const child of node.children || []) visit(child, nextTrail, node.id, depth + 1);
  }
  visit(root, [], null, 0);
  return out;
}

export function withTrails(root) {
  function visit(node, trail, parentId, depth) {
    const nextTrail = [...trail, node.label || node.id];
    return {
      ...node,
      trail: nextTrail,
      parentId,
      depth,
      children: (node.children || []).map((c) => visit(c, nextTrail, node.id, depth + 1)),
    };
  }
  return visit(root, [], null, 0);
}

export function nodeRefs(node) {
  return [...(node.source || []), ...(node.tests || []), ...(node.docs || [])];
}

export function allDescendantRefs(node) {
  const refs = new Set(nodeRefs(node));
  for (const child of node.children || []) {
    for (const ref of allDescendantRefs(child)) refs.add(ref);
  }
  return [...refs];
}

// ---------------------------------------------------------------------------
// JSON diffing (matches arrays of {id} objects by id, like feature-tree children)
// ---------------------------------------------------------------------------

function valueType(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function canDiffById(before, after) {
  const items = [...(before || []), ...(after || [])];
  return items.length > 0 && items.every((i) => i && typeof i === "object" && !Array.isArray(i) && typeof i.id === "string");
}

function byId(items = []) {
  return new Map(items.map((i) => [i.id, i]));
}

export function diffJson(before, after, path = "$") {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  const bt = valueType(before);
  const at = valueType(after);
  if (bt === "array" && at === "array" && canDiffById(before, after)) {
    const b = byId(before);
    const a = byId(after);
    const ids = new Set([...b.keys(), ...a.keys()]);
    const diffs = [];
    for (const id of [...ids].sort()) diffs.push(...diffJson(b.get(id), a.get(id), `${path}[id=${id}]`));
    return diffs;
  }
  if (bt !== "object" || at !== "object") return [{ path, before, after }];
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const diffs = [];
  for (const key of [...keys].sort()) diffs.push(...diffJson(before?.[key], after?.[key], `${path}.${key}`));
  return diffs;
}

// Diffs that belong to a node's own fields (not its children).
export function diffsForExactNode(allDiffs, nodeId) {
  const seg = `[id=${nodeId}]`;
  return allDiffs.filter((d) => {
    const i = d.path.indexOf(seg);
    if (i === -1) return false;
    return !d.path.slice(i + seg.length).startsWith(".children");
  });
}

// ---------------------------------------------------------------------------
// Plain-English summaries
// ---------------------------------------------------------------------------

function splitSentences(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+(?=[A-Z("'“])/)
    .filter(Boolean);
}

export function humanSummary(value, { sentences = 2, maxChars = 240 } = {}) {
  const norm = String(value || "").replace(/\s+/g, " ").trim();
  if (!norm) return "";
  const parts = splitSentences(norm);
  let out = parts.slice(0, sentences).join(" ");
  let i = sentences;
  while (out.length < 60 && i < parts.length) out += ` ${parts[i++]}`;
  if (out.length > maxChars) out = `${out.slice(0, maxChars - 1).trim()}…`;
  return out;
}

export function inlineMd(value) {
  return escapeHtml(value).replace(/`([^`]+)`/g, "<code>$1</code>");
}

export function valueToText(value) {
  if (value === undefined) return "(absent)";
  if (Array.isArray(value)) return value.every((v) => typeof v === "string") ? value.join(", ") || "(empty)" : JSON.stringify(value);
  if (value === null) return "null";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
