// Copies what the project map needs at run time into dist/tree-sitter/: web-tree-sitter's
// runtime (tree-sitter.wasm), the grammar .wasm files and Moon's tag queries.
// Node script (not a shell command) so the build works the same on Windows, macOS and Linux.

import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const core = path.resolve(here, "../../core");
const require = createRequire(path.join(core, "package.json"));
const out = path.resolve(here, "../dist/tree-sitter");
mkdirSync(path.join(out, "queries"), { recursive: true });

copyFileSync(path.join(path.dirname(require.resolve("web-tree-sitter")), "tree-sitter.wasm"), path.join(out, "tree-sitter.wasm"));
const grammars = path.join(path.dirname(require.resolve("tree-sitter-wasms/package.json")), "out");
for (const name of ["python", "javascript", "typescript", "tsx"]) {
  copyFileSync(path.join(grammars, `tree-sitter-${name}.wasm`), path.join(out, `tree-sitter-${name}.wasm`));
}
for (const file of readdirSync(path.join(core, "queries"))) {
  copyFileSync(path.join(core, "queries", file), path.join(out, "queries", file));
}
console.log(`tree-sitter files copied to ${path.relative(process.cwd(), out)}`);
