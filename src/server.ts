import crypto from "node:crypto";
import fs from "node:fs";
import cors from "cors";
import "dotenv/config";
import express, { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_BASE_URL = requiredEnv("PUBLIC_BASE_URL").replace(/\/$/, "");
const ETSY_CLIENT_ID = requiredEnv("ETSY_CLIENT_ID");
const ETSY_API_KEYSTRING = process.env.ETSY_API_KEYSTRING ?? ETSY_CLIENT_ID;
const ETSY_SHARED_SECRET = requiredEnv("ETSY_SHARED_SECRET");
const ETSY_REDIRECT_URI = `${PUBLIC_BASE_URL}/oauth/etsy/callback`;
const ETSY_API_BASE = "https://api.etsy.com/v3/application";
const ETSY_TOKEN_URL = "https://api.etsy.com/v3/public/oauth/token";
const ETSY_AUTHORIZE_URL = "https://www.etsy.com/oauth/connect";
const SCOPES = [
  "shops_r",
  "shops_w",
  "listings_r",
  "listings_w",
  "transactions_r",
  "transactions_w",
].join(" ");

let store: JsonStore;

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.json({
    resource: PUBLIC_BASE_URL,
    authorization_servers: [PUBLIC_BASE_URL],
    bearer_methods_supported: ["header"],
  });
});

