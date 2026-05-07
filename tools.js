import { z } from 'zod';
import * as li from './linkedin.js';

export function registerTools(server) {

  // ─── Profile ───────────────────────────────────────────────────────────────

  server.tool(
    'linkedin_get_profile',
    'Get your own LinkedIn profile information (name, headline, email, profile picture URL)',
    {},
    async () => {
      const profile = await li.getMyProfile();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            name: profile.name,
            given_name: profile.given_name,
            family_name: profile.family_name,
            email: profile.email,
            headline: profile.headline || null,
            picture: profile.picture || null,
            linkedin_id: profile.sub,
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    'linkedin_get_auth_status',
    'Check if the LinkedIn account is connected and authenticated',
    {},
    async () => {
      const { tokenStore } = await import('./token-store.js');
      const tokens = tokenStore.get();
      const isConnected = tokenStore.isConnected();

      if (!isConnected) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              connected: false,
              message: 'Not connected. Visit /auth/linkedin on the MCP server to authenticate.',
            }, null, 2),
          }],
        };
      }

      const daysLeft = tokens.expires_at
        ? Math.floor((tokens.expires_at - Date.now()) / 86400000)
        : null;

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            connected: true,
            person_urn: tokens.person_urn || 'unknown — call linkedin_get_profile to cache it',
            expires_at: tokens.expires_at ? new Date(tokens.expires_at).toISOString() : 'unknown',
            days_until_expiry: daysLeft,
            has_refresh_token: !!tokens.refresh_token,
            scopes: 'openid profile email w_member_social r_member_social',
          }, null, 2),
        }],
      };
    }
  );

  // ─── Posts ─────────────────────────────────────────────────────────────────

  server.tool(
    'linkedin_create_post',
    'Create a new LinkedIn post. Can post plain text or include an article/link. Visibility: PUBLIC, CONNECTIONS, or LOGGED_IN.',
    {
      text: z.string().describe('The main text/content of the post. Supports line breaks with \\n.'),
      visibility: z.enum(['PUBLIC', 'CONNECTIONS', 'LOGGED_IN']).default('PUBLIC').describe('Who can see this post'),
      article_url: z.string().url().optional().describe('Optional: URL of an article or link to share'),
      article_title: z.string().optional().describe('Optional: Title for the shared article'),
      article_description: z.string().optional().describe('Optional: Short description for the shared article'),
    },
    async ({ text, visibility, article_url, article_title, article_description }) => {
      const result = await li.createPost({
        text,
        visibility,
        articleUrl: article_url,
        articleTitle: article_title,
        articleDescription: article_description,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    'linkedin_get_my_posts',
    'Get your recent LinkedIn posts. Returns post text, ID, date, and direct URL.',
    {
      count: z.number().int().min(1).max(50).default(10).describe('Number of posts to retrieve (1–50)'),
      start: z.number().int().min(0).default(0).describe('Pagination offset — use 10 to get the next page after first 10'),
    },
    async ({ count, start }) => {
      const result = await li.getMyPosts({ count, start });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    'linkedin_delete_post',
    'Delete one of your LinkedIn posts by its ID (URN)',
    {
      post_id: z.string().describe('The LinkedIn post URN — e.g. urn:li:share:1234567890 or urn:li:ugcPost:1234567890'),
    },
    async ({ post_id }) => {
      const result = await li.deletePost({ post_id });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    'linkedin_get_post_analytics',
    'Get engagement analytics for one of your posts (reactions, comments breakdown)',
    {
      post_id: z.string().describe('The LinkedIn post URN'),
    },
    async ({ post_id }) => {
      const result = await li.getPostAnalytics({ post_id });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // ─── Comments ──────────────────────────────────────────────────────────────

  server.tool(
    'linkedin_comment_on_post',
    'Post a comment on a LinkedIn post',
    {
      post_id: z.string().describe('The LinkedIn post URN to comment on'),
      text: z.string().describe('The comment text'),
    },
    async ({ post_id, text }) => {
      const result = await li.commentOnPost({ post_id, text });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    'linkedin_get_post_comments',
    'Read comments on one of your LinkedIn posts',
    {
      post_id: z.string().describe('The LinkedIn post URN'),
      count: z.number().int().min(1).max(100).default(20).describe('Number of comments to retrieve'),
    },
    async ({ post_id, count }) => {
      const result = await li.getPostComments({ post_id, count });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // ─── Reactions ─────────────────────────────────────────────────────────────

  server.tool(
    'linkedin_like_post',
    'Like a LinkedIn post',
    {
      post_id: z.string().describe('The LinkedIn post URN to like'),
    },
    async ({ post_id }) => {
      const result = await li.likePost({ post_id });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    'linkedin_unlike_post',
    'Remove your like from a LinkedIn post',
    {
      post_id: z.string().describe('The LinkedIn post URN to unlike'),
    },
    async ({ post_id }) => {
      const result = await li.unlikePost({ post_id });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // ─── Network ───────────────────────────────────────────────────────────────

  server.tool(
    'linkedin_get_connections',
    'Get a list of your LinkedIn connections (requires r_network_size scope — may not be available on all apps)',
    {
      count: z.number().int().min(1).max(100).default(20).describe('Number of connections to retrieve'),
    },
    async ({ count }) => {
      const result = await li.getConnections({ count });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    'linkedin_search_people',
    'Search for people on LinkedIn by keywords. NOTE: Full search requires Partner API — this returns a direct search URL instead.',
    {
      keywords: z.string().describe('Search query — name, job title, company, or keywords'),
      count: z.number().int().min(1).max(25).default(10).describe('Desired number of results'),
    },
    async ({ keywords, count }) => {
      const result = await li.searchPeople({ keywords, count });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    'linkedin_send_message',
    'Send a direct message to a LinkedIn connection. NOTE: Requires LinkedIn Partner Program — returns instructions instead.',
    {
      recipient_urn: z.string().describe("Recipient's LinkedIn URN (urn:li:person:...)"),
      text: z.string().describe('Message content'),
    },
    async ({ recipient_urn, text }) => {
      const result = await li.sendMessage({ recipient_urn, text });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  console.log('[MCP] Registered 12 LinkedIn tools');
}
