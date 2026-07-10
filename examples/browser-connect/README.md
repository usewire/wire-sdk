# Browser connect example

A single static page that acts as a minimal browser agent: it starts a
Wire connect in redirect or popup mode and doubles as the OAuth callback.

## Run it

1. Register an agent in the Wire dashboard with a browser-consent flow
   enabled, and add this page's URL to its redirect URIs (e.g.
   `http://localhost:5173/examples/browser-connect/`).
2. Set `AGENT_ID` in `index.html` to your agent id.
3. From the repo root: `npx vite` and open the page.

Redirect mode navigates this tab to the Wire authorization screen and
back. Popup mode keeps this tab open; the popup relays the result and
closes itself. Either way you end up with a `Connection` whose `mcpUrl`
and `apiKey` you hand to your agent's MCP client.
