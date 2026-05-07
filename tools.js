import { z } from 'zod';
import * as li from './linkedin.js';

/**
 * Registers all LinkedIn tools on the McpServer instance.
 * Each tool maps directly to a LinkedIn API action.
 */
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

  // ─── Posts ─────────────────────────────────────────────────────────────────

  server.tool(
    'linkedin_create_post',
    'Create a new LinkedIn post. Can post plain text, or include an article/link. Visibility: PUBLIC, CONNECTIONS, or LOGGED_IN.',
    {
      text: z.string().describe('The main text/content of the post. Supports line breaks.'),
      visibility: z.enum(['PUBLIC', 'CONNECTIONS', 'LOGGED_IN']).default('PUBLIC').describe('Who can see this post'),
      article_url: z.string().url().optional().describe('Optional: URL of an article to share'),
      article_title: z.string().optional().describe('Optional: Title for the shared article'),
      article_description: z.string().optional().describe('Optional: Description for the shared article'),
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
    'Get your recent LinkedIn posts',
    {
      count: z.number().int().min(1).max(50).default(10).describe('Number of posts to retrieve (1-50)'),
    },
    async ({ count }) => {
      const result = await li.getMyPosts({ count });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    'linkedin_delete_post',
    'Delete one of your LinkedIn posts by its post ID (URN)',
    {
      post_id: z.string().describe('The LinkedIn post ID/URN (e.g., urn:li:ugcPost:1234567890)'),
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
    'Get engagement analytics for one of your posts (likes, comments, shares)',
    {
      post_id: z.string().describe('The LinkedIn post ID/URN'),
    },
    async ({ post_id }) => {
      const result = await li.getPostAnalytics({ post_id });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // ─── Engagement ────────────────────────────────────────────────────────────

  server.tool(
    'linkedin_like_post',
    'Like a LinkedIn post',
    {
      post_id: z.string().describe('The LinkedIn post ID/URN to like'),
    },
    async ({ post_id }) => {
      const result = await li.likePost({ post_id });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    'linkedin_comment_on_post',
    'Post a comment on a LinkedIn post',
    {
      post_id: z.string().describe('The LinkedIn post ID/URN to comment on'),
      text: z.string().describe('The comment text'),
    },
    async ({ post_id, text }) => {
      const result = await li.commentOnPost({ post_id, text });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // ─── Network ───────────────────────────────────────────────────────────────

  server.tool(
    'linkedin_get_connections',
    'Get a list of your LinkedIn connections',
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
    'Search for people on LinkedIn by keywords (name, company, role, etc.)',
    {
      keywords: z.string().describe('Search query - can be a name, job title, company, or any keywords'),
      count: z.number().int().min(1).max(25).default(10).describe('Number of results to return'),
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
    'Send a direct message to a LinkedIn connection',
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

  server.tool(
    'linkedin_get_auth_status',
    'Check if the LinkedIn account is connected and authenticated',
    {},
    async () => {
      const tokens = (await import('./token-store.js')).tokenStore.get();
      const isConnected = (await import('./token-store.js')).tokenStore.isConnected();

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

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            connected: true,
            person_urn: tokens.person_urn || 'unknown (call linkedin_get_profile to cache)',
            expires_at: tokens.expires_at ? new Date(tokens.expires_at).toISOString() : 'unknown',
            has_refresh_token: !!tokens.refresh_token,
          }, null, 2),
        }],
      };
    }
  );

  console.log('[MCP] Registered 10 LinkedIn tools');
}
