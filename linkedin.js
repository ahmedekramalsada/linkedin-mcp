import axios from 'axios';
import { tokenStore } from './token-store.js';

const LI_V2   = 'https://api.linkedin.com/v2';
const LI_REST = 'https://api.linkedin.com/rest';

// LinkedIn versioned API — update monthly or use a stable pinned version
// Format: YYYYMM. Must be within the last 12 months.
const LI_VERSION = '202504';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getToken() {
  const tokens = tokenStore.get();
  if (!tokens?.access_token) throw new Error('Not authenticated. Visit /auth/linkedin to connect.');
  return tokens.access_token;
}

/** Base headers used by all calls */
function baseHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-Restli-Protocol-Version': '2.0.0',
  };
}

/** Headers for the new /rest versioned endpoints */
function restHeaders(token) {
  return { ...baseHeaders(token), 'LinkedIn-Version': LI_VERSION };
}

/**
 * Extracts a human-readable error from an Axios error so we can
 * surface exactly what LinkedIn said, not a generic message.
 */
function liError(err) {
  const status  = err.response?.status;
  const liMsg   = err.response?.data?.message
               || err.response?.data?.error_description
               || err.response?.data?.serviceErrorCode
               || JSON.stringify(err.response?.data)
               || err.message;
  return { status, message: liMsg, raw: err.response?.data };
}

// ─── Profile ──────────────────────────────────────────────────────────────────

export async function getMyProfile() {
  const token = getToken();
  const res = await axios.get(`${LI_V2}/userinfo`, { headers: baseHeaders(token) });
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

// ─── Posts ────────────────────────────────────────────────────────────────────

export async function createPost({ text, visibility = 'PUBLIC', articleUrl = null, articleTitle = null, articleDescription = null }) {
  const token     = getToken();
  const authorUrn = await getMyProfileUrn();

  // Use the new /rest/posts API for creating
  const body = {
    author: authorUrn,
    commentary: text,
    visibility: visibility,   // PUBLIC | CONNECTIONS | LOGGED_IN
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
      article: {
        source: articleUrl,
        title: articleTitle || articleUrl,
        description: articleDescription || '',
      },
    };
  }

  try {
    const res = await axios.post(`${LI_REST}/posts`, body, { headers: restHeaders(token) });
    const postId = res.headers['x-restli-id'] || null;
    return {
      success: true,
      post_id: postId,
      post_url: postId ? `https://www.linkedin.com/feed/update/${postId}` : null,
      message: 'Post created successfully',
    };
  } catch (err) {
    const e = liError(err);
    // Fallback to legacy ugcPosts if the new API rejects
    if (e.status === 400 || e.status === 403) {
      console.warn(`[createPost] /rest/posts failed (${e.status}), trying legacy ugcPosts...`);
      return createPostLegacy({ text, visibility, authorUrn, articleUrl, articleTitle, articleDescription, token });
    }
    throw new Error(`LinkedIn create post failed (${e.status}): ${e.message}`);
  }
}

