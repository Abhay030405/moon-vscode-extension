// Test helper for Task C: a "model" that accepts every request and never answers.
// Point a TrueForge custom (OpenAI-compatible) provider at it to see Moon's watchdog move the
// request to the backup model (resilience.watchdogMs).
//
// Usage: node scripts/hanging-server.js [port]
// Then in TrueForge, set the main provider's base URL to http://127.0.0.1:<port>/v1
// (127.0.0.1 must be in TrueForge's allowed outbound hosts). Ctrl+C to stop.
// The resilience eval (pnpm eval:resilience) starts its own copy; this one is for trying it by hand.

const http = require("node:http");

const port = Number(process.argv[2] ?? 0);
const server = http.createServer((req) => {
  console.log(`${new Date().toLocaleTimeString()} ${req.method} ${req.url}: holding it open, never answering`);
});
server.listen(port, "127.0.0.1", () => {
  console.log(`Hanging model server on http://127.0.0.1:${server.address().port}/v1 (Ctrl+C to stop)`);
});
