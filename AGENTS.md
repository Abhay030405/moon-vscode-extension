# AGENTS.md

Instructions for AI coding agents working on the Moon repository.

Moon is a VS Code coding agent whose agent loop runs on TrueForge, built for the
**TrueFoundry Forge-a-thon (Techfest 2026-27)**. Round 1 deadline: **20 November 2026, 23:59 IST**.

Read before changing anything:
- `docs/architecture.md`: structure and build plan
- `docs/design-decisions.md`: the reasons behind each decision

If the two disagree, stop and point it out; don't pick one silently.

---

## 0. STOP AND ASK FIRST

The rules below protect our score. **If a change would break, weaken or work around any
rule in sections 1–4, do not implement it. Stop, explain which rule it touches and why, and
ask the user first.** This includes "temporary" shortcuts, debug hacks and test-only bypasses.
When unsure whether something breaks a rule, ask.

---

## 1. Eligibility rules (pass/fail, checked before any scoring)

Breaking any of these disqualifies the submission.

- The agent loop runs on **TrueForge** (local mode, `npx @truefoundry/trueforge@<version>`, pinned to the tested version in `trueforge.version` of the config; currently 0.184.2). Moon never runs its own agent loop.
- The extension is a **client of a TrueForge agent**: it creates sessions and sends turns through the TrueForge HTTP API or TypeScript SDK, and renders the streamed events.
- The extension **never calls a model provider directly**: not for inline edit, embeddings, health checks or fallback pings. Everything goes through a TrueForge session.
- Editor capabilities (read file, search, propose a write, run a command) are exposed as **MCP tools**, so the **agent decides** what to read and change, not the extension.
- Models are configured **in TrueForge** (catalog provider or OpenAI-compatible endpoint). **Never hard-code one provider**; Moon must work with any model TrueForge is configured with.
- The **agent definition** used for the demo is committed in `agents/`.
- **Licences:** keep every borrowed file's licence header and attribution, and list it in `NOTICE.md` (source, link, licence). A licence violation is an eligibility failure.
- **Never keep an upstream project's agent loop** (Cline, Continue, Roo, opencode). `reference/` is for reading only; never import from it.
- **No API keys or secrets in the repo.** Ever. Only example config files are committed.
- No code from an employer or any private codebase.

---

## 2. Scoring rules (what the judges check)

Every feature must keep the behaviour that earns the top anchor. Don't ship anything that drops one.

| Criterion | Pts | Top anchor we must keep |
|---|---|---|
| A1 Inline edit | 10 | Diff rendered **in the editor** with **per-hunk Accept/Reject** (never a chat reply to copy) |
| A2 Agent mode | 10 | Discovers and edits **3+ files the user never named** (Task B) |
| A3 Streaming + cancel | 10 | Tokens stream from TrueForge events; editor **never blocks**; Stop is immediate; cancelled run leaves **no half-applied edits** |
| B1 Context assembly | 15 | @file + @symbol + automatic retrieval **with a size budget**, and the agent **visibly shows which files it chose and why** |
| B2 Diff safety | 10 | **No silent writes to disk**; per-hunk review; **working undo** of an applied change, shown on screen |
| B3 Resilience | 10 | **Automatic fallback to the second model with no user action**; editor responsive; `git status` clean after failure |
| B4 TrueForge depth | 10 | MCP tools + **TrueForge tool approval drives the diff review** + a visible context-engineering feature (subagents, deferred tool loading, compaction or skills) |
| C1 Video | 10 | Tasks A, B, C in order, each verified on screen; TrueForge session shown in Task B |
| C2 Write-up | 15 | Architecture, context strategy, model setup, trade-offs, timestamped scorecard, honest limitations |

