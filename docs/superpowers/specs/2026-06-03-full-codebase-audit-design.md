# Full Codebase Audit: OpenClaude Studio v0.3.0

**Date:** 2026-06-03
**Scope:** Server (`apps/server`), Web (`apps/web`), Shared types (`packages/shared`)
**Status:** Draft for review

---

## Executive Summary

A deep inspection of every source file in OpenClaude Studio identified 3 critical security issues, 6 high-severity logic or performance bugs, 9 medium-severity code quality issues, 6 low-severity edge cases, 5 testing gaps, and 6 improvement opportunities. The most urgent items are a TOCTOU race in `safeFile.ts`, symlink bypass in `sessionChangeReview.ts`, and an O(M\*N) space diff algorithm that can OOM on large files.

---

## CRITICAL: Security Issues

### C-1. TOCTOU Race in `readContainedBoundedTextFile`

**File:** `apps/server/src/services/safeFile.ts:28-49`

`readContainedBoundedTextFile` performs `realpath` validation, then separately calls `readBoundedTextFile` which does its own `lstat` + `open`. Between the realpath check and the actual file open, an attacker could replace the path with a symlink pointing outside the allowed root.

```
readContainedBoundedTextFile(root, target):
  1. containedTarget = assertContainedPath(root, target)  // string prefix check
  2. [realRoot, realTarget] = realpath(root), realpath(containedTarget)  // first check
  3. isPathInside(realRoot, realTarget)  // passes
  4. --- RACE WINDOW: target could be replaced with symlink here ---
  5. readBoundedTextFile(containedTarget, ...)  // opens again via lstat + open
```

**Impact:** A local attacker with ability to create symlinks in a project directory could read arbitrary files during the race window.

**Recommendation:** Open the file handle once with `O_NOFOLLOW`, then validate realpath from the handle's fd. Use `fstat` on the already-open handle instead of a separate `lstat`.

### C-2. `safeChildPath` Does Not Resolve Symlinks

**File:** `apps/server/src/services/sessionChangeReview.ts:476-488`

`safeChildPath` uses `resolve()` which only normalizes the path string — it does not resolve symlinks. If `root` or any intermediate directory is a symlink, the `startsWith` check can be bypassed. This function is used to construct backup file paths from session IDs and backup file names supplied via transcript data.

```typescript
function safeChildPath(root: string, child: string): string | null {
  const resolvedRoot = resolve(root);       // string normalization only
  const resolvedPath = resolve(resolvedRoot, child);  // no symlink resolution
  if (resolvedPath === resolvedRoot || !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
    return null;
  }
  return resolvedPath;
}
```

**Impact:** If the file-history directory or a parent contains a symlink, constructed paths could escape the intended directory.

**Recommendation:** Use `realpath` on both `root` and the constructed path, or open the path via a file handle and validate using `fstat` + `readlink`.

### C-3. `assertContainedPath` Relies on String Prefix Without Symlink Resolution

**File:** `apps/server/src/services/safeFile.ts:17-26`

`assertContainedPath` is a synchronous function that only does `resolve()` + `relative()` string comparison. It does not resolve symlinks at all. The caller `readContainedBoundedTextFile` does call `realpath` afterward, but between `assertContainedPath` returning and `realpath` executing there is no atomically bound file handle.

```typescript
export function assertContainedPath(root: string, target: string): string {
  const resolvedRoot = resolve(root);      // string-only
  const resolvedTarget = resolve(target);  // string-only
  if (isPathInside(resolvedRoot, resolvedTarget)) {
    return resolvedTarget;  // returned path might be a symlink
  }
  throw invalidRequest('...');
}
```

**Recommendation:** Merge the containment check and file open into a single atomic operation. Open with `O_NOFOLLOW` first, then validate containment from the file descriptor.

---

## HIGH: Logic Bugs and Performance Issues

### H-1. `sortProjectSummaries` Active Flag Collision

**File:** `apps/server/src/services/openclaudeData.ts:194-212`

`sortProjectSummaries` computes `latestTimestamp` as the maximum `lastUsedTimestamp` across all projects, then sets `active = true` for every project whose timestamp exactly equals this maximum. If multiple projects were used at the exact same millisecond, all of them are marked active.

```typescript
active: latestTimestamp > 0 && lastUsedTimestamp !== null && lastUsedTimestamp === latestTimestamp,
```

**Impact:** Multiple projects can appear active simultaneously, which may confuse the UI and cause incorrect data filtering.

**Recommendation:** Use a stable tiebreaker (e.g., lexicographic path comparison) to ensure exactly one project is active when timestamps collide.

