import axios from 'axios';
import { tokenStore } from './token-store.js';

const LI_V2   = 'https://api.linkedin.com/v2';
const LI_REST = 'https://api.linkedin.com/rest';

// ─── LinkedIn-Version ─────────────────────────────────────────────────────────
// Must be YYYYMM format, within the last 12 months.
// Current date: May 2026 → use 202605.
// Update this if you get "version not supported" errors.
const LI_VERSION = '202605';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getToken() {
  const tokens = tokenStore.get();
  if (!tokens?.access_token) throw new Error('Not authenticated. Visit /auth/linkedin to connect.');
  return tokens.access_token;
}

/**
 * ALL LinkedIn API calls now need LinkedIn-Version header.
 * Even the "legacy" /v2/ugcPosts endpoint requires it now (error: NO_VERSION).
 */
function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-Restli-Protocol-Version': '2.0.0',
    'LinkedIn-Version': LI_VERSION,
  };
}

function liError(err) {
  const status = err.response?.status;
  const msg = err.response?.data?.message
    || err.response?.data?.error_description
    || JSON.stringify(err.response?.data)
    || err.message;
  return { status, message: msg, raw: err.response?.data };
}

// ─── Profile ──────────────────────────────────────────────────────────────────

export async function getMyProfile() {
  const token = getToken();
  // userinfo doesn't need LinkedIn-Version — it's an OpenID Connect endpoint
  const res = await axios.get(`${LI_V2}/userinfo`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Restli-Protocol-Version': '2.0.0',
    },
  });
  return res.data;
}

export async function getMyProfileUrn() {
  const tokens = tokenStore.get();
  if (tokens?.person_urn) return tokens.person_urn;
  const profile = await getMyProfile();
  const urn = `urn:li:person:${profile.sub}`;
  tokenStore.save({ ...tokens, person_urn: urn });
  return urn;
}

// ─── Create Post ──────────────────────────────────────────────────────────────

export async function createPost({ text, visibility = 'PUBLIC', articleUrl = null, articleTitle = null, articleDescription = null }) {
  const token     = getToken();
  const authorUrn = await getMyProfileUrn();

  // Try new /rest/posts first
  try {
    const body = {
      author: authorUrn,
      commentary: text,
      visibility,
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    };
    if (articleUrl) {
      body.content = {
        article: { source: articleUrl, title: articleTitle || articleUrl, description: articleDescription || '' },
      };
    }
    const res = await axios.post(`${LI_REST}/posts`, body, { headers: headers(token) });
    const postId = res.headers['x-restli-id'] || null;
    return { success: true, post_id: postId, post_url: postId ? `https://www.linkedin.com/feed/update/${postId}` : null, message: 'Post created' };
  } catch (err) {
    const e = liError(err);
    console.warn(`[createPost] /rest/posts failed (${e.status}), trying ugcPosts...`);
  }

  // Fallback: legacy ugcPosts (also needs LinkedIn-Version now)
  let shareMediaCategory = 'NONE';
  let media = [];
  if (articleUrl) {
    shareMediaCategory = 'ARTICLE';
    media = [{ status: 'READY', originalUrl: articleUrl, title: { text: articleTitle || articleUrl }, description: { text: articleDescription || '' } }];
  }
  const body = {
    author: authorUrn,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: { text },
        shareMediaCategory,
        ...(media.length > 0 ? { media } : {}),
      },
    },
    visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': visibility },
  };
  const res = await axios.post(`${LI_V2}/ugcPosts`, body, { headers: headers(token) });
  const postId = res.headers['x-restli-id'] || res.data.id;
  return { success: true, post_id: postId, post_url: postId ? `https://www.linkedin.com/feed/update/${postId}` : null, message: 'Post created (ugcPosts)' };
}

// ─── Read Posts ───────────────────────────────────────────────────────────────

