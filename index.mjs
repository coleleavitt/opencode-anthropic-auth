import { generatePKCE } from "@openauthjs/openauth/pkce";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { access, readFile, writeFile, chmod, readdir } from "fs/promises";
import { join, basename } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

const TOOL_PREFIX = "mcp_";

// ============================================================================
// Usage Tracking - Read from OpenCode's Storage
// ============================================================================

const METRICS_HOST = process.env.ANTHROPIC_USAGE_HOST || "localhost";
const METRICS_PORT = parseInt(process.env.ANTHROPIC_USAGE_PORT || "9091", 10);
const OPENCODE_STORAGE = join(process.env.HOME, ".local/share/opencode/storage");

// Anthropic pricing per 1M tokens (latest pricing as of Jan 2025)
// https://www.anthropic.com/pricing
const PRICING = {
  "claude-opus-4-5": { input: 5, output: 25, cacheRead: 0.50, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  "claude-opus-4": { input: 15, output: 75, cacheRead: 1.50, cacheWrite5m: 18.75, cacheWrite1h: 30 },
  "claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.30, cacheWrite5m: 3.75, cacheWrite1h: 6 },
  "claude-sonnet-4": { input: 3, output: 15, cacheRead: 0.30, cacheWrite5m: 3.75, cacheWrite1h: 6 },
  "claude-sonnet-3-5": { input: 3, output: 15, cacheRead: 0.30, cacheWrite5m: 3.75, cacheWrite1h: 6 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.10, cacheWrite5m: 1.25, cacheWrite1h: 2 },
  "claude-haiku-3-5": { input: 0.80, output: 4, cacheRead: 0.08, cacheWrite5m: 1, cacheWrite1h: 1.6 },
  "claude-haiku-3": { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite5m: 0.30, cacheWrite1h: 0.50 },
};

let metricsServer = null;

function calculateCost(model, inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0) {
  const pricing = PRICING[model] || PRICING["claude-sonnet-4-5"];
  return (
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output +
    (cacheReadTokens / 1_000_000) * pricing.cacheRead +
    (cacheWriteTokens / 1_000_000) * pricing.cacheWrite5m
  );
}

async function* walkDir(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkDir(path);
    } else {
      yield path;
    }
  }
}

async function getUsageFromStorage() {
  const messageDir = join(OPENCODE_STORAGE, "message");
  if (!existsSync(messageDir)) return null;

  const usage = {
    byAccount: new Map(),
    overall: {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheTokens: 0,
      cost: 0,
    },
  };

  for await (const filePath of walkDir(messageDir)) {
    if (!filePath.endsWith(".json")) continue;
    
    try {
      const content = await readFile(filePath, "utf-8");
      const msg = JSON.parse(content);
      
      // Only count assistant messages with cost data
      if (msg.role !== "assistant") continue;
      if (typeof msg.cost !== "number") continue;
      
      const model = msg.modelID || "unknown";
      const provider = msg.providerID || "unknown";
      
      // Skip non-Anthropic providers
      if (provider !== "anthropic") continue;
      
      const inputTokens = msg.tokens?.input || 0;
      const outputTokens = (msg.tokens?.output || 0) + (msg.tokens?.reasoning || 0);
      const cacheRead = msg.tokens?.cache?.read || 0;
      const cacheWrite = msg.tokens?.cache?.write || 0;
      const cost = msg.cost || calculateCost(model, inputTokens, outputTokens, cacheRead, cacheWrite);
      
      // Use account name from session metadata if available
      const sessionId = msg.sessionID;
      const accountKey = msg.mode || "anthropic";
      
      if (!usage.byAccount.has(accountKey)) {
        usage.byAccount.set(accountKey, {
          accountId: accountKey,
          accountName: accountKey,
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheTokens: 0,
          cost: 0,
        });
      }
      
      const accountUsage = usage.byAccount.get(accountKey);
      accountUsage.requests++;
      accountUsage.inputTokens += inputTokens;
      accountUsage.outputTokens += outputTokens;
      accountUsage.cacheTokens += cacheRead + cacheWrite;
      accountUsage.cost += cost;
      
      usage.overall.requests++;
      usage.overall.inputTokens += inputTokens;
      usage.overall.outputTokens += outputTokens;
      usage.overall.cacheTokens += cacheRead + cacheWrite;
      usage.overall.cost += cost;
    } catch (e) {
      // Skip malformed files
    }
  }
  
  return usage;
}