### H-2. O(M\*N) Space in `longestCommonSubsequenceTable`

**File:** `apps/server/src/services/diff.ts:88-101`

The diff algorithm builds a full M×N table where M and N are the line counts of the before and after files. With the guard at `maxDiffCells = 2,000,000`, worst case is ~2M entries × 8 bytes each = ~16 MB per diff. But this is per-file, and `readSessionChangeReview` processes all changed files in a session concurrently via `Promise.all`.

For a session that modifies many large files, this can cause significant memory pressure or OOM.

**Recommendation:** Switch to a space-optimized diff algorithm (e.g., Myers diff with linear space, or patience diff). Alternatively, use the `maxDiffCells` guard to also limit space allocation.

### H-3. `looksBinary` Iterates Every Character

**File:** `apps/server/src/services/sessionChangeReview.ts:653-669`

`looksBinary` iterates over every character in the string, even after finding a null byte. For large files (up to 512 KB, the `maxChangeFileBytes` limit), this creates unnecessary overhead. More importantly, this function is called on every file in every change review.

```typescript
function looksBinary(content: string): boolean {
  if (!content) return false;
  if (content.includes('\u0000')) return true;
  let controlCharacters = 0;
  for (const char of content) {  // iterates ALL characters
    const code = char.charCodeAt(0);
    if (code < 32 && char !== '\n' && char !== '\r' && char !== '\t') {
      controlCharacters += 1;
    }
  }
  return controlCharacters / content.length > 0.05;
}
```

**Recommendation:** Sample the first N bytes instead of scanning the entire file. A 4 KB sample is sufficient to detect binary content with high confidence.

### H-4. `sessionArtifacts.ts` Has Zero Test Coverage

**File:** `apps/server/src/services/sessionArtifacts.ts` (511 lines)

This module performs recursive directory scanning with up to 10 levels of depth, reading and parsing transcript files, and making scope disambiguation decisions that affect whether backup files are read. It has no test file. Its functions (`isUnambiguousSessionArtifactScope`, `findAmbiguousSessionArtifactIds`) contain subtle logic around path resolution, session ID matching, and project-scoped filtering.

**Impact:** Any regression in this module could silently skip backup file reading or incorrectly allow cross-project data access.

**Recommendation:** Add comprehensive unit tests covering: empty directories, single-project sessions, multi-project sessions, ambiguous sessions, symlinked directories, depth limit enforcement, and transcript parsing edge cases.

### H-5. `stringFromUnknown` Inconsistency Across Files

The `stringFromUnknown` function appears in at least 5 files with slightly different behavior:

| File | Line | Behavior |
|------|------|----------|
| `openclaudeData.ts` | 729-731 | Non-empty string → value, else null |
| `sessionChangeReview.ts` | 720-722 | Non-empty string → value, else null (identical) |
| `providerProfiles.ts` | 529-531 | **Trims** the string before checking (different!) |
| `sessions.ts` | 737-739 | Non-empty string → value, else null (identical) |
| `sessionArtifacts.ts` | 504-506 | Non-empty string → value, else null (identical) |

`providerProfiles.ts` trims whitespace before checking length, while all others do not. This means `" "` would be treated as `null` in provider profiles but as a truthy string everywhere else.

**Impact:** Inconsistent whitespace handling can lead to subtle bugs. A whitespace-only string used as a provider name, model, or base URL would pass validation in most places but fail in provider profile processing.

**Recommendation:** Extract a single shared utility with consistent behavior. Decide whether trimming is always desired and apply uniformly.

### H-6. `encodeProjectPath` Collision Potential

**File:** `apps/server/src/services/paths.ts:37-39`

```typescript
export function encodeProjectPath(projectPath: string): string {
  return resolve(projectPath).replace(/[^a-zA-Z0-9]/g, '-');
}
```

All non-alphanumeric characters are replaced with `-`, so paths like `/home/user/my project` and `/home/user/my-project` both become `-home-user-my-project`. This is used for transcript directory name matching, which means:

1. Two different project paths could map to the same directory name
2. `isProjectTranscriptDirectoryName` could match the wrong project's transcripts

**Impact:** Project data from one path could be attributed to another path, leading to incorrect session listings and overview data.

**Recommendation:** This is an inherited OpenClaude convention and cannot be changed unilaterally. Document the collision risk and consider adding a warning diagnostic when two configured projects map to the same encoded name.

---

## MEDIUM: Code Quality and Maintenance Issues

### M-1. Redundant Transcript Re-reading in Session Change Review

**File:** `apps/server/src/services/sessionChangeReview.ts:66-72` and `174-204`

