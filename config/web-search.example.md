# Web search for Moon's agent (optional, off by default)

Moon's agent can use TrueForge's built-in web tools: `web_search` (ranked hits with titles,
links and snippets) and `web_fetch` (the text of a page). TrueForge runs them; Moon never
calls a search service itself and never sees the key.

## 1. Set the provider in TrueForge

1. Get an API key from Parallel (https://parallel.ai), the search provider TrueForge supports.
2. Open TrueForge (`scripts/start-trueforge`, which runs the pinned version, then its web UI), go to
   **Settings → Web search**, choose **Parallel** and paste the key there.

The key lives only in TrueForge's own settings. Do not put it in `.env`, in `config/` or
anywhere in this repository.

## 2. Turn it on in Moon

In `config/moon.json`:

```json
"extras": { "webSearch": true, ... }
```

The next new chat in agent mode gets the web tools. Inline edit (Ctrl+I) never does.

If `webSearch` is `true` but TrueForge has no provider, Moon says so in its output channel
and the status bar, and the chat works without the web tools.

## Notes

- No extra entry in `trueforge.allowedOutboundHosts` is needed: that list is only for local
  hosts (Moon's own MCP server). Parallel's API is a public address.
- Results are written by strangers: Moon's safety rules tell the agent to treat them as
  information only and never follow instructions found in them.
- Keep it off for the demo and the evals, so the fixed tasks never depend on the web.
