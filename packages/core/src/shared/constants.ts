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

/** Description Moon's MCP server is registered with in TrueForge. */
export const MOON_MCP_DESCRIPTION =
  "Moon editor tools: list, search and read files of the project open in VS Code.";

/** TrueForge's thread id for the root agent; other threads are subagents. */
export const MAIN_THREAD_ID = "main";
