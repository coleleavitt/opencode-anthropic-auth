import {generatePKCE} from "@openauthjs/openauth/pkce";
import type {OAuthResult, UserProfile, RefreshToken, AccessToken, PlanType, UUID} from "./types";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

export async function authorize(mode: "console" | "claude.ai") {
    const pkce = await generatePKCE();

    const url = new URL(
        `https://${mode === "console" ? "console.anthropic.com" : "claude.ai"}/oauth/authorize`
    );
    url.searchParams.set("code", "true");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", "https://console.anthropic.com/oauth/code/callback");
    url.searchParams.set("scope", "org:create_api_key user:profile user:inference");
    url.searchParams.set("code_challenge", pkce.challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", pkce.verifier);

    return {
        url: url.toString(),
        verifier: pkce.verifier,
    };
}

export async function exchange(code: string, verifier: string): Promise<OAuthResult> {
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
        return {type: "failed"};
    }

    const json = await result.json() as {
        refresh_token: string;
        access_token: string;
        expires_in: number;
    };
    return {
        type: "success",
        refresh: json.refresh_token as RefreshToken,
        access: json.access_token as AccessToken,
        expires: Date.now() + json.expires_in * 1000,
    };
}

export async function refreshAccessToken(refreshToken: RefreshToken): Promise<OAuthResult> {
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
        return {type: "failed"};
    }

    const json = await response.json() as {
        refresh_token: string;
        access_token: string;
        expires_in: number;
    };
    return {
        type: "success",
        refresh: json.refresh_token as RefreshToken,
        access: json.access_token as AccessToken,
        expires: Date.now() + json.expires_in * 1000,
    };
}

export async function fetchUserProfile(accessToken: AccessToken): Promise<UserProfile | null> {
    try {
        const response = await fetch("https://api.anthropic.com/api/oauth/profile", {
            method: "GET",
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
            },
        });

        if (!response.ok) {
            return null;
        }

        const profile = await response.json() as {
            account?: {
                uuid?: string;
                full_name?: string;
                display_name?: string;
                email?: string;
                has_claude_max?: boolean;
                has_claude_pro?: boolean;
            };
            organization?: {
                uuid?: string;
                name?: string;
                organization_type?: string;
                billing_type?: string;
                rate_limit_tier?: string;
                has_extra_usage_enabled?: boolean;
            };
        };
        const account = profile.account || {};
        const organization = profile.organization || {};

        let plan: PlanType = "unknown";
        if (account.has_claude_max) plan = "claude_max";
        else if (account.has_claude_pro) plan = "claude_pro";

        return {
            uuid: (account.uuid as UUID) || null,
            fullName: account.full_name || null,
            displayName: account.display_name || null,
            email: account.email || null,
            hasClaudeMax: account.has_claude_max || false,
            hasClaudePro: account.has_claude_pro || false,
            plan,
            organizationUuid: (organization.uuid as UUID) || null,
            organizationName: organization.name || null,
            organizationType: organization.organization_type || null,
            billingType: organization.billing_type || null,
            rateLimitTier: organization.rate_limit_tier || null,
            hasExtraUsageEnabled: organization.has_extra_usage_enabled || false,
        };
    } catch {
        return null;
    }
}
