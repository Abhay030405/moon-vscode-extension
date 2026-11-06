# Moon: Design Decisions

Coding agent for the TrueFoundry Forge-a-thon (VS Code extension, agent loop on TrueForge).
Round 1 deadline: **20 November 2026, 23:59 IST**.

How to read this file:
- **Decided**: we agreed on it.
- **Decided (confirmed)**: first proposed as a suggestion, then confirmed on 5 Nov 2026.
- **Open**: still to decide or to settle by testing.

The build plan, folder structure, evaluation and safety plan are in `moon-architecture-and-build-plan.md`.

Last updated: 5 November 2026

---

## 0. Ground rules from the PS (never break these)

- The agent loop runs on **TrueForge**. The extension creates sessions and sends turns through the TrueForge HTTP API or the TypeScript SDK.
- The extension **never calls a model provider directly**. This includes inline edit (it also goes through a TrueForge session) and any embedding calls.
- Editor abilities (read file, search, propose a write, run a command) are exposed to the agent as **MCP tools**. The agent decides what to read and change, not the extension.
- **No silent writes to disk.** Every change is shown for review before it touches the real files.
- An applied change must be **undoable**, and undo must be shown on screen in the video.
- Must work with **any model** configured in TrueForge (organisers may retest live with their own model).
- Task C check: `git status` must show **no changes** after a failed run.

---

## 1. Inline edit (A1)

**Decided**
- Flow: user selects code, presses a keybinding, types an instruction in plain English, sees the diff inside the editor, and accepts or rejects **each hunk separately** (aim: full 10 points).
- A rejected hunk leaves the original lines exactly as they were. To change it differently, the user edits by hand or runs inline edit again.
- Editing a hunk inside the diff view: **skip** (no extra points).
- Inline edit runs through a **TrueForge session** with a **smaller toolbox**:
  - Context: selected code + the rest of that file + **errors VS Code already shows on those lines** (Problems list / red underlines).
  - Up to **~3 quick read-only lookups** (read, search, find where something is defined).
  - No scout subagent, no terminal commands, no hidden copy. It must feel fast.
- Errors that only appear when running the program (terminal output): the user pastes them into the instruction.
- **Edit scope, option (b):** the selected lines can change, plus small needed changes elsewhere **in the same file** (for example a new import). These show as a **separate hunk** so the user can see and reject them.

**Decided (confirmed)**
- If accepting only some hunks breaks the code (for example a rename kept in one hunk but not in another): trust the user, no warning.

**Decided**
- When one hunk is accepted and lines move, the remaining hunks are recalculated (see section 9, small items).

