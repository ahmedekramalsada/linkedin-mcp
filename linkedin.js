import axios from 'axios';
import { tokenStore } from './token-store.js';

// ─── API bases ────────────────────────────────────────────────────────────────
// /v2  = legacy endpoints (userinfo, ugcPosts create/delete, socialActions)
// /rest = new versioned endpoints (posts read, social metadata)
const LI_V2 = 'https://api.linkedin.com/v2';
const LI_REST = 'https://api.linkedin.com/rest';

// LinkedIn requires a versioned header on all /rest endpoints (YYYYMM format)
// Update this monthly or pin to a stable version. 202505 = May 2025.
const LI_VERSION = '202505';

function getHeaders(accessToken, includeVersion = false) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'X-Restli-Protocol-Version': '2.0.0',
  };
  if (includeVersion) headers['LinkedIn-Version'] = LI_VERSION;
  return headers;
}

function getToken() {
  const tokens = tokenStore.get();
  if (!tokens?.access_token) {
    throw new Error('Not authenticated. Visit /auth/linkedin to connect.');
  }
  return tokens.access_token;
}

// ─── Profile ──────────────────────────────────────────────────────────────────

export async function getMyProfile() {
  const token = getToken();
  const res = await axios.get(`${LI_V2}/userinfo`, { headers: getHeaders(token) });
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

export async function createPost({
  text,
  visibility = 'PUBLIC',
  articleUrl = null,
  articleTitle = null,
  articleDescription = null,
}) {
  const token = getToken();
  const authorUrn = await getMyProfileUrn();

  // Map PUBLIC -> PUBLIC, CONNECTIONS -> CONNECTIONS, LOGGED_IN -> LOGGED_IN
  const visibilityMap = {
    PUBLIC: 'PUBLIC',
    CONNECTIONS: 'CONNECTIONS',
    LOGGED_IN: 'LOGGED_IN',
  };

  // Use the new /rest/posts API (replaces ugcPosts)
  const body = {
    author: authorUrn,
    commentary: text,
    visibility: visibilityMap[visibility] || 'PUBLIC',
    distribution: {
      feedDistribution: 'MAIN_FEED',
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };

  // Add article content if URL provided
  if (articleUrl) {
    body.content = {
      article: {
        source: articleUrl,
        title: articleTitle || articleUrl,
        description: articleDescription || '',
      },
    };
  }

  const res = await axios.post(`${LI_REST}/posts`, body, {
    headers: getHeaders(token, true), // needs LinkedIn-Version
  });

  // New Posts API returns the post URN in x-restli-id header
  const postId = res.headers['x-restli-id'] || res.headers['x-linkedin-id'] || null;

  return {
    success: true,
    post_id: postId,
    post_url: postId ? `https://www.linkedin.com/feed/update/${postId}` : null,
    message: 'Post created successfully',
  };
}

export async function getMyPosts({ count = 10, start = 0 } = {}) {
  const token = getToken();
  const authorUrn = await getMyProfileUrn();

  // New Posts API - requires r_member_social scope
  // GET /rest/posts?author={urn}&q=author&count=N&sortBy=LAST_MODIFIED
  const res = await axios.get(`${LI_REST}/posts`, {
    params: {
      author: authorUrn,
      q: 'author',
      count,
      start,
      sortBy: 'LAST_MODIFIED',
    },
    headers: getHeaders(token, true), // LinkedIn-Version required
  });

  const elements = res.data.elements || [];

  const posts = elements.map(post => {
    // New Posts API uses different field names than ugcPosts
    const text =
      post.commentary ||
      post.specificContent?.['com.linkedin.ugc.ShareContent']?.shareCommentary?.text ||
      '';

    const createdAt = post.createdAt || post.created?.time || 0;
    const postId = post.id || '';

    // Extract article/media info if present
    const article = post.content?.article || null;
    const mediaType = post.content ? Object.keys(post.content)[0] : null;

    return {
      id: postId,
      text,
      created_at: createdAt ? new Date(createdAt).toISOString() : null,
      lifecycle_state: post.lifecycleState,
      visibility: post.visibility,
      url: postId ? `https://www.linkedin.com/feed/update/${postId}` : null,
      ...(article ? { article_url: article.source, article_title: article.title } : {}),
      ...(mediaType && mediaType !== 'article' ? { media_type: mediaType } : {}),
    };
  });

  return {
    posts,
    count: posts.length,
    total: res.data.paging?.total || posts.length,
    start: res.data.paging?.start || 0,
  };
}

export async function deletePost({ post_id }) {
  const token = getToken();
  const encodedId = encodeURIComponent(post_id);

  // New Posts API delete
  await axios.delete(`${LI_REST}/posts/${encodedId}`, {
    headers: getHeaders(token, true),
  });

  return { success: true, message: `Post ${post_id} deleted successfully` };
}

// ─── Post Analytics ───────────────────────────────────────────────────────────

export async function getPostAnalytics({ post_id }) {
  const token = getToken();
  const encodedId = encodeURIComponent(post_id);

  try {
    // New Social Metadata API - needs LinkedIn-Version header
    const res = await axios.get(`${LI_REST}/socialMetadata/${encodedId}`, {
      headers: getHeaders(token, true),
    });

    const data = res.data;

    // Aggregate all reaction types into a total
    const reactionSummaries = data.reactionSummaries || {};
    const totalReactions = Object.values(reactionSummaries).reduce(
      (sum, r) => sum + (r.count || 0),
      0
    );

    return {
      post_id,
      reactions: totalReactions,
      reaction_breakdown: reactionSummaries,
      comments: data.commentSummary?.count || 0,
      top_level_comments: data.commentSummary?.topLevelCount || 0,
      comments_state: data.commentsState || 'UNKNOWN',
    };
  } catch (err) {
    const status = err.response?.status;
    return {
      post_id,
      error: status === 403
        ? 'Analytics require r_member_social scope. Reconnect your LinkedIn account via /auth/linkedin to grant this permission.'
        : `Failed to fetch analytics: ${err.response?.data?.message || err.message}`,
      reactions: null,
      comments: null,
    };
  }
}

// ─── Comments ─────────────────────────────────────────────────────────────────

export async function commentOnPost({ post_id, text }) {
  const token = getToken();
  const authorUrn = await getMyProfileUrn();
  const encodedId = encodeURIComponent(post_id);

  // socialActions still works under /rest with version header
  const body = {
    actor: authorUrn,
    message: { text },
  };

  const res = await axios.post(
    `${LI_REST}/socialActions/${encodedId}/comments`,
    body,
    { headers: getHeaders(token, true) }
  );

  const commentId = res.headers['x-restli-id'] || res.data.id;
  return {
    success: true,
    comment_id: commentId,
    message: 'Comment posted successfully',
  };
}

export async function getPostComments({ post_id, count = 20 }) {
  const token = getToken();
  const encodedId = encodeURIComponent(post_id);

  try {
    const res = await axios.get(
      `${LI_REST}/socialActions/${encodedId}/comments`,
      {
        params: { count },
        headers: getHeaders(token, true),
      }
    );

    const comments = (res.data.elements || []).map(c => ({
      id: c.id,
      text: c.message?.text || '',
      actor: c.actor,
      created_at: c.created?.time ? new Date(c.created.time).toISOString() : null,
      likes: c.likesSummary?.totalLikes || 0,
    }));

    return { post_id, comments, total: res.data.paging?.total || comments.length };
  } catch (err) {
    return {
      post_id,
      error: `Could not fetch comments: ${err.response?.data?.message || err.message}`,
      comments: [],
    };
  }
}

// ─── Reactions / Likes ────────────────────────────────────────────────────────

export async function likePost({ post_id }) {
  const token = getToken();
  const authorUrn = await getMyProfileUrn();
  const encodedId = encodeURIComponent(post_id);

  await axios.post(
    `${LI_REST}/socialActions/${encodedId}/likes`,
    { actor: authorUrn },
    { headers: getHeaders(token, true) }
  );

  return { success: true, message: `Liked post ${post_id}` };
}

export async function unlikePost({ post_id }) {
  const token = getToken();
  const authorUrn = await getMyProfileUrn();
  const encodedId = encodeURIComponent(post_id);
  const encodedActor = encodeURIComponent(authorUrn);

  await axios.delete(
    `${LI_REST}/socialActions/${encodedId}/likes/${encodedActor}`,
    { headers: getHeaders(token, true) }
  );

  return { success: true, message: `Unliked post ${post_id}` };
}

// ─── Network ──────────────────────────────────────────────────────────────────

export async function getConnections({ count = 20 } = {}) {
  const token = getToken();

  try {
    const res = await axios.get(
      `${LI_V2}/connections?q=viewer&start=0&count=${count}`,
      { headers: getHeaders(token) }
    );

    const connections = (res.data.elements || []).map(c => ({
      id: c['to~']?.id || c.to,
      name: [
        c['to~']?.firstName?.localized?.en_US,
        c['to~']?.lastName?.localized?.en_US,
      ]
        .filter(Boolean)
        .join(' '),
      headline: c['to~']?.headline?.localized?.en_US || '',
    }));

    return { connections, total: res.data.paging?.total || connections.length };
  } catch (err) {
    return {
      note: `Connections require r_network_size scope (partner program). Error: ${err.response?.data?.message || err.message}`,
      connections: [],
    };
  }
}

export async function sendConnectionRequest({ profile_url, message = '' }) {
  return {
    success: false,
    note: 'LinkedIn removed connection requests from their public API. This requires a LinkedIn Partner Program.',
    workaround: `Send a request manually at: ${profile_url}`,
  };
}

export async function searchPeople({ keywords, count = 10 }) {
  return {
    note: 'People search requires LinkedIn Talent Solutions Partner Program — not available on free developer apps.',
    results: [],
    query: keywords,
    workaround: `Search manually at: https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords)}`,
  };
}

// ─── Messages ─────────────────────────────────────────────────────────────────

export async function sendMessage({ recipient_urn, text }) {
  return {
    success: false,
    note: 'Direct messaging requires the w_messages scope — only available via LinkedIn Partner Program.',
    workaround: 'Message people directly at: https://www.linkedin.com/messaging',
  };
}
