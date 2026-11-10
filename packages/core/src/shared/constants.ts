// Fixed values that never change between setups. Anything a user might change
// belongs in config/moon.json instead (see config.ts).

/** Folder (relative to the Moon repo root) that holds the config files. */
export const CONFIG_DIR = "config";

/** The user's own config file (git-ignored). */
export const CONFIG_FILE_NAME = "moon.json";

/** The committed example the user copies to create CONFIG_FILE_NAME. */
export const EXAMPLE_CONFIG_FILE_NAME = "moon.example.json";

/**
 * How soon to re-read config/moon.json after it failed to load. (Once it loads,
 * trueforge.statusCheckIntervalMs from the config is used instead.)
 */
export const CONFIG_RETRY_MS = 3000;

/** Search results show at most this many characters of each matching line. */
export const MAX_MATCH_LINE_CHARS = 300;

/** A file whose first this-many bytes contain a NUL byte is treated as binary and skipped. */
export const BINARY_SNIFF_BYTES = 8000;

/**
 * Language-neutral patterns for "where is NAME defined". `NAME` is replaced by the
 * escaped symbol. A heuristic until the tree-sitter project map arrives (Phase 4).
 */
export const DEFINITION_PATTERNS: readonly string[] = [
  String.raw`^\s*(async\s+)?def\s+NAME\b`, // Python function / method
  String.raw`^\s*(export\s+)?(default\s+)?(abstract\s+)?class\s+NAME\b`, // class (Python, JS/TS, Java, C#, ...)
  String.raw`^\s*(export\s+)?(default\s+)?(async\s+)?function\s*\*?\s*NAME\b`, // JS/TS function
  String.raw`^\s*(export\s+)?(const|let|var)\s+NAME\s*[=:]`, // JS/TS variable / arrow function
  String.raw`^\s*(export\s+)?(interface|type|enum)\s+NAME\b`, // TS types
  String.raw`^\s*func\s+(\([^)]*\)\s*)?NAME\b`, // Go
  String.raw`^\s*(pub(\([^)]*\))?\s+)?(fn|struct|enum|trait|type)\s+NAME\b`, // Rust
  // Java / C# / Kotlin method. Needs at least one modifier, so a call like `assert NAME(` doesn't match.
  String.raw`^\s*((public|private|protected|internal|static|final|override|virtual|abstract|synchronized)\s+)+[\w<>\[\],.?\s]*?\bNAME\s*\(`,
  String.raw`^NAME\s*(:[^=]+)?=[^=]`, // top-level assignment (Python constant, etc.)
];

/** Version Moon's MCP server reports to clients during the MCP handshake. */
export const MCP_SERVER_VERSION = "0.1.0";

/** What the background check of the main model sends (tiny, so it costs almost nothing). */
export const PROBE_MESSAGE = "Health check from Moon: do not use any tools, reply with just OK.";

/** Long work (copy, map) gives the extension host back at least this often (ms). */
export const WORK_SLICE_MS = 12;

/** Files copied at the same time when making the hidden copy. */
export const COPY_CONCURRENCY = 16;

/** Largest MCP request body Moon's server reads (the MCP SDK's own limit is the same 4 MB). */
export const MCP_MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Description Moon's MCP server is registered with in TrueForge. */
export const MOON_MCP_DESCRIPTION =
  "Moon editor tools: list, search and read files of the project open in VS Code, see its errors, and propose edits for review.";

/** TrueForge's thread id for the root agent; other threads are subagents. */
export const MAIN_THREAD_ID = "main";

/**
 * The line diff compares at most this many line pairs (old lines x new lines, after the
 * common start and end are trimmed). Bigger changes are shown as one hunk.
 */
export const DIFF_MAX_CELLS = 4_000_000;

/** How long a short Moon message stays in the status bar. */
export const STATUS_MESSAGE_MS = 6000;

/** TrueForge's wrapper tool for calling a deferred tool: call_tool {mcp_server, tool_name, input}. */
export const TRUEFORGE_CALL_TOOL = "call_tool";

