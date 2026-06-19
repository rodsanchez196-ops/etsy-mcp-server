# Etsy MCP Server for OpenAI Agent Builder

This is a deployable remote MCP server that lets OpenAI Agent Builder connect directly to Etsy using Etsy OAuth 2.0 with PKCE.

## Tools

- `etsy_get_my_shops`
- `etsy_get_shop`
- `etsy_get_listings`
- `etsy_create_listing`
- `etsy_update_listing`
- `etsy_get_orders`
- `etsy_get_messages`
- `etsy_reply_to_message`

Important: Etsy's official OpenAPI v3 spec does not expose conversations/messages or reply endpoints. The two message tools are registered so Agent Builder can see the requested surface, but they return `unsupported_by_etsy_open_api_v3` instead of faking unsupported Etsy calls.

## Environment Variables

```bash
PUBLIC_BASE_URL=https://your-deployed-etsy-mcp.example.com
PORT=3000
DATA_PATH=etsy-mcp-store.json
ETSY_CLIENT_ID=your_etsy_keystring
ETSY_API_KEYSTRING=your_etsy_keystring
ETSY_SHARED_SECRET=your_etsy_shared_secret
```

`ETSY_CLIENT_ID` and `ETSY_API_KEYSTRING` are normally the same Etsy keystring.

## Etsy Developer Portal Setup

1. Go to `https://www.etsy.com/developers/your-apps`.
2. Create or open your Etsy app.
3. Copy the app keystring into `ETSY_CLIENT_ID` and `ETSY_API_KEYSTRING`.
4. Copy the shared secret into `ETSY_SHARED_SECRET`.
5. Add this exact OAuth redirect URI:

```text
https://your-deployed-etsy-mcp.example.com/oauth/etsy/callback
```

6. Replace the host with the real deployed host used in `PUBLIC_BASE_URL`.
7. The URI must be HTTPS and must match exactly. No trailing slash.

The server requests these Etsy scopes:

```text
shops_r shops_w listings_r listings_w transactions_r transactions_w
```

## Local Development

```bash
npm install
cp .env.example .env
npm run dev
```

For local Agent Builder testing, expose the server with an HTTPS tunnel and set:

```bash
PUBLIC_BASE_URL=https://your-tunnel-host
```

Then add this redirect URI to Etsy:

```text
https://your-tunnel-host/oauth/etsy/callback
```

## Deployment

Deploy to any Node host that supports persistent storage for the JSON token store, such as Render, Railway, Fly.io, or a VPS.

Build command:

```bash
npm install && npm run build
```

Start command:

```bash
npm start
```

Set all environment variables in the hosting provider.

If your platform has ephemeral disk, set `DATA_PATH` to a mounted persistent volume path or replace the JSON store with Postgres/Redis before production use.

## OpenAI Agent Builder Setup

In Agent Builder, add a remote MCP connection:

| Field | Value |
|---|---|
| MCP Server URL | `https://your-deployed-etsy-mcp.example.com` |
| Authentication | OAuth |
| Headers | None |

Do not use:

```text
https://your-deployed-etsy-mcp.example.com/mcp
https://your-deployed-etsy-mcp.example.com/sse
```

When Agent Builder connects, it discovers:

```text
https://your-deployed-etsy-mcp.example.com/.well-known/oauth-protected-resource
https://your-deployed-etsy-mcp.example.com/.well-known/oauth-authorization-server
```

The OAuth flow then sends Employee #1 to Etsy, Employee #1 approves the Etsy app, and Agent Builder receives an MCP bearer token for subsequent tool calls.

## Etsy API Routes Used

The server calls Etsy Open API v3:

```text
GET   /v3/application/users/{user_id}/shops
GET   /v3/application/shops/{shop_id}
GET   /v3/application/shops/{shop_id}/listings
GET   /v3/application/shops/{shop_id}/listings/active
POST  /v3/application/shops/{shop_id}/listings
PATCH /v3/application/shops/{shop_id}/listings/{listing_id}
GET   /v3/application/shops/{shop_id}/receipts
```

Every Etsy API call sends:

```text
Authorization: Bearer <etsy_oauth_access_token>
x-api-key: <keystring>:<shared_secret>
```
