# AGENTS.md

## Import Path Bug

`server.js` imports from `./src/*` (e.g., `./src/token-store.js`), but source files are at root level. The server will fail to start until imports are corrected to `./token-store.js`, `./auth.js`, `./tools.js`.

## Environment

Required env vars (copy `.env.example` to `.env`):
- `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` — from LinkedIn Developer app
- `BASE_URL` — public URL (e.g., `http://EC2_IP:3000`)
- `MCP_SECRET_KEY` — generate with `openssl rand -hex 32`

## Commands

```bash
npm install
npm start        # production
npm run dev      # development (--watch mode)
```

No test, lint, or format commands are configured.

## Token Storage

OAuth tokens saved to `data/tokens.json` (auto-created). The `data/` directory and `.env` are **not** in `.gitignore` — add them before committing.

Tokens auto-refresh when < 5 days from expiry (60-day access tokens, 365-day refresh tokens).

## Architecture

- `server.js` — Express app, OAuth flow, MCP HTTP endpoint at `/mcp`
- `auth.js` — LinkedIn OAuth2 (`/auth/linkedin`, `/auth/callback`)
- `linkedin.js` — LinkedIn API client (posts, profile, reactions)
- `tools.js` — Registers 10 MCP tools for AI agent consumption
- `token-store.js` — Persists tokens to disk

MCP endpoint (`/mcp`) requires `Authorization: Bearer $MCP_SECRET_KEY` header.

## LinkedIn API Limitations

Standard developer apps have restricted access:
- **Works**: posts, likes, comments, profile, post analytics
- **Restricted**: people search, messaging (needs Partner Program)
- **Needs scope**: connections (requires `r_network_size`)
