import axios from 'axios';
import { tokenStore } from './token-store.js';

const LI_AUTH_BASE = 'https://www.linkedin.com/oauth/v2';

export function getAuthUrl(clientId, redirectUri, state) {
  const scopes = ['openid', 'profile', 'email', 'w_member_social'].join(' ');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    scope: scopes,
  });
  return `${LI_AUTH_BASE}/authorization?${params.toString()}`;
}

export async function exchangeCode({ code, clientId, clientSecret, redirectUri }) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await axios.post(`${LI_AUTH_BASE}/accessToken`, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  const data = res.data;

  // expires_in is in seconds (LinkedIn tokens last ~5184000s = 60 days)
  const expires_at = Date.now() + (data.expires_in || 5184000) * 1000;

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || null,
    expires_in: data.expires_in,
    expires_at,
    token_type: data.token_type || 'Bearer',
  };
}

export async function refreshAccessToken({ clientId, clientSecret }) {
  const tokens = tokenStore.get();
  if (!tokens?.refresh_token) throw new Error('No refresh token available. Re-authenticate at /auth/linkedin');

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await axios.post(`${LI_AUTH_BASE}/accessToken`, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  const data = res.data;
  const expires_at = Date.now() + (data.expires_in || 5184000) * 1000;

  const updated = {
    ...tokens,
    access_token: data.access_token,
    expires_in: data.expires_in,
    expires_at,
  };

  tokenStore.save(updated);
  console.log('[Auth] Token refreshed successfully');
  return updated;
}
