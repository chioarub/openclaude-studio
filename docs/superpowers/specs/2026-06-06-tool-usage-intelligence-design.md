# Tool Usage Intelligence

Date: 2026-06-06
Status: Approved

## Problem

Users don't know what the AI actually does. Which tools it uses, how often, which fail, which files it touches most, and how behavior differs between models. Studio shows session outcomes but not operational patterns. This makes it hard to understand AI behavior, diagnose issues, or optimize usage.

## Solution

Extract per-tool-call data from existing session transcripts and surface tool analytics directly in the Control Center and Sessions page. No new pages, no new navigation items. Tool intelligence appears where users already look.

## Data Layer

### New shared types (`packages/shared/src/api.ts`)

```typescript
type ToolCallEvent = {
  toolName: string;
  success: boolean;
  timestamp: number;
  sessionId: string;
  arguments?: string; // bounded summary, max 120 chars
};

type ToolBreakdown = Array<{
  name: string;
  count: number;
  successRate: number;
  avgPerSession: number;
}>;

type EditedFileSummary = {
  path: string;
  editCount: number;
  writeCount: number;
  readCount: number;
  lastSessionId: string;
  lastSessionTitle: string;
};

type PerModelTools = {
  model: string;
  totalCalls: number;
  topTools: Array<{ name: string; count: number }>;
};

type ToolUsageSummary = {
  totalCalls: number;
  successRate: number;
  tools: ToolBreakdown;
  mostEditedFiles: EditedFileSummary[]; // capped at 20
  toolTrends: Array<{
    date: string;
    [toolName: string]: number;
  }>;
  perModel: PerModelTools[];
};

// Lightweight version for Control Center overview
type ToolSummaryLite = {
  totalCalls: number;
  successRate: number;
  tools: ToolBreakdown; // all tools
  topEditedFiles: EditedFileSummary[]; // capped at 8
  perModel: PerModelTools[];
};
```

### New server service (`apps/server/src/services/toolUsage.ts`)

Aggregates tool call data from session transcripts.

- Reuses existing transcript parsing from `sessions.ts` but extracts richer per-event data
- Parses each `.jsonl` line for tool_use and tool_result events
- Maps tool_result status to success/failure (error content = failure)
- Extracts bounded argument summaries per tool type:
  - Edit/Write/Read: the `file_path` argument
  - Bash: the `command` argument
  - Grep/Glob: the `pattern` argument
  - All others: first string argument found, if any
  - All truncated to 120 characters, no raw file content included
- Groups and counts by tool name, by date, by model
- Computes success rates per tool

### New server endpoint

`GET /api/projects/:projectId/tool-usage`

Returns full `ToolUsageSummary`. Accepts optional `?refresh=true` to bypass cache.

### Extended existing endpoint

`GET /api/projects/:projectId/overview` — response extended with optional `toolSummary: ToolSummaryLite | null` field. Null when no sessions exist or parsing fails. This field is additive and optional, so older web deployments talking to newer servers still work.

### Extended session endpoints

`GET /api/projects/:projectId/sessions/:sessionId` — response extended with optional `toolBreakdown` field containing per-session tool counts and success rates.

`GET /api/projects/:projectId/sessions` — each `SessionSummary` extended with optional `toolCounts: Array<{ name: string; count: number }>` containing the top 3 tools by call count. Intentionally lightweight (no success rate) for inline table badges.

## Control Center Integration

A new **Tool Analytics** section renders below the usage chart and above recent sessions.

Contains four elements:

1. **Tool Distribution chart** — horizontal bar chart (Recharts) showing call count per tool, sorted by frequency. Interactive: hovering shows success rate for that tool.

2. **Top Edited Files** — compact table (top 8) with columns: file path, edit/write/read counts. File path links open the Session Details modal for the session that last touched it.

3. **Success Rate indicator** — inline stat "Tool success rate: 94.2%" with color: green for >95%, yellow for >85%, red below.