**Decided (6 Nov): how it looks, Copilot-style**
- The user asked for it to work like Copilot's Ctrl+I: a small box opens in the editor at the selection, you type there, the change shows in place.
- VS Code's public API cannot add Copilot's inline-chat widget or draw extra lines inside the editor, so Moon uses what the stable API offers:
  - **Instruction box:** VS Code's inline comment box under the selected lines (Moon's own comment controller). Moon opens it through VS Code's "Add Comment" command, which puts the cursor in it. Ctrl+Enter sends. The same box shows the live steps, Stop, and a link to the TrueForge session.
  - **Preview (changed 6 Nov, user's choice, replaces "never inside the file text"):** like Copilot, each change's new lines are put in the editor right under its old lines: new lines **green**, old lines **red**. The stable API can't draw extra lines without putting them in the text, so the preview lives in the **unsaved editor text only**:
    - Saving during review (including auto-save on focus change) writes the file **without** the preview (only accepted changes), then puts the preview back in the editor. Auto-save "after delay" drops the preview instead, so it can't loop.
    - Accept removes that change's red lines; Reject removes its green lines. Each is one Ctrl+Z step, and Ctrl+Z / Ctrl+Y back into a preview state shows its colours and buttons again.
    - After the last decision, the first Ctrl+Z returns straight to the original code (Moon goes back to the original text, then applies the result, as two steps).
    - Closing the box or starting a new inline edit removes the preview. Typing inside the preview hides the colours and buttons until the text matches a preview state again (known limitation).
  - **Buttons:** CodeLens "Accept / Reject" above each change, "Accept all / Reject all" above the first.
- **Ctrl+I:** Moon takes it by default; the VS Code setting `moon.inlineEdit.useCtrlI` gives it back to Copilot. Ctrl+Alt+M always works. (A VS Code setting, not `config/moon.json`, because only VS Code settings can switch a keybinding.)
- Side effect: Moon's comment controller makes every line "commentable" by Moon, so VS Code shows a faint "+" in the gutter on hover; clicking it also opens Moon's box.

---

## 2. Agent mode (A2)

### 2.1 Where the agent works: the hidden copy

**Decided**
- **One full copy of the project per agent run.** Not a copy per step.
- The copy keeps the **same file names and folder structure** (no `xyz_copy.py`, because Python imports would still use the original file).
- The copy lives **outside the project folder** (the system temp folder), so:
  - `git status` stays clean (Task C)
  - search does not find duplicate files
- **Plain folder copy, not git worktree** (a worktree misses uncommitted changes). Skip heavy folders like `.git`, `venv`, `node_modules`.
- The agent reads, writes and runs tests **only inside the copy**. No approval pauses for writes during the run.
- **Moon works on any project in any language**; nothing in Moon's code is specific to one language or to Flask (updated 6 Nov).
- Every command runs **with the copy as its working folder**. Project-specific needs are **settings, not code**: Moon's config can add environment variables for commands run in the copy (for example `PYTHONPATH=src`, or a `PATH` entry for a local tool), with `{copy}` standing for the copy's folder.
- Known case to cover with such a setting: Python projects installed in "editable" mode (like our Flask test setup) may import from the **original** folder instead of the copy, so tests would check the wrong code. Two safeguards: (1) the setting above points imports at the copy; (2) after running tests, Moon checks the run actually used the copy (for example a file path in the test output) and warns if not. **Test this early, on Flask.**
- The copy is **deleted** after review finishes or after cancel.
- Give the agent a small tool: **"list my pending changes"**, so it can re-check what it changed instead of trusting its memory (useful after compaction).

**Rejected options (and why)**
- Approve each write during the run (Cline style): too many interruptions mid-run.
- Write to disk first, review at the end (Copilot/Cursor style): breaks the "before it touches disk" rule.

### 2.2 Review and apply

**Decided**
- At the end, the agent calls one final tool, **"apply changes"**, which requires **TrueForge tool approval**.
- That approval opens Moon's review screen:
  - all changed files, hunk by hunk
  - test results from the copy
  - **Accept all**, per file, and per hunk accept/reject
- TrueForge approval is a plain **allow / deny**. So:
  - the extension remembers which hunks the user picked
  - sends **allow** (or **deny** if everything was rejected)
  - the "apply changes" tool, which runs inside the extension, writes **only the accepted hunks**
  - it tells the agent which hunks were rejected (if everything is rejected, the **deny reason** carries this, since TrueForge shows deny reasons to the agent)
- If the user rejects some hunks, the test results may no longer be accurate. Show a note ("You rejected N hunks, test results may be out of date") and a **Re-run tests** button.

### 2.3 Terminal commands

**Decided**
- The user is asked before commands run.
- **TrueForge decides when to pause** (the run-command tool is marked "needs approval" in the agent setup). The extension only shows the question and sends the answer back.
- Three buttons: **Allow once** / **Always allow this command for this run** / **Deny**. ("Always allow" maps to TrueForge's built-in "allow for this session" approval rule.)
- Commands run inside the hidden copy.

---

## 3. Context assembly (B1, plus B4)

### 3.1 Four layers

**Decided**
1. **@-mentions** (what the user names)
   - `@file`: whole file if it fits in the budget. If too big: the file's outline (function/class names) + a note "large file, read the parts you need".
   - `@symbol`: a **drop-down picker while typing** (for example `run`: `app.py` line 600 / `run`: `cli.py` line 800), so there is never confusion about which one.
2. **Project map at the start** (Aider style): folder structure + important function and class names per file, ranked, **cut to fit the budget**.
3. **Search tools for the agent** (Claude Code / Cline style): word search, find where something is defined, find where something is used, read **part** of a file (line range).
4. **Scout subagent** (TrueForge subagent): searches in its own context and returns a short report, "these files matter, and here is why". Keeps the main agent's context clean.

**Decided: no meaning-search (embeddings)**
- Risk to the eligibility rule (the extension must not call a model provider directly).
- The index goes out of date and is extra work.
- State this choice and the reason in the write-up.

### 3.2 Budget and compaction

**Decided**
- Project map budget = **10% of the model's window**, with a **minimum and a maximum** so it isn't useless on small models or wasteful on huge ones.
- **Window size:** first read it from TrueForge (each configured model can carry `contextLength`). If it's not filled in, use a **Moon setting** ("model window size") with a safe default.
- Use the **same window number** for the map budget and for TrueForge's compaction threshold.
- **Compaction: use TrueForge's built-in compaction** (on by default; triggers at 80% of the model's window, or 50,000 tokens if the window is unknown; the threshold can be set explicitly). Don't build our own.
- Compaction must never lose: **the plan, the changed files, the user's decisions**. The hidden copy is the source of truth for changes (via "list my pending changes").

### 3.3 Showing the agent's choices (needed for 15/15 on B1)

**Decided: option (c)**
- The panel shows 3–5 chosen files, **one line of reason each**, plus a small **budget bar** (for example "map 1.8k / 4k").
- The reasons must come **from the agent** (the scout's report), not be written by the extension.
- Must be readable in about 2 seconds in the video.

### 3.4 Languages

**Decided**
- The project map uses **tree-sitter**. Reuse the existing rule files from Aider or Cline, keeping their licence and credit.
- **Python and JS/TS in the main build** (Phase 4): Python because the judged tasks use it, JS/TS because it is the most common language people will try Moon on. **Java and Go** next (stretch). Each language is a grammar + rule file, not new logic (updated 6 Nov).
- Any other language: fall back to the file list + search tools (Moon still works, with a thinner map).
- Search, read and run-command tools already work for every language.
- VS Code's own symbol list (from installed language extensions) is **not** the main path: it depends on the user's extensions and can be slow.

### 3.5 TrueForge context features (B4)

**Decided**
- Main feature: **subagents** (the scout). Also using built-in **compaction**.
- **Deferred tool loading** and **dynamic subagents** are **on by default** in TrueForge (section 7). Mention and show them in the write-up.
- **Code Mode: not used.** Code Mode lets the agent write a small script that calls many tools in one go and only returns the final result. In TrueForge it **needs the sandbox**, which does not run on Windows.
- **TrueForge skills: not used for now**, for the same reason (TrueForge says skills need the sandbox). The later notes feature (section 5) gives its notes to the agent as plain text at the start of a session instead.

---

## 4. Streaming and cancellation (A3)

**Decided**
- Agent-mode Stop **while the agent is working** = **delete the hidden copy**. The real files were never touched, so the workspace stays consistent.
- **Closing or leaving the review screen halfway** (for example 3 of 6 hunks accepted):
  - It's a session; the user can come back and continue the review later.
  - When the review is finished, accepted hunks are applied and the rest stay unchanged.
- **Stop during inline edit:** show **nothing**. The half-streamed diff disappears and the original code stays exactly as it was.
- **Stop kills a running terminal command** too (for example `pytest`).
- **Second stop path:** if **TrueForge itself cancels** a tool call (for example on a timeout), the run-command tool listens for that cancel message and kills the running process too.
- **While the agent works, show short live logs** (short summaries like "searching 'cli command'", "reading cli.py") along with the streamed words.

**Decided (confirmed)**
- **Review, closing halfway:** while reviewing, clicks only **mark** hunks as accepted/rejected. Nothing is written until the user presses **Apply**. If the panel is closed before Apply, the hidden copy and the choices are **kept** (not deleted) so the user can resume; the TrueForge turn simply stays paused waiting for approval. A **Discard** option throws everything away.
- **Apply is all-or-nothing:** before writing, save a backup of every file being changed. If any write fails, restore all of them. (This backup is also what "Undo this whole run" can use.)
- **Check before Apply:** if the user edited a real file by hand after the copy was made, a hunk may no longer fit. Detect this and warn instead of writing into the wrong place.
- **Inline edit streaming goes into a preview only** (shown on top of the code), never into the real file text. So Stop just removes the preview, with nothing to undo.
- **Small "Stopped" message** in the status bar for a moment after Stop, so the user knows it worked (also clear in the video).
- **Who stops the terminal command:** the run-command tool runs inside the extension, which started the process, so the **extension kills it directly** the moment Stop is clicked. It doesn't wait for TrueForge to tell it.
  - Order on Stop: kill the running command → tell TrueForge to cancel the turn → delete the hidden copy → show "Stopped".
  - Kill the command **and any processes it started** (pytest can start helpers). Ask it to stop politely first; force-kill after a few seconds.
- **Live logs come from TrueForge's streamed tool-call events**, not invented by the extension. Keep them to one short line each.

**Open**
- Cancel: **confirmed**, TrueForge has `sessions.cancel`. Still to test: how long a paused (waiting for approval) turn can stay paused.

---

## 5. Moon notes (memory) feature: built AFTER the required features

**Decided**
- Notes are **never written inside the project**. On first use, Moon asks the user to choose a notes folder outside the project.
- After an **agent-mode** task, Moon shows **only a quiet one-line hint**: "run `/update` to save what I learned". No pop-ups. No hint after inline edits.
- `/update` runs **only after review is finished**, and reads the **real accepted code** (not the hidden copy).
- `/update` runs **in the background**, as its own small TrueForge session or subagent (never a direct model call).
- The background job and a new main task can **both run at the same time**.
- If the model says "too many requests", the background job waits and retries later. The main task always gets the model first.
- Build order: **after** the five required features work end to end.

**Decided (confirmed)**
- One sub-folder per project inside the notes folder, matched by project path or git remote address.
- Notes are **hints, not truth**: the agent always confirms by reading the real code.
- Save the date or git commit with each note, so Moon can say "this note may be old".
- Only **general** skills (how to work: find similar code first, add a test, update docs, how to run tests in the copy). **No Flask-specific notes for the demo**, because naming the files in a note can look like "the user named the files" (A2/B1 risk).

---

## 6. Resilience and models (B3, Task C)

Task C: the organisers break the model (unreachable address or invalid key) and repeat Task A. The editor must stay responsive, the user sees a clear message or a second model takes over automatically, and `git status` shows no files changed. Aim: **10/10 = automatic switch to a second model with no user action.**

**Decided**
- "Files unchanged" is already guaranteed: inline edit is preview-only and agent mode works in the hidden copy.
- **Models available:**
  - Claude, direct from Anthropic (~$100 credit)
  - DeepSeek V4.1 Flash via Azure AI Foundry (backup), deployment `DeepSeek-V4.1-Flash-2`
- **Azure facts, checked on our deployment (6 Nov):**
  - Context window **1,048,576 tokens** (from Azure's own error message). Output has **no separate cap**: input and output share that window (a request allowing 1,048,000 output tokens was accepted).
  - So TrueForge's "max output" for this model is set to **65,536**, not the full window: if the requested output equals the window, any input pushes the total over the limit and Azure rejects the call.
  - Azure lists **DeepSeek-V4.1-Flash as "preview", retiring 15 Dec 2026**, one day before Round 2 (16–18 Dec). See open items.
- **Handle each kind of failure differently:**
  - Wrong API key / model not found → switch to the backup **immediately** (retrying can't fix it)
  - Server unreachable / server error → switch right away (TrueForge has already retried twice); no reply at all → Moon's 10–12 s watchdog, then switch
  - Too many requests → wait and retry, then switch if it keeps happening
  - Model dies halfway through an answer → throw away the half answer, start fresh on the backup (never join two halves)
  - The user never waits more than about **10–15 seconds** before the backup takes over
- **Switching back to the main model** (user's idea, which matches the industry "circuit breaker" pattern):
  - After switching, keep using the backup for a while.
  - In the background, now and then send a tiny test request to the main model.
  - When the main model answers again, switch back **after the current task finishes**, never in the middle of one.
- **Short message on switch**, for example: "Main model failed (invalid key), switched to backup: X". Also shown when switching back.
- **If every model fails:** clear message, nothing changed, plus a **Retry** button.

**Decided (confirmed)**
- **Order:** main = **Claude (Anthropic)**, backup = **DeepSeek V4.1 Flash on Azure AI Foundry**. Only these two models are used (Gemini / Google Cloud dropped). The backup must be a **different provider with a different key**, so one broken key or one provider outage can't take down both.
- **Background test requests also go through TrueForge** (never a direct call). Keep them rare and growing apart (for example after 30s, then 1 min, then 2 min...), because each one costs a little.
- **Wrong-key failures don't fix themselves.** Instead of pinging forever, test the main model again **when the model settings change**, plus a slow background check.
- Fallback applies to **both** inline edit and agent mode.
- To save credits: do day-to-day development and testing mostly on the cheaper model, and save Claude for real test runs and the demo recording.

**Decided: who does the switching**
- **Option (b), the extension does it.** It notices the failure (turn ends with "error") and runs the same request again on a **new session whose inline agent definition uses the backup model** (still never a direct model call).
- Option (a), a TrueForge built-in backup setting: **checked, does not exist** in SDK v0.183. Kept in mind in case a later version adds it.
- Not using (c), an AI gateway (more setup, and unclear what the organisers will break in Task C).

**Decided (tested)**
- TrueForge errors are plain text, but they **include the provider's status number** (tested: `[Model Error] Request failed (401): invalid x-api-key`). Classify by that number: 401/403/404 → switch now; 429 → wait, retry, then switch; 5xx → switch now (TrueForge already retried). **No number or anything unknown → switch to backup.** Unreachable address, tested: `[Model Error] Cannot connect to API:` (no number) → switch to backup.
- Providers: Anthropic is built in; Azure DeepSeek via the custom OpenAI-compatible provider. Anthropic key confirmed; Azure AI Foundry key and endpoint to be set in `.env`.

**Decided (confirmed; after reading TrueForge's timeouts, section 7)**
- **TrueForge already retries twice**, so on a 5xx or unreachable error Moon **switches to the backup right away** instead of retrying again.
- **Moon's own timer (watchdog):** if no streamed event arrives within about **10–12 seconds** of sending, Moon cancels the turn and switches. This covers servers that never answer (TrueForge alone would wait up to minutes).

---

## 7. What we learned about TrueForge

**Checked directly in the TrueForge SDK package** (`@truefoundry/trueforge-sdk` v0.183, its type definitions and reference), 5 Nov 2026. Still worth a quick run of the real server to confirm behaviour.

**Sessions, turns, streaming, cancel**
- The extension creates a **session**, then sends **turns** and reads a **live event stream** (word-by-word message pieces, tool calls, tool results, approval requests, compaction started/finished, turn done).
- **Cancel exists:** `sessions.cancel`. A turn ends as **done, cancelled, or error**.
- A paused turn (waiting for approval) is just a state; the client answers it later in a new turn. Need to test how long it can wait.

**Tool approval (our review screen and the command buttons)**
- Each MCP server attached to an agent has a list of **tools that need approval**. The **default is "@write" and "@destructive"**, so we must set this list ourselves: `run_command` and `apply_changes` need approval; tools that only write into the hidden copy must **not** pause.
- The answer is **allow** or **deny**, and **deny can carry a reason that the agent sees**.
- **"Always allow this command for this run" is built in:** an "allow for this session" approval rule, with an optional expiry time.

**MCP tools: how TrueForge reaches the extension**
- TrueForge connects to MCP servers **over HTTP only** (streamable HTTP or SSE), registered by URL in its settings. No "start a local program" option.
- So the **extension must run a small MCP server on localhost** and register its address with TrueForge.
- TrueForge also has "client tools" (it pauses and asks the client to run a tool). **Not using these**, because the rules require the editor's abilities to be MCP tools.

**Models**
- An agent definition has **one model** (`provider/model`). **There is no built-in backup-model setting**, so resilience **option (a) does not exist** in this version. Option (b) is confirmed.
- A session can be created with a **full agent definition written inline**, so the extension **can pick the model per session**. Switching to the backup = start the request on a session whose agent uses the backup model.
- Each configured model can carry its **window size** (`contextLength`) and max output size. So the window size can come from TrueForge **when it's filled in**. Otherwise use the Moon setting.
- Providers available: Anthropic, Google Gemini, OpenAI, a **custom OpenAI-compatible endpoint** (used for the Azure DeepSeek backup), and others.
- **Errors come as a human-readable message, with no separate error-code field.** But the message **contains the provider's status number in brackets** (see the wrong-key test below), so Moon reads that number. Anything unknown → switch to backup.

**Context features (B4)**
- **Compaction:** on by default, 80% of the model window or 50,000 tokens if unknown, explicit threshold possible.
- **Dynamic subagents:** on by default (the agent can start helpers). Our scout can use this.
- **Deferred tool loading is the default** for MCP tools (only tool names first, full details when needed), with an option to preload chosen tools.
- **Large tool responses** are moved out of the main context automatically (on by default; uses the sandbox, check if it works without one).
- Agent definitions also support **skills**, a **loop step limit** (default 512), and "ask the user a question".
- **Skills and Code Mode need the TrueForge sandbox** (the SDK says so in its sandbox setting), and the sandbox does not run on Windows. So Moon uses neither.

**Chat UI kit (`@truefoundry/trueforge-ui`)**
- React chat interface built on assistant-ui, needs **Tailwind CSS**, can connect straight to a TrueForge server, and allows replacing its components.
- **Decided: not used.** Moon builds its own panel.

**Seen on the Windows development laptop (TrueForge v0.183.1, standalone mode)**
- Runs at `http://localhost:8790`, with its own chat UI there and API docs at `/api/v1/docs`.
- Auth is off in local mode, so the extension needs no login token.
- Data is stored in a local SQLite file (in the Windows AppData folder).
- **The TrueForge sandbox does not work on Windows** ("macOS and Linux only"). Our design doesn't need it (the hidden copy and commands are handled by the extension). But features that use the sandbox, like **moving large tool responses out of context**, may not work on Windows. So **our tools must keep their own output small** (read part of a file, limit search results).
- The repeated "sandbox-environments/pending" log lines every 5 seconds are normal background checks. Ignore them.
- **Tested in the TrueForge UI:** a model answers through TrueForge, the answer **streams word by word**, the UI shows a short step summary ("Agent steps · N tool calls · N thoughts"), and **stopping mid-answer works**: the turn ends marked **"client-cancelled"**. In TrueForge's own UI the half answer stays visible; Moon hides it for inline edit (section 4).
- **Wrong key, tested (Anthropic):** the error text is `[Model Error] Request failed (401): invalid x-api-key`. The provider's **status number is inside the text in brackets** (here `401`), so Moon can read that number instead of guessing from words: 401/403 → switch now, 429 → wait and retry, 5xx → switch now (TrueForge already retried).
- **Unreachable address, tested** (`http://localhost:9999/v1`, after allowing localhost): the error text is `[Model Error] Cannot connect to API:`. **No status number.** It appeared in **under 1 second** (nothing listening at that address = refused instantly). Moon treats "Cannot connect" as unreachable → switch to backup right away. The 10–12 s watchdog is still needed for servers that connect but never answer.
- The TrueForge UI has a **chat history / sessions list** to switch between chats. This is where the Task B session can be shown in the video.
- Custom (OpenAI-compatible) providers **require** context length and max output tokens, so TrueForge always knows the window size for them. Provider names must be lowercase letters, digits and hyphens.

**IMPORTANT: TrueForge blocks localhost and private addresses by default** (found when adding a provider at `localhost`: "Outbound URL blocked for host localhost"; confirmed in `@truefoundry/trueforge-core`, file `ssrfGuard`)
- A safety guard (on by default) blocks outgoing calls to `localhost`, `127.x`, private networks (`10.x`, `192.168.x`, `172.16–31.x`), test ranges, and names ending in `.local`, `.test`, `.invalid`, `.example`, etc.
- **The same guard applies to MCP servers.** So TrueForge **cannot reach Moon's localhost MCP server** unless we allow it. Same for a local model (Ollama).
- **Fix:** start TrueForge with the environment variable `OUTBOUND_URL_ALLOWED_HOSTS` set to `["localhost","127.0.0.1"]` (a JSON list). Hosts on this list skip the check. (`NETWORK_POLICY_ENABLED=false` turns the whole guard off, but the allow list is the safer choice.)
- **This must go in the README setup steps**, or Moon won't work for the judges.

**TrueForge's own timeouts and retries for model calls** (defaults, from the server code; all changeable with environment variables)
- Connect timeout **5 seconds**; waiting for the first reply **2 minutes**; **2 automatic retries** (waits of about 1s, then 2s).
- So TrueForge **already retries** server errors and unreachable addresses before reporting an error. A dead address can take ~15–20 s to fail; a server that connects but never answers could take **minutes**.

**Windows also matters for our extension (decided)**
- Must work on **Windows, macOS and Linux**, because development happens on Windows and the judges may use anything.
- Killing a command and its helper processes works differently on Windows. Test Stop on Windows specifically.
- Path separators differ (`\` vs `/`), including when pointing Python at the copy's `src` folder.

**Not needed**
- MCP Gateway approvals (an enterprise feature) and the TrueForge sandbox (optional per the PS).

---

## 8. Starting point

**Decided**
- **Build from scratch, and borrow specific pieces** from open source (not a full fork of Cline / Roo / Continue / opencode).
- Why:
  - Cline/Roo's own agent loop is wired into everything and must be removed (eligibility rule). Untangling it would eat most of the 15 days.
  - Our flow (hidden copy, one review at the end) is different from theirs, so the parts we'd reuse are the parts we'd replace.
  - The shortlist call requires explaining our own code. A small codebase we wrote is much safer than a 100k+ line fork.
  - Claude Code (our main coding tool) works much better on a small, clean project it can fully see.
  - Judges score our changes from the start point. From scratch, everything is our work and the git history is clean.
- **README will say:** "from scratch", plus a list of borrowed files/ideas with their source projects and licences.
- Comfortable stack: **TypeScript, React and VS Code extensions**.

**What to borrow** (keep licence and credit)
- Per-hunk "Accept | Reject" in the editor: approach from **Continue**.
- **Tree-sitter rule files** from Aider or Cline (project map).
- VS Code built-ins: diff view, drop-down picker (`@symbol`), Problems list (errors).
- **Not using the TrueForge chat UI kit.** Moon has **its own UI** (React panel inside VS Code), built for our flow (context card, live logs, approval cards, review screen).

---

## 9. MCP tools and agent setup

**Decided**
- **One MCP server** inside the extension, on localhost (TrueForge started with `OUTBOUND_URL_ALLOWED_HOSTS`). Each kind of agent is switched on only for the tools it needs.
- **Tool list:**
  - Looking around (never pause): `list_files` (skips junk folders, size limit), `search_text` (max ~50 results), `find_definition`, `find_usages`, `read_file` (line range only), `get_errors` (VS Code's error list for a file)
  - Changing the hidden copy (never pause): `edit_file`, `list_pending_changes`
  - Pause for the user (TrueForge approval): `run_command`, `apply_changes`
  - Inline edit only: `propose_edit`
- **Who gets which tools:**
  - Agent mode: all looking-around tools + edit tools + `run_command` + `apply_changes`
  - Scout subagent: looking-around tools only (can look, never change)
  - Inline edit: looking-around tools + `get_errors` + `propose_edit` (no terminal, no hidden copy)
- **`edit_file` works by replacing an exact piece of text** ("find these lines, replace with these"), like Claude Code and Cline. Uses little text; if the model gets the old text wrong, the edit fails safely. **Whole-file writing only for new files.**
- **The project map is put in automatically** at the start of every agent-mode session (not a tool the agent has to remember to call). It stays within the 10% budget.
- **Inline edit hands back its change through the `propose_edit` tool** (fixed shape, works the same with any model). Moon turns it into the in-editor diff with Accept/Reject.

**Decided: where the project map is kept**
- The map is **cached in Moon's own folder, outside the project** (the same notes folder), one cache per project. It is **never written into the project**.
- Moon remembers **when each file last changed** and, at the start of a session, re-reads **only the changed files**. Updates are automatic and almost instant. The user never has to update anything.
- Why: the map is built by tree-sitter (no AI call, no credits), so rebuilding is cheap. A map the user must update by hand goes stale and misleads the agent.
- **If the project already has an `AGENTS.md` or `CLAUDE.md`, Moon reads it and gives it to the agent, but never writes to it** (the industry habit: those files are short rules written by people).
- Rejected: storing the generated map in `AGENTS.md` (changes the user's project and `git status`, fills other tools' context, goes stale when the user forgets to update it).

**Decided: small items**
- **Undo after apply:** agent mode has an **"Undo this whole run"** button that restores every file from the backup saved just before Apply (one click, easy to film for B2). Inline edit is applied through VS Code's editor, so normal **Ctrl+Z** undoes it.
- **Unsaved editor changes:** Moon never saves the user's files for them. The hidden copy is made from the **text as shown in the editor** (including unsaved typing), and Apply writes through the editor too.
- **Hunk positions moving:** after every accept or reject, Moon **recalculates the remaining hunks** by comparing the current file with the proposed final version. No position tracking to get wrong.
- **The agent's written instructions:** first draft written during building, then tested on Task B and adjusted.

---

## 10. Open items (all in one place)

1. (done) Hunk positions: recalculated after each accept/reject.
2. (done) Unsaved changes: copy taken from editor text.
3. (done) Undo: "Undo this whole run" button + Ctrl+Z for inline edit.
4. Test while building: how long a paused (waiting for approval) turn can wait.
5. (done) Code Mode: not used (needs the sandbox; not on Windows).
6. (done) Errors captured: wrong key `... (401): invalid x-api-key`; unreachable `Cannot connect to API:` in under 1 second.
7. (done) Models: both providers registered in TrueForge by `scripts/setup-providers` (Anthropic `claude-sonnet-5-5`, Azure `deepseek-v4-1-flash-2`); Azure limits confirmed (section 6).
8. (done) UI: Moon builds its own panel; the TrueForge chat UI kit is not used.
9. (done) MCP tools and map storage decided (section 9). The agent's written instructions: drafted during building.
10. (done) TrueForge running locally, model added; chat, streaming, cancel, wrong-key and unreachable tests done.
11. (done) Architecture, folder structure and build plan: see `moon-architecture-and-build-plan.md`.
12. **Azure model retirement:** `DeepSeek-V4.1-Flash` (preview) retires on **15 Dec 2026**, before Round 2. Before the finals, move the backup to a model that stays available (for example `DeepSeek-V4-Flash`, generally available until Feb 2028, or `DeepSeek-V4.1-Flash-1017`, preview until Mar 2027). Only `.env` and `config/moon.json` change; no code. Also confirm in the Azure portal which base model the `DeepSeek-V4.1-Flash-2` deployment uses.
13. **Pin the TrueForge version before recording the demo.** `trueforge.version` is `latest` while building; set it to the exact version we tested (0.184.1 today) before recording and submitting, so a TrueForge release on the last day can't break the demo or the judges' setup.
14. Confirm while building the TrueForge client: sessions refer to a model as `provider/name` (for example `azure-deepseek/deepseek-v4-1-flash-2`).
15. **Test projects in more languages:** add at least one small JS/TS repo to `config/test-repos.json` with a few retrieval scenarios, so "works on any language" is checked, not just claimed.

---

## 11. Setup facts learned while building (6 Nov)

- **TrueForge does not read provider keys from environment variables.** Providers live in TrueForge's own settings. `scripts/setup-providers` writes them through TrueForge's local API (`PUT /api/v1/settings/model-providers`), using `config/trueforge.json` (which providers and models) and `.env` (keys, endpoint, model id). It only talks to TrueForge, never to a model provider.
- **TrueForge names** (providers and models) may only use lowercase letters, digits and hyphens, so the Azure deployment `DeepSeek-V4.1-Flash-2` is registered as `deepseek-v4-1-flash-2`. Well-known providers are named by their type (`anthropic`); custom ones choose a name (`azure-deepseek`).
- **TrueForge's network guard can block cloud endpoints too**, not only localhost: on some networks DNS also returns a NAT64 (`64:ff9b::`) address, which the guard treats as private. `scripts/start-trueforge` therefore allows localhost **plus the hosts of our own provider endpoints** (read from `.env`).
- **Test projects are data, not code.** `config/test-repos.json` lists the repositories used to test Moon (Flask 3.1.3 for the fixed tasks first), each with its exact commit and its own setup commands; `scripts/setup-test-repo` prepares them in `test-repos/` (git-ignored). Moon's own config knows nothing about them.
- TrueForge needs **Node.js 22.14+**.