**The three fixed tasks** (on `pallets/flask` tag `3.1.3`, commit `22d92470`) must always work:
- **A:** inline edit of `get_debug_flag` in `src/flask/helpers.py`.
- **B:** agent mode adds a `flask config` CLI command (masked JSON, in `flask --help`, tested, documented), touching 3+ files without being told which.
- **C:** with a broken endpoint or invalid key, repeat Task A: editor responsive, backup model takes over, `git status` shows no changes.

**Out of scope (don't build):** tab completion / fill-in-the-middle, training or hosting a model,
any hosted backend or database beyond local TrueForge, user accounts/auth, Marketplace publishing.

**Submission must include:** README that works from a clean clone (start TrueForge, load the agent
definition, example model config, declared starting point "from scratch" + borrowed parts), the
upstream licences, the agent definition, and a write-up stating every model used, where it ran and its cost.

---

## 3. Models

Moon uses exactly **two** models, both configured in TrueForge:

| Role | Model | Where |
|---|---|---|
| Main | Claude | Anthropic |
| Backup (automatic fallback) | DeepSeek V4.1 Flash | Azure AI Foundry, via TrueForge's OpenAI-compatible provider |

- Fallback = start the same request on a new TrueForge session whose agent uses the backup model. Never a direct provider call.
- Model choice must stay swappable from config. The organisers may retest live with a model of their choice.

---

## 4. No hard-coding: config, `.env` and global CSS

**Never write a literal value in code when it is a setting.** That means model names, provider
names, URLs, ports, timeouts, budgets, limits, retry counts and feature flags.

- **Secrets go in `.env`** (git-ignored). `.env.example` lists every variable with an empty value. Keys are entered into TrueForge's own model-provider settings (TrueForge does not read them from environment variables); Moon's code never reads or sends provider keys.
- **Everything else goes in config.** `config/moon.example.json` and `config/trueforge.example.json` hold the main/backup model, provider names, TrueForge URL, timers (watchdog, circuit breaker), context budget, tool output limits, etc. Real configs (`config/*.json`) are git-ignored.
- Code reads settings through **one config module** in `packages/core/src/shared/`. No other file reads `.env` or the config files directly, and no file contains a model name, URL or magic number.
- Real constants (things that never change between setups) live in one constants file in `packages/core/src/shared/`, not scattered inline.
- When you add a new setting: add it to the example config (or `.env.example` for secrets), the config module's types, and the README.

**Styling (webview UI):**
- All colours, spacing, font sizes, radii, shadows and z-indexes are **CSS variables** in `packages/webview-ui/src/styles/global.css`.
- Components use only `var(--...)`. **No hex/rgb colours, pixel values or font sizes inside components.**
- Base the variables on VS Code theme variables (`--vscode-*`) so Moon follows the user's light/dark theme.

---

## 5. Layout

- `packages/core`: all logic. **Never imports `vscode`**, so it can be tested without VS Code.
- `packages/extension`: thin VS Code layer that wires the editor to `core`.
- `packages/webview-ui`: the Moon panel (React + Vite). Global styles in `src/styles/global.css`.
- `packages/evals`: evaluation harness, run against the real TrueForge from the command line.
- `agents/`: agent definitions and prompts (required in the repo).
- `config/`: example config files only.
- `reference/`: read-only clones of Cline, Continue, OpenCode and Aider. Git-ignored.

## 6. Working rules

- Stack: TypeScript, React, VS Code extension API, pnpm workspace.
- Build from scratch; borrow specific pieces only, with credit in `NOTICE.md`.
- Must work on Windows and macOS/Linux (paths, process killing, scripts in both `.ps1` and `.sh`).
- Keep changes small and follow the phase order in `docs/architecture.md` section 7.
- We must be able to explain every line in the shortlist call, so prefer simple, readable code over clever code.

## 7. env rule
- when you change anything in the .env.example run this code always for windows : "powershell -ExecutionPolicy Bypass -File config/sync-env.ps1 -NoBackup", for Linux / Mac / Git Bash :  "sh config/sync-env.sh --no-backup"
