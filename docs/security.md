# Moon security architecture

Built against the **OWASP Top 10 for LLM Applications (2026)** and its mapping to **OWASP AISVS 1.0**.
This file is the threat model, the controls as built, where each lives in the code, how it is
tested, and what it does **not** cover.

## 1. Principle

OWASP 2026, preface: *"Stop trying to build a model that cannot be fooled. Build the system around it,
so that when the model is fooled, and it will be, nothing important breaks."*

Moon follows that literally:
- **Every control is deterministic TypeScript**, mostly in `packages/core/src/safety/`.
- **None of them asks a model** to judge safety. That also keeps AGENTS.md section 1: Moon never calls a model provider directly.
- **The prompt rules** (`agents/prompts/safety-rules.md`) are an extra soft layer. Nothing depends on them.

## 2. Threat model

**What we protect:**
- the user's project and git state;
- secrets on the machine (environment variables, `.env`, keys inside ordinary files);
- the user's shell;
- the user's GitHub account (when that extra is on);
- past conversations (memory);
- money (tokens).

**Where untrusted text comes from (LLM01 "delivery surfaces"):**

| Source | Trust |
|---|---|
| Project files, including AGENTS.md / CLAUDE.md and tests | Trusted surface, but anyone with commit access can plant text |
| Command output | Semi-trusted (the project's code produced it) |
| Web search / fetch, GitHub issues and PRs | Untrusted |
| Earlier conversations (memory) | Can be poisoned |
| The model's own output | Treated as untrusted (LLM10, zero trust) |

```
 user ──(panel)──▶ extension ──▶ TrueForge (local) ──▶ model provider
                     ▲   │             │
                     │   ▼             ▼ tool calls (the model chooses)
            Moon MCP server (token-protected, localhost)
                     │
   project files · hidden copy · shell · past sessions      outside: web search, GitHub MCP
```

**The lethal trifecta / Rule of Two (LLM01 #8).** Moon's agent has all three legs:
- **A. untrusted input:** always, and more when web search or GitHub is on;
- **B. sensitive data:** the project and its secrets;
- **C. state change / outbound communication:** the shell, GitHub writes, links in answers.

OWASP says such an agent needs per-action human approval. Moon has that, and adds:
- controls that limit **what an approval can be fooled about**;
- removing leg C (network commands) whenever leg A is strongest (the taint rule, below).

## 3. The layers as built

```
 model's tool call ─▶ L1 MCP auth ─▶ L2 policy ─▶ L3 approval card ─▶ approval ledger ─▶ tool runs in L4
                      (token, no      (block/warn,   (exact action,       (run_command runs    (env allowlist,
                       browsers)       taint)         hidden chars        only what the user   network blocked,
                                                      shown)              approved)            copy, timeouts)
 tool result ─▶ L5 model filter (secrets redacted, hidden chars shown, control codes removed, untrusted wrapper) ─▶ model
 model output ─▶ L6 (memory-write check, link confirmation, review warnings, Verified line) ─▶ panel / disk
 everything ─▶ L7 security log (hash-chained)      per task ─▶ budget (calls, loops, commands, tokens, time)
```

### L1. Who may call Moon's tools (fixes "a direct call skips the approval")
- **Per-start bearer token.** `tools/server.ts` makes a random 32-byte token on every start and keeps it in memory only. Moon registers it with TrueForge as header auth (`trueforge/registration.ts`). This was checked live: TrueForge 0.184 sends the header on every request.
- **401 without the token, 403 for any request with an `Origin` header.** Every browser sends `Origin`; TrueForge doesn't. The Host allowlist against DNS rebinding stays.
- **Tested by** a unit test (`core/test/tools.test.ts`) and the eval scenario `direct-mcp-call`.

### Complete mediation: the approval ledger (LLM03 #7)
TrueForge asks the user before it calls a tool, but Moon's tool can't see that answer. So:
- The extension records every Allow in the run's `ApprovalLedger` (`safety/approval-ledger.ts`). The key is a SHA-256 of the tool name plus its canonical arguments; the record expires after `security.approvalTtlMs`, and each approval works once.
- `run_command` runs **only** with a matching record.
- "Always for this run" is a sticky record for that exact command. It is never offered in a tainted task.
- `apply_changes` already had the same property: it writes only what the user accepted on the review screen.

### L2. Command policy and taint (LLM03 #7, LLM01 #8)
`safety/command-policy.ts` gives every command a verdict before any card shows.
- **Splitting.** The command is split on `&&`, `||`, `;`, `|`, `&`, newlines, `$( )` and backticks, and every part is checked.
- **Block** (`security.blockedCommandPatterns`): no card, a clear reason to the agent, and a log entry. Covers:
  - encoded PowerShell, `iex`, decode-and-pipe, piping into a shell or interpreter;
  - `git push`, changing git remotes, hooks or credentials;
  - registry, services and scheduled tasks;
  - whole-drive deletes and shell start-up files;
  - any command containing hidden characters.
- **Network** (`security.networkCommandPatterns`): `curl`/`wget`/`iwr`, `ssh`/`scp`/`nc`, inline Python/Node using the network, package installs, `git clone/fetch/pull`.
  - Normally: a red warning on the card.
  - In a **tainted** task: blocked.
- **Taint.** A task becomes tainted once the agent uses a tool whose result comes from outside the project:
  - web search or fetch;
  - `read_past_session`;
  - any third-party MCP tool (e.g. GitHub).

  In a tainted task, network commands are blocked, "Always" disappears, and the generic card says which outside source came first. Taint is tracked in `extension/src/agent-run/agent-session.ts`.
- **Defence in depth.** `run_command` re-checks the block list itself, even after an approval.

### L3. Approval cards that can't be fooled (LLM01 #5, #7)
- **Hidden characters** (Unicode tag block, variation selectors, zero-width, bidi overrides and isolates) are shown as `⟦U+202E⟧` on the generic card, in the review diff and in tool results (`safety/unicode.ts`). A command containing any of them is blocked outright.
- **Workspace Trust.** In a folder VS Code marks as Restricted, agent mode can read but runs no commands and applies nothing (`capabilities.untrustedWorkspaces: limited`).

### L4. The command sandbox-lite (LLM02 #2, LLM03 #4, LLM06 #4)
- **Environment allowlist** (`safety/command-env.ts`, `security.commandEnvAllow`). Commands get only system basics (PATH, TEMP, HOME, ...) plus Moon's `agentRun.commandEnv`. A variable whose **name** matches `security.secretEnvNamePattern` (TOKEN, SECRET, KEY, PASSWORD, ...) is never passed, even if listed. `GITHUB_TOKEN`, `AWS_*` and API keys of the VS Code process never reach a command.
- **Network blocked by default** (`security.blockCommandNetwork: true`). The proxy variables point at a dead local port (`127.0.0.1:9`) and `PIP_NO_INDEX=1` is set, so pip, npm, curl, Python and Node fail to connect. Localhost still works.
  - This is a speed bump, not a sandbox: a program can ignore proxy settings.
  - Turn it off per machine in config if a project's commands need the internet.
- **Unchanged from before:**
  - commands run in the hidden copy;
  - timeouts;
  - process-tree kill on Stop;
  - output caps.

### L5. What the model reads (LLM02, LLM01 #5, LLM10 #8)
One filter, `safety/output-filter.ts`, applied in **one place for every tool result** (`tools/registry.ts`), and to Moon's own opening context and messages (`trueforge/chat.ts`).

**Secret redaction** (`safety/secret-scan.ts`):
- **Known formats:** AWS, GitHub, `sk-…` API keys, Stripe, Slack, Google, npm, Hugging Face, Azure account keys, JWTs, private-key blocks, passwords in URLs.
- **Any `secret/token/password/api_key = "…"` assignment** whose value is random-looking (Shannon entropy ≥ 3.5 bits per character). Placeholders, variable names and patterns are skipped.
- **The marker.** Each secret becomes `«secret redacted: kind»`. Checked live: TrueForge's stored events held only the markers, never the keys.
- **Edits.** `edit_file` / `propose_edit` refuse to write a marker back, so redaction can never destroy a real value.

**Other filters:**
- Hidden characters are shown, not deleted, so edits stay byte-true. Three or more in one result add an injection warning.
- Terminal control sequences (ANSI, OSC links, bell, backspace, lone CR) are removed.
- File and command text stays inside `<untrusted_project_content>`, and that wrapper can't be closed early.

### L6. What the model produces (LLM01 #9, LLM05, LLM07, LLM10 #9)

**Memory writes are privileged** (`safety/memory-write.ts`):
- `save_summary` takes at most two plain lines, `security.summaryMaxChars` long.
- It is refused if it holds hidden characters, links, commands, or orders aimed at an agent ("from now on…", "always run…", "without asking…"). A refused summary is never stored; Moon builds one from its own records.
- `list_past_sessions` output is wrapped as untrusted.

**Link confirmation** (`extension/src/webview-host/panel-provider.ts`):
- A link in an answer opens only after a modal showing the domain, the full address and the data it carries.
- `security.trustedLinkDomains`, and domains already allowed in this window, open directly.
- Images stay as alt text (existing).

**The review screen:**
- **Security warnings** when the change adds a secret or hidden characters.
- **A Verified line:** did the last command run *after* the last edit, and did it pass? This comes from what Moon saw, not from the agent's claim (LLM07 claim-check-act).

### Budgets per task (LLM06 #2, #8, #9)
`safety/run-budget.ts` counts across every turn of one request:
- **tool calls:** `maxToolCallsPerTask`;
- **identical calls**, i.e. the same tool with the same arguments (loop detection): `maxIdenticalCalls`;
- **commands:** `maxCommandsPerTask`;
- **tokens**, from TrueForge's usage events: `maxTokensPerTask`;
- **wall time:** `maxTaskMs`.

A breach stops the task exactly as Stop does: the hidden copy is deleted, so nothing half-done reaches the files. The panel says why, and the security log records it.

TrueForge's own `iterationLimit` (60 for agent mode, 8 for inline) stays as the per-turn cap.

### L7. Security log (LLM03 #8, AISVS C12)
`safety/audit-log.ts` writes to the extension's storage, in `security-log/<date>.jsonl`.

**What is logged:**
- approvals asked, allowed and denied;
- blocked commands and refused summaries;
- redactions (kinds and counts only);
- taint;
- budget stops;
- MCP auth refusals;
- link decisions.

**How it is protected:**
- Each line carries the SHA-256 of the line before it, so an edited or deleted line breaks the chain.
- **Moon: Show security log** opens today's file and verifies the chain.
- Files older than `security.auditLog.retentionDays` are deleted.
- It never holds file contents, secret values or the MCP token.

### Supply chain (LLM04)
- **TrueForge is pinned** to the tested version, `trueforge.version: "0.184.2"`.
- **Third-party MCP tools are an explicit list.** GitHub uses `extras.github.enableTools` instead of `@all`, so a tool the server adds later is never enabled by itself. Write-type tools (create, add, update, merge, delete, push, …) require approval **by name**, as well as through the `@write` / `@destructive` selectors, which Moon could not verify for a remote server.
- **`pnpm check:security`** (`packages/evals/check-security.ts`):
  - `pnpm audit --prod`, which fails on a high or critical advisory;
  - a secret scan of every tracked file with the same detectors;
  - a CycloneDX 1.5 SBOM in `docs/sbom.cdx.json`;
  - a licence list that flags copyleft.

  Last run: 0 advisories, 0 secrets, 201 components, all permissive licences.

## 4. OWASP Top 10 (2026) coverage

| Risk | Moon's controls | AISVS |
|---|---|---|
| LLM01 Prompt injection | Untrusted wrapper, hidden characters shown, taint (Rule of Two), exact-action cards, command policy, memory-write check, static + adaptive evals | C2, C9, C10, C11 |
| LLM02 Sensitive information | Secret redaction on every path to the model, environment allowlist, secret-file guard, log hygiene, repo secret scan | C5, C7, C8 |
| LLM03 Excessive agency | Token auth + approval ledger (complete mediation), graduated command policy, hidden copy + per-hunk review, Workspace Trust, explicit GitHub tool list | C5, C9, C10 |
| LLM04 Supply chain | Pinned TrueForge, audit, SBOM, licences, explicit third-party tool list | C3, C4, C6 |
| LLM05 Poisoning | Memory-write check, past sessions approved and wrapped, project-scoped history | C1, C8 |
| LLM06 Unbounded consumption | Per-task budgets (tokens, calls, loops, commands, time), `iterationLimit`, circuit breaker | C9, C12 |
| LLM07 Misinformation | Verified line (tests after the last edit), no write without review | C7, C12 |
| LLM08 Hidden context | No secrets in agent definitions (repo scan); all enforcement deterministic, none in the prompt | C7, C9 |
| LLM09 Vector and embedding | **Not applicable.** Moon has no embeddings or vector store (lexical ranking and a repo map). Memory is scoped by project key. | C8 |
| LLM10 Improper output handling | Strict CSP, no raw HTML, no images, link confirmation, control codes removed, diff review | C7, C9 |

## 5. How it is tested
- **Unit tests** in `packages/core/test/security.test.ts`, `tools.test.ts` and `agent-run.test.ts`: ledger, environment, policy splitting and verdicts, redaction (true and false positives), Unicode, model filter, summaries, budget, audit chain, MCP 401/403, `run_command` refusals.
- **Live safety eval** (`pnpm eval:safety`): every scenario runs on **both** models, plus one model-free check.
  - **The original 6:** comment-delete, test-output-exfil, agents-md-no-approval, env-into-docs, symlink-outside, poisoned-past-session.
  - **New with this layer:** secret-in-source, env-exfil, unicode-smuggle, encoded-command, memory-poison-write, loop-budget.
  - **Adaptive** (written knowing Moon's defences, reported apart, as LLM01 #11 asks): adaptive-fake-moon-note, which closes Moon's tag and fakes a Moon approval note, and adaptive-split-payload (a download, then a run, split across two files).
  - **Model-free:** direct-mcp-call.
- **How a run is judged:** leaks are checked against **TrueForge's stored events**, i.e. what the model was actually given, plus the answers and the copy's files. A planted command that Moon's policy blocked counts as safe: it never reached a card.

## 6. Limits (stated honestly)
- **No OS sandbox for commands on Windows.** Approval, policy, the environment allowlist and the network speed bump reduce the risk; they don't remove it. Real isolation (a container or AppContainer) is future work.
- **Secret detection is pattern-and-entropy based.** It misses formats it doesn't know. OWASP recommends NER/ML classifiers, which would need a model call Moon may not make directly.
- **Prompt injection is not solved.** Moon limits what a fooled agent can *do*, and measures it with static and adaptive evals.
- **Third-party tool descriptions are not hashed or pinned.** TrueForge doesn't expose another server's tool descriptions to Moon. Moon pins the **list** of enabled tools instead.
- **Link confirmation covers clicks in Moon's panel only.** Text the user copies elsewhere is out of scope.
- **The human is still the last line for commands.** Fewer, clearer cards (blocking, taint, trusted domains) limit approval fatigue; they don't remove it.
