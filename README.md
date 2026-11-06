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

- **Node.js** 22.14 or newer (TrueForge needs it), and **pnpm**
- **VS Code** (latest stable)
- **Git**
- **Python** 3.10+ (only for the Flask demo tasks and evals)
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
| `AZURE_FOUNDRY_MODEL` | The DeepSeek deployment name in Azure (default `DeepSeek-V4.1-Flash-2`); must match `models.backup.model` in `config/moon.json` |

`.env` is git-ignored. **Never commit keys.** The keys are given to TrueForge only; Moon's own code never reads them.

When `.env.example` gains a new variable, bring your `.env` up to date without losing your values:

```bash
powershell -ExecutionPolicy Bypass -File config/sync-env.ps1 -NoBackup   # Windows
```

### 3. Create your config

```bash
cp config/moon.example.json config/moon.json
cp config/trueforge.example.json config/trueforge.json
```

- `config/trueforge.json`: the model providers TrueForge should know about (names, models, window sizes). Secrets are not stored here; it names the `.env` variables instead.
- `config/moon.json`: Moon's settings: TrueForge version, URL and port, request timeout and how often the status bar re-checks TrueForge, main and backup model, resilience timers, context budget, and tool limits. Moon checks this file on start and names any field that is wrong.

Real config files are git-ignored; only the `*.example.json` files are committed.

<details>
<summary><b>Every setting in <code>config/moon.json</code></b></summary>

