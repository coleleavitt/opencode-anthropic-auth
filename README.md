# opencode-anthropic-auth

Multi-account Anthropic authentication plugin for OpenCode with usage tracking.

## Features

- **Multi-account support**: Manage multiple Anthropic accounts with automatic rotation on rate limits
- **Usage tracking**: Reads from OpenCode's existing message storage - no separate database needed
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

The plugin reads token/cost data directly from OpenCode's existing storage at:
```
~/.local/share/opencode/storage/message/{session}/{message}.json
```

No separate database required!

### Viewing Usage Stats

```bash
bun ~/WebstormProjects/opencode-anthropic-auth/index.mjs --usage
```

Output:
```
Anthropic API Usage Tracker
============================

Usage by Account:

Sisyphus (Sisyphus)
  Requests: 10100
  Input tokens: 55,273
  Output tokens: 4,643,343
  Total cost: $2222.84

Overall:
  Total requests: 14,220
  Total input tokens: 136,746
  Total output tokens: 5,513,388
  Total cost: $2,357.93
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

#### Metrics

| Metric | Labels | Description |
|--------|--------|-------------|
| `anthropic_requests_total` | account, account_id | Total requests |
| `anthropic_tokens_total` | account, account_id, type | Tokens by type (input/output/cache) |
| `anthropic_cost_usd_total` | account, account_id | Total cost in USD |

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
4. **Usage Reading**: Aggregates data from OpenCode's message storage files

## File Locations

| File | Purpose |
|------|---------|
| `~/.config/opencode/anthropic-accounts.json` | Account credentials |
| `~/.local/share/opencode/storage/message/` | Message data (tokens, cost) |
| `http://localhost:9091/metrics` | Prometheus metrics |

## Grafana Dashboard Example

Create panels using these queries:

**Total Cost by Agent:**
```promql
anthropic_cost_usd_total{account!="overall"}
```

**Tokens Over Time:**
```promql
rate(anthropic_tokens_total{account="Sisyphus"}[5m])
```

**Request Count by Agent:**
```promql
anthropic_requests_total{account!="overall"}
```

## Notes

- Requires Bun runtime (OpenCode uses Bun)
- Works alongside `opencode-antigravity-auth` for non-Anthropic providers
- Token data comes from Anthropic response headers (`x-anthropic-input-tokens`, `x-anthropic-output-tokens`, `x-anthropic-cache-tokens`)
- Cost is calculated using Anthropic's current pricing tier
