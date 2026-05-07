import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { tokenStore } from './token-store.js';
import { getAuthUrl, exchangeCode, refreshAccessToken } from './auth.js';
import { registerTools } from './tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Env Validation ──────────────────────────────────────────────────────────

const REQUIRED_ENV = ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET', 'BASE_URL', 'MCP_SECRET_KEY'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌ Missing required env var: ${key}`);
    process.exit(1);
  }
}

const {
  LINKEDIN_CLIENT_ID,
  LINKEDIN_CLIENT_SECRET,
  BASE_URL,
  MCP_SECRET_KEY,
  PORT = 3000,
} = process.env;

const REDIRECT_URI = `${BASE_URL}/auth/callback`;

// ─── Express App ─────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── OAuth State Store (in-memory, short-lived) ────────────────────────────

const oauthStates = new Map();

// ─── Auth Routes ──────────────────────────────────────────────────────────────

// Start OAuth flow
app.get('/auth/linkedin', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  oauthStates.set(state, Date.now());

  // Cleanup old states (older than 10 min)
  for (const [s, t] of oauthStates) {
    if (Date.now() - t > 600_000) oauthStates.delete(s);
  }

  const authUrl = getAuthUrl(LINKEDIN_CLIENT_ID, REDIRECT_URI, state);
  console.log(`[Auth] Redirecting to LinkedIn OAuth...`);
  res.redirect(authUrl);
});

// OAuth callback
app.get('/auth/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    console.error(`[Auth] LinkedIn OAuth error: ${error} - ${error_description}`);
    return res.redirect(`/?error=${encodeURIComponent(error_description || error)}`);
  }

  if (!oauthStates.has(state)) {
    return res.redirect('/?error=Invalid+OAuth+state.+Please+try+again.');
  }

  oauthStates.delete(state);

  try {
    const tokens = await exchangeCode({
      code,
      clientId: LINKEDIN_CLIENT_ID,
      clientSecret: LINKEDIN_CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
    });

    tokenStore.save(tokens);
    console.log('[Auth] ✅ LinkedIn connected successfully');
    res.redirect('/?success=1');
  } catch (err) {
    console.error('[Auth] Token exchange failed:', err.response?.data || err.message);
    res.redirect(`/?error=${encodeURIComponent('Token exchange failed: ' + (err.response?.data?.error_description || err.message))}`);
  }
});

// Disconnect
app.post('/auth/disconnect', (req, res) => {
  tokenStore.clear();
  res.json({ success: true, message: 'LinkedIn disconnected' });
});

// Auth status API
app.get('/auth/status', (req, res) => {
  const tokens = tokenStore.get();
  const isConnected = tokenStore.isConnected();

  res.json({
    connected: isConnected,
    expires_at: tokens?.expires_at ? new Date(tokens.expires_at).toISOString() : null,
    person_urn: tokens?.person_urn || null,
    has_refresh_token: !!tokens?.refresh_token,
  });
});

// Manual token refresh
app.post('/auth/refresh', async (req, res) => {
  try {
    const updated = await refreshAccessToken({
      clientId: LINKEDIN_CLIENT_ID,
      clientSecret: LINKEDIN_CLIENT_SECRET,
    });
    res.json({ success: true, expires_at: new Date(updated.expires_at).toISOString() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── MCP Auth Middleware ──────────────────────────────────────────────────────

function requireMcpAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const keyFromHeader = authHeader?.replace('Bearer ', '');
  const keyFromQuery = req.query.secret;

  if (keyFromHeader !== MCP_SECRET_KEY && keyFromQuery !== MCP_SECRET_KEY) {
    res.status(401).json({ error: 'Unauthorized. Provide valid MCP_SECRET_KEY in Authorization header or secret query param.' });
    return;
  }
  next();
}

// ─── MCP Server Factory ────────────────────────────────────────────────────

function createMcpServer() {
  const server = new McpServer({
    name: 'linkedin-mcp',
    version: '1.0.0',
  });

  registerTools(server);
  return server;
}

// ─── Session Management ───────────────────────────────────────────────────────

const sessions = new Map(); // sessionId -> transport

// Cleanup inactive sessions every 30 min
setInterval(() => {
  const now = Date.now();
  for (const [id, { lastUsed }] of sessions) {
    if (now - lastUsed > 30 * 60 * 1000) {
      sessions.delete(id);
      console.log(`[MCP] Cleaned up session ${id}`);
    }
  }
}, 5 * 60 * 1000);

// ─── MCP HTTP Endpoint (Streamable HTTP) ─────────────────────────────────────

app.all('/mcp', requireMcpAuth, async (req, res) => {
  // Auto-refresh token if needed
  if (tokenStore.needsRefresh()) {
    try {
      await refreshAccessToken({ clientId: LINKEDIN_CLIENT_ID, clientSecret: LINKEDIN_CLIENT_SECRET });
    } catch (err) {
      console.warn('[MCP] Auto-refresh failed:', err.message);
    }
  }

  const sessionId = req.headers['mcp-session-id'];

  try {
    if (sessionId && sessions.has(sessionId)) {
      // Reuse existing session
      const session = sessions.get(sessionId);
      session.lastUsed = Date.now();
      await session.transport.handleRequest(req, res, req.body);
    } else {
      // New session
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
      });

      const server = createMcpServer();
      await server.connect(transport);

      const newSessionId = transport.sessionId;
      sessions.set(newSessionId, { transport, lastUsed: Date.now() });
      console.log(`[MCP] New session: ${newSessionId}`);

      await transport.handleRequest(req, res, req.body);
    }
  } catch (err) {
    console.error('[MCP] Request error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

// ─── MCP SSE Endpoint (for SSE clients like opencode) ─────────────────────

const sseSessions = new Map();

app.get('/sse', requireMcpAuth, async (req, res) => {
  const transport = new SSEServerTransport('/message', res);
  const server = createMcpServer();

  const sessionId = transport.sessionId;
  sseSessions.set(sessionId, { transport, lastUsed: Date.now() });
  console.log(`[SSE] New session: ${sessionId}`);

  await server.connect(transport);
});

app.post('/message', requireMcpAuth, async (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId || !sseSessions.has(sessionId)) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const session = sseSessions.get(sessionId);
  session.lastUsed = Date.now();
  await session.transport.handlePostMessage(req, res, req.body);
});

// Cleanup SSE sessions
setInterval(() => {
  const now = Date.now();
  for (const [id, { lastUsed }] of sseSessions) {
    if (now - lastUsed > 30 * 60 * 1000) {
      sseSessions.delete(id);
      console.log(`[SSE] Cleaned up session ${id}`);
    }
  }
}, 5 * 60 * 1000);

// ─── Health Check ─────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    linkedin_connected: tokenStore.isConnected(),
    active_sessions: sessions.size,
    uptime_seconds: Math.floor(process.uptime()),
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║          LinkedIn MCP Server v1.0.0              ║
╠══════════════════════════════════════════════════╣
║  Dashboard:  ${BASE_URL.padEnd(35)}║
║  MCP URL:    ${(BASE_URL + '/mcp').padEnd(35)}║
║  Auth URL:   ${(BASE_URL + '/auth/linkedin').padEnd(35)}║
╠══════════════════════════════════════════════════╣
║  Connected:  ${(tokenStore.isConnected() ? '✅ Yes' : '❌ No - visit /auth/linkedin').padEnd(35)}║
╚══════════════════════════════════════════════════╝
  `);
});
