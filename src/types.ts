/**
 * Type definitions for opencode-anthropic-auth plugin
 */

/**
 * OAuth Refresh Token - Opaque bearer token (NOT a JWT)
 * Format: sk-ant-ort01-{base64_random_bytes}
 * - sk = Session Key, ant = Anthropic, ort01 = OAuth Refresh Token v1
 * - 95 chars base64 = ~71 bytes random (~568 bits entropy)
 * - Server validates via DB lookup, can be revoked
 */
export type RefreshToken = `sk-ant-ort01-${string}`;

/**
 * OAuth Access Token - Opaque bearer token (NOT a JWT)
 * Format: sk-ant-oat01-{base64_random_bytes}
 * - sk = Session Key, ant = Anthropic, oat01 = OAuth Access Token v1
 * - 95 chars base64 = ~71 bytes random (~568 bits entropy)
 * - Server validates via DB lookup, can be revoked
 */
export type AccessToken = `sk-ant-oat01-${string}`;

export type UUID = `${string}-${string}-${string}-${string}-${string}`;
export type UnixTimestamp = number;
export type Email = string;
export type PlanType = "claude_max" | "claude_pro" | "unknown";
export type OrganizationType = "claude_max" | "personal" | string;
export type BillingType = "stripe_subscription" | "enterprise" | string;

export interface Account {
    name: string;
    refreshToken: RefreshToken;
    accessToken?: AccessToken;
    expiresAt?: UnixTimestamp;
    email?: Email;
    addedAt: UnixTimestamp;
    lastUsed: UnixTimestamp;
    rateLimitResetTime: UnixTimestamp;

    uuid?: UUID;
    fullName?: string;
    displayName?: string;
    hasClaudeMax?: boolean;
    hasClaudePro?: boolean;
    plan?: PlanType;
    organizationUuid?: UUID;
    organizationName?: string;
    organizationType?: OrganizationType;
    billingType?: BillingType;
    rateLimitTier?: string;
    hasExtraUsageEnabled?: boolean;
}

export interface AccountData {
    version: number;
    accounts: Account[];
    activeIndex?: number;
}

export interface OAuthResult {
    type: "success" | "failed";
    refresh?: RefreshToken;
    access?: AccessToken;
    expires?: UnixTimestamp;
}

export interface UserProfile {
    uuid: UUID | null;
    fullName: string | null;
    displayName: string | null;
    email: Email | null;
    hasClaudeMax: boolean;
    hasClaudePro: boolean;
    plan: PlanType;
    organizationUuid: UUID | null;
    organizationName: string | null;
    organizationType: OrganizationType | null;
    billingType: BillingType | null;
    rateLimitTier: string | null;
    hasExtraUsageEnabled: boolean;
}

export interface UsageStats {
    byAccount: Map<string, AccountUsage>;
    overall: OverallUsage;
}

export interface AccountUsage {
    accountId: string;
    accountName: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cacheTokens: number;
    cost: number;
}

export interface OverallUsage {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cacheTokens: number;
    cost: number;
}

export interface ModelPricing {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
}

export interface RequestRecord {
    sessionId?: string;
    messageId?: string;
    agent?: string;
    model: string;
    accountName?: string;
    accountEmail?: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
    durationMs?: number;
    statusCode?: number;
    errorMessage?: string;
}

export interface TimeSeriesMetrics {
    byAgent: Map<string, AgentMetrics>;
    overall: AgentMetrics | null;
}

export interface AgentMetrics {
    agent?: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cacheTokens: number;
    cost: number;
}

export interface HourlyData {
    timestamp: number;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cacheTokens: number;
    cost: number;
}

export interface DailyData {
    date: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cacheTokens: number;
    cost: number;
}

export interface TimeSeriesData {
    hourly: HourlyData[];
    daily: DailyData[];
}

export interface WeeklyData {
    label: string;
    start: number;
    end: number;
    requests: number;
    cost: number;
    tokens: number;
}

export interface MonthlyData {
    month: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cacheTokens: number;
    cost: number;
    days: number;
}

export interface TrendAnalysis {
    last24h: PeriodStats;
    prev24h: PeriodStats;
    last7d: PeriodStats;
    requestGrowth: number;
    costGrowth: number;
    avgDailyRequests: string;
    avgDailyCost: string;
}

export interface PeriodStats {
    requests: number;
    cost: number;
    tokens: number;
}

export interface ModelUsage {
    model: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cacheTokens: number;
    cost: number;
}

export interface UsageByModel {
    byModel: Map<string, ModelUsage>;
    overall: OverallUsage;
}
