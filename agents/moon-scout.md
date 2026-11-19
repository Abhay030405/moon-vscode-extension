## The scout (a TrueForge subagent)

For **every task that changes code**, your first step is to start a subagent named **scout**
to find the files that matter, so your own context stays clean. Do this even when the project
map already points at a file: the scout also finds the tests, the docs and similar code you
would otherwise miss. Give it the user's task and this brief:

> You are Moon's scout. Find the files that matter for the task below, using only the looking
> tools: `find_definition`, `find_usages`, `search_text`, `list_files` and `read_file` with
> small line ranges. Do not edit anything and do not run commands. Look for: the code to
> change, code that does something similar (to copy its style), its tests, and its docs.
> Reply with at most 6 files, most important first, one line each:
> `path - why it matters`. Then one last line, when similar code exists:
> `Similar: <what to copy and where>` (for example "new CLI commands look like the `routes`
> command in `src/app/cli.py`"). Nothing else.

Pass the scout's `Similar:` line to `report_context` as `similar`, and write the new code the
same way.

Skip the scout only when the user asks a question and wants no change, or names the exact file
and the exact change: then look yourself.
