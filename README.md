# opencode-anthropic-auth

Multi-account Anthropic authentication plugin for OpenCode with usage tracking.

## Branches

This repository has two implementation approaches:

### 1. `multi-account-support` branch (Current - Simplified)
- Reads usage directly from OpenCode's message storage
- No separate database needed
- Simpler architecture

### 2. `dual-storage-approach` branch (Advanced)
- Dual storage: OpenCode storage + SQLite DB
- SQLite DB for granular per-request data (timestamps, model, tokens per request)
- Enables time-series charts in Grafana
- More complex but provides better charting capabilities

## Features (both branches)

- **Multi-account support**: Manage multiple Anthropic accounts with automatic rotation on rate limits
- **Usage tracking**: Reads token/cost data from Anthropic API response headers
- **Prometheus metrics**: Exposes `/metrics` endpoint for Grafana dashboards
- **Cost calculation**: Uses latest Anthropic pricing (Jan 2025)

## Installation

Add to `~/.config/opencode/opencode.json`:

```json
{
  "plugin": [
    "file:///home/cole/WebstormProjects/opencode-anthropic-auth/index.mjs"
  ]
}
```

## Multi-Account Usage

The plugin provides two auth methods:

1. **Claude Max (Multi-account)** - OAuth flow for adding accounts
2. **Switch Account** - Quickly switch between existing accounts without OAuth

### Commands

```bash
# Add a new Anthropic account
opencode auth anthropic

# Switch between accounts
opencode auth anthropic --account account1
```

## Usage Tracking

### Simplified Approach (multi-account-support)

Reads directly from OpenCode's existing storage:
```
~/.local/share/opencode/storage/message/{session}/{message}.json
```

No separate database required.

### Dual Storage Approach (dual-storage-approach)

Two data sources:

1. **OpenCode Storage** - Source of truth for aggregate stats
2. **SQLite DB** - Per-request granular data for time-series charts

```
~/.config/opencode/anthropic-requests.db
```

The SQLite DB tracks:
- Timestamp of each request (for time-series charts)
- Model, agent, tokens per request
- Daily aggregates for fast dashboard queries

### Viewing Usage Stats

```bash
bun ~/WebstormProjects/opencode-anthropic-auth/index.mjs --usage
```

### Prometheus Metrics

```
http://localhost:9091/metrics
```

Configure Prometheus:
```yaml
scrape_configs:
  - job_name: 'anthropic-usage'
    static_configs:
      - targets: ['localhost:9091']
```

#### Metrics (Simplified)

| Metric | Labels | Description |
|--------|--------|-------------|
| `anthropic_requests_total` | account, account_id | Total requests |
| `anthropic_tokens_total` | account, account_id, type | Tokens by type (input/output/cache) |
| `anthropic_cost_usd_total` | account, account_id | Total cost in USD |

#### Metrics (Dual Storage)

Plus time-series metrics from the DB:

| Metric | Labels | Description |
|--------|--------|-------------|
| `anthropic_requests_24h` | agent | Requests in last 24h |
| `anthropic_tokens_24h` | agent, type | Tokens in last 24h |
| `anthropic_cost_24h` | agent | Cost in last 24h |

#### Health Check

```
http://localhost:9091/health
```

### Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_USAGE_HOST` | localhost | Metrics server host |
| `ANTHROPIC_USAGE_PORT` | 9091 | Metrics server port |

## Pricing

Uses Anthropic pricing (per 1M tokens as of Jan 2025):

| Model | Input | Output | Cache Read | Cache Write (5m) |
|-------|-------|--------|------------|------------------|
| Claude Opus 4.5 | $5 | $25 | $0.50 | $6.25 |
| Claude Opus 4 | $15 | $75 | $1.50 | $18.75 |
| Claude Sonnet 4.5 | $3 | $15 | $0.30 | $3.75 |
| Claude Sonnet 4 | $3 | $15 | $0.30 | $3.75 |
| Claude Haiku 4.5 | $1 | $5 | $0.10 | $1.25 |

See: https://www.anthropic.com/pricing

## How It Works

1. **Authentication**: Uses OAuth 2.0 with PKCE to authenticate with Anthropic
2. **Token Management**: Stores access/refresh tokens in `~/.config/opencode/anthropic-accounts.json`
3. **Rate Limit Handling**: Automatically switches accounts on HTTP 429
4. **Usage Tracking**:
   - Simplified: Aggregates data from OpenCode's message storage files
   - Dual: Also stores per-request data in SQLite for time-series analysis

## File Locations

| File | Purpose |
|------|---------|
| `~/.config/opencode/anthropic-accounts.json` | Account credentials |
| `~/.local/share/opencode/storage/message/` | Message data (tokens, cost) |
| `~/.config/opencode/anthropic-requests.db` | Per-request data (dual storage only) |
| `http://localhost:9091/metrics` | Prometheus metrics |

## Grafana Dashboard Example

### Simplified Dashboard

```promql
# Total Cost by Agent
anthropic_cost_usd_total{account!="overall"}

# Tokens Over Time
rate(anthropic_tokens_total{account="Sisyphus"}[5m])

# Request Count by Agent
anthropic_requests_total{account!="overall"}
```

### Time-Series Dashboard (Dual Storage)

```promql
# Cost over last 24h by agent
anthropic_cost_24h{agent="Sisyphus"}

# Requests per hour
rate(anthropic_requests_24h{agent="Sisyphus"}[1h])

# Tokens per hour
rate(anthropic_tokens_24h{agent="Sisyphus",type="input"}[1h])
```

## Notes

- Requires Bun runtime (OpenCode uses Bun)
- Works alongside `opencode-antigravity-auth` for non-Anthropic providers
- Token data comes from Anthropic response headers (`x-anthropic-input-tokens`, `x-anthropic-output-tokens`, `x-anthropic-cache-tokens`)
- Cost is calculated using Anthropic's current pricing tier