4. **Per-Model Breakdown** — compact table showing each model's total calls and top 3 tools. Only renders when more than one model has been used.

Data source: the `toolSummary` field from the overview endpoint. Rendered only when the field is present and non-null.

On mobile: elements stack vertically, bar chart scrolls horizontally if needed, tables become scrollable.

## Sessions Page Integration

Two additions:

### Session table: Tools column

New column between "Models" and "Changed" showing top 2-3 tool badges with counts. E.g. `Edit (12) Read (8)`. Gives instant context about what the session did.

On mobile: hidden from the table, shown in the expandable row detail instead.

### Session Details modal: Tool Summary section

New collapsible section at the top of the Conversation tab (collapsed by default). Contains:

- Mini horizontal bar chart of tool calls in this session
- Success/failure counts per tool
- Files modified in this session with links to the Review Changes tab
- Total tool calls and average tool calls per message

Data source: the `toolBreakdown` field from the session details endpoint.

## Performance

### Caching

In-memory LRU cache in the server, scoped per project:

- Key: `projectId`
- Value: `{ summary: ToolUsageSummary, computedAt: number }`
- Max entries: 10 projects (evict least recently used)
- TTL: 5 minutes. After TTL, next request recomputes.
- Bypass: `?refresh=true` query param forces recomputation.
- Cache is shared between the overview (lite) and full endpoint. The lite version is derived from the full cached summary.

### Bounds

- `mostEditedFiles`: capped at 20 in full summary, 8 in lite version
- `toolTrends`: capped at last 30 days
- `arguments` field: truncated to 120 characters, no raw file content
- Per-session parsing: bounded by existing safeFile read limits

## Error Handling

### Server

- If transcript parsing fails for a single session, skip it and append a diagnostic warning. Do not fail the entire aggregation.
- If zero sessions produce parseable tool data, return an empty summary with a diagnostic.
- Cache computation errors do not crash the server. Log the error, return available data, add diagnostic.

### Web

- If `toolSummary` is null or missing from overview response, the Tool Analytics section does not render. No error shown to user.
- If `toolBreakdown` is missing from session details, the Tool Summary section does not render.
- Charts handle empty data gracefully (show "No tool data yet" message).
- Graceful degradation when talking to older server versions that don't include new fields.

## Testing

### Server unit tests (`apps/server/src/services/toolUsage.test.ts`)

- Parse tool calls from synthetic transcript fixtures
- Success cases: multiple tools, multiple sessions, mixed models
- Edge cases: empty sessions, sessions with no tool calls, malformed tool events
- Cache: hit, miss, TTL expiry, refresh param, LRU eviction
- Aggregation correctness: counts, rates, trends, per-model grouping
- Bounds enforcement: file cap, trend date cap, argument truncation

### Web tests

- Tool charts render with valid data
- Top Edited Files table renders with links
- Success rate indicator shows correct color
- Per-Model table renders only with multiple models
- Graceful degradation: section hidden when data is null/missing
- Session table shows tool badges when present
- Session Details modal shows tool summary when present
- Mobile: tools column hidden, badges in expandable detail

### E2E

- Update existing E2E spec to verify Tool Analytics section appears on Control Center when test data includes sessions with tool calls.

## Files Changed

### New files
- `apps/server/src/services/toolUsage.ts`
- `apps/server/src/services/toolUsage.test.ts`

### Modified files
- `packages/shared/src/api.ts` — new types, extended response types
- `apps/server/src/http/server.ts` — new endpoint, extended overview and session endpoints
- `apps/web/src/App.tsx` — Tool Analytics section in Control Center, Tools column in Sessions table, Tool Summary in Session Details modal

## Scope Exclusions

- No new navigation routes or pages
- No file watching or real-time updates
- No tool execution time tracking (not available in transcript data)
- No cross-project aggregation (per-project only)
- No export/download of tool data
