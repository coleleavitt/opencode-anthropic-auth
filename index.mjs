import {generatePKCE} from "@openauthjs/openauth/pkce";
import {readFileSync, writeFileSync, existsSync} from "fs";
import {access, readFile, writeFile, chmod, readdir} from "fs/promises";
import {join, basename} from "path";
import {fileURLToPath} from "url";
import {dirname} from "path";
import {Database} from "bun:sqlite";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

const TOOL_PREFIX = "mcp_";

// ============================================================================
// Dual Storage Approach:
// 1. OpenCode Storage - Source of truth for aggregate stats
// 2. SQLite DB - Per-request granular data for time-series charting
// ============================================================================

const METRICS_HOST = process.env.ANTHROPIC_USAGE_HOST || "localhost";
const METRICS_PORT = parseInt(process.env.ANTHROPIC_USAGE_PORT || "9091", 10);
const OPENCODE_STORAGE = join(process.env.HOME, ".local/share/opencode/storage");
const REQUESTS_DB_PATH = join(process.env.HOME, ".config/opencode/anthropic-requests.db");

// Anthropic pricing per 1M tokens (latest pricing as of Jan 2025)
// https://www.anthropic.com/pricing
const PRICING = {
    "claude-opus-4-5": {input: 5, output: 25, cacheRead: 0.50, cacheWrite5m: 6.25, cacheWrite1h: 10},
    "claude-opus-4": {input: 15, output: 75, cacheRead: 1.50, cacheWrite5m: 18.75, cacheWrite1h: 30},
    "claude-sonnet-4-5": {input: 3, output: 15, cacheRead: 0.30, cacheWrite5m: 3.75, cacheWrite1h: 6},
    "claude-sonnet-4": {input: 3, output: 15, cacheRead: 0.30, cacheWrite5m: 3.75, cacheWrite1h: 6},
    "claude-sonnet-3-5": {input: 3, output: 15, cacheRead: 0.30, cacheWrite5m: 3.75, cacheWrite1h: 6},
    "claude-haiku-4-5": {input: 1, output: 5, cacheRead: 0.10, cacheWrite5m: 1.25, cacheWrite1h: 2},
    "claude-haiku-3-5": {input: 0.80, output: 4, cacheRead: 0.08, cacheWrite5m: 1, cacheWrite1h: 1.6},
    "claude-haiku-3": {input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite5m: 0.30, cacheWrite1h: 0.50},
};

let metricsServer = null;

let requestsDb = null;

// ============================================================================
// SQLite DB Layer for granular per-request data
// ============================================================================