function generateMetrics(usage) {
  const lines = ["# Anthropic API Usage Metrics", ""];
  
  // By account
  for (const [key, row] of usage.byAccount) {
    const safeLabel = (row.accountName || row.accountId || "unknown").replace(/"/g, '\\"');
    lines.push(`# Account: ${safeLabel}`);
    lines.push(`anthropic_requests_total{account="${safeLabel}",account_id="${row.accountId}"} ${row.requests}`);
    lines.push(`anthropic_tokens_total{account="${safeLabel}",account_id="${row.accountId}",type="input"} ${row.inputTokens}`);
    lines.push(`anthropic_tokens_total{account="${safeLabel}",account_id="${row.accountId}",type="output"} ${row.outputTokens}`);
    lines.push(`anthropic_tokens_total{account="${safeLabel}",account_id="${row.accountId}",type="cache"} ${row.cacheTokens}`);
    lines.push(`anthropic_cost_usd_total{account="${safeLabel}",account_id="${row.accountId}"} ${row.cost.toFixed(6)}`);
    lines.push("");
  }
  
  // Overall
  lines.push("# Overall totals");
  lines.push(`anthropic_requests_total{account="overall",account_id=""} ${usage.overall.requests}`);
  lines.push(`anthropic_tokens_total{account="overall",account_id="",type="input"} ${usage.overall.inputTokens}`);
  lines.push(`anthropic_tokens_total{account="overall",account_id="",type="output"} ${usage.overall.outputTokens}`);
  lines.push(`anthropic_tokens_total{account="overall",account_id="",type="cache"} ${usage.overall.cacheTokens}`);
  lines.push(`anthropic_cost_usd_total{account="overall",account_id=""} ${usage.overall.cost.toFixed(6)}`);
  
  return lines.join("\n");
}

function startMetricsServer() {
  if (metricsServer) return;
  
  metricsServer = Bun.serve({
    hostname: METRICS_HOST,
    port: METRICS_PORT,
    fetch: async (request) => {
      const url = new URL(request.url);
      
      if (url.pathname === "/metrics") {
        const usage = await getUsageFromStorage();
        if (!usage) {
          return new Response("# No usage data found\n", { headers: { "Content-Type": "text/plain" } });
        }
        return new Response(generateMetrics(usage), {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
      
      if (url.pathname === "/health") {
        return new Response("OK", { status: 200 });
      }
      
      return new Response("Not Found", { status: 404 });
    },
  });
  
  console.log(`[anthropic-usage] Metrics server running at http://${METRICS_HOST}:${METRICS_PORT}/metrics`);
}

function printUsageStats() {
  console.log("Anthropic API Usage Tracker");
  console.log("============================\n");
  
  // This will be called from CLI with --usage flag
  getUsageFromStorage().then((usage) => {
    if (!usage) {
      console.log("No usage data found.");
      return;
    }
    
    console.log("Usage by Account:\n");
    for (const [key, row] of usage.byAccount) {
      console.log(`${row.accountName} (${row.accountId})`);
      console.log(`  Requests: ${row.requests}`);
      console.log(`  Input tokens: ${row.inputTokens.toLocaleString()}`);
      console.log(`  Output tokens: ${row.outputTokens.toLocaleString()}`);
      console.log(`  Total cost: $${row.cost.toFixed(4)}`);
      console.log("");
    }
    
    console.log("Overall:");
    console.log(`  Total requests: ${usage.overall.requests}`);
    console.log(`  Total input tokens: ${usage.overall.inputTokens.toLocaleString()}`);
    console.log(`  Total output tokens: ${usage.overall.outputTokens.toLocaleString()}`);
    console.log(`  Total cost: $${usage.overall.cost.toFixed(4)}`);
  });
}

// ============================================================================
// Storage Layer - File locking and atomic writes
// ============================================================================

const STORAGE_PATH = join(process.env.HOME, ".config/opencode/anthropic-accounts.json");

async function acquireLock(lockPath, timeout = 5000) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    try {
      await access(lockPath);
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch {
      // Lock doesn't exist, create it
      try {
        await writeFile(lockPath, `${process.pid}`);
        return true;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
  return false;
}

async function releaseLock(lockPath) {
  try {
    await access(lockPath);
    await writeFile(lockPath, "").catch(() => {});
  } catch {
    // Lock doesn't exist
  }
}

async function loadAccounts() {
  if (!existsSync(STORAGE_PATH)) {
    return { version: 1, accounts: [], activeIndex: 0 };
  }

  const content = readFileSync(STORAGE_PATH, "utf-8");
  return JSON.parse(content);
}

async function saveAccounts(data) {
  const lockPath = `${STORAGE_PATH}.lock`;
  await acquireLock(lockPath);

  try {
    const tempPath = `${STORAGE_PATH}.tmp.${Date.now()}`;
    writeFileSync(tempPath, JSON.stringify(data, null, 2));
    // Atomic rename
    if (existsSync(STORAGE_PATH)) {
      writeFileSync(STORAGE_PATH, readFileSync(tempPath, "utf-8"));
    } else {
      writeFileSync(STORAGE_PATH, readFileSync(tempPath, "utf-8"));
    }
  } finally {
    await releaseLock(lockPath);
  }
}

// ============================================================================
// Account Management
// ============================================================================

class AccountManager {
  constructor(data) {
    this.data = data;
  }

  getAccounts() {
    return this.data.accounts || [];
  }

  getAccountCount() {
    return this.getAccounts().length;
  }

  getCurrentOrNextAvailable() {
    const accounts = this.getAccounts();
    if (accounts.length === 0) return null;

    const now = Date.now();
    const startIndex = this.data.activeIndex || 0;

    // Try from active index forward
    for (let i = 0; i < accounts.length; i++) {
      const idx = (startIndex + i) % accounts.length;
      const account = accounts[idx];
      if (!account.rateLimitResetTime || account.rateLimitResetTime < now) {
        return account;
      }
    }

    // All are rate limited, return the one with earliest reset
    let earliest = accounts[0];
    for (const account of accounts) {
      if (!earliest.rateLimitResetTime || (account.rateLimitResetTime && account.rateLimitResetTime < earliest.rateLimitResetTime)) {
        earliest = account;
      }
    }
    return earliest;
  }

  getActiveAccount() {
    const accounts = this.getAccounts();
    const index = this.data.activeIndex || 0;
    return accounts[index] || null;
  }

  isTokenExpired(account) {
    if (!account.expiresAt) return true;
    const bufferMs = 5 * 60 * 1000; // 5 minute buffer
    return !account.expiresAt || Date.now() >= account.expiresAt - bufferMs;
  }

  addAccount({ name, refreshToken, accessToken, expiresAt, email }) {
    this.data.accounts.push({
      name,
      refreshToken,
      accessToken,
      expiresAt,
      email,
      addedAt: Date.now(),
      lastUsed: 0,
      rateLimitResetTime: 0,
    });
    return this;
  }

  setActiveAccount(nameOrIndex) {
    if (typeof nameOrIndex === "number") {
      this.data.activeIndex = nameOrIndex;
    } else {
      const idx = this.data.accounts.findIndex((a) => a.name === nameOrIndex);
      if (idx >= 0) {
        this.data.activeIndex = idx;
      }
    }
    return this;
  }

  updateTokens(account, accessToken, expiresAt) {
    account.accessToken = accessToken;
    account.expiresAt = expiresAt;
    return this;
  }

  markRateLimited(account, retryAfterMs) {
    account.rateLimitResetTime = Date.now() + retryAfterMs;
    return this;
  }

  static async loadFromDisk() {
    const data = await loadAccounts();
    return new AccountManager(data);
  }

  async saveToDisk() {
    await saveAccounts(this.data);
    return this;
  }
}

// ============================================================================
// OAuth Functions
// ============================================================================

async function authorize(mode) {
  const pkce = await generatePKCE();

  const url = new URL(
    `https://${mode === "console" ? "console.anthropic.com" : "claude.ai"}/oauth/authorize`,
  );
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set(
    "redirect_uri",
    "https://console.anthropic.com/oauth/code/callback",
  );
  url.searchParams.set(
    "scope",
    "org:create_api_key user:profile user:inference",
  );
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", pkce.verifier);
  return {
    url: url.toString(),
    verifier: pkce.verifier,
  };
}

async function exchange(code, verifier) {
  const splits = code.split("#");
  const result = await fetch("https://console.anthropic.com/v1/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      code: splits[0],
      state: splits[1],
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: "https://console.anthropic.com/oauth/code/callback",
      code_verifier: verifier,
    }),
  });
  if (!result.ok) {
    return { type: "failed" };
  }
  const json = await result.json();
  return {
    type: "success",
    refresh: json.refresh_token,
    access: json.access_token,
    expires: Date.now() + json.expires_in * 1000,
  };
}

async function refreshAccessToken(refreshToken) {
  const response = await fetch("https://console.anthropic.com/v1/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });

  if (!response.ok) {
    return { type: "failed" };
  }

  const json = await response.json();
  return {
    type: "success",
    refresh: json.refresh_token,
    access: json.access_token,
    expires: Date.now() + json.expires_in * 1000,
  };
}

/**
 * Fetch complete user profile from Anthropic API
 * @param {string} accessToken
 * @returns {Object|null} Complete profile or null on error
 */
async function fetchUserProfile(accessToken) {
  try {
    const response = await fetch("https://api.anthropic.com/api/oauth/profile", {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      return null;
    }

    const profile = await response.json();
    const account = profile.account || {};
    const organization = profile.organization || {};

    // Determine plan type from boolean flags
    let plan = "unknown";
    if (account.has_claude_max) plan = "claude_max";
    else if (account.has_claude_pro) plan = "claude_pro";

    return {
      // Account fields
      uuid: account.uuid || null,
      fullName: account.full_name || null,
      displayName: account.display_name || null,
      email: account.email || null,
      hasClaudeMax: account.has_claude_max || false,
      hasClaudePro: account.has_claude_pro || false,

      // Plan info
      plan,

      // Organization fields
      organizationUuid: organization.uuid || null,
      organizationName: organization.name || null,
      organizationType: organization.organization_type || null,
      billingType: organization.billing_type || null,
      rateLimitTier: organization.rate_limit_tier || null,
      hasExtraUsageEnabled: organization.has_extra_usage_enabled || false,
    };
  } catch (error) {
    return null;
  }
}

// ============================================================================
// Plugin
// ============================================================================

export async function AnthropicAuthPlugin({ client }) {
  const accountManager = await AccountManager.loadFromDisk();
  let hasShownAccountToast = false;
  
  // Start metrics server
  startMetricsServer();

  return {
    auth: {
      provider: "anthropic",
      async loader(getAuth, provider) {
        const account = accountManager.getCurrentOrNextAvailable();

        if (!account) {
          return {};
        }

        // Zero out cost for max plan
        for (const model of Object.values(provider.models)) {
          model.cost = {
            input: 0,
            output: 0,
            cache: {
              read: 0,
              write: 0,
            },
          };
        }

        return {
          apiKey: "",
          async fetch(input, init) {
            const currentAccount = accountManager.getCurrentOrNextAvailable();
            if (!currentAccount) {
              throw new Error("No Anthropic accounts available");
            }

            // Show account indicator toast on first request
            if (!hasShownAccountToast) {
              await client?.tui?.showToast({
                body: {
                  title: "Anthropic",
                  message: `Using account: ${currentAccount.name}`,
                  variant: "info",
                },
              }).catch(() => {});
              hasShownAccountToast = true;
            }

            // Update last used
            currentAccount.lastUsed = Date.now();

            // Check if token needs refresh
            if (!currentAccount.accessToken || accountManager.isTokenExpired(currentAccount)) {
              const result = await refreshAccessToken(currentAccount.refreshToken);

              if (result.type === "failed") {
                await client?.tui?.showToast({
                  body: {
                    title: "Token Refresh Failed",
                    message: `Could not refresh token for ${currentAccount.name}`,
                    variant: "error",
                  },
                }).catch(() => {});
                throw new Error(`Token refresh failed for account: ${currentAccount.name}`);
              }

              accountManager.updateTokens(currentAccount, result.access, result.expires);
              await accountManager.saveToDisk();

              await client?.tui?.showToast({
                body: {
                  title: "Token Refreshed",
                  message: `Using account: ${currentAccount.name}`,
                  variant: "info",
                },
              }).catch(() => {});
            }

            const requestInit = init ?? {};

            const requestHeaders = new Headers();
            if (input instanceof Request) {
              input.headers.forEach((value, key) => {
                requestHeaders.set(key, value);
              });
            }
            if (requestInit.headers) {
              if (requestInit.headers instanceof Headers) {
                requestInit.headers.forEach((value, key) => {
                  requestHeaders.set(key, value);
                });
              } else if (Array.isArray(requestInit.headers)) {
                for (const [key, value] of requestInit.headers) {
                  if (typeof value !== "undefined") {
                    requestHeaders.set(key, String(value));
                  }
                }
              } else {
                for (const [key, value] of Object.entries(requestInit.headers)) {
                  if (typeof value !== "undefined") {
                    requestHeaders.set(key, String(value));
                  }
                }
              }
            }

            const incomingBeta = requestHeaders.get("anthropic-beta") || "";
            const incomingBetasList = incomingBeta
              .split(",")
              .map((b) => b.trim())
              .filter(Boolean);

            const includeClaudeCode = incomingBetasList.includes(
              "claude-code-20250219",
            );

            const mergedBetas = [
              "oauth-2025-04-20",
              "interleaved-thinking-2025-05-14",
              ...(includeClaudeCode ? ["claude-code-20250219"] : []),
            ].join(",");

            requestHeaders.set("authorization", `Bearer ${currentAccount.accessToken}`);
            requestHeaders.set("anthropic-beta", mergedBetas);
            requestHeaders.set(
              "user-agent",
              "claude-cli/2.1.2 (external, cli)",
            );
            requestHeaders.delete("x-api-key");

            let body = requestInit.body;
            if (body && typeof body === "string") {
              try {
                const parsed = JSON.parse(body);

                // Sanitize system prompt - server blocks "OpenCode" string
                if (parsed.system && Array.isArray(parsed.system)) {
                  parsed.system = parsed.system.map((item) => {
                    if (item.type === "text" && item.text) {
                      return {
                        ...item,
                        text: item.text
                          .replace(/OpenCode/g, "Claude Code")
                          .replace(/opencode/gi, "Claude"),
                      };
                    }
                    return item;
                  });
                }

                // Add prefix to tools definitions
                if (parsed.tools && Array.isArray(parsed.tools)) {
                  parsed.tools = parsed.tools.map((tool) => ({
                    ...tool,
                    name: tool.name ? `${TOOL_PREFIX}${tool.name}` : tool.name,
                  }));
                }
                // Add prefix to tool_use blocks in messages
                if (parsed.messages && Array.isArray(parsed.messages)) {
                  parsed.messages = parsed.messages.map((msg) => {
                    if (msg.content && Array.isArray(msg.content)) {
                      msg.content = msg.content.map((block) => {
                        if (block.type === "tool_use" && block.name) {
                          return { ...block, name: `${TOOL_PREFIX}${block.name}` };
                        }
                        return block;
                      });
                    }
                    return msg;
                  });
                }
                body = JSON.stringify(parsed);
              } catch (e) {
                // ignore parse errors
              }
            }

            let requestInput = input;
            let requestUrl = null;
            try {
              if (typeof input === "string" || input instanceof URL) {
                requestUrl = new URL(input.toString());
              } else if (input instanceof Request) {
                requestUrl = new URL(input.url);
              }
            } catch {
              requestUrl = null;
            }

            if (
              requestUrl &&
              requestUrl.pathname === "/v1/messages" &&
              !requestUrl.searchParams.has("beta")
            ) {
              requestUrl.searchParams.set("beta", "true");
              requestInput =
                input instanceof Request
                  ? new Request(requestUrl.toString(), input)
                  : requestUrl;
            }

            const response = await fetch(requestInput, {
              ...requestInit,
              body,
              headers: requestHeaders,
            });

            const durationMs = Date.now() - (globalThis._requestStartTime || Date.now());

            // Record usage from response headers
            const inputTokens = parseInt(response.headers?.get?.("x-anthropic-input-tokens") || "0", 10);
            const outputTokens = parseInt(response.headers?.get?.("x-anthropic-output-tokens") || "0", 10);
            const cacheTokens = parseInt(response.headers?.get?.("x-anthropic-cache-tokens") || "0", 10);
            
            if (inputTokens > 0 || outputTokens > 0) {
              // Extract model from request body
              let model = "unknown";
              try {
                if (body && typeof body === "string") {
                  const parsed = JSON.parse(body);
                  model = parsed.model || "unknown";
                }
              } catch {
                // ignore parse errors
              }
            }

            // Handle rate limiting
            if (response.status === 429) {
              const retryAfter = response.headers.get("retry-after");
              const retryAfterMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 60000;

              accountManager.markRateLimited(currentAccount, retryAfterMs);
              await accountManager.saveToDisk();

              const nextAccount = accountManager.getCurrentOrNextAvailable();
              if (nextAccount && nextAccount.name !== currentAccount.name) {
                await client?.tui?.showToast({
                  body: {
                    title: "Rate Limited",
                    message: `Switching to ${nextAccount.name}`,
                    variant: "warning",
                  },
                }).catch(() => {});
              }
            }

            // Transform streaming response to rename tools back
            if (response.body) {
              const reader = response.body.getReader();
              const decoder = new TextDecoder();
              const encoder = new TextEncoder();

              const stream = new ReadableStream({
                async pull(controller) {
                  const { done, value } = await reader.read();
                  if (done) {
                    controller.close();
                    return;
                  }

                  let text = decoder.decode(value, { stream: true });
                  text = text.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, '"name": "$1"');
                  controller.enqueue(encoder.encode(text));
                },
              });

              return new Response(stream, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
              });
            }

            return response;
          },
        };
      },
      methods: [
        {
          label: "Claude Max (Multi-account)",
          type: "oauth",
          authorize: async () => {
            const existingAccounts = accountManager.getAccounts();

            // Generate account name automatically
            const nextIndex = existingAccounts.length + 1;
            const accountName = `account${nextIndex}`;

            const { url, verifier } = await authorize("max");

            return {
              url: url,
              instructions: `Paste the authorization code for "${accountName}":\n\nIf you want to add more accounts, run this command again after completing this one.\n`,
              method: "code",
              callback: async (code) => {
                const credentials = await exchange(code, verifier);
                if (credentials.type === "failed") {
                  await client?.tui?.showToast({
                    body: {
                      title: "Authentication Failed",
                      message: "Could not add account. Please try again.",
                      variant: "error",
                    },
                  }).catch(() => {});
                  return { type: "failed" };
                }

                // Fetch user profile to get email and name
                const profile = await fetchUserProfile(credentials.access);
                const displayName = profile?.email || profile?.fullName || accountName;

                accountManager.addAccount({
                  name: displayName,  // Use email as account name
                  refreshToken: credentials.refresh,
                  accessToken: credentials.access,
                  expiresAt: credentials.expires,

                  // All profile fields
                  uuid: profile?.uuid || null,
                  fullName: profile?.fullName || null,
                  displayName: profile?.displayName || null,
                  email: profile?.email || null,
                  hasClaudeMax: profile?.hasClaudeMax || false,
                  hasClaudePro: profile?.hasClaudePro || false,
                  plan: profile?.plan || "unknown",
                  organizationUuid: profile?.organizationUuid || null,
                  organizationName: profile?.organizationName || null,
                  organizationType: profile?.organizationType || null,
                  billingType: profile?.billingType || null,
                  rateLimitTier: profile?.rateLimitTier || null,
                  hasExtraUsageEnabled: profile?.hasExtraUsageEnabled || false,
                });
                await accountManager.saveToDisk();

                await client?.tui?.showToast({
                  body: {
                    title: "Account Added",
                    message: `"${displayName}" has been configured. Run auth login again to add more.`,
                    variant: "success",
                  },
                }).catch(() => {});

                return { type: "success" };
              },
            };
          },
        },
        {
          label: "Create an API Key",
          type: "oauth",
          authorize: async () => {
            const { url, verifier } = await authorize("console");
            return {
              url: url,
              instructions: "Paste the authorization code here: ",
              method: "code",
              callback: async (code) => {
                const credentials = await exchange(code, verifier);
                if (credentials.type === "failed") return credentials;
                const result = await fetch(
                  `https://api.anthropic.com/api/oauth/claude_cli/create_api_key`,
                  {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      authorization: `Bearer ${credentials.access}`,
                    },
                  },
                ).then((r) => r.json());
                return { type: "success", key: result.raw_key };
              },
            };
          },
        },
        {
          provider: "anthropic",
          label: "Manually enter API Key",
          type: "api",
        },
        {
          label: "Switch Account",
          type: "oauth",
          prompts: [
            {
              type: "select",
              key: "account",
              message: "Select account to use:",
              options: (() => {
                const accounts = accountManager.getAccounts();
                return accounts.map((acc, i) => ({
                  label: acc.fullName ? `${acc.fullName} (${acc.name})` : acc.name,
                  value: acc.name,
                }));
              })(),
            },
          ],
          authorize: async (inputs) => {
            const accounts = accountManager.getAccounts();
            const selectedAccount = accounts.find((a) => a.name === inputs.account);

            if (selectedAccount) {
              accountManager.setActiveAccount(inputs.account);
              await accountManager.saveToDisk();

              await client?.tui?.showToast({
                body: {
                  title: "Account Switched",
                  message: `Now using account: ${selectedAccount.name}`,
                  variant: "success",
                },
              }).catch(() => {});
            }

            return {
              url: "",
              instructions: "",
              method: "auto",  // Changed from "code" - won't prompt for code
              callback: async () => {
                return { type: "success" };
              },
            };
          },
        },
      ],
    },
  };
}

// ============================================================================
// CLI for viewing usage stats
// ============================================================================

if (process.argv[1]?.endsWith("index.mjs") && process.argv.includes("--usage")) {
  console.log("Anthropic API Usage Tracker");
  console.log("============================\n");

  getUsageFromStorage().then((usage) => {
    if (!usage || usage.overall.requests === 0) {
      console.log("No Anthropic usage data found.");
      return;
    }

    console.log("Usage by Account:\n");
    for (const [key, row] of usage.byAccount) {
      console.log(`${row.accountName} (${row.accountId})`);
      console.log(`  Requests: ${row.requests}`);
      console.log(`  Input tokens: ${row.inputTokens.toLocaleString()}`);
      console.log(`  Output tokens: ${row.outputTokens.toLocaleString()}`);
      console.log(`  Total cost: $${row.cost.toFixed(4)}`);
      console.log("");
    }

    console.log("Overall:");
    console.log(`  Total requests: ${usage.overall.requests}`);
    console.log(`  Total input tokens: ${usage.overall.inputTokens.toLocaleString()}`);
    console.log(`  Total output tokens: ${usage.overall.outputTokens.toLocaleString()}`);
    console.log(`  Total cost: $${usage.overall.cost.toFixed(4)}`);
  });
}