/** TrueForge's built-in tool for asking the user a question (off in Moon's definitions). */
export const TRUEFORGE_ASK_USER_TOOL = "ask_user_question";

/** Agent mode's MCP endpoint is the editor endpoint's path plus this, registered under the name + this. */
export const AGENT_ENDPOINT_SUFFIX = "-agent";

/** Folder (inside the system temp folder) that holds the hidden copies of agent runs. */
export const RUNS_TEMP_DIR = "moon-runs";
/** Deleting a run's copy: retries (and delay) while a just-killed process still holds files. */
export const RUN_DIR_REMOVE_RETRIES = 10;
export const RUN_DIR_REMOVE_RETRY_MS = 200;

/**
 * Commands the approval card warns about. Each: a pattern (case-insensitive) and why it is risky.
 * The user still decides; this only highlights.
 */
export const RISKY_COMMAND_PATTERNS: readonly { pattern: string; reason: string }[] = [
  { pattern: String.raw`\brm\s+(-\w*[rf]\w*\s+)+`, reason: "deletes files (rm -r / -f)" },
  { pattern: String.raw`\b(del|erase)\b.*\s/[sq]\b`, reason: "deletes files (del /s)" },
  { pattern: String.raw`\b(rmdir|rd)\b.*\s/s\b`, reason: "deletes folders (rmdir /s)" },
  { pattern: String.raw`\bRemove-Item\b`, reason: "deletes files (Remove-Item)" },
  { pattern: String.raw`\b(curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod|irm)\b`, reason: "downloads or sends data over the network" },
  { pattern: String.raw`\b(scp|ssh|ftp|nc|ncat|netcat)\b`, reason: "connects to another machine" },
  { pattern: String.raw`\bgit\s+(push|reset\s+--hard|clean\b|rebase|checkout\s+--|filter-branch|reflog\s+expire)`, reason: "changes git history or discards work" },
  { pattern: String.raw`\b(pip|pip3|npm|pnpm|yarn)\s+(install|add|uninstall|remove)\b`, reason: "installs or removes packages" },
  { pattern: String.raw`\b(sudo|runas|chmod|chown|icacls|takeown)\b`, reason: "changes permissions or runs as another user" },
  { pattern: String.raw`\b(format|mkfs|diskpart|shutdown|reboot)\b`, reason: "affects the whole machine" },
  { pattern: String.raw`(^|[\s"'=])(\.\.[\/]|~[\/]|[a-z]:[\/]|/(etc|usr|bin|home|Users|var|tmp)\b)`, reason: "touches a path outside the project" },
  { pattern: String.raw`\.env\b|id_rsa|\.ssh\b|\.aws\b|credentials`, reason: "touches secrets or keys" },
];

/** In the report after review, each rejected hunk is shown by its first this-many lines. */
export const REJECTED_HUNK_PREVIEW_LINES = 3;

/** Rough token count of text: characters divided by this (good enough for budgets). */
export const CHARS_PER_TOKEN = 4;

/** Project rule files given to the agent if present (the first one found is used). */
export const PROJECT_RULE_FILES: readonly string[] = ["AGENTS.md", "CLAUDE.md"];

/** Languages the project map parses, by file extension, and their tree-sitter grammar / query files. */
export const MAP_LANGUAGES: Readonly<Record<string, { grammar: string; query: string }>> = {
  ".py": { grammar: "tree-sitter-python.wasm", query: "python-tags.scm" },
  ".js": { grammar: "tree-sitter-javascript.wasm", query: "javascript-tags.scm" },
  ".mjs": { grammar: "tree-sitter-javascript.wasm", query: "javascript-tags.scm" },
  ".cjs": { grammar: "tree-sitter-javascript.wasm", query: "javascript-tags.scm" },
  ".jsx": { grammar: "tree-sitter-javascript.wasm", query: "javascript-tags.scm" },
  ".ts": { grammar: "tree-sitter-typescript.wasm", query: "typescript-tags.scm" },
  ".mts": { grammar: "tree-sitter-typescript.wasm", query: "typescript-tags.scm" },
  ".cts": { grammar: "tree-sitter-typescript.wasm", query: "typescript-tags.scm" },
  ".tsx": { grammar: "tree-sitter-tsx.wasm", query: "typescript-tags.scm" },
};

