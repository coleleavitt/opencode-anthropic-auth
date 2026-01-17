import {AccountManager} from "./account-manager";
import {authorize, exchange, fetchUserProfile, refreshAccessToken} from "./oauth";

const TOOL_PREFIX = "mcp_";

interface OpenCodeClient {
    tui?: {
        showToast: (args: any) => Promise<void>;
    };
    project?: {
        name?: string;
    };
}

interface PluginContext {
    client?: OpenCodeClient;
}

export async function AnthropicAuthPlugin({client}: PluginContext) {
    const accountManager = await AccountManager.loadFromDisk();
    let hasShownAccountToast = false;

    return {
        auth: {
            provider: "anthropic",
            async loader(getAuth: any, provider: any) {
                const account = accountManager.getCurrentOrNextAvailable();

                if (!account) {
                    return {};
                }

                for (const model of Object.values(provider.models) as any[]) {
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
                    async fetch(input: Request | URL | string, init?: RequestInit) {
                        const currentAccount = accountManager.getCurrentOrNextAvailable();
                        if (!currentAccount) {
                            throw new Error("No Anthropic accounts available");
                        }

                        if (!hasShownAccountToast) {
                            await client?.tui?.showToast({
                                body: {
                                    title: "Anthropic",
                                    message: `Using account: ${currentAccount.name}`,
                                    variant: "info",
                                },
                            }).catch(() => {
                            });
                            hasShownAccountToast = true;
                        }

                        currentAccount.lastUsed = Date.now();

                        if (!currentAccount.accessToken || accountManager.isTokenExpired(currentAccount)) {
                            const result = await refreshAccessToken(currentAccount.refreshToken);

                            if (result.type === "failed") {
                                await client?.tui?.showToast({
                                    body: {
                                        title: "Token Refresh Failed",
                                        message: `Could not refresh token for ${currentAccount.name}`,
                                        variant: "error",
                                    },
                                }).catch(() => {
                                });
                                throw new Error(`Token refresh failed for account: ${currentAccount.name}`);
                            }

                            accountManager.updateTokens(currentAccount, result.access!, result.expires!, result.refresh);
                            await accountManager.saveToDisk();

                            await client?.tui?.showToast({
                                body: {
                                    title: "Token Refreshed",
                                    message: `Using account: ${currentAccount.name}`,
                                    variant: "info",
                                },
                            }).catch(() => {
                            });
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

                        const includeClaudeCode = incomingBetasList.includes("claude-code-20250219");
                        const mergedBetas = [
                            "oauth-2025-04-20",
                            "interleaved-thinking-2025-05-14",
                            ...(includeClaudeCode ? ["claude-code-20250219"] : []),
                        ].join(",");

                        requestHeaders.set("authorization", `Bearer ${currentAccount.accessToken}`);
                        requestHeaders.set("anthropic-beta", mergedBetas);
                        requestHeaders.set("user-agent", "claude-cli/2.1.2 (external, cli)");
                        requestHeaders.delete("x-api-key");

                        let body = requestInit.body;
                        if (body && typeof body === "string") {
                            try {
                                const parsed = JSON.parse(body);

                                if (parsed.system && Array.isArray(parsed.system)) {
                                    parsed.system = parsed.system.map((item: any) => {
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

                                if (parsed.tools && Array.isArray(parsed.tools)) {
                                    parsed.tools = parsed.tools.map((tool: any) => ({
                                        ...tool,
                                        name: tool.name ? `${TOOL_PREFIX}${tool.name}` : tool.name,
                                    }));
                                }

                                if (parsed.messages && Array.isArray(parsed.messages)) {
                                    parsed.messages = parsed.messages.map((msg: any) => {
                                        if (msg.content && Array.isArray(msg.content)) {
                                            msg.content = msg.content.map((block: any) => {
                                                if (block.type === "tool_use" && block.name) {
                                                    return {...block, name: `${TOOL_PREFIX}${block.name}`};
                                                }
                                                return block;
                                            });
                                        }
                                        return msg;
                                    });
                                }
                                body = JSON.stringify(parsed);
                            } catch {
                            }
                        }

                        let requestInput = input;
                        let requestUrl: URL | null = null;
                        try {
                            if (typeof input === "string" || input instanceof URL) {
                                requestUrl = new URL(input.toString());
                            } else if (input instanceof Request) {
                                requestUrl = new URL(input.url);
                            }
                        } catch {
                            requestUrl = null;
                        }

                        if (requestUrl && requestUrl.pathname === "/v1/messages" && !requestUrl.searchParams.has("beta")) {
                            requestUrl.searchParams.set("beta", "true");
                            requestInput = input instanceof Request ? new Request(requestUrl.toString(), input) : requestUrl;
                        }

                        const response = await fetch(requestInput, {
                            ...requestInit,
                            body,
                            headers: requestHeaders,
                        });

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
                                }).catch(() => {
                                });
                            }
                        }

                        if (response.status === 401) {
                            const refreshResult = await refreshAccessToken(currentAccount.refreshToken);
                            if (refreshResult.type === "success") {
                                accountManager.updateTokens(currentAccount, refreshResult.access!, refreshResult.expires!, refreshResult.refresh);
                                await accountManager.saveToDisk();

                                requestHeaders.set("authorization", `Bearer ${refreshResult.access}`);
                                const retryResponse = await fetch(requestInput, {
                                    ...requestInit,
                                    body,
                                    headers: requestHeaders,
                                });

                                await client?.tui?.showToast({
                                    body: {
                                        title: "Token Refreshed",
                                        message: `Retrying request for ${currentAccount.name}`,
                                        variant: "info",
                                    },
                                }).catch(() => {
                                });

                                return retryResponse;
                            }
                        }

                        if (response.body) {
                            const reader = response.body.getReader();
                            const decoder = new TextDecoder();
                            const encoder = new TextEncoder();

                            const stream = new ReadableStream({
                                async pull(controller) {
                                    const {done, value} = await reader.read();
                                    if (done) {
                                        controller.close();
                                        return;
                                    }

                                    let text = decoder.decode(value, {stream: true});
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
                        const nextIndex = existingAccounts.length + 1;
                        const accountName = `account${nextIndex}`;

                        const {url, verifier} = await authorize("console");

                        return {
                            url,
                            instructions: `Paste the authorization code for "${accountName}":\n\nIf you want to add more accounts, run this command again after completing this one.\n`,
                            method: "code",
                            callback: async (code: string) => {
                                const credentials = await exchange(code, verifier);
                                if (credentials.type === "failed") {
                                    await client?.tui?.showToast({
                                        body: {
                                            title: "Authentication Failed",
                                            message: "Could not add account. Please try again.",
                                            variant: "error",
                                        },
                                    }).catch(() => {
                                    });
                                    return {type: "failed"};
                                }

                                const profile = await fetchUserProfile(credentials.access!);
                                const displayName = profile?.email || profile?.fullName || accountName;

                                accountManager.addAccount({
                                    name: displayName,
                                    refreshToken: credentials.refresh!,
                                    accessToken: credentials.access,
                                    expiresAt: credentials.expires,
                                    uuid: profile?.uuid ?? undefined,
                                    fullName: profile?.fullName ?? undefined,
                                    displayName: profile?.displayName ?? undefined,
                                    email: profile?.email ?? undefined,
                                    hasClaudeMax: profile?.hasClaudeMax ?? false,
                                    hasClaudePro: profile?.hasClaudePro ?? false,
                                    plan: profile?.plan ?? "unknown",
                                    organizationUuid: profile?.organizationUuid ?? undefined,
                                    organizationName: profile?.organizationName ?? undefined,
                                    organizationType: profile?.organizationType ?? undefined,
                                    billingType: profile?.billingType ?? undefined,
                                    rateLimitTier: profile?.rateLimitTier ?? undefined,
                                    hasExtraUsageEnabled: profile?.hasExtraUsageEnabled ?? false,
                                });
                                await accountManager.saveToDisk();

                                await client?.tui?.showToast({
                                    body: {
                                        title: "Account Added",
                                        message: `"${displayName}" has been configured. Run auth login again to add more.`,
                                        variant: "success",
                                    },
                                }).catch(() => {
                                });

                                return {type: "success"};
                            },
                        };
                    },
                },
                {
                    label: "Create an API Key",
                    type: "oauth",
                    authorize: async () => {
                        const {url, verifier} = await authorize("console");
                        return {
                            url,
                            instructions: "Paste the authorization code here: ",
                            method: "code",
                            callback: async (code: string) => {
                                const credentials = await exchange(code, verifier);
                                if (credentials.type === "failed") return credentials;

                                const result = (await fetch(
                                    `https://api.anthropic.com/api/oauth/claude_cli/create_api_key`,
                                    {
                                        method: "POST",
                                        headers: {
                                            "Content-Type": "application/json",
                                            authorization: `Bearer ${credentials.access}`,
                                        },
                                    }
                                ).then((r) => r.json())) as { raw_key: string };

                                return {type: "success", key: result.raw_key};
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
                                return accounts.map((acc) => ({
                                    label: acc.fullName ? `${acc.fullName} (${acc.name})` : acc.name,
                                    value: acc.name,
                                }));
                            })(),
                        },
                    ],
                    authorize: async (inputs: { account: string }) => {
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
                            method: "auto",
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