async function createPostLegacy({ text, visibility, authorUrn, articleUrl, articleTitle, articleDescription, token }) {
  let shareMediaCategory = 'NONE';
  let media = [];
  if (articleUrl) {
    shareMediaCategory = 'ARTICLE';
    media = [{ status: 'READY', originalUrl: articleUrl,
      title: { text: articleTitle || articleUrl }, description: { text: articleDescription || '' } }];
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
  const res = await axios.post(`${LI_V2}/ugcPosts`, body, { headers: baseHeaders(token) });
  const postId = res.headers['x-restli-id'] || res.data.id;
  return {
    success: true,
    post_id: postId,
    post_url: postId ? `https://www.linkedin.com/feed/update/${postId}` : null,
    message: 'Post created successfully (via legacy API)',
  };
}

// ─── READ POSTS — tries 3 strategies, surfaces real errors ───────────────────

export async function getMyPosts({ count = 10, start = 0 } = {}) {
  const token     = getToken();
  const authorUrn = await getMyProfileUrn();
  const errors    = [];

  // ── Strategy 1: New versioned /rest/posts API ────────────────────────────
  // Requires r_member_social scope + LinkedIn-Version header
  try {
    console.log(`[getMyPosts] Trying /rest/posts for ${authorUrn}`);
    const res = await axios.get(`${LI_REST}/posts`, {
      headers: restHeaders(token),
      params: {
        author: authorUrn,
        q: 'author',
        count,
        start,
      },
    });
    const posts = (res.data.elements || []).map(parseRestPost);
    return {
      source: 'rest/posts (new API)',
      posts,
      total: res.data.paging?.total ?? posts.length,
      start: res.data.paging?.start ?? 0,
    };
  } catch (err) {
    const e = liError(err);
    console.warn(`[getMyPosts] /rest/posts failed: ${e.status} — ${e.message}`);
    errors.push({ endpoint: '/rest/posts', ...e });
  }

  // ── Strategy 2: Legacy ugcPosts with correct List() encoding ─────────────
  // Requires r_member_social or w_member_social (depending on LinkedIn version)
  // IMPORTANT: the URN inside List() must NOT be double-encoded by axios.
  // We build the URL manually to control encoding precisely.
  try {
    console.log(`[getMyPosts] Trying /v2/ugcPosts for ${authorUrn}`);
    // Encode only the URN part, keep List() brackets raw
    const encodedUrn = encodeURIComponent(authorUrn);
    const url = `${LI_V2}/ugcPosts?q=authors&authors=List(${encodedUrn})&count=${count}&start=${start}`;
    const res = await axios.get(url, { headers: baseHeaders(token) });
    const posts = (res.data.elements || []).map(parseUgcPost);
    return {
      source: 'v2/ugcPosts (legacy API)',
      posts,
      total: res.data.paging?.total ?? posts.length,
      start: res.data.paging?.start ?? 0,
    };
  } catch (err) {
    const e = liError(err);
    console.warn(`[getMyPosts] /v2/ugcPosts failed: ${e.status} — ${e.message}`);
    errors.push({ endpoint: '/v2/ugcPosts', ...e });
  }

  // ── Strategy 3: ugcPosts with raw (un-encoded) URN inside List() ──────────
  // Some LinkedIn API versions want the URN unencoded inside List()
  try {
    console.log(`[getMyPosts] Trying /v2/ugcPosts with raw URN`);
    const url = `${LI_V2}/ugcPosts?q=authors&authors=List(${authorUrn})&count=${count}&start=${start}`;
    const res = await axios.get(url, { headers: baseHeaders(token) });
    const posts = (res.data.elements || []).map(parseUgcPost);
    return {
      source: 'v2/ugcPosts raw-urn (legacy API)',
      posts,
      total: res.data.paging?.total ?? posts.length,
      start: res.data.paging?.start ?? 0,
    };
  } catch (err) {
    const e = liError(err);
    console.warn(`[getMyPosts] /v2/ugcPosts raw URN failed: ${e.status} — ${e.message}`);
    errors.push({ endpoint: '/v2/ugcPosts-raw', ...e });
  }

  // All 3 failed — return the real errors so you can debug
  return {
    success: false,
    posts: [],
    errors,
    diagnosis: diagnose(errors),
    fix: 'See diagnosis above. Most common fix: disconnect and reconnect LinkedIn at /auth/linkedin to grant r_member_social scope.',
  };
}

/** Parse a post from the new /rest/posts API */
function parseRestPost(post) {
  return {
    id: post.id || '',
    text: post.commentary || '',
    created_at: post.createdAt ? new Date(post.createdAt).toISOString() : null,
    lifecycle_state: post.lifecycleState,
    visibility: post.visibility,
    url: post.id ? `https://www.linkedin.com/feed/update/${post.id}` : null,
    media_type: post.content ? Object.keys(post.content)[0] : null,
  };
}

/** Parse a post from the legacy ugcPosts API */
function parseUgcPost(post) {
  return {
    id: post.id || '',
    text: post.specificContent?.['com.linkedin.ugc.ShareContent']?.shareCommentary?.text || '',
    created_at: post.created?.time ? new Date(post.created.time).toISOString() : null,
    lifecycle_state: post.lifecycleState,
    visibility: post.visibility?.['com.linkedin.ugc.MemberNetworkVisibility'] || null,
    url: post.id ? `https://www.linkedin.com/feed/update/${post.id}` : null,
  };
}

/** Give the user a human-readable explanation of what went wrong */
function diagnose(errors) {
  const statuses = errors.map(e => e.status);
  if (statuses.every(s => s === 403)) {
    return 'All endpoints returned 403 Forbidden. Your token is missing the r_member_social scope. Disconnect and reconnect LinkedIn at /auth/linkedin.';
  }
  if (statuses.every(s => s === 400)) {
    return 'All endpoints returned 400 Bad Request. Either (a) r_member_social scope not approved for your LinkedIn App, or (b) your person URN is wrong. Check the LinkedIn Developer Portal → your app → Auth tab → ensure r_member_social is listed.';
  }
  if (statuses.some(s => s === 401)) {
    return 'Token expired or invalid. Reconnect at /auth/linkedin.';
  }
  return `Mixed errors: ${errors.map(e => `${e.endpoint}=${e.status}`).join(', ')}`;
}

// ─── Delete ───────────────────────────────────────────────────────────────────

export async function deletePost({ post_id }) {
  const token = getToken();

  // Try new /rest/posts first, fall back to /v2/ugcPosts
  try {
    await axios.delete(`${LI_REST}/posts/${encodeURIComponent(post_id)}`, { headers: restHeaders(token) });
    return { success: true, message: `Post ${post_id} deleted` };
  } catch (err) {
    const e = liError(err);
    if (e.status === 404 || e.status === 400) {
      // Try legacy
      await axios.delete(`${LI_V2}/ugcPosts/${encodeURIComponent(post_id)}`, { headers: baseHeaders(token) });
      return { success: true, message: `Post ${post_id} deleted (via legacy API)` };
    }
    throw new Error(`Delete failed (${e.status}): ${e.message}`);
  }
}

// ─── Analytics ────────────────────────────────────────────────────────────────

export async function getPostAnalytics({ post_id }) {
  const token = getToken();
  try {
    const res = await axios.get(
      `${LI_REST}/socialMetadata/${encodeURIComponent(post_id)}`,
      { headers: restHeaders(token) }
    );
    const data = res.data;
    const totalReactions = Object.values(data.reactionSummaries || {})
      .reduce((sum, r) => sum + (r.count || 0), 0);
    return {
      post_id,
      total_reactions: totalReactions,
      reaction_breakdown: data.reactionSummaries || {},
      comments: data.commentSummary?.count || 0,
      top_level_comments: data.commentSummary?.topLevelCount || 0,
    };
  } catch (err) {
    const e = liError(err);
    return { post_id, error: `Analytics failed (${e.status}): ${e.message}`, raw: e.raw };
  }
}

// ─── Comments ─────────────────────────────────────────────────────────────────

export async function commentOnPost({ post_id, text }) {
  const token = getToken();
  const authorUrn = await getMyProfileUrn();
  const body = { actor: authorUrn, message: { text } };

  try {
    const res = await axios.post(
      `${LI_REST}/socialActions/${encodeURIComponent(post_id)}/comments`,
      body,
      { headers: restHeaders(token) }
    );
    return { success: true, comment_id: res.headers['x-restli-id'] || res.data.id, message: 'Comment posted' };
  } catch (err) {
    // Fallback to v2
    const res2 = await axios.post(
      `${LI_V2}/socialActions/${encodeURIComponent(post_id)}/comments`,
      body,
      { headers: baseHeaders(token) }
    );
    return { success: true, comment_id: res2.data.id, message: 'Comment posted (legacy API)' };
  }
}

export async function getPostComments({ post_id, count = 20 }) {
  const token = getToken();
  try {
    const res = await axios.get(
      `${LI_REST}/socialActions/${encodeURIComponent(post_id)}/comments`,
      { headers: restHeaders(token), params: { count } }
    );
    const comments = (res.data.elements || []).map(c => ({
      id: c.id, text: c.message?.text || '', actor: c.actor,
      created_at: c.created?.time ? new Date(c.created.time).toISOString() : null,
    }));
    return { post_id, comments, total: res.data.paging?.total ?? comments.length };
  } catch (err) {
    const e = liError(err);
    return { post_id, error: `Comments failed (${e.status}): ${e.message}`, comments: [] };
  }
}

// ─── Likes ────────────────────────────────────────────────────────────────────

export async function likePost({ post_id }) {
  const token = getToken();
  const authorUrn = await getMyProfileUrn();
  try {
    await axios.post(
      `${LI_REST}/socialActions/${encodeURIComponent(post_id)}/likes`,
      { actor: authorUrn },
      { headers: restHeaders(token) }
    );
  } catch {
    await axios.post(
      `${LI_V2}/socialActions/${encodeURIComponent(post_id)}/likes`,
      { actor: authorUrn },
      { headers: baseHeaders(token) }
    );
  }
  return { success: true, message: `Liked post ${post_id}` };
}

export async function unlikePost({ post_id }) {
  const token = getToken();
  const authorUrn = await getMyProfileUrn();
  try {
    await axios.delete(
      `${LI_REST}/socialActions/${encodeURIComponent(post_id)}/likes/${encodeURIComponent(authorUrn)}`,
      { headers: restHeaders(token) }
    );
  } catch {
    await axios.delete(
      `${LI_V2}/socialActions/${encodeURIComponent(post_id)}/likes/${encodeURIComponent(authorUrn)}`,
      { headers: baseHeaders(token) }
    );
  }
  return { success: true, message: `Unliked post ${post_id}` };
}

// ─── Network (partner-only — return honest messages) ─────────────────────────

export async function getConnections({ count = 20 } = {}) {
  return {
    note: 'Connection list requires r_network_size scope — only available via LinkedIn Partner Program.',
    connections: [],
  };
}

export async function sendConnectionRequest({ profile_url }) {
  return {
    success: false,
    note: 'LinkedIn removed connection requests from their public API.',
    workaround: `Send a request manually at: ${profile_url}`,
  };
}

export async function searchPeople({ keywords }) {
  return {
    note: 'People search requires LinkedIn Talent Solutions Partner Program.',
    results: [],
    workaround: `Search manually: https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords)}`,
  };
}

export async function sendMessage({ recipient_urn }) {
  return {
    success: false,
    note: 'Direct messaging requires w_messages scope — LinkedIn Partner Program only.',
    workaround: 'Message at: https://www.linkedin.com/messaging',
  };
}
