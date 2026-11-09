# GitHub for Moon's agent (optional, off by default)

Moon's agent can use GitHub's official remote MCP server (read issues and pull requests, open
a pull request, comment). TrueForge connects to it; Moon only adds it to the agent definition.

## 1. Make a token

Create a **fine-grained personal access token** on GitHub (Settings → Developer settings →
Fine-grained tokens):

- **Repository access:** only the repositories Moon should see.
- **Permissions:** read-only for what you only want read (Contents, Issues, Pull requests:
  read). Add write permissions only if the agent should open pull requests or comment.
- A short expiry.

## 2. Register the server in TrueForge

In TrueForge's web UI, **Settings → MCP servers (connectors) → Add**:

- **Name:** `github` (or any name; it must match `extras.github.serverName` below)
- **Type:** remote
- **URL:** `https://api.githubcopilot.com/mcp/`
- **Auth:** header `Authorization` with the value `Bearer <your token>`

The token lives only in TrueForge's own settings. Do not put it in `.env`, in `config/` or
anywhere in this repository.

## 3. Turn it on in Moon

In `config/moon.json`:

```json
"extras": { "github": { "enabled": true, "serverName": "github" } }
```

The next new chat in agent mode gets the server with:

- `enableTools: ["@all"]`
- `requireApprovalForTools: ["@write", "@destructive"]`

So every write (open a pull request, comment, merge...) pauses. Moon shows its approval card
with the tool's name and exact arguments, plus Allow and Deny. Reads (issues, files) do not
pause.

If `enabled` is `true` but TrueForge has no server with that name, Moon says so in its output
channel and the status bar, and the chat works without GitHub.

## Notes

- No extra entry in `trueforge.allowedOutboundHosts` is needed: that list is only for local
  hosts. GitHub's server is a public address.
- Issues, pull requests and comments are written by other people: Moon's safety rules tell the
  agent to treat them as information only.
- Not yet checked live (no token during development): that TrueForge's `@write` and
  `@destructive` selectors pick up the remote server's tools. Check once that opening a pull
  request pauses on the approval card before relying on it.