/** Lines longer than this mark a generated or minified file, which the map skips. */
export const MAP_MAX_LINE_LENGTH = 1000;
/** Bump when the cached map format changes, so old caches are ignored. */
export const MAP_CACHE_VERSION = 1;
/** PageRank: rounds and damping (the share of rank that follows references). */
export const RANK_ITERATIONS = 25;
export const RANK_DAMPING = 0.85;
/** Words shorter than this in the user's request are ignored when ranking. */
export const RANK_MIN_WORD_LENGTH = 3;
/** The file that matches the request best gets this many times its rank added (Aider uses 10x too). */
export const RANK_FOCUS_BOOST = 10;
/** Match weights: a name from the request defined in the file (or an @-named file), and a request word inside a defined name (a word in the path counts 1 x its rarity). */
export const RANK_EXACT_NAME_WEIGHT = 2;
export const RANK_NAME_WORD_WEIGHT = 0.1;
/** Common words in requests that say nothing about which files matter. */
export const RANK_STOP_WORDS: ReadonlySet<string> = new Set(
  ("the and for with that this from into have has had should would could will can are was were not but all any " +
    "add adds added make makes use uses using new also when then than them they its it's our your you please " +
    "need needs want wants like just only each every some more most other such what which who how why where " +
    "there here about above after before over under again same so very does did done get gets got let lets")
    .split(" "),
);
/** Share of the starting rank given to files that match the request. */
export const RANK_FOCUS_SHARE = 0.9;
/** Two words match as one with an ending if the shorter has at least this many letters... */
export const RANK_MIN_PREFIX_LENGTH = 4;
/** ...and the longer adds at most this many ("test" / "tests", but not "help" / "helpers"). */
export const RANK_MAX_SUFFIX_LENGTH = 2;
/** Most names listed under one file in the map. */
export const MAP_MAX_NAMES_PER_FILE = 12;

/** Most sessions TrueForge returns per sessions.list page (checked on 0.184); Moon pages through more. */
export const TRUEFORGE_LIST_PAGE_MAX = 25;

/** Longest value TrueForge accepts for one session label (metadata), checked on 0.184. */
export const TRUEFORGE_LABEL_MAX = 128;

/** Folder (inside the extension's storage folder) that holds each conversation's work record. */
export const WORK_RECORDS_DIR = "work-records";

/** A work record keeps at most this many entries (the oldest are dropped). */
export const WORK_RECORD_MAX_ENTRIES = 5000;

/** A file changed on disk counts as changed only this long after the record noted it (Moon's own apply writes it just before). */
export const STALE_TOLERANCE_MS = 2000;

/** The tool the agent calls to report the files it chose (the panel shows them as the context card). */
export const REPORT_CONTEXT_TOOL = "report_context";

/** The tool the agent calls to show its plan before a big task (needs the user's approval). */
export const PROPOSE_PLAN_TOOL = "propose_plan";

// ---- Security (OWASP LLM Top 10 2026; docs/security.md) ----

/** Start of the text that replaces a secret in tool results: «secret redacted: kind». */
export const REDACTION_PREFIX = "«secret redacted: ";

/** Known secret formats, found anywhere in text sent to the model (safety/secret-scan.ts). */
export const SECRET_PATTERNS: readonly { kind: string; pattern: string }[] = [
  { kind: "private-key", pattern: String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)` },
  { kind: "aws-access-key", pattern: String.raw`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b` },
  { kind: "github-token", pattern: String.raw`\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b` },
  { kind: "api-key", pattern: String.raw`\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}` },
  { kind: "stripe-key", pattern: String.raw`\b[sr]k_(?:live|test)_[0-9A-Za-z]{16,}\b` },
  { kind: "slack-token", pattern: String.raw`\bxox[abprs]-[A-Za-z0-9-]{10,}` },
  { kind: "google-api-key", pattern: String.raw`\bAIza[0-9A-Za-z_-]{35}\b` },
  { kind: "npm-token", pattern: String.raw`\bnpm_[A-Za-z0-9]{36}\b` },
  { kind: "huggingface-token", pattern: String.raw`\bhf_[A-Za-z0-9]{30,}\b` },
  { kind: "azure-account-key", pattern: String.raw`AccountKey=[A-Za-z0-9+/=]{40,}` },
  { kind: "jwt", pattern: String.raw`\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}` },
  { kind: "url-password", pattern: String.raw`\b[a-z][a-z0-9+.-]*://[^\s:/@"']+:[^\s@/"']{4,}@` },
];