`readSessionChangeReview` calls `parseTranscriptFilesForProjectWithDiagnostics` to get transcript entries, then `readFileHistoryByChangedFile` reads the same transcript files again to extract file-history entries. For sessions with large transcripts (up to 10 MB each), this doubles I/O and parsing cost.

**Recommendation:** Extract file-history entries during the first parse pass, or pass the already-parsed content to the file-history extraction function.

### M-2. Monolithic `App.tsx` at 3862 Lines

**File:** `apps/web/src/App.tsx`

The entire web UI lives in a single file containing 20+ components, all state management, all page layouts, and all utility functions. This makes the file difficult to navigate, slows down IDE tooling, and increases risk of merge conflicts.

**Recommendation:** Split into separate files per component/page. A reasonable structure would be:
- `components/` for shared UI components (Header, Sidebar, StatusBanner)
- `pages/` for page components (OverviewPage, SessionsPage, etc.)
- `hooks/` for custom hooks (useApi, useLogs, etc.)
- `utils/` for utility functions (shellArg, formatBytes, etc.)

### M-3. Duplicated Utility Functions Across Server Files

The following functions are duplicated across multiple server files:

- `stringFromUnknown` — 5 files (see H-5)
- `isRecord` — 5 files
- `isNodeFileError` — 4 files
- `safeLstat` — 4 files
- `normalizeTimestamp` — 3 files
- `unique`, `sum` — 2 files each

**Recommendation:** Create a `services/utils.ts` file and import from there.

### M-4. API Contract: `overview` Response Missing `costUsd` for Individual Sessions

**File:** `apps/server/src/services/sessions.ts:397`

Session cost is only populated for the session that matches `lastSessionId`:

```typescript
costUsd: project.usage.lastSessionId === sessionId ? project.usage.costUsd : 0,
```

This means the sessions list almost always shows `costUsd: 0` for all sessions except possibly one. The overview page computes total cost correctly from session-level data, but per-session cost breakdown is not available.

**Impact:** Users cannot see how much individual sessions cost, making cost analysis impossible.

**Recommendation:** This may be an intentional limitation since OpenClaude only stores aggregate cost per project. If so, document it. If not, accumulate cost from transcript usage data.

### M-5. Log Index Cache Uses FIFO Eviction, Not LRU

**File:** `apps/server/src/services/logs.ts:492-499`

```typescript
function pruneLogIndexCache() {
  while (logIndexCache.size > maxLogIndexCacheEntries) {
    const oldestKey = logIndexCache.keys().next().value;
    if (!oldestKey) return;
    logIndexCache.delete(oldestKey);
  }
}
```

`Map` preserves insertion order, so this evicts the first-inserted (oldest) entry, not the least-recently-used. If a user frequently toggles between two log files but other files were cached in between, the actively-used file could be evicted.

**Recommendation:** Use a proper LRU cache, or at minimum move accessed entries to the end of the map on cache hit (delete and re-insert).

### M-6. `buildOverviewResponse` Reads Full Session List and 250 Log Lines Per Request

**File:** `apps/server/src/http/server.ts:197-206`

Every overview request:
1. Reads all project summaries to find the project
2. Reads all transcript files and parses all sessions
3. Opens and reads up to 250 log lines
4. Reads the active provider

No caching is applied to any of these operations. For users with many projects and sessions, this can be slow.

**Recommendation:** Add response caching with short TTL (e.g., 2-5 seconds) or conditional ETag/Last-Modified headers.

### M-7. `formatRelative` Uses UTC Date Without Timezone Awareness

**File:** `apps/server/src/services/openclaudeData.ts:688-705`

`formatRelative` computes delta from `now.getTime() - timestamp`, which is correct for relative times. But `new Date(timestamp).toISOString().slice(0, 10)` produces a UTC date string. If a user's last activity was at 11:30 PM local time but after midnight UTC, the displayed date will be tomorrow's date from the user's perspective.

**Recommendation:** Use local date formatting for the fallback date display, or document that dates are UTC.

### M-8. `isLoopbackBrowserOrigin` Accepts `::1` Hostname Without Brackets

**File:** `apps/server/src/http/server.ts:386-397`

```typescript
hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
```

The `URL` constructor normalizes IPv6 addresses with brackets, so `hostname` for `http://[::1]:43110` is `[::1]` (with brackets). The check for `::1` (without brackets) would only match if someone manually constructs an origin string like `http://::1:43110` which is not a valid URL. This is harmless but adds dead code to the check.

**Recommendation:** Remove `'::1'` from the check list since it cannot be produced by the URL parser.

### M-9. No Request Timeout on Server Endpoints

