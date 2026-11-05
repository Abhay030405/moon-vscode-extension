# Moon

> **Moon. Orbits your code. Lands only when you say yes.**

Moon is a VS Code coding agent whose agent loop runs on **[TrueForge](https://github.com/truefoundry/trueforge)**, TrueFoundry's open-source agent harness. It reads a real repository, plans a change, edits several files in a hidden copy, and shows every change hunk by hunk for review before anything touches your files.

Built for the **TrueFoundry Forge-a-thon, Techfest 2026-27 (IIT Bombay)**.

> **Status:** in development. The repository holds the project structure and design; features are being built in the order listed in [`docs/architecture.md`](docs/architecture.md#7-build-plan). Commands marked *(planned)* will work once their phase is done.

---

## What Moon does

| Feature | What you see |
|---|---|
| **Inline edit** | Select code, press the keybinding, type an instruction. The proposed diff appears **in the editor** with **Accept / Reject on each hunk**. Ctrl+Z undoes an accepted change. |
| **Agent mode** | One request in the Moon panel drives a TrueForge agent through a tool loop (read, search, edit, run a command). The agent finds the files itself, works in a **hidden copy** of your project, runs the tests there, then hands the changes to you for review. |
| **Context assembly** | `@file` and `@symbol` mentions, a ranked **project map** (tree-sitter) cut to a **size budget**, search tools, and a **scout subagent** that reports which files it picked and why. The choices are shown in a context card. |
| **Diff review** | Files → hunks, Accept all / per file / per hunk, all-or-nothing **Apply** with a backup, and **"Undo this whole run"**. Nothing is written to disk before you review it. |
| **Streaming and cancel** | Words stream as they arrive from TrueForge events, with a short live log of every tool call. **Stop** works at any moment: running commands are killed, the hidden copy is deleted, and your workspace is untouched. |
| **Resilience** | If the main model fails (bad key, unreachable, no reply within ~10–12 s), Moon **switches to the backup model automatically** and tells you. Your files stay unchanged. |

### How it fits together

```
VS Code ── Moon panel (React) + editor diffs
   │
   └── Moon extension ──► TrueForge (local) ──► AI model
          ▲                     │
          └──── MCP tools ◄─────┘   (read, search, edit, run, apply)
```

- Moon **never calls a model provider directly**. Every request is a TrueForge session and turn.
- The editor's abilities are exposed to the agent as **MCP tools** served by Moon on localhost, so **the agent decides** what to read and change.
- TrueForge's **tool approval** drives Moon's review screen and command approvals.

Full details: [`docs/architecture.md`](docs/architecture.md) (structure and build plan) and [`docs/design-decisions.md`](docs/design-decisions.md) (the reasons).

---

## Models

Moon works with **any model configured in TrueForge**; nothing is tied to one provider. Our setup uses two:

| Role | Model | Where it runs |
|---|---|---|
| Main | Claude | Anthropic API |
| Backup (automatic) | DeepSeek V4.1 Flash | Azure AI Foundry, via TrueForge's OpenAI-compatible provider |

**Switching models:** change the main/backup model names in `config/moon.json`, and make sure the same providers are set up in TrueForge. No code changes are needed.

Costs and per-model results are reported in the write-up (`docs/writeup/`).

---

## Requirements

- **Node.js** 20 or newer, and **pnpm**
- **VS Code** (latest stable)
- **Git**
- **Python** 3.9+ (only for running the Flask demo tasks and evals)
- API access to at least one model (see [Models](#models))

Works on **Windows** and **macOS/Linux**.

---

## Setup from a clean clone

### 1. Clone and install

```bash
git clone https://github.com/Abhay030405/moon-vscode-extension.git moon
cd moon
pnpm install
```

### 2. Add your keys

```bash
cp .env.example .env          # Windows PowerShell: Copy-Item .env.example .env
```

Fill in `.env`:

| Variable | What it is |
|---|---|
| `ANTHROPIC_API_KEY` | Key for the main model (Claude) |
| `AZURE_FOUNDRY_API_KEY` | Key for the backup model (DeepSeek on Azure AI Foundry) |
| `AZURE_FOUNDRY_ENDPOINT` | Your Azure AI Foundry endpoint URL |

`.env` is git-ignored. **Never commit keys.** The keys are given to TrueForge only; Moon's own code never reads them.

### 3. Create your config

```bash
cp config/moon.example.json config/moon.json
cp config/trueforge.example.json config/trueforge.json
```

- `config/trueforge.json`: the model providers TrueForge should know about (names, models, window sizes; no keys).
- `config/moon.json`: Moon's settings (main and backup model, context budget, timers, limits).

Real config files are git-ignored; only the `*.example.json` files are committed.

### 4. Start TrueForge (local mode)

```bash
# Windows
./scripts/start-trueforge.ps1

# macOS / Linux
./scripts/start-trueforge.sh
```

The script loads `.env` and runs `npx @truefoundry/trueforge@latest` with `OUTBOUND_URL_ALLOWED_HOSTS=["localhost","127.0.0.1"]`.
That variable is required: TrueForge blocks calls to localhost by default, and Moon's MCP server runs on localhost.

TrueForge then runs at `http://localhost:8790` (session viewer there, API docs at `/api/v1/docs`).

### 5. Load the agent definitions

The agent definitions live in [`agents/`](agents/):

| File | Used for |
|---|---|
| `agents/moon-agent.json` | Agent mode: full toolbox, approval list, loop limit, compaction |
| `agents/moon-inline.json` | Inline edit: small toolbox, small loop limit |
| `agents/moon-scout.md` | The scout subagent: looks only, reports files and reasons |
| `agents/prompts/*.md` | The instructions and shared safety rules |

Moon sends these to TrueForge itself when it creates a session, with the model taken from `config/moon.json`. You don't need to import them by hand.

### 6. Build and run the extension *(planned)*

```bash
pnpm build
```

Then open the `moon` folder in VS Code and press **F5** to launch an Extension Development Host with Moon loaded. On start, Moon checks that TrueForge is reachable and registers its MCP server with it.

To install it as a normal extension instead:

```bash
pnpm package                  # creates a .vsix file
code --install-extension packages/extension/moon-*.vsix
```

---

## Using Moon

- **Inline edit:** select code → press the Moon inline-edit keybinding (see *Keyboard Shortcuts → "Moon"*) → type an instruction → Accept or Reject each hunk.
- **Agent mode:** open the **Moon** panel from the activity bar → type a request (optionally with `@file` / `@symbol`) → watch the live log and context card → review the hunks → **Apply**. Use **Undo this whole run** to roll back.
- **Stop:** the Stop button works at every stage and leaves your workspace unchanged.

---

## Trying it on the competition repository

The three fixed tasks run on `pallets/flask`, tag `3.1.3` (commit `22d92470`):

```bash
# Windows
./scripts/setup-flask.ps1
# macOS / Linux
./scripts/setup-flask.sh
```

| Task | Instruction | Check |
|---|---|---|
| **A. Inline edit** | In `src/flask/helpers.py`, select `get_debug_flag`: *"Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false."* | `FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` prints `False` |
| **B. Agent mode** | No files named: *"Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "\*\*\*". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands."* | `pytest tests/test_cli.py -q` passes; the new command prints masked JSON; 3+ files changed |
| **C. Resilience** | Break the main model in TrueForge (invalid key or unreachable endpoint), then repeat Task A | Editor stays responsive, the backup model takes over, `git status` shows no changes |

---

## Development

| Command | What it does |
|---|---|
| `pnpm build` | Build all packages *(planned)* |
| `pnpm test` | Unit tests for `packages/core` (no model, no VS Code) *(planned)* |
| `pnpm eval` | Run the evaluation scenarios against real TrueForge and a real model *(planned)* |
| `pnpm package` | Build the `.vsix` *(planned)* |

Eval results are written to `packages/evals/results/` (git-ignored) as JSON plus a short report.

### Project layout

```
moon/
├── agents/            agent definitions and prompts (loaded into TrueForge)
├── config/            example config files (no keys)
├── scripts/           start TrueForge, set up the Flask checkout, test helpers
├── packages/
│   ├── core/          all logic; never imports VS Code (TrueForge client, context, hidden copy, tools, safety)
│   ├── extension/     thin VS Code layer: inline edit, agent run, review, status bar
│   ├── webview-ui/    the Moon panel (React + Vite)
│   └── evals/         evaluation harness
└── docs/              architecture, design decisions, write-up source
```

Contributor and AI-agent rules (no hard-coded values, config and `.env` only, global CSS variables, competition rules) are in [`AGENTS.md`](AGENTS.md).

---

## Starting point

**From scratch.** Moon is not a fork. Specific ideas and files are borrowed from open-source projects and credited in [`NOTICE.md`](NOTICE.md) with their source, link and licence. Examples include the per-hunk Accept/Reject approach from [Continue](https://github.com/continuedev/continue) and tree-sitter query files from [Aider](https://github.com/Aider-AI/aider) / [Cline](https://github.com/cline/cline).

No upstream agent loop is used. The agent loop is TrueForge.

---

## Security

- No API keys or secrets are committed. Use `.env` (git-ignored) and the `*.example` files.
- Moon's tools can only touch files inside the project or its hidden copy, never read `.env` or key files, and treat file contents as data, not instructions. Risky commands are flagged in the approval card.

---

## Licence

[Apache-2.0](LICENSE). Borrowed code keeps its original licence and attribution; see [`NOTICE.md`](NOTICE.md).