export async function getMyPosts({ count = 10, start = 0 } = {}) {
  const token     = getToken();
  const authorUrn = await getMyProfileUrn();
  const errors    = [];

  // Strategy 1: /rest/posts (new API) — needs LinkedIn-Version (fixed: was 202504, now 202605)
  try {
    console.log(`[getMyPosts] Trying /rest/posts (version ${LI_VERSION})`);
    const res = await axios.get(`${LI_REST}/posts`, {
      headers: headers(token),
      params: { author: authorUrn, q: 'author', count, start },
    });
    const posts = (res.data.elements || []).map(p => ({
      id: p.id,
      text: p.commentary || '',
      created_at: p.createdAt ? new Date(p.createdAt).toISOString() : null,
      lifecycle_state: p.lifecycleState,
      visibility: p.visibility,
      url: p.id ? `https://www.linkedin.com/feed/update/${p.id}` : null,
    }));
    return { source: 'rest/posts', posts, total: res.data.paging?.total ?? posts.length, start: res.data.paging?.start ?? 0 };
  } catch (err) {
    const e = liError(err);
    console.warn(`[getMyPosts] /rest/posts failed: ${e.status} — ${e.message}`);
    errors.push({ endpoint: 'GET /rest/posts', status: e.status, message: e.message });
  }

  // Strategy 2: /v2/ugcPosts with LinkedIn-Version header (fixes NO_VERSION error)
  // encoded URN inside List()
  try {
    console.log(`[getMyPosts] Trying /v2/ugcPosts (version ${LI_VERSION})`);
    const encodedUrn = encodeURIComponent(authorUrn);
    const res = await axios.get(
      `${LI_V2}/ugcPosts?q=authors&authors=List(${encodedUrn})&count=${count}&start=${start}`,
      { headers: headers(token) },  // ← LinkedIn-Version now included
    );
    const posts = (res.data.elements || []).map(p => ({
      id: p.id,
      text: p.specificContent?.['com.linkedin.ugc.ShareContent']?.shareCommentary?.text || '',
      created_at: p.created?.time ? new Date(p.created.time).toISOString() : null,
      lifecycle_state: p.lifecycleState,
      visibility: p.visibility?.['com.linkedin.ugc.MemberNetworkVisibility'] || null,
      url: p.id ? `https://www.linkedin.com/feed/update/${p.id}` : null,
    }));
    return { source: 'v2/ugcPosts', posts, total: res.data.paging?.total ?? posts.length, start: res.data.paging?.start ?? 0 };
  } catch (err) {
    const e = liError(err);
    console.warn(`[getMyPosts] /v2/ugcPosts failed: ${e.status} — ${e.message}`);
    errors.push({ endpoint: 'GET /v2/ugcPosts (encoded)', status: e.status, message: e.message });
  }

  // Strategy 3: ugcPosts with raw (unencoded) URN
  try {
    console.log(`[getMyPosts] Trying /v2/ugcPosts raw URN`);
    const res = await axios.get(
      `${LI_V2}/ugcPosts?q=authors&authors=List(${authorUrn})&count=${count}&start=${start}`,
      { headers: headers(token) },
    );
    const posts = (res.data.elements || []).map(p => ({
      id: p.id,
      text: p.specificContent?.['com.linkedin.ugc.ShareContent']?.shareCommentary?.text || '',
      created_at: p.created?.time ? new Date(p.created.time).toISOString() : null,
      lifecycle_state: p.lifecycleState,
      visibility: p.visibility?.['com.linkedin.ugc.MemberNetworkVisibility'] || null,
      url: p.id ? `https://www.linkedin.com/feed/update/${p.id}` : null,
    }));
    return { source: 'v2/ugcPosts (raw URN)', posts, total: res.data.paging?.total ?? posts.length, start: res.data.paging?.start ?? 0 };
  } catch (err) {
    const e = liError(err);
    console.warn(`[getMyPosts] /v2/ugcPosts raw failed: ${e.status} — ${e.message}`);
    errors.push({ endpoint: 'GET /v2/ugcPosts (raw)', status: e.status, message: e.message });
  }

  // All failed — return real errors
  return {
    success: false,
    posts: [],
    errors,
    diagnosis: diagnose(errors),
  };
}

function diagnose(errors) {
  const statuses = errors.map(e => e.status);
  if (statuses.some(s => s === 403)) {
    const msg403 = errors.find(e => e.status === 403)?.message || '';
    if (msg403.includes('NO_VERSION')) return 'Fixed: LinkedIn-Version header is now sent. If still failing, re-deploy and reconnect.';
    return `403 Forbidden: ${msg403}. Reconnect LinkedIn at /auth/linkedin to refresh scopes.`;
  }
  if (statuses.every(s => s === 400)) {
    return 'All endpoints returned 400. Possible causes: (a) LinkedIn-Version too old — update LI_VERSION in linkedin.js, (b) r_member_social scope not granted — reconnect at /auth/linkedin.';
  }
  return errors.map(e => `${e.endpoint}: ${e.status} — ${e.message}`).join(' | ');
}