**File:** `apps/server/src/http/server.ts`

Fastify does not set a default request timeout. For endpoints that do heavy filesystem I/O (overview, session details, change review), a hung filesystem operation (e.g., NFS stall) could block a connection indefinitely.

**Recommendation:** Configure Fastify's `requestTimeout` option (e.g., 30 seconds) or use per-route timeouts.

---

## LOW: Edge Cases and Minor Issues

### L-1. `isSameOrChildPath` Duplicated With Inconsistent Implementation

Two different implementations exist:

1. `apps/server/src/services/paths.ts:55-58` — uses `sep`-based string prefix
2. `apps/server/src/services/sessionChangeReview.ts:695-698` — uses `relative()` comparison

The `relative()` approach is more robust (handles `..` traversal correctly), while the string prefix approach can be fooled by paths like `/home/user/my-project-backup` when checking against `/home/user/my-project`.

**Recommendation:** Unify on the `relative()` approach in a shared utility.

### L-2. Worktree Directory Name Matching May Miss Edge Cases

**File:** `apps/server/src/services/paths.ts:41-47`

```typescript
directoryName.startsWith(`${encodedProjectPath}--claude-worktrees-`)
```

This hard-codes the worktree naming pattern. If OpenClaude changes the worktree naming convention, this will silently stop matching worktree transcripts.

**Recommendation:** Consider also checking if the directory contains transcripts for the project by examining actual transcript file contents (with a depth limit).

### L-3. `looksBinary` Can False-Positive on UTF-8 Multibyte Characters

**File:** `apps/server/src/services/sessionChangeReview.ts:653-669`

`char.charCodeAt(0)` returns the UTF-16 code unit. For characters outside the BMP (e.g., emojis), the first code unit can be a surrogate pair value (0xD800-0xDFFF), which is > 127 but not a control character. However, for characters like `\u{0080}` (padding character), `charCodeAt(0)` returns 128, which is > 32 and not flagged. The 5% threshold provides reasonable safety margin but is not theoretically sound.

**Recommendation:** This is a pragmatic implementation and the 5% threshold provides adequate protection. No action needed unless binary detection accuracy becomes an issue.

### L-4. `safeSessionBackupPath` Allows Session IDs With Dots

**File:** `apps/server/src/services/sessionChangeReview.ts:467-474`

`safeSessionBackupPath` checks for `..`, `/`, and `\\` but does not validate the session ID format against the expected UUID-like pattern. A session ID like `.hidden` would be allowed and could potentially match hidden directories in the file-history structure.

**Impact:** Low, since `safeChildPath` still performs prefix containment checking.

**Recommendation:** Add a format validation regex for session IDs (e.g., `/^[A-Za-z0-9._-]+$/`).

### L-5. `searchLogs` Loads Entire Log Into Memory for Search

**File:** `apps/server/src/services/logs.ts:104-178`

`searchLogs` iterates through the entire log file in windows of `maxWindowCount` (1000) lines. For very large log files, this requires keeping the full index in memory and performing sequential reads across the entire file. The search is also performed on redacted text, which means the original log content is fully parsed even if most of it doesn't match.

**Recommendation:** Consider streaming search or early termination when enough results are found for forward pagination.

### L-6. `readGitHead` Reads `.git` File Without Size Limit

**File:** `apps/server/src/services/openclaudeData.ts:627-645`

`readGitHead` uses `readFile` without a size limit. If `.git` is a file (worktree case), its contents are read in full. If `.git/HEAD` exists, it is also read without a size limit. While these files are typically tiny, a corrupted or malicious file could cause excessive memory usage.

**Recommendation:** Use `readBoundedTextFile` with a reasonable limit (e.g., 4096 bytes) for git file reads.

---

## Testing Gaps

### T-1. `sessionArtifacts.ts` — No Tests

As noted in H-4, the entire artifact scope resolution module has no test coverage. This is the highest-priority testing gap.

### T-2. CLI Entry Point — No Tests

The CLI (`apps/server/src/cli.ts`) handles argument parsing, server startup, port binding, and graceful shutdown. No tests exist for argument validation, error handling, or signal handling.

### T-3. Web Components — Minimal Test Coverage

`apps/web/src/App.test.tsx` exists but covers only a fraction of the 20+ components in App.tsx. The following components have no test coverage:

- ProviderProfileTemplateModal
- ProviderTemplateSelect
- LogFileSelect
- UsageOverviewChart
- DiagnosticsPage
- ControlCenterPage

### T-4. Error Path Testing in Server

Server tests focus on happy paths. Missing error path tests:

- Transcript files with malformed JSON (partially covered)
- Symlink attacks on file-history paths
- Concurrent access to the same log file
- Projects with special characters in paths

### T-5. Integration Tests for Session Change Review

The session change review feature (the most complex server feature) relies on transcript parsing, file-history reading, diff generation, and artifact scope resolution working together correctly. No integration test covers the full pipeline with realistic fixtures.

---

## Improvement Opportunities

### I-1. Shared Utility Module for Server

Extract duplicated utilities (`stringFromUnknown`, `isRecord`, `isNodeFileError`, `safeLstat`, `normalizeTimestamp`, `unique`, `sum`, `intFromUnknown`) into `apps/server/src/services/utils.ts`. This eliminates ~200 lines of duplication and ensures consistent behavior.

### I-2. Split `App.tsx` Into Modules

Break the 3862-line monolith into focused modules. Priority order:
1. Page components (each page gets its own file)
2. Shared UI components (Header, Sidebar, StatusBanner)
3. Custom hooks (useApi, useLogs, useWorkspace)
4. Utility functions (shellArg, formatBytes, formatDuration)

### I-3. Add `AbortController` Support to Server Endpoints

Fastify supports request lifecycle hooks. Adding `AbortController` integration would allow canceling filesystem operations when the client disconnects, freeing resources faster.

### I-4. Add Response Caching for Frequently-Requested Data

The overview endpoint re-reads all transcripts on every request. A short-lived cache (2-5 seconds) would dramatically reduce I/O for dashboard refresh intervals without stale data concerns.

### I-5. Consider Streaming for Large Transcript Parsing

Transcript files can be up to 10 MB. Currently they are read entirely into memory and split into lines. For projects with many sessions, a streaming JSONL parser would reduce peak memory usage.

### I-6. Add Request Logging for Debugging

The server runs with `logger: false`. Adding structured request logging (method, path, status, duration) behind a `--verbose` flag would help debugging production issues without impacting normal performance.

---

## Priority Matrix

| Priority | Issue | Effort | Impact |
|----------|-------|--------|--------|
| P0 | C-1: TOCTOU in safeFile | Medium | Security |
| P0 | C-2: safeChildPath symlinks | Small | Security |
| P0 | C-3: assertContainedPath | Medium | Security |
| P1 | H-4: sessionArtifacts tests | Medium | Correctness |
| P1 | H-1: Active flag collision | Small | Correctness |
| P1 | H-5: stringFromUnknown inconsistency | Small | Consistency |
| P2 | H-2: O(M*N) diff space | Medium | Performance |
| P2 | H-3: looksBinary perf | Small | Performance |
| P2 | M-1: Redundant transcript reads | Medium | Performance |
| P2 | M-6: Overview response caching | Medium | Performance |
| P2 | M-9: Request timeouts | Small | Reliability |
| P3 | H-6: encodeProjectPath collisions | Small | Correctness |
| P3 | M-2: Split App.tsx | Large | Maintainability |
| P3 | M-3: Duplicated utilities | Small | Maintainability |
| P3 | I-1: Shared utility module | Small | Maintainability |
| P3 | T-1 through T-5: Testing gaps | Medium | Reliability |
| P4 | All LOW and remaining items | varies | Polish |

---

## Proposed Implementation Order

### Phase 1: Security Hardening (P0)
1. Fix TOCTOU in `readContainedBoundedTextFile` — use file handle as the source of truth
2. Add `realpath` to `safeChildPath` or switch to fd-based validation
3. Merge `assertContainedPath` into the atomic open-and-validate flow

### Phase 2: Correctness (P1)
4. Add tiebreaker to `sortProjectSummaries` for active flag
5. Unify `stringFromUnknown` into shared utility
6. Add tests for `sessionArtifacts.ts`

### Phase 3: Performance (P2)
7. Optimize `looksBinary` with sampling
8. Reduce to single transcript parse pass in session change review
9. Add basic response caching for overview endpoint
10. Configure request timeouts

### Phase 4: Maintainability (P3)
11. Extract shared utilities module
12. Split `App.tsx` into focused modules
13. Add missing tests for web components
14. Document encodeProjectPath collision risk

---

## Scope Boundaries

This audit covers all source code in the repository as of commit `85c9cba` (v0.3.0 release). The following are explicitly **out of scope**:

- Changing the read-only MVP contract
- Adding write-capable endpoints
- Replacing core dependencies (React, Fastify, etc.)
- Modifying the public API contract types in ways that break backward compatibility
- External infrastructure (Cloudflare, npm publishing pipeline)

All recommendations respect the project's architectural constraints as documented in `AGENTS.md` and `docs/architecture.md`.