app.get("/.well-known/oauth-authorization-server", (_req, res) => {
  res.json({
    issuer: PUBLIC_BASE_URL,
    authorization_endpoint: `${PUBLIC_BASE_URL}/authorize`,
    token_endpoint: `${PUBLIC_BASE_URL}/token`,
    registration_endpoint: `${PUBLIC_BASE_URL}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  });
});

app.post("/register", (req, res) => {
  res.json({
    client_id: `agent-builder-${randomString(12)}`,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: req.body?.redirect_uris ?? [],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
});

app.get("/authorize", (req, res) => {
  const redirectUri = stringParam(req.query.redirect_uri);
  const openaiState = stringParam(req.query.state);
  const codeChallenge = stringParam(req.query.code_challenge);
  const codeChallengeMethod = stringParam(req.query.code_challenge_method);
  const clientId = stringParam(req.query.client_id);

  if (!redirectUri || !codeChallenge || codeChallengeMethod !== "S256") {
    res.status(400).send("Missing redirect_uri or PKCE S256 parameters.");
    return;
  }

  const state = randomString(32);
  const etsyVerifier = randomString(64);
  store.putOAuthState({
    state,
    openai_redirect_uri: redirectUri,
    openai_state: openaiState,
    openai_code_challenge: codeChallenge,
    openai_code_challenge_method: codeChallengeMethod,
    openai_client_id: clientId,
    etsy_code_verifier: etsyVerifier,
    created_at: Date.now(),
  });

  const url = new URL(ETSY_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", ETSY_CLIENT_ID);
  url.searchParams.set("redirect_uri", ETSY_REDIRECT_URI);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", pkceChallenge(etsyVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  res.redirect(url.toString());
});

app.get("/oauth/etsy/callback", async (req, res) => {
  const state = stringParam(req.query.state);
  const code = stringParam(req.query.code);
  const error = stringParam(req.query.error);
  if (error) {
    res.status(400).send(`Etsy OAuth failed: ${error}`);
    return;
  }
  if (!state || !code) {
    res.status(400).send("Missing Etsy OAuth state or code.");
    return;
  }

  const row = store.getOAuthState(state);
  if (!row) {
    res.status(400).send("Unknown or expired OAuth state.");
    return;
  }
  store.deleteOAuthState(state);

  const etsyToken = await exchangeEtsyCode(code, row.etsy_code_verifier);
  const mcpCode = randomString(48);
  store.putSession({
    mcp_code: mcpCode,
    etsy_access_token: etsyToken.access_token,
    etsy_refresh_token: etsyToken.refresh_token,
    etsy_expires_at: Date.now() + (etsyToken.expires_in - 60) * 1000,
    etsy_user_id: etsyToken.access_token.split(".")[0],
    created_at: Date.now(),
  });

  const redirect = new URL(row.openai_redirect_uri);
  redirect.searchParams.set("code", mcpCode);
  if (row.openai_state) redirect.searchParams.set("state", row.openai_state);
  res.redirect(redirect.toString());
});

app.post("/token", (req, res) => {
  const code = req.body?.code;
  const verifier = req.body?.code_verifier;
  if (req.body?.grant_type !== "authorization_code" || !code || !verifier) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }

  const row = store.getSessionByCode(code);
  if (!row) {
    res.status(400).json({ error: "invalid_grant" });
    return;
  }

  const token = randomString(48);
  store.updateSessionByCode(code, { mcp_access_token: token });
  res.json({
    access_token: token,
    token_type: "Bearer",
    expires_in: 60 * 60 * 24 * 30,
  });
});

app.post("/", async (req, res) => {
  const session = await requireSession(req, res);
  if (!session) return;

  const server = createMcpServer(session);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  res.on("close", () => {
    transport.close().catch(() => undefined);
    server.close().catch(() => undefined);
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

function createMcpServer(session: Session) {
  const server = new McpServer({
    name: "etsy-agent-builder-mcp",
    version: "1.0.0",
  });

  server.tool("etsy_get_my_shops", "Get shops owned by the connected Etsy user.", {}, async () => {
    const userId = await currentUserId(session);
    return json(await etsy(session, "GET", `/users/${userId}/shops`));
  });

  server.tool(
    "etsy_get_shop",
    "Get Etsy shop information.",
    { shop_id: z.number().int().positive() },
    async ({ shop_id }) => json(await etsy(session, "GET", `/shops/${shop_id}`)),
  );

  server.tool(
    "etsy_get_listings",
    "Get listings for a shop.",
    {
      shop_id: z.number().int().positive(),
      state: z.enum(["active", "draft", "expired", "inactive", "sold_out"]).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
    },
    async ({ shop_id, state, limit, offset }) => {
      const path = state === "active" ? `/shops/${shop_id}/listings/active` : `/shops/${shop_id}/listings`;
      return json(await etsy(session, "GET", path, { state, limit, offset }));
    },
  );

  server.tool(
    "etsy_create_listing",
    "Create a draft Etsy listing.",
    {
      shop_id: z.number().int().positive(),
      quantity: z.number().int().positive(),
      title: z.string().min(1).max(140),
      description: z.string().min(1),
      price: z.number().positive(),
      who_made: z.string(),
      when_made: z.string(),
      taxonomy_id: z.number().int().positive(),
      shipping_profile_id: z.number().int().positive(),
      type: z.string().default("physical"),
      tags: z.array(z.string()).optional(),
      materials: z.array(z.string()).optional(),
      shop_section_id: z.number().int().positive().optional(),
      return_policy_id: z.number().int().positive().optional(),
    },
    async ({ shop_id, ...body }) => json(await etsy(session, "POST", `/shops/${shop_id}/listings`, undefined, body)),
  );

  server.tool(
    "etsy_update_listing",
    "Update an Etsy listing.",
    {
      shop_id: z.number().int().positive(),
      listing_id: z.number().int().positive(),
      fields: z.record(z.string(), z.any()),
    },
    async ({ shop_id, listing_id, fields }) => {
      return json(await etsy(session, "PATCH", `/shops/${shop_id}/listings/${listing_id}`, undefined, fields));
    },
  );

  server.tool(
    "etsy_get_orders",
    "Get shop receipts/orders.",
    {
      shop_id: z.number().int().positive(),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
      was_paid: z.boolean().optional(),
      was_shipped: z.boolean().optional(),
      was_canceled: z.boolean().optional(),
      min_created: z.number().int().optional(),
      max_created: z.number().int().optional(),
    },
    async ({ shop_id, ...query }) => json(await etsy(session, "GET", `/shops/${shop_id}/receipts`, query)),
  );

  server.tool(
    "etsy_get_messages",
    "Not supported by Etsy Open API v3. Etsy's public OpenAPI spec does not expose conversations/messages endpoints.",
    { shop_id: z.number().int().positive() },
    async () => unsupportedMessages(),
  );

  server.tool(
    "etsy_reply_to_message",
    "Not supported by Etsy Open API v3. Etsy's public OpenAPI spec does not expose reply-to-message endpoints.",
    {
      shop_id: z.number().int().positive(),
      conversation_id: z.string(),
      message: z.string().min(1),
    },
    async () => unsupportedMessages(),
  );

  return server;
}

async function etsy(
  session: Session,
  method: string,
  path: string,
  query?: Record<string, unknown>,
  body?: Record<string, unknown>,
) {
  const accessToken = await validEtsyAccessToken(session);
  const url = new URL(`${ETSY_API_BASE}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    method,
    headers: {
      "authorization": `Bearer ${accessToken}`,
      "x-api-key": `${ETSY_API_KEYSTRING}:${ETSY_SHARED_SECRET}`,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  const data = text ? safeJson(text) : null;
  if (!response.ok) {
    throw new Error(JSON.stringify({ status: response.status, error: data ?? text }));
  }
  return data;
}

async function currentUserId(session: Session) {
  const token = await validEtsyAccessToken(session);
  return token.split(".")[0];
}

async function validEtsyAccessToken(session: Session) {
  if (session.etsy_expires_at > Date.now()) return session.etsy_access_token;
  const refreshed = await refreshEtsyToken(session.etsy_refresh_token);
  const expiresAt = Date.now() + (refreshed.expires_in - 60) * 1000;
  store.updateSessionByAccessToken(session.mcp_access_token, {
    etsy_access_token: refreshed.access_token,
    etsy_refresh_token: refreshed.refresh_token,
    etsy_expires_at: expiresAt,
  });
  session.etsy_access_token = refreshed.access_token;
  session.etsy_refresh_token = refreshed.refresh_token;
  session.etsy_expires_at = expiresAt;
  return refreshed.access_token;
}

async function exchangeEtsyCode(code: string, verifier: string): Promise<EtsyToken> {
  return etsyTokenRequest({
    grant_type: "authorization_code",
    client_id: ETSY_CLIENT_ID,
    redirect_uri: ETSY_REDIRECT_URI,
    code,
    code_verifier: verifier,
  });
}

async function refreshEtsyToken(refreshToken: string): Promise<EtsyToken> {
  return etsyTokenRequest({
    grant_type: "refresh_token",
    client_id: ETSY_CLIENT_ID,
    refresh_token: refreshToken,
  });
}

async function etsyTokenRequest(params: Record<string, string>): Promise<EtsyToken> {
  const response = await fetch(ETSY_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const data = await response.json() as EtsyToken | { error: string };
  if (!response.ok) throw new Error(`Etsy token request failed: ${JSON.stringify(data)}`);
  return data as EtsyToken;
}

async function requireSession(req: Request, res: Response) {
  const auth = req.header("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
  if (!token) {
    res.status(401)
      .set("WWW-Authenticate", `Bearer resource_metadata="${PUBLIC_BASE_URL}/.well-known/oauth-protected-resource"`)
      .json({ error: "invalid_token", error_description: "Missing Authorization header" });
    return null;
  }
  const row = store.getSessionByAccessToken(token);
  if (!row) {
    res.status(401).json({ error: "invalid_token", error_description: "Invalid token" });
    return null;
  }
  return row;
}

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function unsupportedMessages() {
  return json({
    error: "unsupported_by_etsy_open_api_v3",
    message: "Etsy's official OpenAPI v3 spec does not expose conversations/messages or reply endpoints. This server does not fake message access.",
  });
}

function safeJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function stringParam(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function randomString(bytes: number) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function pkceChallenge(verifier: string) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

class JsonStore {
  private data: StoreData;

  constructor(private readonly filePath: string) {
    this.data = this.load();
  }

  getOAuthState(state: string) {
    this.pruneOldStates();
    return this.data.oauth_states[state];
  }

  putOAuthState(state: OAuthState) {
    this.data.oauth_states[state.state] = state;
    this.save();
  }

  deleteOAuthState(state: string) {
    delete this.data.oauth_states[state];
    this.save();
  }

  getSessionByCode(code: string) {
    return this.data.sessions.find((session) => session.mcp_code === code);
  }

  getSessionByAccessToken(token: string) {
    return this.data.sessions.find((session) => session.mcp_access_token === token);
  }

  putSession(session: Session) {
    this.data.sessions = this.data.sessions.filter((item) => item.mcp_code !== session.mcp_code);
    this.data.sessions.push(session);
    this.save();
  }

  updateSessionByCode(code: string, patch: Partial<Session>) {
    const session = this.getSessionByCode(code);
    if (session) {
      Object.assign(session, patch);
      this.save();
    }
  }

  updateSessionByAccessToken(token: string | undefined, patch: Partial<Session>) {
    if (!token) return;
    const session = this.getSessionByAccessToken(token);
    if (session) {
      Object.assign(session, patch);
      this.save();
    }
  }

  private pruneOldStates() {
    const cutoff = Date.now() - 15 * 60 * 1000;
    let changed = false;
    for (const [state, value] of Object.entries(this.data.oauth_states)) {
      if (value.created_at < cutoff) {
        delete this.data.oauth_states[state];
        changed = true;
      }
    }
    if (changed) this.save();
  }

  private load(): StoreData {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as StoreData;
    } catch {
      return { oauth_states: {}, sessions: [] };
    }
  }

  private save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }
}

type StoreData = {
  oauth_states: Record<string, OAuthState>;
  sessions: Session[];
};

type OAuthState = {
  state: string;
  openai_redirect_uri: string;
  openai_state?: string;
  openai_code_challenge: string;
  openai_code_challenge_method: string;
  openai_client_id?: string;
  etsy_code_verifier: string;
  created_at: number;
};

type Session = {
  mcp_code: string;
  mcp_access_token?: string;
  etsy_access_token: string;
  etsy_refresh_token: string;
  etsy_expires_at: number;
  etsy_user_id?: string;
  created_at: number;
};

type EtsyToken = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
};

store = new JsonStore(process.env.DATA_PATH ?? "etsy-mcp-store.json");

app.listen(PORT, () => {
  console.log(`Etsy MCP server listening on ${PUBLIC_BASE_URL}`);
});
