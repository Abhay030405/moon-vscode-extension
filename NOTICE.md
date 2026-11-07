# NOTICE

Borrowed files and ideas (source project, link, licence).

Moon is written from scratch. The only files taken from another project are the tree-sitter
tag queries listed below.

## Copied files

| Moon file | Source | Licence | Notes |
|---|---|---|---|
| `packages/core/queries/python-tags.scm` | Aider, `aider/queries/tree-sitter-language-pack/python-tags.scm` (https://github.com/Aider-AI/aider), adapted by Aider from https://github.com/tree-sitter/tree-sitter-python | Apache-2.0 (Aider); MIT (tree-sitter-python) | Copied unchanged; credit header added |
| `packages/core/queries/javascript-tags.scm` | Aider, `aider/queries/tree-sitter-language-pack/javascript-tags.scm`, adapted from https://github.com/tree-sitter/tree-sitter-javascript | Apache-2.0 (Aider); MIT (tree-sitter-javascript) | Copied unchanged; credit header added |
| `packages/core/queries/typescript-tags.scm` | Aider, `aider/queries/tree-sitter-languages/typescript-tags.scm`, adapted from https://github.com/tree-sitter/tree-sitter-typescript | Apache-2.0 (Aider); MIT (tree-sitter-typescript) | Copied; Moon added one query (function calls) at the end, marked in the file |

## Ideas borrowed (no code copied)

| Idea | Source | Where in Moon |
|---|---|---|
| Repo map: rank files with PageRank over "uses a name defined in", tilted toward the request, packed to a token budget | Aider's repo map (https://aider.chat/docs/repomap.html) | `packages/core/src/context/ranking.ts`, `repo-map.ts` (written from scratch) |

## Bundled third-party assets

These are installed from npm and bundled into the Moon panel (`packages/extension/dist/webview/`)
unchanged. Their licence files ship inside the npm packages.

| Asset | Source | Licence | Used for |
|---|---|---|---|
| Inter (variable font), via `@fontsource-variable/inter` | https://github.com/rsms/inter · https://fontsource.org/fonts/inter | SIL Open Font License 1.1 | Text in the Moon panel |
| JetBrains Mono (variable font), via `@fontsource-variable/jetbrains-mono` | https://github.com/JetBrains/JetBrainsMono · https://fontsource.org/fonts/jetbrains-mono | SIL Open Font License 1.1 | Code, file paths and tool steps in the Moon panel |

## npm libraries used by the panel

| Library | Link | Licence |
|---|---|---|
| react-markdown | https://github.com/remarkjs/react-markdown | MIT |
| remark-gfm | https://github.com/remarkjs/remark-gfm | MIT |

## npm libraries used by the extension

| Library | Link | Licence | Used for |
|---|---|---|---|
| web-tree-sitter | https://github.com/tree-sitter/tree-sitter | MIT | Parsing source files for the project map (WebAssembly, no native code) |
| tree-sitter-wasms | https://github.com/Gregoor/tree-sitter-wasms | Unlicense (the grammars inside are MIT: tree-sitter-python, -javascript, -typescript) | Prebuilt grammar `.wasm` files, copied into `dist/tree-sitter/` at build time |
