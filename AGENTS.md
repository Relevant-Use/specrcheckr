# AGENTS.md — setup runbook for AI assistants

You are an AI assistant helping a user add **specrcheckr** to *their own*
repository. specrcheckr generates a plain-English, feature-tree review page that
a human approves before changes ship. Follow this runbook top to bottom. It is
imperative: do each step, verify it, then continue.

**Hard rules (do not violate):**
- Do **not** modify the user's application code, CI, or git config without
  explicit confirmation. You are adding review tooling only.
- Do **not** invent feature descriptions. If you can't determine what a feature
  does, write `TODO: confirm` and tell the user — never guess.
- Keep every action reversible. Prefer adding files over editing existing ones.
- Ask questions **one at a time**. Wait for the answer before the next.
- After each step, state what you did and what you verified.

---

## Step 0 — Detect your capabilities

Branch based on what you can do in this environment:

- **You can run shell commands + edit files** (e.g. Claude Code, Cursor agent):
  do every step normally.
- **You can edit files but not run commands:** do all file-writing steps, and
  for any `Run:` step, tell the user the exact command to paste and run, then
  wait for the output.
- **You have no access to the user's repo** (plain chat): output each file's full
  contents for the user to save, and give them the commands to run. Do the
  interview (Step 3) regardless.

State which mode you're in before continuing.

## Step 1 — Preconditions

1. Confirm **Node.js ≥ 18**. Run: `node -v`. If missing, tell the user to install
   Node 18+ from https://nodejs.org and stop here.
2. Confirm you're in a **git repository**. Run: `git rev-parse --is-inside-work-tree`.
   If not, ask the user whether to run `git init` (don't assume).
3. Identify the repo's main branch (usually `main` or `master`). You'll use it as
   the review baseline.

## Step 2 — Install the tool

specrcheckr is zero-dependency. Add it to the user's repo one of these ways
(ask which they prefer; default to A):

- **A. Vendored (simplest):** copy specrcheckr's `bin/`, `scripts/`, and
  `schemas/` directories into a `tools/specrcheckr/` folder in their repo. Then
  they run it with `node tools/specrcheckr/bin/specrcheckr.mjs <command>`.
- **B. As a dependency:** if specrcheckr is published to npm, `npm i -D
  specrcheckr` and use `npx specrcheckr <command>`.

Then run: `node <path>/bin/specrcheckr.mjs init` — this creates
`specrcheckr.config.json`, a starter `docs/specs/feature-tree.json`, and adds
`.spec-review/` to `.gitignore`. Verify those three files exist.

## Step 3 — Interview the user, then draft the feature tree

**This is the most important step. The whole tool's value comes from a good
feature tree.** Do not skip the interview.

Ask, one at a time:
1. "In one sentence, what does this product do?"
2. "What are the 3–8 main areas of the product?" (these become top-level
   features)
3. For each area: "What are the main things a user can do here?"
4. "Which parts involve accounts, permissions, payments, or anything
   security-sensitive?" (these get `"security": true`)
5. "Where does the code for these mostly live?" (folders/paths)

Then **read the codebase yourself** to fill in detail and to map each feature to
its real `source` files. Cross-check the user's answers against what's actually
there.

Write the result to the configured `featureTree` path, following
`schemas/feature-tree.schema.json`. Each node needs:
- a stable `id` (dotted, e.g. `accounts.login`) — **never reuse or renumber ids**,
- a `label`, a plain-English `description` of what it does **today**,
- a `status`, optional `security`, and `source` paths.

**Then show the user the draft and say clearly: "This is my draft — please
correct anything wrong. It will be imperfect."** Apply their corrections.

Run: `node <path>/bin/specrcheckr.mjs validate`. Fix any errors it reports.

## Step 4 — Configure

Open `specrcheckr.config.json` and confirm with the user:
- `productName`
- `baseRef` (their main branch, e.g. `origin/main`)
- `behaviorGlobs` — the globs that match their real code (you saw the layout in
  Step 3; set these accurately)
- `securityGlobs` — paths that should always raise an access/security flag
- Leave `baseTree` as `null` for real repos (it's only for offline demos).

## Step 5 — First review

Run: `node <path>/bin/specrcheckr.mjs review`. Open the printed
`.spec-review/index.html` and walk the user through it: the feature tree on the
left, the before/after and "what you're approving" on the right, the grouped
flags up top. Explain that to **save** decisions they use `serve` (the file:// page
is view-only).

## Step 6 — Wire the gate (offer, don't impose)

Ask if they want the review enforced automatically. If yes:
- **Pre-push hook:** add a hook that runs `specrcheckr check` and blocks the push
  if it exits non-zero. Show them the hook before installing it.
- **CI:** add a job that runs `specrcheckr check` on pull requests.
`check` passes only when a saved approval matches the current change and nothing
is marked "revise". `SPECRCHECKR_BYPASS=1` is the documented escape hatch.

## Step 7 — Teach the ongoing habit

Tell the user, plainly, the maintenance model (this is in the README too):
- When behavior changes, update the feature's `description` **in the same
  change** — ideally before writing code. Offer to do this for them each time.
- Run the review and approve before shipping.
- Periodically ask you to re-check the tree against the codebase for drift.

## Definition of done — verify ALL before declaring success

- [ ] `node -v` is ≥ 18 and you're in a git repo.
- [ ] Tool files are in the repo; `specrcheckr.config.json` exists and is accurate.
- [ ] `docs/specs/feature-tree.json` exists, the user has reviewed it, and
      `validate` passes.
- [ ] `review` generates `.spec-review/index.html` with the user's real features.
- [ ] `.spec-review/` is gitignored.
- [ ] You explained how to review/approve and the maintenance habit.
- [ ] You did NOT modify app code/CI without explicit consent.

Report what you did, where the review page is, and the exact prompts the user can
reuse later (see the "Prompts you'll reuse" section of README.md).