/** `name = "value"` where the name says secret; group 1 is the value (redacted if random-looking). */
export const SECRET_ASSIGNMENT = String.raw`\b[\w.-]*(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth[_-]?key)[\w.-]*["']?\s*[:=]\s*["']([^"'\s]{12,})["']`;

/** Bits per character above which an assigned value counts as a real secret (words score lower). */
export const SECRET_MIN_ENTROPY = 3.5;

/**
 * Characters you can't see, as regex class ranges: tag block, variation selectors (and their
 * supplement), zero-width and direction marks, bidi embeddings / overrides / isolates, word
 * joiners, Mongolian vowel separator. (U+FEFF is left alone: Windows files often start with it.)
 */
export const HIDDEN_CHAR_RANGES: readonly string[] = [
  String.raw`\u{E0000}-\u{E007F}`,
  String.raw`\u{FE00}-\u{FE0F}`,
  String.raw`\u{E0100}-\u{E01EF}`,
  String.raw`\u{200B}-\u{200F}`,
  String.raw`\u{202A}-\u{202E}`,
  String.raw`\u{2060}-\u{2064}`,
  String.raw`\u{2066}-\u{2069}`,
  String.raw`\u{180E}`,
];

/** Tools from TrueForge itself (not third-party servers): seeing them never marks a turn as tainted. */
export const TRUEFORGE_INTERNAL_TOOLS: readonly string[] = ["ask_user_question", "list_tools", "get_tool_info", "load_tools", "create_sub_agent"];

/** Tools whose results come from outside the project (web, past sessions): they taint the turn. */
export const UNTRUSTED_SOURCE_TOOLS: readonly string[] = ["web_search", "web_fetch", "read_past_session"];

/** A saved summary matching any of these is refused (safety/memory-write.ts): it would act as an instruction later. */
export const SUMMARY_INSTRUCTION_PATTERNS: readonly { pattern: string; reason: string }[] = [
  { pattern: String.raw`https?://|www\.`, reason: "it contains a link" },
  { pattern: String.raw`\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-Expression|iex|powershell|bash\s+-c|sh\s+-c|rm\s+-rf|git\s+push|base64)\b`, reason: "it contains a command" },
  { pattern: String.raw`\b(ignore|disregard|forget)\b.{0,40}\b(instructions?|rules?|previous|above)\b`, reason: "it tells an agent to ignore its rules" },
  { pattern: String.raw`\bfrom now on\b|\bnext time\b|\bin (future|later) (chats|sessions|tasks)\b`, reason: "it gives orders for later tasks" },
  { pattern: String.raw`\b(you|the agent|assistant|future agents?|moon)\s+(must|should|need to|has to|have to|will)\b`, reason: "it gives an agent orders" },
  { pattern: String.raw`\b(always|never)\s+(run|call|execute|send|allow|approve|skip|use|read|trust)\b`, reason: "it gives an agent a standing order" },
  { pattern: String.raw`\bwithout\s+(asking|approval|review|confirmation)\b`, reason: "it asks to skip approval" },
];

/** Random bytes in the MCP server's per-start token (hex: twice as many characters). */
export const MCP_TOKEN_BYTES = 32;

/** Folder in the extension's storage that holds the security log (one file per day). */
export const SECURITY_LOG_DIR = "security-log";

/** The link confirmation shows at most this much of the address. */
export const LINK_PREVIEW_CHARS = 300;