// ─── Delete Post ──────────────────────────────────────────────────────────────

export async function deletePost({ post_id }) {
  const token = getToken();
  try {
    await axios.delete(`${LI_REST}/posts/${encodeURIComponent(post_id)}`, { headers: headers(token) });
    return { success: true, message: `Deleted ${post_id}` };
  } catch {
    await axios.delete(`${LI_V2}/ugcPosts/${encodeURIComponent(post_id)}`, { headers: headers(token) });
    return { success: true, message: `Deleted ${post_id} (ugcPosts)` };
  }
}

// ─── Analytics ────────────────────────────────────────────────────────────────

export async function getPostAnalytics({ post_id }) {
  const token = getToken();
  try {
    const res = await axios.get(`${LI_REST}/socialMetadata/${encodeURIComponent(post_id)}`, { headers: headers(token) });
    const totalReactions = Object.values(res.data.reactionSummaries || {}).reduce((s, r) => s + (r.count || 0), 0);
    return {
      post_id,
      total_reactions: totalReactions,
      reaction_breakdown: res.data.reactionSummaries || {},
      comments: res.data.commentSummary?.count || 0,
    };
  } catch (err) {
    const e = liError(err);
    return { post_id, error: `${e.status}: ${e.message}` };
  }
}

// ─── Comments ─────────────────────────────────────────────────────────────────

export async function commentOnPost({ post_id, text }) {
  const token = getToken();
  const authorUrn = await getMyProfileUrn();
  const body = { actor: authorUrn, message: { text } };
  try {
    const res = await axios.post(`${LI_REST}/socialActions/${encodeURIComponent(post_id)}/comments`, body, { headers: headers(token) });
    return { success: true, comment_id: res.headers['x-restli-id'] || res.data.id };
  } catch {
    const res = await axios.post(`${LI_V2}/socialActions/${encodeURIComponent(post_id)}/comments`, body, { headers: headers(token) });
    return { success: true, comment_id: res.data.id };
  }
}

export async function getPostComments({ post_id, count = 20 }) {
  const token = getToken();
  try {
    const res = await axios.get(`${LI_REST}/socialActions/${encodeURIComponent(post_id)}/comments`, { headers: headers(token), params: { count } });
    return {
      post_id,
      comments: (res.data.elements || []).map(c => ({
        id: c.id, text: c.message?.text || '', actor: c.actor,
        created_at: c.created?.time ? new Date(c.created.time).toISOString() : null,
      })),
      total: res.data.paging?.total ?? 0,
    };
  } catch (err) {
    const e = liError(err);
    return { post_id, error: `${e.status}: ${e.message}`, comments: [] };
  }
}

// ─── Likes ────────────────────────────────────────────────────────────────────

export async function likePost({ post_id }) {
  const token = getToken();
  const authorUrn = await getMyProfileUrn();
  try {
    await axios.post(`${LI_REST}/socialActions/${encodeURIComponent(post_id)}/likes`, { actor: authorUrn }, { headers: headers(token) });
  } catch {
    await axios.post(`${LI_V2}/socialActions/${encodeURIComponent(post_id)}/likes`, { actor: authorUrn }, { headers: headers(token) });
  }
  return { success: true, message: `Liked ${post_id}` };
}

export async function unlikePost({ post_id }) {
  const token = getToken();
  const authorUrn = await getMyProfileUrn();
  try {
    await axios.delete(`${LI_REST}/socialActions/${encodeURIComponent(post_id)}/likes/${encodeURIComponent(authorUrn)}`, { headers: headers(token) });
  } catch {
    await axios.delete(`${LI_V2}/socialActions/${encodeURIComponent(post_id)}/likes/${encodeURIComponent(authorUrn)}`, { headers: headers(token) });
  }
  return { success: true, message: `Unliked ${post_id}` };
}

// ─── Partner-only (return honest messages) ────────────────────────────────────

export async function getConnections() {
  return { note: 'Requires LinkedIn Partner Program (r_network_size scope).', connections: [] };
}
export async function sendConnectionRequest({ profile_url }) {
  return { success: false, note: 'Not available via API.', workaround: `Visit: ${profile_url}` };
}
export async function searchPeople({ keywords }) {
  return { note: 'Requires Partner API.', workaround: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords)}` };
}
export async function sendMessage() {
  return { success: false, note: 'Requires w_messages scope (Partner Program only).', workaround: 'https://www.linkedin.com/messaging' };
}
