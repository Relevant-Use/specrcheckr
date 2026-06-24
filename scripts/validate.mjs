// specrcheckr — validate a feature tree against the schema's core rules.
// Zero-dependency structural check (no JSON Schema library required).
import { abs, readJsonOrNull } from "./lib.mjs";

const STATUS = new Set(["planned", "in_progress", "implemented", "observed", "needs_confirmation", "known_incomplete", "known_divergence"]);
const ID_RE = /^[a-zA-Z0-9_.-]+$/;

export function validate({ config, root }) {
  const path = abs(root, config.featureTree);
  const tree = readJsonOrNull(path);
  const errors = [];
  if (!tree) {
    console.error(`specrcheckr: cannot read feature tree at ${path}`);
    return 1;
  }
  if (!tree.root || typeof tree.root !== "object") errors.push("missing top-level `root` node");

  const seen = new Map();
  let count = 0;
  function walk(node, where) {
    if (!node || typeof node !== "object") {
      errors.push(`${where}: not an object`);
      return;
    }
    count++;
    const at = node.id ? `node '${node.id}'` : where;
    for (const field of ["id", "label", "description"]) {
      if (typeof node[field] !== "string" || !node[field].trim()) errors.push(`${at}: missing or empty "${field}"`);
    }
    if (typeof node.id === "string") {
      if (!ID_RE.test(node.id)) errors.push(`${at}: id has invalid characters (use letters, numbers, . _ -)`);
      if (seen.has(node.id)) errors.push(`duplicate id "${node.id}" (ids must be unique and stable)`);
      else seen.set(node.id, true);
    }
    if (node.status !== undefined && !STATUS.has(node.status)) errors.push(`${at}: status "${node.status}" is not one of ${[...STATUS].join(", ")}`);
    if (node.security !== undefined && typeof node.security !== "boolean") errors.push(`${at}: security must be true/false`);
    for (const arrField of ["source", "tests", "docs"]) {
      if (node[arrField] !== undefined && !Array.isArray(node[arrField])) errors.push(`${at}: ${arrField} must be an array of paths`);
    }
    if (node.children !== undefined) {
      if (!Array.isArray(node.children)) errors.push(`${at}: children must be an array`);
      else node.children.forEach((c, i) => walk(c, `${at} > child[${i}]`));
    }
  }
  if (tree.root) walk(tree.root, "root");

  if (errors.length) {
    console.error(`specrcheckr: feature tree INVALID (${errors.length} problem(s)):`);
    for (const e of errors) console.error(`  - ${e}`);
    return 1;
  }
  console.log(`specrcheckr: feature tree valid (${count} feature node(s)).`);
  return 0;
}
