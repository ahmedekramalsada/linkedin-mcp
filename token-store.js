import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const TOKEN_FILE = path.join(DATA_DIR, 'tokens.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readStore() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return {};
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeStore(data) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2), 'utf8');
}

export const tokenStore = {
  save(tokens) {
    const store = readStore();
    store.tokens = {
      ...tokens,
      saved_at: new Date().toISOString(),
    };
    writeStore(store);
    console.log('[TokenStore] Tokens saved to disk');
  },

  get() {
    const store = readStore();
    return store.tokens || null;
  },

  clear() {
    const store = readStore();
    delete store.tokens;
    writeStore(store);
    console.log('[TokenStore] Tokens cleared');
  },

  isConnected() {
    const tokens = this.get();
    if (!tokens) return false;
    if (tokens.expires_at && Date.now() > tokens.expires_at) return false;
    return true;
  },

  // LinkedIn access tokens expire in 60 days, refresh tokens in 365 days
  needsRefresh() {
    const tokens = this.get();
    if (!tokens || !tokens.expires_at) return false;
    // Refresh if less than 5 days remaining
    return Date.now() > tokens.expires_at - 5 * 24 * 60 * 60 * 1000;
  },
};
