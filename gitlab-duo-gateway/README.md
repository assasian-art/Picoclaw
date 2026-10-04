# GitLab Duo Gateway

Render-hosted OAuth bridge for GitLab Duo third-party-agent direct access.

Flow:
1. GitLab OAuth application grants the user an OAuth token.
2. The gateway calls POST /api/v4/ai/third_party_agents/direct_access.
3. GitLab returns a short-lived direct-access token and gateway headers.
4. The gateway forwards Anthropic Messages API traffic to https://cloud.gitlab.com/ai/v1/proxy/anthropic.
5. Claude Code can use the gateway with ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN.

Render environment variables:
- GITLAB_CLIENT_ID
- GITLAB_CLIENT_SECRET
- GATEWAY_SECRET
- PUBLIC_URL
- GITLAB_BASE_URL (optional, defaults to https://gitlab.com)
- AI_GATEWAY_URL (optional, defaults to https://cloud.gitlab.com)

The OAuth application should use scope: api.

Claude Code:
export ANTHROPIC_BASE_URL="https://YOUR-RENDER-URL"
export ANTHROPIC_AUTH_TOKEN="YOUR-GENERATED-CREDENTIAL"
claude

The first version keeps OAuth sessions in memory. Render restarts/sleep can require reconnecting GitLab and generating a new credential.
