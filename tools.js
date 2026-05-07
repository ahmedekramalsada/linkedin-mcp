import { z } from 'zod';
import * as li from './linkedin.js';

export function registerTools(server) {

  // ─── Profile ───────────────────────────────────────────────────────────────

  server.tool('linkedin_get_profile',
    'Get your LinkedIn profile info: name, headline, email, photo, person URN',
    {},
    async () => {
      const profile = await li.getMyProfile();
      return { content: [{ type: 'text', text: JSON.stringify({
        name: profile.name,
        given_name: profile.given_name,
        family_name: profile.family_name,
        email: profile.email,
        headline: profile.headline || null,
        picture: profile.picture || null,
        linkedin_id: profile.sub,
      }, null, 2) }] };
    }
  );

  server.tool('linkedin_get_auth_status',
    'Check if LinkedIn is connected and show token expiry and granted scopes',
    {},
    async () => {
      const { tokenStore } = await import('./token-store.js');
      const tokens = tokenStore.get();
      const isConnected = tokenStore.isConnected();
      if (!isConnected) {
        return { content: [{ type: 'text', text: JSON.stringify({
          connected: false,
          message: 'Not connected. Visit /auth/linkedin to authenticate.',
        }, null, 2) }] };
      }
      const daysLeft = tokens.expires_at
        ? Math.floor((tokens.expires_at - Date.now()) / 86400000) : null;
      return { content: [{ type: 'text', text: JSON.stringify({
        connected: true,
        person_urn: tokens.person_urn || 'unknown — call linkedin_get_profile first',
        expires_at: tokens.expires_at ? new Date(tokens.expires_at).toISOString() : 'unknown',
        days_until_expiry: daysLeft,
        has_refresh_token: !!tokens.refresh_token,
        scopes_requested: 'openid profile email w_member_social r_member_social',
      }, null, 2) }] };
    }
  );

  // ─── Debug tool — shows raw LinkedIn API response ─────────────────────────

  server.tool('linkedin_debug_posts',
    'DEBUG: Makes raw API calls to LinkedIn and returns the exact error/response. Use this to diagnose why reading posts fails.',
    {},
    async () => {
      const { tokenStore } = await import('./token-store.js');
      const tokens = tokenStore.get();
      if (!tokens?.access_token) {
        return { content: [{ type: 'text', text: 'Not authenticated' }] };
      }

      const axios = (await import('axios')).default;
      const results = {};

      // Test 1: userinfo (should always work)
      try {
        const r = await axios.get('https://api.linkedin.com/v2/userinfo', {
          headers: { Authorization: `Bearer ${tokens.access_token}`, 'X-Restli-Protocol-Version': '2.0.0' }
        });
        results.userinfo = { status: r.status, sub: r.data.sub, name: r.data.name };
      } catch (e) {
        results.userinfo = { error: e.response?.status, body: e.response?.data };
      }

      const urn = tokens.person_urn || (results.userinfo?.sub ? `urn:li:person:${results.userinfo.sub}` : null);
      results.person_urn_used = urn;

      if (!urn) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Could not get URN', results }, null, 2) }] };
      }

      // Test 2: /rest/posts (new API)
      try {
        const r = await axios.get('https://api.linkedin.com/rest/posts', {
          headers: {
            Authorization: `Bearer ${tokens.access_token}`,
            'X-Restli-Protocol-Version': '2.0.0',
            'LinkedIn-Version': '202504',
          },
          params: { author: urn, q: 'author', count: 3 },
        });
        results.rest_posts = { status: r.status, count: r.data.elements?.length, paging: r.data.paging };
      } catch (e) {
        results.rest_posts = { error: e.response?.status, body: e.response?.data };
      }

      // Test 3: /v2/ugcPosts with encoded URN
      try {
        const encodedUrn = encodeURIComponent(urn);
        const r = await axios.get(
          `https://api.linkedin.com/v2/ugcPosts?q=authors&authors=List(${encodedUrn})&count=3`,
          { headers: { Authorization: `Bearer ${tokens.access_token}`, 'X-Restli-Protocol-Version': '2.0.0' } }
        );
        results.ugcPosts_encoded = { status: r.status, count: r.data.elements?.length };
      } catch (e) {
        results.ugcPosts_encoded = { error: e.response?.status, body: e.response?.data };
      }

      // Test 4: /v2/ugcPosts with raw URN
      try {
        const r = await axios.get(
          `https://api.linkedin.com/v2/ugcPosts?q=authors&authors=List(${urn})&count=3`,
          { headers: { Authorization: `Bearer ${tokens.access_token}`, 'X-Restli-Protocol-Version': '2.0.0' } }
        );
        results.ugcPosts_raw = { status: r.status, count: r.data.elements?.length };
      } catch (e) {
        results.ugcPosts_raw = { error: e.response?.status, body: e.response?.data };
      }

      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }
  );

  // ─── Posts ─────────────────────────────────────────────────────────────────

  server.tool('linkedin_create_post',
    'Create a LinkedIn post. Text only, or include an article URL. Visibility: PUBLIC, CONNECTIONS, or LOGGED_IN.',
    {
      text: z.string().describe('Post content. Use \\n for line breaks.'),
      visibility: z.enum(['PUBLIC', 'CONNECTIONS', 'LOGGED_IN']).default('PUBLIC'),
      article_url: z.string().url().optional().describe('Optional article/link URL to share'),
      article_title: z.string().optional(),
      article_description: z.string().optional(),
    },
    async ({ text, visibility, article_url, article_title, article_description }) => {
      const result = await li.createPost({ text, visibility, articleUrl: article_url, articleTitle: article_title, articleDescription: article_description });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool('linkedin_get_my_posts',
    'Get your recent LinkedIn posts. Returns post text, ID, date, URL. Tries multiple API strategies automatically.',
    {
      count: z.number().int().min(1).max(50).default(10).describe('Number of posts (1–50)'),
      start: z.number().int().min(0).default(0).describe('Pagination offset'),
    },
    async ({ count, start }) => {
      const result = await li.getMyPosts({ count, start });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool('linkedin_delete_post',
    'Delete one of your LinkedIn posts by URN',
    { post_id: z.string().describe('Post URN e.g. urn:li:share:123 or urn:li:ugcPost:123') },
    async ({ post_id }) => {
      const result = await li.deletePost({ post_id });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool('linkedin_get_post_analytics',
    'Get reactions and comment count for one of your posts',
    { post_id: z.string().describe('Post URN') },
    async ({ post_id }) => {
      const result = await li.getPostAnalytics({ post_id });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ─── Engagement ────────────────────────────────────────────────────────────

  server.tool('linkedin_comment_on_post',
    'Post a comment on a LinkedIn post',
    {
      post_id: z.string().describe('Post URN'),
      text: z.string().describe('Comment text'),
    },
    async ({ post_id, text }) => {
      const result = await li.commentOnPost({ post_id, text });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool('linkedin_get_post_comments',
    'Read comments on one of your LinkedIn posts',
    {
      post_id: z.string().describe('Post URN'),
      count: z.number().int().min(1).max(100).default(20),
    },
    async ({ post_id, count }) => {
      const result = await li.getPostComments({ post_id, count });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool('linkedin_like_post',
    'Like a LinkedIn post',
    { post_id: z.string().describe('Post URN to like') },
    async ({ post_id }) => {
      const result = await li.likePost({ post_id });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool('linkedin_unlike_post',
    'Remove your like from a LinkedIn post',
    { post_id: z.string().describe('Post URN to unlike') },
    async ({ post_id }) => {
      const result = await li.unlikePost({ post_id });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ─── Network (partner-only) ─────────────────────────────────────────────────

  server.tool('linkedin_get_connections',
    'Get your LinkedIn connections (requires partner API — returns explanation if unavailable)',
    { count: z.number().int().min(1).max(100).default(20) },
    async ({ count }) => {
      const result = await li.getConnections({ count });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool('linkedin_search_people',
    'Search people on LinkedIn — returns a direct search URL since the API requires partner access',
    {
      keywords: z.string().describe('Name, job title, company, or any keywords'),
      count: z.number().int().min(1).max(25).default(10),
    },
    async ({ keywords, count }) => {
      const result = await li.searchPeople({ keywords, count });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool('linkedin_send_message',
    'Send a LinkedIn DM — returns explanation since messaging requires partner API',
    {
      recipient_urn: z.string().describe("Recipient LinkedIn URN"),
      text: z.string().describe('Message text'),
    },
    async ({ recipient_urn, text }) => {
      const result = await li.sendMessage({ recipient_urn, text });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  console.log('[MCP] Registered 13 LinkedIn tools (including debug tool)');
}
