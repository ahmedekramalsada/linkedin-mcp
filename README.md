# LinkedIn MCP Server

Full-stack MCP server that lets your AI agent (batabeto/OpenClaw) control LinkedIn as you — post, comment, like, manage your network.

---

## Architecture

```
AI Agent (batabeto) ──MCP/HTTP──► LinkedIn MCP Server ──REST──► LinkedIn API
                                         │
                                   OAuth2 + Token Store
                                         │
                                    Dashboard UI
```

---

## Setup Guide

### 1. Create a LinkedIn App

1. Go to [LinkedIn Developers](https://www.linkedin.com/developers/apps)
2. Click **Create App**
3. Fill in: App Name, LinkedIn Page, Logo
4. Under **Auth** tab → Add `Authorized redirect URLs`:
   ```
   http://YOUR_EC2_IP:3000/auth/callback
   ```
   (or your domain if using nginx)
5. Under **Products** tab → Request:
   - **Share on LinkedIn** (gives `w_member_social` scope)
   - **Sign In with LinkedIn using OpenID Connect** (gives `openid profile email`)
6. Copy your **Client ID** and **Client Secret**

### 2. Install & Configure

```bash
git clone <your-repo> linkedin-mcp
cd linkedin-mcp
npm install

cp .env.example .env
nano .env
```

Fill in `.env`:
```env
LINKEDIN_CLIENT_ID=your_client_id
LINKEDIN_CLIENT_SECRET=your_client_secret
BASE_URL=http://YOUR_EC2_IP:3000
PORT=3000
MCP_SECRET_KEY=$(openssl rand -hex 32)
```

### 3. Run the Server

```bash
# Production
npm start

# Development (auto-restart)
npm run dev

# As a systemd service (recommended for EC2)
sudo nano /etc/systemd/system/linkedin-mcp.service
```

**systemd service file:**
```ini
[Unit]
Description=LinkedIn MCP Server
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/linkedin-mcp
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
EnvironmentFile=/home/ubuntu/linkedin-mcp/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable linkedin-mcp
sudo systemctl start linkedin-mcp
sudo systemctl status linkedin-mcp
```

### 4. Authenticate LinkedIn

1. Open: `http://YOUR_EC2_IP:3000`
2. Click **Connect LinkedIn**
3. Authorize the app on LinkedIn
4. You'll be redirected back — status shows ✅ Connected

### 5. Connect to Your AI Agent

#### For OpenClaw (batabeto):
Add to your agent's MCP config:
```json
{
  "mcpServers": {
    "linkedin": {
      "url": "http://YOUR_EC2_IP:3000/mcp",
      "transport": "http",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_SECRET_KEY"
      }
    }
  }
}
```

#### For Claude Desktop:
```json
{
  "mcpServers": {
    "linkedin": {
      "command": "npx",
      "args": ["mcp-remote", "http://YOUR_EC2_IP:3000/mcp", "--header", "Authorization: Bearer YOUR_MCP_SECRET_KEY"]
    }
  }
}
```

---

## Available Tools

| Tool | Description |
|------|-------------|
| `linkedin_get_profile` | Get your name, headline, email, photo |
| `linkedin_create_post` | Post text, articles, links |
| `linkedin_get_my_posts` | List your recent posts |
| `linkedin_delete_post` | Delete a post by URN |
| `linkedin_get_post_analytics` | Get likes/comments/shares |
| `linkedin_like_post` | Like any post |
| `linkedin_comment_on_post` | Comment on a post |
| `linkedin_get_connections` | List your network |
| `linkedin_search_people` | Search people by keywords |
| `linkedin_get_auth_status` | Check if authenticated |

---

## Example Agent Prompts

```
"Post on LinkedIn: Excited to share that I just deployed a full Kubernetes cluster
 with ArgoCD GitOps! #DevOps #Kubernetes"

"Get my last 5 LinkedIn posts"

"Delete my LinkedIn post with ID urn:li:ugcPost:1234567890"

"Comment 'Great insight!' on post urn:li:ugcPost:9876543210"

"Check my LinkedIn connection status"
```

---

## API Limitations (LinkedIn)

LinkedIn's public API is restricted. Here's what works vs what doesn't:

| Feature | Status | Notes |
|---------|--------|-------|
| Create posts | ✅ Works | Text, articles, links |
| Delete posts | ✅ Works | Your posts only |
| Like posts | ✅ Works | Any visible post |
| Comment | ✅ Works | Any visible post |
| Get your posts | ✅ Works | Via UGC Posts API |
| Get connections | ⚠️ Needs scope | `r_network_size` required |
| Search people | ❌ Restricted | Needs Partner API |
| Send messages | ❌ Restricted | Needs Partner Program |
| Image posts | 🔜 Possible | Needs media upload flow |

---

## Security

- The MCP endpoint is protected by `MCP_SECRET_KEY` — keep it secret
- OAuth tokens are stored locally in `data/tokens.json` — don't commit this file
- LinkedIn tokens expire in 60 days; refresh tokens last 365 days
- The server auto-refreshes tokens when < 5 days remain

---

## Open EC2 Port

```bash
# In AWS Security Group, allow inbound:
# Port 3000, TCP, from your agent's IP (or 0.0.0.0/0 for testing)
```

Or use nginx to proxy `yourdomain.com/mcp` → `localhost:3000/mcp`.