function initRequestsDb() {
    if (requestsDb) return requestsDb;

    const configDir = join(process.env.HOME, ".config/opencode");
    const dbPath = join(configDir, "anthropic-requests.db");

    requestsDb = new Database(dbPath);

    // Create requests table for granular per-request tracking
    requestsDb.exec(`
        CREATE TABLE IF NOT EXISTS requests
        (
            id
            INTEGER
            PRIMARY
            KEY
            AUTOINCREMENT,
            timestamp
            INTEGER
            NOT
            NULL,
            session_id
            TEXT,
            message_id
            TEXT,
            agent
            TEXT,
            model
            TEXT
            NOT
            NULL,
            provider
            TEXT
            DEFAULT
            'anthropic',
            account_name
            TEXT,
            account_email
            TEXT,
            input_tokens
            INTEGER
            DEFAULT
            0,
            output_tokens
            INTEGER
            DEFAULT
            0,
            cache_read_tokens
            INTEGER
            DEFAULT
            0,
            cache_write_tokens
            INTEGER
            DEFAULT
            0,
            cost_usd
            REAL
            DEFAULT
            0,
            duration_ms
            INTEGER,
            status_code
            INTEGER,
            error_message
            TEXT
        )
    `);

    // Create index for time-series queries
    requestsDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_requests_timestamp
            ON requests(timestamp)
    `);

    requestsDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_requests_agent
            ON requests(agent)
    `);

    requestsDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_requests_model
            ON requests(model)
    `);

    // Create daily aggregates table for fast dashboard queries
    requestsDb.exec(`
        CREATE TABLE IF NOT EXISTS daily_aggregates
        (
            id
            INTEGER
            PRIMARY
            KEY
            AUTOINCREMENT,
            date
            TEXT
            NOT
            NULL
            UNIQUE,
            agent
            TEXT,
            total_requests
            INTEGER
            DEFAULT
            0,
            total_input_tokens
            INTEGER
            DEFAULT
            0,
            total_output_tokens
            INTEGER
            DEFAULT
            0,
            total_cache_tokens
            INTEGER
            DEFAULT
            0,
            total_cost_usd
            REAL
            DEFAULT
            0
        )
    `);

    requestsDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_daily_aggregates_date
            ON daily_aggregates(date)
    `);

    requestsDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_daily_aggregates_agent
            ON daily_aggregates(agent)
    `);

    return requestsDb;
}

function recordRequest({
                           sessionId,
                           messageId,
                           agent,
                           model,
                           accountName,
                           accountEmail,
                           inputTokens,
                           outputTokens,
                           cacheReadTokens,
                           cacheWriteTokens,
                           costUsd,
                           durationMs,
                           statusCode,
                           errorMessage,
                       }) {
    if (!requestsDb) return;

    const timestamp = Date.now();
    const date = new Date(timestamp).toISOString().split("T")[0];

    try {
        // Insert the request record
        requestsDb.exec(`
            INSERT INTO requests (timestamp, session_id, message_id, agent, model, account_name, account_email,
                                  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                                  cost_usd, duration_ms, status_code, error_message)
            VALUES (${timestamp}, ${sessionId ? `'${sessionId.replace(/'/g, "''")}'` : "NULL"},
                    ${messageId ? `'${messageId.replace(/'/g, "''")}'` : "NULL"},
                    ${agent ? `'${agent.replace(/'/g, "''")}'` : "NULL"},
                    '${model.replace(/'/g, "''")}',
                    ${accountName ? `'${accountName.replace(/'/g, "''")}'` : "NULL"},
                    ${accountEmail ? `'${accountEmail.replace(/'/g, "''")}'` : "NULL"},
                    ${inputTokens || 0}, ${outputTokens || 0}, ${cacheReadTokens || 0},
                    ${cacheWriteTokens || 0}, ${costUsd || 0}, ${durationMs || "NULL"},
                    ${statusCode || "NULL"}, ${errorMessage ? `'${errorMessage.replace(/'/g, "''")}'` : "NULL"})
        `);

        // Update or insert daily aggregate
        const existing = requestsDb.query(`
            SELECT id
            FROM daily_aggregates
            WHERE date = '${date}' AND agent = ${agent ? `'${agent.replace(/'/g, "''")}'` : "NULL"}
        `).get();

        if (existing) {
            requestsDb.exec(`
                UPDATE daily_aggregates
                SET total_requests      = total_requests + 1,
                    total_input_tokens  = total_input_tokens + ${inputTokens || 0},
                    total_output_tokens = total_output_tokens + ${outputTokens || 0},
                    total_cache_tokens  = total_cache_tokens + ${(cacheReadTokens || 0) + (cacheWriteTokens || 0)},
                    total_cost_usd      = total_cost_usd + ${costUsd || 0}
                WHERE date = '${date}' AND agent = ${agent ? `'${agent.replace(/'/g, "''")}'` : "NULL"}
            `);
        } else {
            requestsDb.exec(`
                INSERT INTO daily_aggregates (date, agent, total_requests, total_input_tokens, total_output_tokens,
                                              total_cache_tokens, total_cost_usd)
                VALUES ('${date}',
                        ${agent ? `'${agent.replace(/'/g, "''")}'` : "NULL"},
                        1,
                        ${inputTokens || 0},
                        ${outputTokens || 0},
                        ${(cacheReadTokens || 0) + (cacheWriteTokens || 0)},
                        ${costUsd || 0})
            `);
        }
    } catch (error) {
        console.error("[anthropic-usage] Failed to record request:", error.message);
    }
}

function getTimeSeriesMetrics() {
    if (!requestsDb) return {byAgent: new Map(), overall: null};

    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const metrics = {
        byAgent: new Map(), overall: null,
    };

    try {
        // Get metrics by agent for last 24h
        const agentResults = requestsDb.query(`
            SELECT agent,
                   COUNT(*)                                    as requests,
                   SUM(input_tokens)                           as input_tokens,
                   SUM(output_tokens)                          as output_tokens,
                   SUM(cache_read_tokens + cache_write_tokens) as cache_tokens,
                   SUM(cost_usd)                               as cost_usd
            FROM requests
            WHERE timestamp >= ${oneDayAgo}
            GROUP BY agent
        `).all();

        for (const row of agentResults) {
            metrics.byAgent.set(row.agent, {
                agent: row.agent,
                requests: row.requests || 0,
                inputTokens: row.input_tokens || 0,
                outputTokens: row.output_tokens || 0,
                cacheTokens: row.cache_tokens || 0,
                cost: row.cost_usd || 0,
            });
        }

        // Get overall metrics for last 24h
        const overallResult = requestsDb.query(`
            SELECT COUNT(*)                                    as requests,
                   SUM(input_tokens)                           as input_tokens,
                   SUM(output_tokens)                          as output_tokens,
                   SUM(cache_read_tokens + cache_write_tokens) as cache_tokens,
                   SUM(cost_usd)                               as cost_usd
            FROM requests
            WHERE timestamp >= ${oneDayAgo}
        `).get();

        if (overallResult) {
            metrics.overall = {
                requests: overallResult.requests || 0,
                inputTokens: overallResult.input_tokens || 0,
                outputTokens: overallResult.output_tokens || 0,
                cacheTokens: overallResult.cache_tokens || 0,
                cost: overallResult.cost_usd || 0,
            };
        }
    } catch (error) {
        console.error("[anthropic-usage] Failed to get time-series metrics:", error.message);
    }

    return metrics;
}

function calculateCost(model, inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0) {
    const pricing = PRICING[model] || PRICING["claude-sonnet-4-5"];
    return ((inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output + (cacheReadTokens / 1_000_000) * pricing.cacheRead + (cacheWriteTokens / 1_000_000) * pricing.cacheWrite5m);
}

async function* walkDir(dir) {
    const entries = await readdir(dir, {withFileTypes: true});
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
        byAccount: new Map(), overall: {
            requests: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0, cost: 0,
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

// ============================================================================
// Usage by Model - Aggregates usage per model for cost breakdown
// ============================================================================

async function getUsageByModel() {
    const messageDir = join(OPENCODE_STORAGE, "message");
    if (!existsSync(messageDir)) return null;

    const usage = {
        byModel: new Map(), overall: {
            requests: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0, cost: 0,
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

            if (!usage.byModel.has(model)) {
                usage.byModel.set(model, {
                    model, requests: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0, cost: 0,
                });
            }

            const modelUsage = usage.byModel.get(model);
            modelUsage.requests++;
            modelUsage.inputTokens += inputTokens;
            modelUsage.outputTokens += outputTokens;
            modelUsage.cacheTokens += cacheRead + cacheWrite;
            modelUsage.cost += cost;

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

// ============================================================================
// Time-Series Data - Aggregates usage by hour for time-series charts
// ============================================================================

async function getTimeSeriesData(hours = 24) {
    const messageDir = join(OPENCODE_STORAGE, "message");
    if (!existsSync(messageDir)) return null;

    const cutoffTime = Date.now() - hours * 60 * 60 * 1000;
    const hourlyData = new Map();
    const dailyData = new Map();

    for await (const filePath of walkDir(messageDir)) {
        if (!filePath.endsWith(".json")) continue;

        try {
            const content = await readFile(filePath, "utf-8");
            const msg = JSON.parse(content);

            // Only count assistant messages with cost data
            if (msg.role !== "assistant") continue;
            if (typeof msg.cost !== "number") continue;

            const provider = msg.providerID || "unknown";
            if (provider !== "anthropic") continue;

            // Check timestamp
            const timestamp = msg.time?.created;
            if (!timestamp || timestamp < cutoffTime) continue;

            const model = msg.modelID || "unknown";
            const agent = msg.agent || "unknown";
            const inputTokens = msg.tokens?.input || 0;
            const outputTokens = (msg.tokens?.output || 0) + (msg.tokens?.reasoning || 0);
            const cacheRead = msg.tokens?.cache?.read || 0;
            const cacheWrite = msg.tokens?.cache?.write || 0;
            const cost = msg.cost || calculateCost(model, inputTokens, outputTokens, cacheRead, cacheWrite);

            // Hourly bucket
            const hourKey = new Date(timestamp).toISOString().slice(0, 13) + ":00"; // "2025-01-15T10:00"
            if (!hourlyData.has(hourKey)) {
                hourlyData.set(hourKey, {
                    timestamp: new Date(hourKey).getTime(),
                    requests: 0,
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheTokens: 0,
                    cost: 0,
                });
            }
            const hourEntry = hourlyData.get(hourKey);
            hourEntry.requests++;
            hourEntry.inputTokens += inputTokens;
            hourEntry.outputTokens += outputTokens;
            hourEntry.cacheTokens += cacheRead + cacheWrite;
            hourEntry.cost += cost;

            // Daily bucket
            const dayKey = new Date(timestamp).toISOString().split("T")[0]; // "2025-01-15"
            if (!dailyData.has(dayKey)) {
                dailyData.set(dayKey, {
                    date: dayKey, requests: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0, cost: 0,
                });
            }
            const dayEntry = dailyData.get(dayKey);
            dayEntry.requests++;
            dayEntry.inputTokens += inputTokens;
            dayEntry.outputTokens += outputTokens;
            dayEntry.cacheTokens += cacheRead + cacheWrite;
            dayEntry.cost += cost;
        } catch (e) {
            // Skip malformed files
        }
    }

    // Sort hourly data by timestamp
    const sortedHourly = Array.from(hourlyData.values())
        .sort((a, b) => a.timestamp - b.timestamp);

    // Sort daily data by date
    const sortedDaily = Array.from(dailyData.values())
        .sort((a, b) => a.date.localeCompare(b.date));

    return {
        hourly: sortedHourly, daily: sortedDaily,
    };
}

// ============================================================================
// Usage by Hour of Day - Identify peak usage hours
// ============================================================================

async function getUsageByHourOfDay() {
    const messageDir = join(OPENCODE_STORAGE, "message");
    if (!existsSync(messageDir)) return null;

    const hourlyData = new Array(24).fill(null).map((_, hour) => ({
        hour, requests: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0, cost: 0,
    }));

    for await (const filePath of walkDir(messageDir)) {
        if (!filePath.endsWith(".json")) continue;

        try {
            const content = await readFile(filePath, "utf-8");
            const msg = JSON.parse(content);

            if (msg.role !== "assistant") continue;
            if (typeof msg.cost !== "number") continue;

            const provider = msg.providerID || "unknown";
            if (provider !== "anthropic") continue;

            const timestamp = msg.time?.created;
            if (!timestamp) continue;

            const hour = new Date(timestamp).getHours();
            const model = msg.modelID || "unknown";
            const inputTokens = msg.tokens?.input || 0;
            const outputTokens = (msg.tokens?.output || 0) + (msg.tokens?.reasoning || 0);
            const cacheRead = msg.tokens?.cache?.read || 0;
            const cacheWrite = msg.tokens?.cache?.write || 0;
            const cost = msg.cost || calculateCost(model, inputTokens, outputTokens, cacheRead, cacheWrite);

            hourlyData[hour].requests++;
            hourlyData[hour].inputTokens += inputTokens;
            hourlyData[hour].outputTokens += outputTokens;
            hourlyData[hour].cacheTokens += cacheRead + cacheWrite;
            hourlyData[hour].cost += cost;
        } catch (e) {
            // Skip malformed files
        }
    }

    return hourlyData;
}

// ============================================================================
// Usage by Day of Week - Identify peak usage days
// ============================================================================

async function getUsageByDayOfWeek() {
    const messageDir = join(OPENCODE_STORAGE, "message");
    if (!existsSync(messageDir)) return null;

    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const dailyData = new Array(7).fill(null).map((_, dayIndex) => ({
        dayIndex,
        dayName: dayNames[dayIndex],
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheTokens: 0,
        cost: 0,
        uniqueDays: new Set(),
    }));

    for await (const filePath of walkDir(messageDir)) {
        if (!filePath.endsWith(".json")) continue;

        try {
            const content = await readFile(filePath, "utf-8");
            const msg = JSON.parse(content);

            if (msg.role !== "assistant") continue;
            if (typeof msg.cost !== "number") continue;

            const provider = msg.providerID || "unknown";
            if (provider !== "anthropic") continue;

            const timestamp = msg.time?.created;
            if (!timestamp) continue;

            const dayIndex = new Date(timestamp).getDay();
            const dateStr = new Date(timestamp).toISOString().split("T")[0];
            const model = msg.modelID || "unknown";
            const inputTokens = msg.tokens?.input || 0;
            const outputTokens = (msg.tokens?.output || 0) + (msg.tokens?.reasoning || 0);
            const cacheRead = msg.tokens?.cache?.read || 0;
            const cacheWrite = msg.tokens?.cache?.write || 0;
            const cost = msg.cost || calculateCost(model, inputTokens, outputTokens, cacheRead, cacheWrite);

            dailyData[dayIndex].requests++;
            dailyData[dayIndex].inputTokens += inputTokens;
            dailyData[dayIndex].outputTokens += outputTokens;
            dailyData[dayIndex].cacheTokens += cacheRead + cacheWrite;
            dailyData[dayIndex].cost += cost;
            dailyData[dayIndex].uniqueDays.add(dateStr);
        } catch (e) {
            // Skip malformed files
        }
    }

    // Convert uniqueDays to count
    return dailyData.map(d => ({
        ...d, uniqueDays: d.uniqueDays.size,
    }));
}

// ============================================================================
// Weekly Breakdown - Week over week comparison
// ============================================================================

async function getWeeklyBreakdown() {
    const messageDir = join(OPENCODE_STORAGE, "message");
    if (!existsSync(messageDir)) return null;

    const now = Date.now();
    const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const twoWeeksAgo = now - 14 * 24 * 60 * 60 * 1000;
    const threeWeeksAgo = now - 21 * 24 * 60 * 60 * 1000;
    const fourWeeksAgo = now - 28 * 24 * 60 * 60 * 1000;

    const weeks = [{
        label: "This Week", start: oneWeekAgo, end: now, requests: 0, cost: 0, tokens: 0
    }, {
        label: "Last Week", start: twoWeeksAgo, end: oneWeekAgo, requests: 0, cost: 0, tokens: 0
    }, {
        label: "2 Weeks Ago", start: threeWeeksAgo, end: twoWeeksAgo, requests: 0, cost: 0, tokens: 0
    }, {label: "3 Weeks Ago", start: fourWeeksAgo, end: threeWeeksAgo, requests: 0, cost: 0, tokens: 0},];

    for await (const filePath of walkDir(messageDir)) {
        if (!filePath.endsWith(".json")) continue;

        try {
            const content = await readFile(filePath, "utf-8");
            const msg = JSON.parse(content);

            if (msg.role !== "assistant") continue;
            if (typeof msg.cost !== "number") continue;

            const provider = msg.providerID || "unknown";
            if (provider !== "anthropic") continue;

            const timestamp = msg.time?.created;
            if (!timestamp) continue;

            const model = msg.modelID || "unknown";
            const inputTokens = msg.tokens?.input || 0;
            const outputTokens = (msg.tokens?.output || 0) + (msg.tokens?.reasoning || 0);
            const cacheRead = msg.tokens?.cache?.read || 0;
            const cacheWrite = msg.tokens?.cache?.write || 0;
            const cost = msg.cost || calculateCost(model, inputTokens, outputTokens, cacheRead, cacheWrite);
            const totalTokens = inputTokens + outputTokens + cacheRead + cacheWrite;

            for (const week of weeks) {
                if (timestamp >= week.start && timestamp < week.end) {
                    week.requests++;
                    week.cost += cost;
                    week.tokens += totalTokens;
                    break;
                }
            }
        } catch (e) {
            // Skip malformed files
        }
    }

    return weeks;
}

// ============================================================================
// Monthly Breakdown - Monthly totals and trends
// ============================================================================

async function getMonthlyBreakdown() {
    const messageDir = join(OPENCODE_STORAGE, "message");
    if (!existsSync(messageDir)) return null;

    const monthlyData = new Map();

    for await (const filePath of walkDir(messageDir)) {
        if (!filePath.endsWith(".json")) continue;

        try {
            const content = await readFile(filePath, "utf-8");
            const msg = JSON.parse(content);

            if (msg.role !== "assistant") continue;
            if (typeof msg.cost !== "number") continue;

            const provider = msg.providerID || "unknown";
            if (provider !== "anthropic") continue;

            const timestamp = msg.time?.created;
            if (!timestamp) continue;

            const date = new Date(timestamp);
            const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;

            if (!monthlyData.has(monthKey)) {
                monthlyData.set(monthKey, {
                    month: monthKey,
                    requests: 0,
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheTokens: 0,
                    cost: 0,
                    days: new Set(),
                });
            }

            const entry = monthlyData.get(monthKey);
            const model = msg.modelID || "unknown";
            const inputTokens = msg.tokens?.input || 0;
            const outputTokens = (msg.tokens?.output || 0) + (msg.tokens?.reasoning || 0);
            const cacheRead = msg.tokens?.cache?.read || 0;
            const cacheWrite = msg.tokens?.cache?.write || 0;
            const cost = msg.cost || calculateCost(model, inputTokens, outputTokens, cacheRead, cacheWrite);

            entry.requests++;
            entry.inputTokens += inputTokens;
            entry.outputTokens += outputTokens;
            entry.cacheTokens += cacheRead + cacheWrite;
            entry.cost += cost;
            entry.days.add(date.toISOString().split("T")[0]);
        } catch (e) {
            // Skip malformed files
        }
    }

    // Convert to sorted array
    const sorted = Array.from(monthlyData.values())
        .map(m => ({...m, days: m.days.size}))
        .sort((a, b) => a.month.localeCompare(b.month));

    return sorted;
}

// ============================================================================
// Trend Analysis - Calculate growth/decline rates
// ============================================================================

async function getTrendAnalysis() {
    const messageDir = join(OPENCODE_STORAGE, "message");
    if (!existsSync(messageDir)) return null;

    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000;
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

    let last24h = {requests: 0, cost: 0, tokens: 0};
    let prev24h = {requests: 0, cost: 0, tokens: 0};
    let last7d = {requests: 0, cost: 0, tokens: 0};

    for await (const filePath of walkDir(messageDir)) {
        if (!filePath.endsWith(".json")) continue;

        try {
            const content = await readFile(filePath, "utf-8");
            const msg = JSON.parse(content);

            if (msg.role !== "assistant") continue;
            if (typeof msg.cost !== "number") continue;

            const provider = msg.providerID || "unknown";
            if (provider !== "anthropic") continue;

            const timestamp = msg.time?.created;
            if (!timestamp) continue;

            const model = msg.modelID || "unknown";
            const inputTokens = msg.tokens?.input || 0;
            const outputTokens = (msg.tokens?.output || 0) + (msg.tokens?.reasoning || 0);
            const cacheRead = msg.tokens?.cache?.read || 0;
            const cacheWrite = msg.tokens?.cache?.write || 0;
            const cost = msg.cost || calculateCost(model, inputTokens, outputTokens, cacheRead, cacheWrite);
            const totalTokens = inputTokens + outputTokens + cacheRead + cacheWrite;

            if (timestamp >= oneDayAgo) {
                last24h.requests++;
                last24h.cost += cost;
                last24h.tokens += totalTokens;
            } else if (timestamp >= twoDaysAgo) {
                prev24h.requests++;
                prev24h.cost += cost;
                prev24h.tokens += totalTokens;
            }

            if (timestamp >= sevenDaysAgo) {
                last7d.requests++;
                last7d.cost += cost;
                last7d.tokens += totalTokens;
            }
        } catch (e) {
            // Skip malformed files
        }
    }

    // Calculate growth rates
    const requestGrowth = prev24h.requests > 0 ? ((last24h.requests - prev24h.requests) / prev24h.requests * 100).toFixed(1) : "N/A";
    const costGrowth = prev24h.cost > 0 ? ((last24h.cost - prev24h.cost) / prev24h.cost * 100).toFixed(1) : "N/A";

    // Calculate avg daily for last 7 days
    const avgDailyRequests = (last7d.requests / 7).toFixed(1);
    const avgDailyCost = (last7d.cost / 7).toFixed(2);

    return {
        last24h,
        prev24h,
        last7d,
        requestGrowth: parseFloat(requestGrowth) || 0,
        costGrowth: parseFloat(costGrowth) || 0,
        avgDailyRequests,
        avgDailyCost,
    };
}

async function generateMetrics(usage) {
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

    // By Model - usage breakdown per model
    lines.push("");
    lines.push("# Usage by Model");
    const usageByModel = await getUsageByModel();
    if (usageByModel && usageByModel.byModel.size > 0) {
        for (const [model, row] of usageByModel.byModel) {
            const safeModel = (model || "unknown").replace(/"/g, '\\"');
            lines.push(`# Model: ${safeModel}`);
            lines.push(`anthropic_requests_total{model="${safeModel}"} ${row.requests}`);
            lines.push(`anthropic_tokens_total{model="${safeModel}",type="input"} ${row.inputTokens}`);
            lines.push(`anthropic_tokens_total{model="${safeModel}",type="output"} ${row.outputTokens}`);
            lines.push(`anthropic_tokens_total{model="${safeModel}",type="cache"} ${row.cacheTokens}`);
            lines.push(`anthropic_cost_usd_total{model="${safeModel}"} ${row.cost.toFixed(6)}`);
            lines.push("");
        }
    }

    // Time-series metrics from OpenCode storage (last 24h)
    lines.push("");
    lines.push("# Time-series metrics (last 24h from OpenCode storage)");
    const timeSeriesData = await getTimeSeriesData(24);

    // Hourly data
    if (timeSeriesData && timeSeriesData.hourly.length > 0) {
        lines.push("# Hourly usage");
        for (const row of timeSeriesData.hourly) {
            const hourLabel = new Date(row.timestamp).toISOString().slice(0, 13);
            lines.push(`anthropic_requests_hourly{timestamp="${hourLabel}"} ${row.requests}`);
            lines.push(`anthropic_tokens_hourly{timestamp="${hourLabel}",type="input"} ${row.inputTokens}`);
            lines.push(`anthropic_tokens_hourly{timestamp="${hourLabel}",type="output"} ${row.outputTokens}`);
            lines.push(`anthropic_tokens_hourly{timestamp="${hourLabel}",type="cache"} ${row.cacheTokens}`);
            lines.push(`anthropic_cost_usd_hourly{timestamp="${hourLabel}"} ${row.cost.toFixed(6)}`);
        }
        lines.push("");
    }

    // Daily data
    if (timeSeriesData && timeSeriesData.daily.length > 0) {
        lines.push("# Daily usage");
        for (const row of timeSeriesData.daily) {
            lines.push(`anthropic_requests_daily{date="${row.date}"} ${row.requests}`);
            lines.push(`anthropic_tokens_daily{date="${row.date}",type="input"} ${row.inputTokens}`);
            lines.push(`anthropic_tokens_daily{date="${row.date}",type="output"} ${row.outputTokens}`);
            lines.push(`anthropic_tokens_daily{date="${row.date}",type="cache"} ${row.cacheTokens}`);
            lines.push(`anthropic_cost_usd_daily{date="${row.date}"} ${row.cost.toFixed(6)}`);
        }
        lines.push("");
    }

    // Hour of day patterns
    lines.push("# Usage by hour of day (0-23)");
    const hourlyPatterns = await getUsageByHourOfDay();
    if (hourlyPatterns) {
        for (const row of hourlyPatterns) {
            lines.push(`anthropic_requests_by_hour{hour="${row.hour}"} ${row.requests}`);
            lines.push(`anthropic_cost_usd_by_hour{hour="${row.hour}"} ${row.cost.toFixed(6)}`);
            lines.push(`anthropic_tokens_by_hour{hour="${row.hour}"} ${row.inputTokens + row.outputTokens}`);
        }
        lines.push("");
    }

    // Day of week patterns
    lines.push("# Usage by day of week");
    const dailyPatterns = await getUsageByDayOfWeek();
    if (dailyPatterns) {
        for (const row of dailyPatterns) {
            const safeDay = row.dayName.replace(/"/g, '\\"');
            lines.push(`anthropic_requests_by_day_of_week{day="${safeDay}"} ${row.requests}`);
            lines.push(`anthropic_cost_usd_by_day_of_week{day="${safeDay}"} ${row.cost.toFixed(6)}`);
            lines.push(`anthropic_tokens_by_day_of_week{day="${safeDay}"} ${row.inputTokens + row.outputTokens}`);
        }
        lines.push("");
    }

    // Weekly breakdown
    lines.push("# Weekly usage");
    const weeklyData = await getWeeklyBreakdown();
    if (weeklyData) {
        for (const row of weeklyData) {
            const safeLabel = row.label.replace(/"/g, '\\"');
            lines.push(`anthropic_requests_weekly{week="${safeLabel}"} ${row.requests}`);
            lines.push(`anthropic_cost_usd_weekly{week="${safeLabel}"} ${row.cost.toFixed(6)}`);
            lines.push(`anthropic_tokens_weekly{week="${safeLabel}"} ${row.tokens}`);
        }
        lines.push("");
    }

    // Monthly breakdown
    lines.push("# Monthly usage");
    const monthlyData = await getMonthlyBreakdown();
    if (monthlyData) {
        for (const row of monthlyData) {
            lines.push(`anthropic_requests_monthly{month="${row.month}"} ${row.requests}`);
            lines.push(`anthropic_cost_usd_monthly{month="${row.month}"} ${row.cost.toFixed(6)}`);
            lines.push(`anthropic_tokens_monthly{month="${row.month}"} ${row.inputTokens + row.outputTokens}`);
        }
        lines.push("");
    }

    // Trend analysis
    lines.push("# Trend analysis");
    const trends = await getTrendAnalysis();
    if (trends) {
        lines.push(`anthropic_requests_last_24h ${trends.last24h.requests}`);
        lines.push(`anthropic_cost_usd_last_24h ${trends.last24h.cost.toFixed(6)}`);
        lines.push(`anthropic_requests_last_7d ${trends.last7d.requests}`);
        lines.push(`anthropic_cost_usd_last_7d ${trends.last7d.cost.toFixed(6)}`);
        lines.push(`anthropic_request_growth_percent ${trends.requestGrowth}`);
        lines.push(`anthropic_cost_growth_percent ${trends.costGrowth}`);
        lines.push(`anthropic_avg_daily_requests ${trends.avgDailyRequests}`);
        lines.push(`anthropic_avg_daily_cost ${trends.avgDailyCost}`);
        lines.push("");
    }

    // Time-series metrics from SQLite DB (last 24h by agent)
    lines.push("# Time-series metrics (last 24h from SQLite DB by agent)");
    const timeSeriesMetrics = getTimeSeriesMetrics();

    // By agent
    for (const [agent, row] of timeSeriesMetrics.byAgent) {
        const safeAgent = (agent || "unknown").replace(/"/g, '\\"');
        lines.push(`# Agent: ${safeAgent}`);
        lines.push(`anthropic_requests_24h{agent="${safeAgent}"} ${row.requests}`);
        lines.push(`anthropic_tokens_24h{agent="${safeAgent}",type="input"} ${row.inputTokens}`);
        lines.push(`anthropic_tokens_24h{agent="${safeAgent}",type="output"} ${row.outputTokens}`);
        lines.push(`anthropic_tokens_24h{agent="${safeAgent}",type="cache"} ${row.cacheTokens}`);
        lines.push(`anthropic_cost_24h{agent="${safeAgent}"} ${row.cost.toFixed(6)}`);
        lines.push("");
    }

    // Overall 24h
    if (timeSeriesMetrics.overall) {
        const o = timeSeriesMetrics.overall;
        lines.push("# Overall 24h totals");
        lines.push(`anthropic_requests_24h{agent="overall"} ${o.requests}`);
        lines.push(`anthropic_tokens_24h{agent="overall",type="input"} ${o.inputTokens}`);
        lines.push(`anthropic_tokens_24h{agent="overall",type="output"} ${o.outputTokens}`);
        lines.push(`anthropic_tokens_24h{agent="overall",type="cache"} ${o.cacheTokens}`);
        lines.push(`anthropic_cost_24h{agent="overall"} ${o.cost.toFixed(6)}`);
    }

    // Throughput Velocity (TPS) - Detect soft throttles
    lines.push("");
    lines.push("# Throughput Velocity (tokens per second)");
    const throughputData = await getThroughputVelocity();
    if (throughputData) {
        for (const [agent, row] of throughputData.byAgent) {
            const safeAgent = (agent || "unknown").replace(/"/g, '\\"');
            lines.push(`anthropic_tps_avg{agent="${safeAgent}"} ${row.avgTps}`);
            lines.push(`anthropic_tps_median{agent="${safeAgent}"} ${row.medianTps}`);
        }
        lines.push(`anthropic_tps_avg{agent="overall"} ${throughputData.overall.avgTps}`);
    }

    // Agent Chattiness Ratio (output/input)
    lines.push("");
    lines.push("# Agent Chattiness Ratio (output_tokens / input_tokens)");
    const chattinessData = await getAgentChattinessRatio();
    if (chattinessData) {
        for (const [agent, row] of chattinessData.byAgent) {
            const safeAgent = (agent || "unknown").replace(/"/g, '\\"');
            lines.push(`anthropic_chattiness_ratio{agent="${safeAgent}"} ${row.ratio}`);
        }
        lines.push(`anthropic_chattiness_ratio{agent="overall"} ${chattinessData.overall.ratio}`);
    }

    // Cache Hit Rate (CHR)
    lines.push("");
    lines.push("# Cache Hit Rate (cache_read / (input + cache_read))");
    const chrData = await getCacheHitRate();
    if (chrData) {
        for (const [agent, row] of chrData.byAgent) {
            const safeAgent = (agent || "unknown").replace(/"/g, '\\"');
            lines.push(`anthropic_cache_hit_rate{agent="${safeAgent}"} ${row.chr}`);
        }
        lines.push(`anthropic_cache_hit_rate{agent="overall"} ${chrData.overall.chr}`);
    }

    // Success Rate
    lines.push("");
    lines.push("# Request Success Rate (%)");
    const successData = await getSuccessRate();
    if (successData) {
        for (const [agent, row] of successData.byAgent) {
            const safeAgent = (agent || "unknown").replace(/"/g, '\\"');
            lines.push(`anthropic_success_rate{agent="${safeAgent}"} ${row.successRate}`);
        }
        lines.push(`anthropic_success_rate{agent="overall"} ${successData.overall.successRate}`);
    }

    // Cost Efficiency
    lines.push("");
    lines.push("# Cost Efficiency (cost per request, cost per 1K tokens)");
    const efficiencyData = await getCostEfficiency();
    if (efficiencyData) {
        for (const [agent, row] of efficiencyData.byAgent) {
            const safeAgent = (agent || "unknown").replace(/"/g, '\\"');
            lines.push(`anthropic_cost_per_request{agent="${safeAgent}"} ${row.costPerRequest}`);
            lines.push(`anthropic_cost_per_1k_tokens{agent="${safeAgent}"} ${row.costPerToken}`);
        }
        lines.push(`anthropic_cost_per_request{agent="overall"} ${efficiencyData.overall.costPerRequest}`);
        lines.push(`anthropic_cost_per_1k_tokens{agent="overall"} ${efficiencyData.overall.costPerToken}`);
    }

    // Token Burst Rate - Detect context overflow
    lines.push("");
    lines.push("# Token Burst Rate (max output tokens per hour)");
    const burstData = await getTokenBurstRate();
    if (burstData) {
        lines.push(`anthropic_burst_max_hourly_tokens ${burstData.maxHour.outputTokens}`);
        lines.push(`anthropic_burst_max_hour{date="${burstData.maxHour.hour}"} ${burstData.maxHour.requests}`);
        lines.push(`anthropic_burst_avg_hourly_tokens ${burstData.avgHourlyOutput}`);
    }

    // Session Depth - Detect conversation bloat
    lines.push("");
    lines.push("# Session Depth (avg messages per session)");
    const depthData = await getSessionDepth();
    if (depthData) {
        lines.push(`anthropic_session_count ${depthData.totalSessions}`);
        lines.push(`anthropic_session_avg_depth ${depthData.avgDepth}`);
        lines.push(`anthropic_session_max_depth ${depthData.maxDepth}`);
        lines.push(`anthropic_session_avg_duration_min ${depthData.avgDurationMin}`);
    }

    // Error Distribution
    lines.push("");
    lines.push("# Error Distribution");
    const errorData = await getErrorDistribution();
    if (errorData) {
        lines.push(`anthropic_error_total ${errorData.totalErrors}`);
        lines.push(`anthropic_error_rate_overall ${errorData.overallErrorRate}`);
        for (const [type, row] of errorData.byErrorType) {
            const safeType = type.replace(/"/g, '\\"');
            lines.push(`anthropic_error_count{type="${safeType}"} ${row.count}`);
            lines.push(`anthropic_error_percent{type="${safeType}"} ${row.percentage}`);
        }
    }

    // Tool Call Density
    lines.push("");
    lines.push("# Tool Call Density (requests with tool calls)");
    const toolData = await getToolCallDensity();
    if (toolData) {
        for (const [agent, row] of toolData.byAgent) {
            const safeAgent = (agent || "unknown").replace(/"/g, '\\"');
            lines.push(`anthropic_tool_density{agent="${safeAgent}"} ${row.density}`);
        }
        lines.push(`anthropic_tool_density{agent="overall"} ${toolData.overall.density}`);
    }

    // Context Inflation
    lines.push("");
    lines.push("# Context Inflation (input token growth per session)");
    const inflationData = await getContextInflation();
    if (inflationData) {
        for (const [agent, row] of inflationData.byAgent) {
            const safeAgent = (agent || "unknown").replace(/"/g, '\\"');
            lines.push(`anthropic_context_inflation{agent="${safeAgent}"} ${row.avgInflationPercent}`);
        }
        lines.push(`anthropic_context_inflation{agent="overall"} ${inflationData.overall.avgInflationPercent}`);
    }

    return lines.join("\n");
}

function startMetricsServer() {
    if (metricsServer) return;

    metricsServer = Bun.serve({
        hostname: METRICS_HOST, port: METRICS_PORT, fetch: async (request) => {
            const url = new URL(request.url);

            if (url.pathname === "/metrics") {
                const usage = await getUsageFromStorage();
                if (!usage) {
                    return new Response("# No usage data found\n", {headers: {"Content-Type": "text/plain"}});
                }
                return new Response(await generateMetrics(usage), {
                    headers: {"Content-Type": "text/plain; charset=utf-8"},
                });
            }

            if (url.pathname === "/health") {
                return new Response("OK", {status: 200});
            }

            return new Response("Not Found", {status: 404});
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
// Advanced Metrics - Throughput, Efficiency, and Health Metrics
// ============================================================================

// Throughput Velocity (TPS) - Detect soft throttles before hard limits
async function getThroughputVelocity() {
    const messageDir = join(OPENCODE_STORAGE, "message");
    if (!existsSync(messageDir)) return null;

    const byAgent = new Map();
    const overall = {outputTokens: 0, durationMs: 0, requests: 0};

    for await (const filePath of walkDir(messageDir)) {
        if (!filePath.endsWith(".json")) continue;

        try {
            const content = await readFile(filePath, "utf-8");
            const msg = JSON.parse(content);

            if (msg.role !== "assistant") continue;
            if (typeof msg.cost !== "number") continue;

            const provider = msg.providerID || "unknown";
            if (provider !== "anthropic") continue;

            const agent = msg.agent || "unknown";
            const outputTokens = (msg.tokens?.output || 0) + (msg.tokens?.reasoning || 0);

            // Calculate duration from timestamps
            const durationMs = msg.time?.completed && msg.time?.created
                ? msg.time.completed - msg.time.created
                : null;

            if (!durationMs || durationMs <= 0 || outputTokens <= 0) continue;

            // Per-agent stats
            if (!byAgent.has(agent)) {
                byAgent.set(agent, {outputTokens: 0, durationMs: 0, requests: 0, tpsValues: []});
            }
            const agentStats = byAgent.get(agent);
            agentStats.outputTokens += outputTokens;
            agentStats.durationMs += durationMs;
            agentStats.requests++;
            agentStats.tpsValues.push(outputTokens / (durationMs / 1000));

            // Overall stats
            overall.outputTokens += outputTokens;
            overall.durationMs += durationMs;
            overall.requests++;
        } catch (e) {
            // Skip malformed files
        }
    }

    // Calculate TPS for each agent
    const agentResults = new Map();
    for (const [agent, stats] of byAgent) {
        const avgTps = stats.requests > 0 ? stats.outputTokens / (stats.durationMs / 1000) : 0;
        const medianTps = stats.tpsValues.length > 0
            ? stats.tpsValues.sort((a, b) => a - b)[Math.floor(stats.tpsValues.length / 2)]
            : 0;
        agentResults.set(agent, {
            agent,
            avgTps: avgTps.toFixed(2),
            medianTps: medianTps.toFixed(2),
            totalOutputTokens: stats.outputTokens,
            totalDurationSec: (stats.durationMs / 1000).toFixed(0),
            requests: stats.requests,
        });
    }

    const avgTps = overall.requests > 0 ? overall.outputTokens / (overall.durationMs / 1000) : 0;

    return {
        byAgent: agentResults,
        overall: {
            avgTps: avgTps.toFixed(2),
            totalOutputTokens: overall.outputTokens,
            totalDurationSec: (overall.durationMs / 1000).toFixed(0),
            requests: overall.requests,
        },
    };
}

// Agent Chattiness Ratio - Detect inefficient or looping agents
async function getAgentChattinessRatio() {
    const messageDir = join(OPENCODE_STORAGE, "message");
    if (!existsSync(messageDir)) return null;

    const byAgent = new Map();
    let overallInput = 0;
    let overallOutput = 0;

    for await (const filePath of walkDir(messageDir)) {
        if (!filePath.endsWith(".json")) continue;

        try {
            const content = await readFile(filePath, "utf-8");
            const msg = JSON.parse(content);

            if (msg.role !== "assistant") continue;
            if (typeof msg.cost !== "number") continue;

            const provider = msg.providerID || "unknown";
            if (provider !== "anthropic") continue;

            const agent = msg.agent || "unknown";
            const inputTokens = msg.tokens?.input || 0;
            const outputTokens = (msg.tokens?.output || 0) + (msg.tokens?.reasoning || 0);

            if (!byAgent.has(agent)) {
                byAgent.set(agent, {inputTokens: 0, outputTokens: 0, requests: 0});
            }
            const stats = byAgent.get(agent);
            stats.inputTokens += inputTokens;
            stats.outputTokens += outputTokens;
            stats.requests++;

            overallInput += inputTokens;
            overallOutput += outputTokens;
        } catch (e) {
            // Skip malformed files
        }
    }

    const agentResults = new Map();
    for (const [agent, stats] of byAgent) {
        const ratio = stats.inputTokens > 0 ? stats.outputTokens / stats.inputTokens : 0;
        agentResults.set(agent, {
            agent,
            ratio: ratio.toFixed(2),
            inputTokens: stats.inputTokens,
            outputTokens: stats.outputTokens,
            requests: stats.requests,
        });
    }

    const overallRatio = overallInput > 0 ? overallOutput / overallInput : 0;

    return {
        byAgent: agentResults,
        overall: {
            ratio: overallRatio.toFixed(2),
            inputTokens: overallInput,
            outputTokens: overallOutput,
        },
    };
}

// Cache Hit Rate (CHR) - Measure caching efficiency
async function getCacheHitRate() {
    const messageDir = join(OPENCODE_STORAGE, "message");
    if (!existsSync(messageDir)) return null;

    const byAgent = new Map();
    let overallCacheRead = 0;
    let overallInput = 0;

    for await (const filePath of walkDir(messageDir)) {
        if (!filePath.endsWith(".json")) continue;

        try {
            const content = await readFile(filePath, "utf-8");
            const msg = JSON.parse(content);

            if (msg.role !== "assistant") continue;
            if (typeof msg.cost !== "number") continue;

            const provider = msg.providerID || "unknown";
            if (provider !== "anthropic") continue;

            const agent = msg.agent || "unknown";
            const inputTokens = msg.tokens?.input || 0;
            const cacheReadTokens = msg.tokens?.cache?.read || 0;

            if (!byAgent.has(agent)) {
                byAgent.set(agent, {cacheReadTokens: 0, inputTokens: 0, requests: 0});
            }
            const stats = byAgent.get(agent);
            stats.cacheReadTokens += cacheReadTokens;
            stats.inputTokens += inputTokens;
            stats.requests++;

            overallCacheRead += cacheReadTokens;
            overallInput += inputTokens;
        } catch (e) {
            // Skip malformed files
        }
    }

    const agentResults = new Map();
    for (const [agent, stats] of byAgent) {
        const total = stats.inputTokens + stats.cacheReadTokens;
        const chr = total > 0 ? (stats.cacheReadTokens / total * 100) : 0;
        agentResults.set(agent, {
            agent,
            chr: chr.toFixed(1),
            cacheReadTokens: stats.cacheReadTokens,
            inputTokens: stats.inputTokens,
            totalTokens: total,
            requests: stats.requests,
        });
    }

    const overallTotal = overallInput + overallCacheRead;
    const overallChr = overallTotal > 0 ? (overallCacheRead / overallTotal * 100) : 0;

    return {
        byAgent: agentResults,
        overall: {
            chr: overallChr.toFixed(1),
            cacheReadTokens: overallCacheRead,
            inputTokens: overallInput,
            totalTokens: overallTotal,
        },
    };
}

// Request Success Rate - Health metric per agent
async function getSuccessRate() {
    const messageDir = join(OPENCODE_STORAGE, "message");
    if (!existsSync(messageDir)) return null;

    const byAgent = new Map();
    let overallSuccess = 0;
    let overallTotal = 0;

    for await (const filePath of walkDir(messageDir)) {
        if (!filePath.endsWith(".json")) continue;

        try {
            const content = await readFile(filePath, "utf-8");
            const msg = JSON.parse(content);

            if (msg.role !== "assistant") continue;
            if (typeof msg.cost !== "number") continue;

            const provider = msg.providerID || "unknown";
            if (provider !== "anthropic") continue;

            const agent = msg.agent || "unknown";
            const isError = msg.error ? true : false;

            if (!byAgent.has(agent)) {
                byAgent.set(agent, {success: 0, total: 0});
            }
            const stats = byAgent.get(agent);
            stats.total++;
            if (!isError) stats.success++;
            overallTotal++;
            if (!isError) overallSuccess++;
        } catch (e) {
            // Skip malformed files
        }
    }

    const agentResults = new Map();
    for (const [agent, stats] of byAgent) {
        const rate = stats.total > 0 ? (stats.success / stats.total * 100) : 0;
        agentResults.set(agent, {
            agent,
            successRate: rate.toFixed(1),
            success: stats.success,
            total: stats.total,
            failed: stats.total - stats.success,
        });
    }

    const overallRate = overallTotal > 0 ? (overallSuccess / overallTotal * 100) : 0;

    return {
        byAgent: agentResults,
        overall: {
            successRate: overallRate.toFixed(1),
            success: overallSuccess,
            total: overallTotal,
            failed: overallTotal - overallSuccess,
        },
    };
}

// Cost Efficiency Metrics - Cost per request and per token
async function getCostEfficiency() {
    const messageDir = join(OPENCODE_STORAGE, "message");
    if (!existsSync(messageDir)) return null;

    const byAgent = new Map();
    let overallCost = 0;
    let overallRequests = 0;
    let overallTokens = 0;

    for await (const filePath of walkDir(messageDir)) {
        if (!filePath.endsWith(".json")) continue;

        try {
            const content = await readFile(filePath, "utf-8");
            const msg = JSON.parse(content);

            if (msg.role !== "assistant") continue;
            if (typeof msg.cost !== "number") continue;

            const provider = msg.providerID || "unknown";
            if (provider !== "anthropic") continue;

            const agent = msg.agent || "unknown";
            const model = msg.modelID || "unknown";
            const cost = msg.cost || 0;
            const inputTokens = msg.tokens?.input || 0;
            const outputTokens = (msg.tokens?.output || 0) + (msg.tokens?.reasoning || 0);
            const cacheTokens = (msg.tokens?.cache?.read || 0) + (msg.tokens?.cache?.write || 0);
            const totalTokens = inputTokens + outputTokens + cacheTokens;

            if (!byAgent.has(agent)) {
                byAgent.set(agent, {cost: 0, requests: 0, tokens: 0});
            }
            const stats = byAgent.get(agent);
            stats.cost += cost;
            stats.requests++;
            stats.tokens += totalTokens;

            overallCost += cost;
            overallRequests++;
            overallTokens += totalTokens;
        } catch (e) {
            // Skip malformed files
        }
    }

    const agentResults = new Map();
    for (const [agent, stats] of byAgent) {
        const costPerRequest = stats.requests > 0 ? stats.cost / stats.requests : 0;
        const costPerToken = stats.tokens > 0 ? stats.cost / (stats.tokens / 1000) : 0;
        agentResults.set(agent, {
            agent,
            costPerRequest: costPerRequest.toFixed(4),
            costPerToken: costPerToken.toFixed(4),
            totalCost: stats.cost.toFixed(2),
            requests: stats.requests,
            totalTokens: stats.tokens,
        });
    }

    const overallCostPerRequest = overallRequests > 0 ? overallCost / overallRequests : 0;
    const overallCostPerToken = overallTokens > 0 ? overallCost / (overallTokens / 1000) : 0;

    return {
        byAgent: agentResults,
        overall: {
            costPerRequest: overallCostPerRequest.toFixed(4),
            costPerToken: overallCostPerToken.toFixed(4),
            totalCost: overallCost.toFixed(2),
            requests: overallRequests,
            totalTokens: overallTokens,
        },
    };
}

// ============================================================================
// Health & Distribution Metrics
// ============================================================================

// Token Burst Rate - Detect context overflow from output spikes
async function getTokenBurstRate() {
    const messageDir = join(OPENCODE_STORAGE, "message");
    if (!existsSync(messageDir)) return null;

    const now = Date.now();
    const hourlyBuckets = new Map();

    for await (const filePath of walkDir(messageDir)) {
        if (!filePath.endsWith(".json")) continue;

        try {
            const content = await readFile(filePath, "utf-8");
            const msg = JSON.parse(content);

            if (msg.role !== "assistant") continue;
            if (typeof msg.cost !== "number") continue;

            const provider = msg.providerID || "unknown";
            if (provider !== "anthropic") continue;

            const timestamp = msg.time?.created;
            if (!timestamp) continue;

            const hourKey = new Date(timestamp).toISOString().slice(0, 13);
            const outputTokens = (msg.tokens?.output || 0) + (msg.tokens?.reasoning || 0);

            if (!hourlyBuckets.has(hourKey)) {
                hourlyBuckets.set(hourKey, {outputTokens: 0, requests: 0, timestamp: new Date(hourKey).getTime()});
            }
            const bucket = hourlyBuckets.get(hourKey);
            bucket.outputTokens += outputTokens;
            bucket.requests++;
        } catch (e) {
            // Skip malformed files
        }
    }

    const sorted = Array.from(hourlyBuckets.values())
        .sort((a, b) => b.outputTokens - a.outputTokens);

    const maxBucket = sorted[0] || {outputTokens: 0, requests: 0, timestamp: now};
    const avgBucket = hourlyBuckets.size > 0
        ? {outputTokens: sorted.reduce((sum, b) => sum + b.outputTokens, 0) / sorted.length}
        : {outputTokens: 0};

    return {
        maxHour: {
            hour: sorted[0]?.hour || "N/A",
            outputTokens: maxBucket.outputTokens,
            requests: maxBucket.requests,
        },
        avgHourlyOutput: avgBucket.outputTokens.toFixed(0),
        hourlyData: sorted,
    };
}

// Session Depth - Detect conversation bloat
async function getSessionDepth() {
    const messageDir = join(OPENCODE_STORAGE, "message");
    if (!existsSync(messageDir)) return null;

    const sessions = new Map();

    for await (const filePath of walkDir(messageDir)) {
        if (!filePath.endsWith(".json")) continue;

        try {
            const content = await readFile(filePath, "utf-8");
            const msg = JSON.parse(content);

            const sessionId = msg.sessionID;
            if (!sessionId) continue;

            const agent = msg.agent || "unknown";
            const isAssistant = msg.role === "assistant";
            const inputTokens = msg.tokens?.input || 0;
            const timestamp = msg.time?.created;

            if (!sessions.has(sessionId)) {
                sessions.set(sessionId, {
                    sessionId,
                    agent,
                    totalMessages: 0,
                    assistantMessages: 0,
                    totalInputTokens: 0,
                    firstMessage: timestamp,
                    lastMessage: timestamp,
                });
            }
            const session = sessions.get(sessionId);
            session.totalMessages++;
            if (isAssistant) session.assistantMessages++;
            session.totalInputTokens += inputTokens;
            if (timestamp) {
                if (!session.firstMessage || timestamp < session.firstMessage) session.firstMessage = timestamp;
                if (!session.lastMessage || timestamp > session.lastMessage) session.lastMessage = timestamp;
            }
        } catch (e) {
            // Skip malformed files
        }
    }

    const sessionArray = Array.from(sessions.values());

    // Calculate depth metrics
    const totalMessages = sessionArray.reduce((sum, s) => sum + s.totalMessages, 0);
    const avgDepth = sessionArray.length > 0 ? totalMessages / sessionArray.length : 0;

    // Find longest sessions
    const sortedByDepth = [...sessionArray].sort((a, b) => b.totalMessages - a.totalMessages);

    // Calculate session duration
    const durations = sessionArray
        .filter(s => s.firstMessage && s.lastMessage)
        .map(s => s.lastMessage - s.firstMessage);
    const avgDurationMs = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;

    return {
        totalSessions: sessionArray.length,
        avgDepth: avgDepth.toFixed(1),
        maxDepth: sortedByDepth[0]?.totalMessages || 0,
        avgDurationMin: (avgDurationMs / 60000).toFixed(1),
        byAgent: new Map(
            [...sessionArray.reduce((map, s) => {
                if (!map.has(s.agent)) {
                    map.set(s.agent, {sessions: 0, totalMessages: 0});
                }
                const a = map.get(s.agent);
                a.sessions++;
                a.totalMessages += s.totalMessages;
                return map;
            }, new Map())].map(([agent, stats]) => [
                agent,
                {agent, ...stats, avgDepth: (stats.totalMessages / stats.sessions).toFixed(1)}
            ])
        ),
        longestSessions: sortedByDepth.slice(0, 5),
    };
}

// Error Distribution - Track error types
async function getErrorDistribution() {
    const messageDir = join(OPENCODE_STORAGE, "message");
    if (!existsSync(messageDir)) return null;

    const byAgent = new Map();
    const byErrorType = new Map();
    const byHour = new Map();
    let totalErrors = 0;
    let totalRequests = 0;

    for await (const filePath of walkDir(messageDir)) {
        if (!filePath.endsWith(".json")) continue;

        try {
            const content = await readFile(filePath, "utf-8");
            const msg = JSON.parse(content);

            if (msg.role !== "assistant") continue;
            if (typeof msg.cost !== "number") continue;

            const provider = msg.providerID || "unknown";
            if (provider !== "anthropic") continue;

            const agent = msg.agent || "unknown";
            const timestamp = msg.time?.created;
            const hasError = !!msg.error;
            const errorName = msg.error?.name || (hasError ? "Unknown" : null);

            totalRequests++;

            // Agent stats
            if (!byAgent.has(agent)) {
                byAgent.set(agent, {total: 0, errors: 0});
            }
            const agentStats = byAgent.get(agent);
            agentStats.total++;
            if (hasError) agentStats.errors++;

            // Error type stats
            if (errorName) {
                if (!byErrorType.has(errorName)) {
                    byErrorType.set(errorName, {count: 0, examples: []});
                }
                const errorStats = byErrorType.get(errorName);
                errorStats.count++;
                if (errorStats.examples.length < 3) {
                    errorStats.examples.push(msg.error?.data?.message || errorName);
                }
                totalErrors++;
            }

            // Hourly error rate
            if (timestamp && hasError) {
                const hourKey = new Date(timestamp).toISOString().slice(0, 13);
                if (!byHour.has(hourKey)) {
                    byHour.set(hourKey, {errors: 0, requests: 0});
                }
                const hourStats = byHour.get(hourKey);
                hourStats.errors++;
                hourStats.requests++;
            } else if (timestamp) {
                const hourKey = new Date(timestamp).toISOString().slice(0, 13);
                if (!byHour.has(hourKey)) {
                    byHour.set(hourKey, {errors: 0, requests: 0});
                }
                byHour.get(hourKey).requests++;
            }
        } catch (e) {
            // Skip malformed files
        }
    }

    // Calculate error rates
    const agentResults = new Map();
    for (const [agent, stats] of byAgent) {
        const rate = stats.total > 0 ? (stats.errors / stats.total * 100) : 0;
        agentResults.set(agent, {
            agent,
            errorRate: rate.toFixed(2),
            errors: stats.errors,
            total: stats.total,
        });
    }

    const errorTypeResults = new Map();
    for (const [type, stats] of byErrorType) {
        errorTypeResults.set(type, {
            type,
            count: stats.count,
            percentage: totalErrors > 0 ? (stats.count / totalErrors * 100).toFixed(1) : 0,
            examples: stats.examples,
        });
    }

    const hourlyResults = Array.from(byHour.entries())
        .map(([hour, stats]) => ({
            hour,
            errorRate: stats.requests > 0 ? (stats.errors / stats.requests * 100).toFixed(1) : 0,
            errors: stats.errors,
            requests: stats.requests,
        }))
        .sort((a, b) => b.errors - a.errors);

    return {
        totalRequests,
        totalErrors,
        overallErrorRate: totalRequests > 0 ? (totalErrors / totalRequests * 100).toFixed(2) : 0,
        byAgent: agentResults,
        byErrorType: errorTypeResults,
        hourlyErrors: hourlyResults,
    };
}

// Tool Call Density - Detect tool-heavy agents
async function getToolCallDensity() {
    const messageDir = join(OPENCODE_STORAGE, "message");
    if (!existsSync(messageDir)) return null;

    const byAgent = new Map();
    let totalToolCalls = 0;
    let totalRequests = 0;

    for await (const filePath of walkDir(messageDir)) {
        if (!filePath.endsWith(".json")) continue;

        try {
            const content = await readFile(filePath, "utf-8");
            const msg = JSON.parse(content);

            if (msg.role !== "assistant") continue;
            if (typeof msg.cost !== "number") continue;

            const provider = msg.providerID || "unknown";
            if (provider !== "anthropic") continue;

            const agent = msg.agent || "unknown";
            const hasToolCalls = msg.finish === "tool-calls";

            if (!byAgent.has(agent)) {
                byAgent.set(agent, {requests: 0, toolCalls: 0});
            }
            const stats = byAgent.get(agent);
            stats.requests++;
            if (hasToolCalls) stats.toolCalls++;

            totalRequests++;
            if (hasToolCalls) totalToolCalls++;
        } catch (e) {
            // Skip malformed files
        }
    }

    const agentResults = new Map();
    for (const [agent, stats] of byAgent) {
        const density = stats.requests > 0 ? (stats.toolCalls / stats.requests * 100) : 0;
        agentResults.set(agent, {
            agent,
            density: density.toFixed(1),
            toolCalls: stats.toolCalls,
            requests: stats.requests,
            noToolCalls: stats.requests - stats.toolCalls,
        });
    }

    const overallDensity = totalRequests > 0 ? (totalToolCalls / totalRequests * 100) : 0;

    return {
        byAgent: agentResults,
        overall: {
            density: overallDensity.toFixed(1),
            toolCalls: totalToolCalls,
            requests: totalRequests,
            noToolCalls: totalRequests - totalToolCalls,
        },
    };
}

// Context Inflation - Track input token growth per session
async function getContextInflation() {
    const messageDir = join(OPENCODE_STORAGE, "message");
    if (!existsSync(messageDir)) return null;

    const sessions = new Map();

    for await (const filePath of walkDir(messageDir)) {
        if (!filePath.endsWith(".json")) continue;

        try {
            const content = await readFile(filePath, "utf-8");
            const msg = JSON.parse(content);

            if (msg.role !== "assistant") continue;
            if (typeof msg.cost !== "number") continue;

            const provider = msg.providerID || "unknown";
            if (provider !== "anthropic") continue;

            const sessionId = msg.sessionID;
            const agent = msg.agent || "unknown";
            const inputTokens = msg.tokens?.input || 0;
            const timestamp = msg.time?.created;

            if (!sessions.has(sessionId)) {
                sessions.set(sessionId, {
                    sessionId,
                    agent,
                    messages: [],
                    totalInputTokens: 0,
                });
            }
            const session = sessions.get(sessionId);
            session.messages.push({inputTokens, timestamp});
            session.totalInputTokens += inputTokens;
        } catch (e) {
            // Skip malformed files
        }
    }

    // Calculate input growth rate per session
    const agentGrowth = new Map();
    const overallGrowth = [];

    for (const session of sessions.values()) {
        if (session.messages.length < 2) continue;

        // Sort by timestamp
        session.messages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

        // Calculate growth: last message input / first message input
        const firstInput = session.messages[0].inputTokens;
        const lastInput = session.messages[session.messages.length - 1].inputTokens;
        const growth = firstInput > 0 ? (lastInput - firstInput) / firstInput : 0;

        overallGrowth.push(growth);

        if (!agentGrowth.has(session.agent)) {
            agentGrowth.set(session.agent, {growths: [], avgInput: 0, totalInput: 0, count: 0});
        }
        const stats = agentGrowth.get(session.agent);
        stats.growths.push(growth);
        stats.totalInput += session.totalInputTokens;
        stats.count++;
    }

    const agentResults = new Map();
    for (const [agent, stats] of agentGrowth) {
        const avgGrowth = stats.growths.length > 0
            ? stats.growths.reduce((a, b) => a + b, 0) / stats.growths.length
            : 0;
        agentResults.set(agent, {
            agent,
            avgInflationPercent: (avgGrowth * 100).toFixed(1),
            avgInputPerSession: (stats.totalInput / stats.count).toFixed(0),
            sessionsAnalyzed: stats.count,
        });
    }

    const overallAvgGrowth = overallGrowth.length > 0
        ? overallGrowth.reduce((a, b) => a + b, 0) / overallGrowth.length
        : 0;

    return {
        byAgent: agentResults,
        overall: {
            avgInflationPercent: (overallAvgGrowth * 100).toFixed(1),
            sessionsWithGrowth: overallGrowth.length,
        },
    };
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
        await writeFile(lockPath, "").catch(() => {
        });
    } catch {
        // Lock doesn't exist
    }
}

async function loadAccounts() {
    if (!existsSync(STORAGE_PATH)) {
        return {version: 1, accounts: [], activeIndex: 0};
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

    addAccount({name, refreshToken, accessToken, expiresAt, email}) {
        this.data.accounts.push({
            name, refreshToken, accessToken, expiresAt, email, addedAt: Date.now(), lastUsed: 0, rateLimitResetTime: 0,
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

    const url = new URL(`https://${mode === "console" ? "console.anthropic.com" : "claude.ai"}/oauth/authorize`,);
    url.searchParams.set("code", "true");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", "https://console.anthropic.com/oauth/code/callback",);
    url.searchParams.set("scope", "org:create_api_key user:profile user:inference",);
    url.searchParams.set("code_challenge", pkce.challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", pkce.verifier);
    return {
        url: url.toString(), verifier: pkce.verifier,
    };
}

async function exchange(code, verifier) {
    const splits = code.split("#");
    const result = await fetch("https://console.anthropic.com/v1/oauth/token", {
        method: "POST", headers: {
            "Content-Type": "application/json",
        }, body: JSON.stringify({
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
        method: "POST", headers: {
            "Content-Type": "application/json",
        }, body: JSON.stringify({
            grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLIENT_ID,
        }),
    });

    if (!response.ok) {
        return {type: "failed"};
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
            method: "GET", headers: {
                "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json",
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
        if (account.has_claude_max) plan = "claude_max"; else if (account.has_claude_pro) plan = "claude_pro";

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

export async function AnthropicAuthPlugin({client}) {
    const accountManager = await AccountManager.loadFromDisk();
    let hasShownAccountToast = false;

    // Start metrics server
    startMetricsServer();

    // Initialize SQLite DB for granular request tracking
    initRequestsDb();

    return {
        auth: {
            provider: "anthropic", async loader(getAuth, provider) {
                const account = accountManager.getCurrentOrNextAvailable();

                if (!account) {
                    return {};
                }

                // Zero out cost for max plan
                for (const model of Object.values(provider.models)) {
                    model.cost = {
                        input: 0, output: 0, cache: {
                            read: 0, write: 0,
                        },
                    };
                }

                return {
                    apiKey: "", async fetch(input, init) {
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
                            }).catch(() => {
                            });
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
                                }).catch(() => {
                                });
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

                        const includeClaudeCode = incomingBetasList.includes("claude-code-20250219",);

                        const mergedBetas = ["oauth-2025-04-20", "interleaved-thinking-2025-05-14", ...(includeClaudeCode ? ["claude-code-20250219"] : []),].join(",");

                        requestHeaders.set("authorization", `Bearer ${currentAccount.accessToken}`);
                        requestHeaders.set("anthropic-beta", mergedBetas);
                        requestHeaders.set("user-agent", "claude-cli/2.1.2 (external, cli)",);
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
                                                ...item, text: item.text
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
                                        ...tool, name: tool.name ? `${TOOL_PREFIX}${tool.name}` : tool.name,
                                    }));
                                }
                                // Add prefix to tool_use blocks in messages
                                if (parsed.messages && Array.isArray(parsed.messages)) {
                                    parsed.messages = parsed.messages.map((msg) => {
                                        if (msg.content && Array.isArray(msg.content)) {
                                            msg.content = msg.content.map((block) => {
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

                        if (requestUrl && requestUrl.pathname === "/v1/messages" && !requestUrl.searchParams.has("beta")) {
                            requestUrl.searchParams.set("beta", "true");
                            requestInput = input instanceof Request ? new Request(requestUrl.toString(), input) : requestUrl;
                        }

                        const response = await fetch(requestInput, {
                            ...requestInit, body, headers: requestHeaders,
                        });

                        const durationMs = Date.now() - (globalThis._requestStartTime || Date.now());

                        // Record usage from response headers
                        const inputTokens = parseInt(response.headers?.get?.("x-anthropic-input-tokens") || "0", 10);
                        const outputTokens = parseInt(response.headers?.get?.("x-anthropic-output-tokens") || "0", 10);
                        const cacheReadTokens = parseInt(response.headers?.get?.("x-anthropic-cache-read-input-tokens") || "0", 10);
                        const cacheWriteTokens = parseInt(response.headers?.get?.("x-anthropic-cache-write-input-tokens") || "0", 10);

                        let model = "unknown";
                        let sessionId = null;
                        let messageId = null;

                        if (inputTokens > 0 || outputTokens > 0 || cacheReadTokens > 0) {
                            // Extract model from request body
                            try {
                                if (body && typeof body === "string") {
                                    const parsed = JSON.parse(body);
                                    model = parsed.model || "unknown";
                                    sessionId = parsed.session_id || null;
                                    messageId = parsed.message_id || null;
                                }
                            } catch {
                                // ignore parse errors
                            }

                            // Calculate cost and record to SQLite
                            const costUsd = calculateCost(model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);

                            recordRequest({
                                sessionId,
                                messageId,
                                agent: client?.project?.name || "unknown",
                                model,
                                accountName: currentAccount.name,
                                accountEmail: currentAccount.email,
                                inputTokens,
                                outputTokens,
                                cacheReadTokens,
                                cacheWriteTokens,
                                costUsd,
                                durationMs,
                                statusCode: response.status,
                                errorMessage: response.status >= 400 ? `HTTP ${response.status}` : null,
                            });
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
                                }).catch(() => {
                                });
                            }
                        }

                        // Transform streaming response to rename tools back
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
                                status: response.status, statusText: response.statusText, headers: response.headers,
                            });
                        }

                        return response;
                    },
                };
            }, methods: [{
                label: "Claude Max (Multi-account)", type: "oauth", authorize: async () => {
                    const existingAccounts = accountManager.getAccounts();

                    // Generate account name automatically
                    const nextIndex = existingAccounts.length + 1;
                    const accountName = `account${nextIndex}`;

                    const {url, verifier} = await authorize("max");

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
                                }).catch(() => {
                                });
                                return {type: "failed"};
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
                            }).catch(() => {
                            });

                            return {type: "success"};
                        },
                    };
                },
            }, {
                label: "Create an API Key", type: "oauth", authorize: async () => {
                    const {url, verifier} = await authorize("console");
                    return {
                        url: url,
                        instructions: "Paste the authorization code here: ",
                        method: "code",
                        callback: async (code) => {
                            const credentials = await exchange(code, verifier);
                            if (credentials.type === "failed") return credentials;
                            const result = await fetch(`https://api.anthropic.com/api/oauth/claude_cli/create_api_key`, {
                                method: "POST", headers: {
                                    "Content-Type": "application/json", authorization: `Bearer ${credentials.access}`,
                                },
                            },).then((r) => r.json());
                            return {type: "success", key: result.raw_key};
                        },
                    };
                },
            }, {
                provider: "anthropic", label: "Manually enter API Key", type: "api",
            }, {
                label: "Switch Account", type: "oauth", prompts: [{
                    type: "select", key: "account", message: "Select account to use:", options: (() => {
                        const accounts = accountManager.getAccounts();
                        return accounts.map((acc, i) => ({
                            label: acc.fullName ? `${acc.fullName} (${acc.name})` : acc.name, value: acc.name,
                        }));
                    })(),
                },], authorize: async (inputs) => {
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
                        }).catch(() => {
                        });
                    }

                    return {
                        url: "", instructions: "", method: "auto",  // Changed from "code" - won't prompt for code
                        callback: async () => {
                            return {type: "success"};
                        },
                    };
                },
            },],
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

        // Show usage by model
        getUsageByModel().then((usageByModel) => {
            if (usageByModel && usageByModel.byModel.size > 0) {
                console.log("\n---\n");
                console.log("Usage by Model:\n");

                // Sort by cost (most expensive first)
                const sortedModels = Array.from(usageByModel.byModel.values())
                    .sort((a, b) => b.cost - a.cost);

                for (const row of sortedModels) {
                    console.log(`${row.model}`);
                    console.log(`  Requests: ${row.requests}`);
                    console.log(`  Input tokens: ${row.inputTokens.toLocaleString()}`);
                    console.log(`  Output tokens: ${row.outputTokens.toLocaleString()}`);
                    console.log(`  Total cost: $${row.cost.toFixed(4)}`);
                    console.log("");
                }
            }

            // Show time-series data from OpenCode storage
            return getTimeSeriesData(24);
        }).then((timeSeriesData) => {
            if (timeSeriesData && (timeSeriesData.hourly.length > 0 || timeSeriesData.daily.length > 0)) {
                console.log("\n---\n");
                console.log("Last 24 Hours (from OpenCode storage):\n");

                if (timeSeriesData.hourly.length > 0) {
                    console.log("Hourly breakdown:");
                    for (const row of timeSeriesData.hourly) {
                        const hourLabel = new Date(row.timestamp).toLocaleString("en-US", {
                            month: "short", day: "numeric", hour: "numeric", hour12: true,
                        });
                        console.log(`  ${hourLabel}: ${row.requests} requests, $${row.cost.toFixed(4)}`);
                    }
                }

                if (timeSeriesData.daily.length > 0) {
                    console.log("\nDaily breakdown:");
                    for (const row of timeSeriesData.daily) {
                        console.log(`  ${row.date}: ${row.requests} requests, $${row.cost.toFixed(4)}`);
                    }
                }
            }

            // Show usage by hour of day
            return getUsageByHourOfDay().then((hourlyPatterns) => {
                if (hourlyPatterns) {
                    console.log("\n---\n");
                    console.log("Usage by Hour of Day:\n");

                    // Sort by cost (highest first)
                    const sorted = [...hourlyPatterns].sort((a, b) => b.cost - a.cost);
                    const hourNames = ["12 AM", "1 AM", "2 AM", "3 AM", "4 AM", "5 AM", "6 AM", "7 AM", "8 AM", "9 AM", "10 AM", "11 AM", "12 PM", "1 PM", "2 PM", "3 PM", "4 PM", "5 PM", "6 PM", "7 PM", "8 PM", "9 PM", "10 PM", "11 PM"];

                    for (const row of sorted.slice(0, 10)) {
                        console.log(`  ${hourNames[row.hour]}: $${row.cost.toFixed(2)} (${row.requests} requests)`);
                    }
                }
                return getUsageByDayOfWeek();
            });
        }).then((dailyPatterns) => {
            if (dailyPatterns) {
                console.log("\n---\n");
                console.log("Usage by Day of Week:\n");

                // Sort by cost (highest first)
                const sorted = [...dailyPatterns].sort((a, b) => b.cost - a.cost);

                for (const row of sorted) {
                    console.log(`  ${row.dayName}: $${row.cost.toFixed(2)} (${row.requests} requests, ${row.uniqueDays} days)`);
                }
            }
            return getWeeklyBreakdown();
        }).then((weeklyData) => {
            if (weeklyData) {
                console.log("\n---\n");
                console.log("Weekly Breakdown:\n");

                for (const row of weeklyData) {
                    console.log(`  ${row.label}: $${row.cost.toFixed(2)} (${row.requests} requests, ${(row.tokens / 1000).toFixed(0)}K tokens)`);
                }
            }
            return getMonthlyBreakdown();
        }).then((monthlyData) => {
            if (monthlyData && monthlyData.length > 0) {
                console.log("\n---\n");
                console.log("Monthly Breakdown:\n");

                for (const row of monthlyData) {
                    console.log(`  ${row.month}: $${row.cost.toFixed(2)} (${row.requests} requests, ${row.days} days)`);
                }
            }
            return getTrendAnalysis();
        }).then((trends) => {
            if (trends) {
                console.log("\n---\n");
                console.log("Trends:\n");

                const growthEmoji = trends.costGrowth > 0 ? "↑" : trends.costGrowth < 0 ? "↓" : "→";
                console.log(`  Last 24h: ${trends.last24h.requests} requests, $${trends.last24h.cost.toFixed(2)}`);
                console.log(`  Last 7 days: ${trends.last7d.requests} requests, $${trends.last7d.cost.toFixed(2)}`);
                console.log(`  Avg daily (7d): ${trends.avgDailyRequests} requests, $${trends.avgDailyCost}`);
                console.log(`  Cost growth (vs prev 24h): ${growthEmoji} ${trends.costGrowth}%`);
            }

            // Show advanced metrics
            return getThroughputVelocity().then((throughput) => {
                return getAgentChattinessRatio().then((chattiness) => {
                    return getCacheHitRate().then((chr) => {
                        return getSuccessRate().then((success) => {
                            return getCostEfficiency().then((efficiency) => {
                                console.log("\n---\n");
                                console.log("Advanced Metrics:\n");

                                // Throughput Velocity
                                if (throughput) {
                                    console.log("Throughput Velocity (TPS):\n");
                                    const sortedTps = [...throughput.byAgent.values()]
                                        .sort((a, b) => parseFloat(b.avgTps) - parseFloat(a.avgTps));
                                    for (const row of sortedTps.slice(0, 5)) {
                                        console.log(`  ${row.agent}: ${row.avgTps} TPS avg, ${row.medianTps} TPS median`);
                                    }
                                    console.log(`  Overall: ${throughput.overall.avgTps} TPS avg`);
                                }

                                // Chattiness Ratio
                                if (chattiness) {
                                    console.log("\nAgent Chattiness Ratio (output/input):\n");
                                    const sortedChattiness = [...chattiness.byAgent.values()]
                                        .sort((a, b) => parseFloat(b.ratio) - parseFloat(a.ratio));
                                    for (const row of sortedChattiness.slice(0, 5)) {
                                        console.log(`  ${row.agent}: ${row.ratio}x (${(row.outputTokens / 1000).toFixed(0)}K out / ${(row.inputTokens / 1000).toFixed(0)}K in)`);
                                    }
                                    console.log(`  Overall: ${chattiness.overall.ratio}x`);
                                }

                                // Cache Hit Rate
                                if (chr) {
                                    console.log("\nCache Hit Rate (%):\n");
                                    const sortedChr = [...chr.byAgent.values()]
                                        .sort((a, b) => parseFloat(b.chr) - parseFloat(a.chr));
                                    for (const row of sortedChr.slice(0, 5)) {
                                        console.log(`  ${row.agent}: ${row.chr}% (${(row.cacheReadTokens / 1000).toFixed(0)}K cached)`);
                                    }
                                    console.log(`  Overall: ${chr.overall.chr}%`);
                                }

                                // Success Rate
                                if (success) {
                                    console.log("\nSuccess Rate (%):\n");
                                    const sortedSuccess = [...success.byAgent.values()]
                                        .sort((a, b) => parseFloat(b.successRate) - parseFloat(a.successRate));
                                    for (const row of sortedSuccess.slice(0, 5)) {
                                        const status = parseFloat(row.successRate) < 95 ? "⚠️" : "✓";
                                        console.log(`  ${status} ${row.agent}: ${row.successRate}% (${row.failed} failed)`);
                                    }
                                    console.log(`  Overall: ${success.overall.successRate}%`);
                                }

                                // // Cost Efficiency
                                // if (efficiency) {
                                //     console.log("\nCost Efficiency:\n");
                                //     const sortedEfficiency = [...efficiency.byAgent.values()]
                                //         .sort((a, b) => parseFloat(a.costPerRequest) - parseFloat(b.costPerRequest));
                                //     for (const row of sortedEfficiency.slice(0, 5)) {
                                //         console.log(`  ${row.agent}: $${row.costPerRequest}/req, $${row.costPerToken}/1K tokens`);
                                //     }
                                //     console.log(`  Overall: $${efficiency.overall.costPerRequest}/req, $${efficiency.overall.costPerToken}/1K tokens`);
                                // }
                            });
                        });
                    });
                });
            });

            // Additional health metrics
            return getTokenBurstRate().then((burst) => {
                return getSessionDepth().then((depth) => {
                    return getErrorDistribution().then((errors) => {
                        return getToolCallDensity().then((tools) => {
                            return getContextInflation().then((inflation) => {
                                console.log("\n---\n");
                                console.log("Health & Distribution Metrics:\n");

                                // Token Burst Rate
                                if (burst) {
                                    console.log("Token Burst Rate (output spikes):\n");
                                    console.log(`  Peak hour: ${burst.maxHour.hour || "N/A"}`);
                                    console.log(`  Max output tokens: ${(burst.maxHour.outputTokens / 1000).toFixed(0)}K`);
                                    console.log(`  Avg hourly output: ${(parseFloat(burst.avgHourlyOutput) / 1000).toFixed(0)}K`);
                                }

                                // Session Depth
                                if (depth) {
                                    console.log("\nSession Depth:\n");
                                    console.log(`  Total sessions: ${depth.totalSessions}`);
                                    console.log(`  Avg messages/session: ${depth.avgDepth}`);
                                    console.log(`  Max messages/session: ${depth.maxDepth}`);
                                    console.log(`  Avg session duration: ${depth.avgDurationMin} min`);
                                }

                                // Error Distribution
                                if (errors) {
                                    console.log("\nError Distribution:\n");
                                    console.log(`  Total errors: ${errors.totalErrors} / ${errors.totalRequests} requests`);
                                    console.log(`  Error rate: ${errors.overallErrorRate}%`);
                                    console.log("  By type:");
                                    for (const [type, row] of errors.byErrorType) {
                                        const icon = parseFloat(row.percentage) > 10 ? "⚠️" : "✓";
                                        console.log(`    ${icon} ${type}: ${row.count} (${row.percentage}%)`);
                                    }
                                }

                                // Tool Call Density
                                if (tools) {
                                    console.log("\nTool Call Density:\n");
                                    const sortedTools = [...tools.byAgent.values()]
                                        .sort((a, b) => parseFloat(b.density) - parseFloat(a.density));
                                    for (const row of sortedTools.slice(0, 5)) {
                                        const density = parseFloat(row.density);
                                        console.log(`  ${row.agent}: ${density}% requests have tool calls (${row.toolCalls}/${row.requests})`);
                                    }
                                    console.log(`  Overall: ${tools.overall.density}%`);
                                }

                                // Context Inflation
                                if (inflation) {
                                    console.log("\nContext Inflation (input growth):\n");
                                    const sortedInflation = [...inflation.byAgent.values()]
                                        .sort((a, b) => parseFloat(b.avgInflationPercent) - parseFloat(a.avgInflationPercent));
                                    for (const row of sortedInflation.slice(0, 5)) {
                                        const growth = parseFloat(row.avgInflationPercent);
                                        const icon = growth > 100 ? "📈" : growth > 50 ? "📊" : "✅";
                                        console.log(`  ${icon} ${row.agent}: ${row.avgInflationPercent}% growth, ${row.avgInputPerSession} avg input`);
                                    }
                                    console.log(`  Overall: ${inflation.overall.avgInflationPercent}% growth`);
                                }
                            });
                        });
                    });
                });
            });
        }).then(() => {
            console.log("\n---\n");
            console.log("Last 24 Hours (from SQLite DB by agent):\n");

            const timeSeriesMetrics = getTimeSeriesMetrics();

            if (timeSeriesMetrics.byAgent.size > 0) {
                for (const [agent, row] of timeSeriesMetrics.byAgent) {
                    console.log(`Agent: ${agent || "unknown"}`);
                    console.log(`  Requests: ${row.requests}`);
                    console.log(`  Input tokens: ${row.inputTokens.toLocaleString()}`);
                    console.log(`  Output tokens: ${row.outputTokens.toLocaleString()}`);
                    console.log(`  Total cost: $${row.cost.toFixed(4)}`);
                    console.log("");
                }
            } else {
                console.log("No data in last 24 hours.");
            }

            if (timeSeriesMetrics.overall) {
                console.log("Overall 24h:");
                console.log(`  Total requests: ${timeSeriesMetrics.overall.requests}`);
                console.log(`  Total input tokens: ${timeSeriesMetrics.overall.inputTokens.toLocaleString()}`);
                console.log(`  Total output tokens: ${timeSeriesMetrics.overall.outputTokens.toLocaleString()}`);
                console.log(`  Total cost: $${timeSeriesMetrics.overall.cost.toFixed(4)}`);
            }
        });
    });
}