| Setting | Meaning |
|---|---|
| `trueforge.version`, `trueforge.port` | TrueForge package version and port used by `scripts/start-trueforge` |
| `trueforge.baseUrl` | Where Moon talks to TrueForge |
| `trueforge.requestTimeoutMs` | How long Moon waits for TrueForge to answer a request (for a streamed turn: until the stream starts) |
| `trueforge.statusCheckIntervalMs` | How often the status bar re-checks TrueForge |
| `trueforge.allowedOutboundHosts` | Hosts TrueForge may call even though they are local (Moon's MCP server is on localhost) |
| `trueforge.sessionUrlTemplate` | Link to a session in TrueForge's UI; `{baseUrl}` and `{sessionId}` are filled in |
| `models.main`, `models.backup` | `provider` and `model` names as registered in TrueForge |
| `mcp.host`, `mcp.port`, `mcp.path` | Where Moon's MCP server listens. `port: 0` picks a free port on each start; Moon registers the URL with TrueForge itself |
| `mcp.serverName` | Name the MCP server is registered under in TrueForge (and used by the agent definition) |
| `agent.definitionFile` | Agent definition for agent mode, relative to this repository |
| `agent.inlineDefinitionFile` | Agent definition for inline edit (Ctrl+I), relative to this repository |
| `inline.contextLines` | Lines of the file sent with an inline edit, before and after the selection (the agent can read more with its tools) |
| `inline.maxProblems` | Most editor problems (errors, warnings) sent with an inline edit |
| `resilience.*` | Watchdog and circuit-breaker timers for the automatic fallback *(Phase 5)* |
| `context.*` | Project-map size budget *(Phase 4)* |
| `tools.searchMaxResults`, `tools.listFilesMaxResults` | Most matches / files one tool call returns |
| `tools.readFileMaxLines` | Most lines one `read_file` call returns |
| `tools.maxFileBytes` | Larger files are not read or searched |
| `tools.maxOutputChars` | Any tool result is cut at this many characters |
| `tools.ignoredDirs` | Folders the tools never walk into (dependencies, build output, caches) |
| `ui.typingCharsPerSecond` | Steady speed the panel reveals a streamed answer at (it arrives from the model in bursts) |
| `ui.typingMaxLagMs` | The panel speeds up so it is never more than this far behind the real stream |
| `safety.secretFileGlobs`, `safety.secretFileExceptions` | Files the tools refuse to read or list (keys, `.env`, certificates), and the allowed exceptions (`.env.example`) |

</details>

### 4. Start TrueForge (local mode)

```bash
# Windows
powershell -ExecutionPolicy Bypass -File scripts/start-trueforge.ps1

# macOS / Linux
sh scripts/start-trueforge.sh
```

The script checks your Node.js version, then runs `npx @truefoundry/trueforge@<trueforge.version> --port <trueforge.port>` (both from `config/moon.json`) with `OUTBOUND_URL_ALLOWED_HOSTS` set from `trueforge.allowedOutboundHosts`.
That variable is required: TrueForge blocks calls to localhost by default, and Moon's MCP server runs on localhost.

TrueForge then runs at `http://localhost:8790` (chat UI and sessions there, API docs at `/api/v1/docs`). The first start downloads TrueForge and takes about a minute. Leave this terminal open.

### 4b. Add the model providers in TrueForge

TrueForge keeps its model providers in its own settings (it does not read keys from environment variables). With TrueForge running, open a second terminal and run:

```bash
# Windows
powershell -ExecutionPolicy Bypass -File scripts/setup-providers.ps1

# macOS / Linux
sh scripts/setup-providers.sh
```

The script reads the providers from `config/trueforge.json` and the keys, endpoint and model id from `.env`, then creates or updates them through TrueForge's local API (`PUT /api/v1/settings/model-providers`). It only talks to TrueForge, never to a model provider. It never prints key values, and it is safe to run again (for example after rotating a key). At the end it lists the providers in TrueForge with their `provider/model` names.

TrueForge model names may only use lowercase letters, digits and hyphens, so a model id like `DeepSeek-V4.1-Flash-2` is registered under the name `deepseek-v4-1-flash-2`. Use the printed `provider/model` names in `models.main` and `models.backup` in `config/moon.json`.

**About "Outbound URL blocked for host …":** TrueForge's network guard refuses hosts that resolve to private addresses. Some networks' DNS also returns a NAT64 (`64:ff9b::`) IPv6 address for cloud endpoints such as Azure, which trips the guard. `scripts/start-trueforge` already allows the hosts of the endpoints in `config/trueforge.json`, so this should not happen when TrueForge was started with it. If it still does, add the host to `trueforge.allowedOutboundHosts` in `config/moon.json` and restart TrueForge.

**Manual fallback:** open `http://localhost:8790` → settings → model providers and add:

| Provider name | Type | Values |
|---|---|---|
| `anthropic` | Anthropic | API key = `ANTHROPIC_API_KEY`; model `claude-sonnet-5-5` |
| `azure-deepseek` | Custom (OpenAI-compatible) | Base URL = `AZURE_FOUNDRY_ENDPOINT`, API key = `AZURE_FOUNDRY_API_KEY`; model id = `AZURE_FOUNDRY_MODEL`, name `deepseek-v4-1-flash-2`, context length 1048576, max output 65536 |

### 5. Load the agent definitions

The agent definitions live in [`agents/`](agents/):

| File | Used for |
|---|---|
| `agents/moon-agent.json` | Agent mode: full toolbox, approval list, loop limit, compaction |
| `agents/moon-inline.json` | Inline edit: small toolbox, small loop limit |
| `agents/moon-scout.md` | The scout subagent: looks only, reports files and reasons |
| `agents/prompts/*.md` | The instructions and shared safety rules |

Moon sends these to TrueForge itself when it creates a session, with the model taken from `config/moon.json`. You don't need to import them by hand. The JSON files are TrueForge agent specs with three placeholders that Moon fills in: `{{model}}` (from `models.main`, or `models.backup` on fallback), `{{mcpServer}}` (from `mcp.serverName`) and `{{file:...}}` (the text of a prompt file). Moon also registers its MCP server (`moon-editor`) in TrueForge automatically before each new chat.

### 6. Build and run the extension

```bash
pnpm build
```

Open the `moon` folder in VS Code and press **F5** (launch configuration "Run Moon extension"). A second VS Code window opens with Moon loaded. Open a project in it, for example `test-repos/flask`.

In that window:
- The **status bar** (bottom left) shows **"Moon: connected to TrueForge (N models)"**. If TrueForge is stopped it shows **"Moon: TrueForge not reachable"**, and it updates by itself within `trueforge.statusCheckIntervalMs` when you start or stop TrueForge. A warning colour means something needs fixing (hover for the reason).
- **Moon: Check setup** (Command Palette, or click the status bar) lists the models TrueForge has, with their window sizes, and whether Moon's main and backup models are among them. Details are written to the **Moon** output panel.
- The **Moon** icon in the activity bar opens the chat panel. Ask a question about the open project: the live log shows each tool call (`searching "…"`, `reading path:lines`), the answer streams in, **Stop** ends the run at once, and the **TrueForge session** link opens the same session in TrueForge's UI. Every tool call is also written to the **Moon** output panel.

- **Inline edit:** open a file, select the lines to change and press **Ctrl+I** (Cmd+I on macOS) or **Ctrl+Alt+M**. Moon's box opens under the selection with the cursor in it. Type the instruction and press **Ctrl+Enter**. The box shows each step; **Esc** (or the Stop button) stops it and the file stays untouched. Then each change is shown in place, like Copilot: new lines **green**, removed lines **red**, with **Accept / Reject** above each change and **Accept all / Reject all**. The preview is only in the editor, never on disk: saving during review saves only the changes you accepted. After the last decision, **Ctrl+Z** returns to the original code. While changes wait for review, the file and the folders above it show a green dot (●) in the Explorer.

Moon finds its config at `config/moon.json` in this repository. To use another file, set **`moon.configPath`** in VS Code settings to its full path.

**Ctrl+I: Moon or Copilot.** By default Moon takes Ctrl+I in the editor. To give Ctrl+I back to Copilot's inline chat, turn off **`moon.inlineEdit.useCtrlI`** in VS Code settings; Moon's inline edit stays on **Ctrl+Alt+M**. (This is a VS Code setting, not part of `config/moon.json`, because only VS Code settings can switch a keybinding.)

To install it as a normal extension instead *(planned)*:

```bash
pnpm package                  # creates a .vsix file
code --install-extension packages/extension/moon-*.vsix
```

---

## Using Moon

- **Inline edit:** select code → **Ctrl+I** (or **Ctrl+Alt+M**, or right-click → *Edit selection with Moon*) → type an instruction → **Ctrl+Enter** → Accept or Reject each change.
- **Agent mode:** open the **Moon** panel from the activity bar → type a request (optionally with `@file` / `@symbol`) → watch the live log and context card → review the hunks → **Apply**. Use **Undo this whole run** to roll back.
- **Stop:** the Stop button works at every stage and leaves your workspace unchanged.

---

## Test repositories

Moon works on **any project in any language**: open a folder in VS Code and use it. For testing Moon itself (the demo tasks and evals), the repositories we test against are listed in [`config/test-repos.json`](config/test-repos.json), each with its exact commit and its own setup commands. Add an entry there to test on another project or language.

The competition's three fixed tasks run on `pallets/flask`, tag `3.1.3` (commit `22d92470`), which is the first entry:

```bash
# Windows
powershell -ExecutionPolicy Bypass -File scripts/setup-test-repo.ps1 -Name flask
# macOS / Linux
sh scripts/setup-test-repo.sh flask
```

The script clones each repo into `test-repos/` (git-ignored), checks out the pinned ref and confirms the commit, then runs that repo's setup commands (for Flask: a `.venv` with Flask and its test requirements). Local-only files such as the venv are hidden from the repo's `git status` (through `.git/info/exclude`), so `git status` stays clean for Task C. Leave out the name to set up every repo; add `-SkipSetup` / `--skip-setup` to only check out the code. Then open `test-repos/flask` in VS Code.

| Task | Instruction | Check |
|---|---|---|
| **A. Inline edit** | In `src/flask/helpers.py`, select `get_debug_flag`: *"Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false."* | `FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` prints `False` |
| **B. Agent mode** | No files named: *"Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "\*\*\*". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands."* | `pytest tests/test_cli.py -q` passes; the new command prints masked JSON; 3+ files changed |
| **C. Resilience** | Break the main model in TrueForge (invalid key or unreachable endpoint), then repeat Task A | Editor stays responsive, the backup model takes over, `git status` shows no changes |

---

## Development

| Command | What it does |
|---|---|
| `pnpm build` | Build all packages (the extension is bundled with esbuild into `packages/extension/dist/`) |
| `pnpm test` | Unit tests for `packages/core` with Vitest (no model, no VS Code) |
| `pnpm typecheck` | TypeScript checks for every package |
| `pnpm eval` | Run the evaluation scenarios against real TrueForge and a real model *(planned)* |
| `pnpm package` | Build the `.vsix` *(planned)* |

Eval results are written to `packages/evals/results/` (git-ignored) as JSON plus a short report.

### Project layout

```
moon/
├── agents/            agent definitions and prompts (loaded into TrueForge)
├── config/            example config files (no keys)
├── scripts/           start TrueForge, set up test repositories, test helpers
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
