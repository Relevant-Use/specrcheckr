# Manual setup (for developers)

Prefer to set up specrcheckr by hand, without an AI? This is the full technical
path. specrcheckr is **zero-dependency** — it needs only Node.js 18+.

## 1. Get the tool into your repo

Either vendor it:

```bash
# copy bin/, scripts/, schemas/ into your repo (e.g. tools/specrcheckr/)
```

…and call it as `node tools/specrcheckr/bin/specrcheckr.mjs <command>`, or — if
published to npm — `npm i -D specrcheckr` and use `npx specrcheckr <command>`.

## 2. Initialize

```bash
specrcheckr init
```

Creates `specrcheckr.config.json`, a starter `docs/specs/feature-tree.json`, and
adds `.spec-review/` to `.gitignore`.

## 3. Configure

`specrcheckr.config.json` (all paths are relative to the config file's folder):

| Key | Meaning |
|---|---|
| `productName` | Shown in the review page header. |
| `featureTree` | Path to your feature tree JSON. |
| `baseRef` | Git ref to diff against (e.g. `origin/main`). |
| `baseTree` | Optional path to a baseline tree JSON. If set, specrcheckr diffs against this file instead of git — used for demos/offline. Leave `null` for real repos. |
| `behaviorGlobs` | Globs matching your implementation code. A changed file matching these is "behavior-sensitive". |
| `specGlobs` | Globs matching your spec/docs files. |
| `securityGlobs` | Changed files matching these raise an Access/security flag. |
| `outputDir` | Where the generated packet goes (default `.spec-review`). |
| `denylist` | Extra banned terms for `scan` (on top of the built-ins). |

Globs support `*` (one path segment), `**` (any depth), and `?`.

## 4. Author the feature tree

`docs/specs/feature-tree.json` — see [`schemas/feature-tree.schema.json`](./schemas/feature-tree.schema.json)
for the full contract. Minimal shape:

```json
{
  "version": "1",
  "root": {
    "id": "product",
    "label": "My Product",
    "description": "What the product does, in one or two sentences.",
    "status": "implemented",
    "children": [
      {
        "id": "accounts.login",
        "label": "Log in",
        "description": "Plain-English description of what this does TODAY.",
        "status": "implemented",
        "security": true,
        "source": ["src/auth/login.ts"],
        "tests": ["src/auth/login.test.ts"]
      }
    ]
  }
}
```

Rules that matter:
- **`id` is stable forever.** Comments and approvals are keyed to it. Never
  reuse or renumber.
- `description` is what the feature does **now**. When behavior changes, you edit
  this text — specrcheckr shows the before/after from the diff of this field.
- `source`/`tests`/`docs` are how a code change maps to a feature. Keep accurate.
- `status` ∈ `planned`, `in_progress`, `implemented`, `observed`,
  `needs_confirmation`, `known_incomplete`, `known_divergence`.

## 5. Commands

```bash
specrcheckr validate   # structural check of the feature tree
specrcheckr review     # write .spec-review/index.html (+ latest.json)
specrcheckr serve      # serve it AND save decisions to .spec-review/approval.json
specrcheckr check      # exit 0 if approved+current, else 1 (for hooks/CI)
specrcheckr scan       # exit 1 if denylist terms appear in the repo
```

The `file://` page is view-only; use `serve` (default http://127.0.0.1:4179) to
save approvals.

## 6. The gate

`check` regenerates the packet and passes only when:
- nothing behavior-relevant changed, **or**
- `.spec-review/approval.json` exists, its `base`/`head` match the current diff,
  its decision is `approved`, and no feature is marked `revise`.

### Pre-push hook

`.git/hooks/pre-push` (make it executable):

```bash
#!/bin/sh
specrcheckr check || {
  echo "specrcheckr: review not approved. Run 'specrcheckr serve', approve, retry."
  exit 1
}
```

Bypass once with `SPECRCHECKR_BYPASS=1 git push`.

### CI

Run `specrcheckr check` on pull requests. It needs the saved `approval.json`,
so commit it or pass approval through your own mechanism. (By default
`.spec-review/` is gitignored — adjust to taste.)

## Data files

- `.spec-review/latest.json` — the machine-readable packet (changed files,
  flags, changed features, metadata). Safe for agents to read.
- `.spec-review/approval.json` — saved decision: `{ base, head, decision,
  comments, node_reviews, saved_at }`. `node_reviews` is keyed by feature `id`.

Both are regenerated/overwritten freely; treat them as disposable per-change
state.
