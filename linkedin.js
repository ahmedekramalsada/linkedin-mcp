import axios from 'axios';
import { tokenStore } from './token-store.js';

const LI_API = 'https://api.linkedin.com/v2';
const LI_MEDIA_API = 'https://api.linkedin.com/media/upload';

function getHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'X-Restli-Protocol-Version': '2.0.0',
  };
}

function getToken() {
  const tokens = tokenStore.get();
  if (!tokens?.access_token) throw new Error('Not authenticated. Visit /auth/linkedin to connect.');
  return tokens.access_token;
}

export async function getMyProfile() {
  const token = getToken();
  const res = await axios.get(`${LI_API}/userinfo`, { headers: getHeaders(token) });
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

export async function createPost({ text, visibility = 'PUBLIC', articleUrl = null, articleTitle = null, articleDescription = null }) {
  const token = getToken();
  const authorUrn = await getMyProfileUrn();

  let shareMediaCategory = 'NONE';
  let media = [];

  if (articleUrl) {
    shareMediaCategory = 'ARTICLE';
    media = [{
      status: 'READY',
      originalUrl: articleUrl,
      title: { text: articleTitle || articleUrl },
      description: { text: articleDescription || '' },
    }];
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
    visibility: {
      'com.linkedin.ugc.MemberNetworkVisibility': visibility,
    },
  };

  const res = await axios.post(`${LI_API}/ugcPosts`, body, { headers: getHeaders(token) });
  const postId = res.headers['x-restli-id'] || res.data.id;
  return {
    success: true,
    post_id: postId,
    post_url: postId ? `https://www.linkedin.com/feed/update/${postId}` : null,
    message: 'Post created successfully',
  };
}

export async function getMyPosts({ count = 10 } = {}) {
  const token = getToken();
  const authorUrn = await getMyProfileUrn();
  const encodedUrn = encodeURIComponent(authorUrn);

  const res = await axios.get(
    `${LI_API}/ugcPosts?q=authors&authors=List(${encodedUrn})&count=${count}`,
    { headers: getHeaders(token) }
  );

  const posts = (res.data.elements || []).map(post => ({
    id: post.id,
    text: post.specificContent?.['com.linkedin.ugc.ShareContent']?.shareCommentary?.text || '',
    created_at: new Date(post.created?.time || 0).toISOString(),
    lifecycle_state: post.lifecycleState,
    url: `https://www.linkedin.com/feed/update/${post.id}`,
  }));

  return { posts, total: res.data.paging?.total || posts.length };
}

export async function deletePost({ post_id }) {
  const token = getToken();
  const encodedId = encodeURIComponent(post_id);
  await axios.delete(`${LI_API}/ugcPosts/${encodedId}`, { headers: getHeaders(token) });
  return { success: true, message: `Post ${post_id} deleted successfully` };
}

export async function getPostAnalytics({ post_id }) {
  const token = getToken();
  const encodedId = encodeURIComponent(post_id);

  try {
    const res = await axios.get(
      `${LI_API}/socialMetadata/${encodedId}`,
      { headers: getHeaders(token) }
    );

    const data = res.data;
    return {
      post_id,
      likes: data.likesSummary?.totalLikes || 0,
      comments: data.commentsSummary?.totalFirstLevelComments || 0,
      shares: data.shareStatistics?.shareCount || 0,
    };
  } catch {
    return {
      post_id,
      note: 'Analytics require additional LinkedIn API permissions (Marketing Developer Platform)',
      likes: null,
      comments: null,
    };
  }
}

export async function commentOnPost({ post_id, text }) {
  const token = getToken();
  const authorUrn = await getMyProfileUrn();
  const encodedId = encodeURIComponent(post_id);

  const body = {
    actor: authorUrn,
    message: { text },
  };

  const res = await axios.post(
    `${LI_API}/socialActions/${encodedId}/comments`,
    body,
    { headers: getHeaders(token) }
  );

  return {
    success: true,
    comment_id: res.data.id,
    message: 'Comment posted successfully',
  };
}

export async function likePost({ post_id }) {
  const token = getToken();
  const authorUrn = await getMyProfileUrn();
  const encodedId = encodeURIComponent(post_id);

  await axios.post(
    `${LI_API}/socialActions/${encodedId}/likes`,
    { actor: authorUrn },
    { headers: getHeaders(token) }
  );

  return { success: true, message: `Liked post ${post_id}` };
}

export async function getConnections({ count = 20 } = {}) {
  const token = getToken();

  try {
    const res = await axios.get(
      `${LI_API}/connections?q=viewer&start=0&count=${count}`,
      { headers: getHeaders(token) }
    );

    const connections = (res.data.elements || []).map(c => ({
      id: c['to~']?.id || c.to,
      name: [c['to~']?.firstName?.localized?.en_US, c['to~']?.lastName?.localized?.en_US].filter(Boolean).join(' '),
      headline: c['to~']?.headline?.localized?.en_US || '',
    }));

    return { connections, total: res.data.paging?.total || connections.length };
  } catch {
    return {
      note: 'Connection list requires r_network_size scope. Make sure your LinkedIn App has this permission.',
      connections: [],
    };
  }
}

export async function sendConnectionRequest({ profile_url, message = '' }) {
  return {
    success: false,
    note: 'Sending connection requests requires the w_member_social scope with invitation rights. LinkedIn restricts this via API. Please use LinkedIn.com UI for connection requests.',
    workaround: `You can manually send a request at: ${profile_url}`,
  };
}

export async function searchPeople({ keywords, count = 10 }) {
  const token = getToken();

  try {
    const res = await axios.get(
      `${LI_API}/search/blended?keywords=${encodeURIComponent(keywords)}&origin=GLOBAL_SEARCH_HEADER&q=all&filters=List((key:resultType,value:PEOPLE))&count=${count}`,
      { headers: { ...getHeaders(token), 'X-Restli-Protocol-Version': '2.0.0' } }
    );

    const results = (res.data.elements || []).map(e => ({
      name: e.title?.text || 'Unknown',
      headline: e.primarySubtitle?.text || '',
      summary: e.summary?.text || '',
    }));

    return { results, query: keywords };
  } catch {
    return {
      note: 'People search requires LinkedIn Partner API access (Talent Solutions). Standard developer apps cannot use this endpoint.',
      results: [],
      query: keywords,
    };
  }
}

export async function sendMessage({ recipient_urn, text }) {
  return {
    success: false,
    note: 'Sending messages requires the w_messages scope which is only available via LinkedIn Partner Program.',
    workaround: 'You can message people directly at linkedin.com/messaging',
  };
}
