/**
 * pi-cache-optimizer
 * Global extension for context caching optimization, ignore-file management,
 * repo-hop detection, compact watchdog, and warm KV-cache provider routing.
 *
 * Features:
 *   1. Live cache telemetry  (message_end → real usage: hit-rate, tokens, cost)
 *   2. Auto-compact watchdog  (turn_end → ctx.getContextUsage + ctx.compact)
 *   3. Cache-bust guard        (tool_call → block/warn reads of ignored/huge files)
 *   + .claudecodeignore auto-injection, repo-hop detection, /cache-status command
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";
import chalk from "chalk";

// ─────────────────────────────────────────────────────────────────────────────
// Constants & Types
// ─────────────────────────────────────────────────────────────────────────────

const STATE_FILE = join(homedir(), ".pi", "cache_optimizer_state.json");
const STATE_DIR = join(homedir(), ".pi");

interface CacheOptimizerState {
  lastCwd: string;
  lastTimestamp: number; // epoch ms
  turnCount: number;
  sessionStartTime: number;
}

/** In-memory, per-process cache/cost telemetry (not persisted). */
interface CacheTelemetry {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  assistantMessages: number;
}

interface ContextUsageSnapshot {
  percent?: number | null;
  tokens?: number | null;
  contextWindow?: number | null;
}

const IGNORE_TEMPLATE = `# pi-cache-optimizer auto-generated strict ignore file
# Protects context payload from build artifacts and noise

# Lockfiles & dependency manifests
package-lock.json
yarn.lock
pnpm-lock.yaml
Cargo.lock
composer.lock
Gemfile.lock
go.sum
*.lock

# Build & distribution directories
/dist/
/build/
/target/
/out/
/public/build/
/.next/
/.nuxt/
/.vitepress/cache/
/.astro/

# Package managers & node
node_modules/
bower_components/
jspm_packages/

# Logs & debug output
*.log
logs/
npm-debug.log*
yarn-debug.log*
yarn-error.log*
lerna-debug.log*
*.tsbuildinfo

# Coverage & test artifacts
coverage/
.nyc_output/
*.lcov
__coverage__/
test-results/
playwright-report/
playwright/.cache/

# Temporary / cache directories
.cache/
.tmp/
.temp/
tmp/
temp/
.eslintcache
.stylelintcache
.prettiercache
*.tsbuildinfo
.swc/
.turbo/
.parcel-cache/

# OS & editor noise
.DS_Store
Thumbs.db
.idea/
.vscode/
*.sublime-project
*.sublime-workspace

# Misc heavy or frequently changing files
.env.local
.env.*.local
*.min.js
*.min.css
`;

// Thresholds for compact watchdog
const COMPACT_TURN_THRESHOLD = 18;           // turns (fallback when token usage unknown)
const COMPACT_TIME_MS = 45 * 60 * 1000;      // 45 minutes continuous

// Auto-compact context-pressure thresholds (feature #2)
const AUTO_COMPACT_PERCENT = 78;             // trigger auto-compaction at 78% of context window
const WARN_COMPACT_PERCENT = 65;             // gentle nudge at 65%
const AUTO_COMPACT_MIN_TOKENS = 8_000;       // below this, Pi reports "nothing to compact"
const AUTO_COMPACT_ENABLED = true;           // when false, only warns instead of compacting

// Cache-bust guard thresholds (feature #3)
const GUARD_ENABLED = true;
const GUARD_BLOCK_IGNORED = true;            // hard-block reads that match .claudecodeignore
const GUARD_MAX_FILE_BYTES = 256 * 1024;     // warn/block reads of files larger than 256 KB

// Repo-hop warning window
const REPO_HOP_WINDOW_MS = 3 * 60 * 60 * 1000; // 3 hours

// ─────────────────────────────────────────────────────────────────────────────
// State helpers (global, survives reloads via JSON on disk)
// ─────────────────────────────────────────────────────────────────────────────

function loadState(): CacheOptimizerState {
  try {
    if (existsSync(STATE_FILE)) {
      const raw = readFileSync(STATE_FILE, "utf8");
      return JSON.parse(raw) as CacheOptimizerState;
    }
  } catch {
    // fallthrough to default
  }
  return {
    lastCwd: "",
    lastTimestamp: 0,
    turnCount: 0,
    sessionStartTime: Date.now(),
  };
}

function saveState(state: CacheOptimizerState): void {
  try {
    if (!existsSync(STATE_DIR)) {
      mkdirSync(STATE_DIR, { recursive: true });
    }
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    // Non-fatal; we just lose persistence for one restart
    console.warn("[pi-cache-optimizer] Failed to persist state:", err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// .claudecodeignore / .cursorignore auto-injection
// ─────────────────────────────────────────────────────────────────────────────

function ensureIgnoreFile(cwd: string, ctx: ExtensionContext): void {
  const claudecode = join(cwd, ".claudecodeignore");
  const cursor = join(cwd, ".cursorignore");

  // If either already exists we do NOT overwrite (respect user choice)
  if (existsSync(claudecode) || existsSync(cursor)) {
    return;
  }

  try {
    writeFileSync(claudecode, IGNORE_TEMPLATE, "utf8");
    ctx.ui.notify(
      chalk.green("✓ pi-cache-optimizer: Created .claudecodeignore (strict build-artifact policy)"),
      "info"
    );
  } catch (err) {
    ctx.ui.notify(
      chalk.yellow(`pi-cache-optimizer: Could not create .claudecodeignore: ${err}`),
      "warn"
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ignore-pattern matching (shared by the cache-bust guard)
// ─────────────────────────────────────────────────────────────────────────────

/** Load and cache parsed ignore patterns per cwd. */
const ignoreCache = new Map<string, string[]>();

function loadIgnorePatterns(cwd: string): string[] {
  if (ignoreCache.has(cwd)) return ignoreCache.get(cwd)!;

  const patterns: string[] = [];
  for (const name of [".claudecodeignore", ".cursorignore"]) {
    const file = join(cwd, name);
    if (existsSync(file)) {
      try {
        for (const line of readFileSync(file, "utf8").split("\n")) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith("#")) patterns.push(trimmed);
        }
      } catch {
        // ignore unreadable ignore file
      }
    }
  }
  // Fall back to template patterns so the guard works even before a file lands on disk.
  if (patterns.length === 0) {
    for (const line of IGNORE_TEMPLATE.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) patterns.push(trimmed);
    }
  }
  ignoreCache.set(cwd, patterns);
  return patterns;
}

/** Convert a single gitignore-ish glob to a RegExp tested against a relative posix path. */
function patternToRegExp(pattern: string): RegExp {
  let p = pattern;
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.slice(0, -1);
  const anchored = p.startsWith("/");
  if (anchored) p = p.slice(1);

  // Escape regex specials except glob wildcards * and ?
  const escaped = p
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");

  // Anchored patterns match from root; otherwise match any path segment boundary.
  const head = anchored ? "^" : "(^|/)";
  // Directory patterns match the dir and everything under it.
  const tail = dirOnly ? "(/|$)" : "($|/)";
  return new RegExp(head + escaped + tail);
}

/** Returns the matching pattern if `relPath` (posix, repo-relative) is ignored, else null. */
function matchedIgnorePattern(relPath: string, patterns: string[]): string | null {
  const norm = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  for (const pattern of patterns) {
    try {
      if (patternToRegExp(pattern).test(norm)) return pattern;
    } catch {
      // skip malformed pattern
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Repo-hop detection & LRU cache warning
// ─────────────────────────────────────────────────────────────────────────────

function checkRepoHop(currentCwd: string, ctx: ExtensionContext, state: CacheOptimizerState): void {
  const now = Date.now();
  const prev = state.lastCwd;
  const prevTs = state.lastTimestamp;

  if (prev && prev !== resolve(currentCwd) && now - prevTs < REPO_HOP_WINDOW_MS) {
    const elapsedMin = Math.round((now - prevTs) / 60000);
    ctx.ui.notify(
      chalk.hex("#ffaa00")(
        `⚠ Repo switch detected (${elapsedMin}m ago). ` +
        `Stick to one repo for best OpenRouter LRU / KV cache reuse, or run parallel branches.`
      ),
      "warn"
    );
  }

  // Always update state
  state.lastCwd = resolve(currentCwd);
  state.lastTimestamp = now;
  saveState(state);
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache telemetry helpers (feature #1)
// ─────────────────────────────────────────────────────────────────────────────

function freshTelemetry(): CacheTelemetry {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, assistantMessages: 0 };
}

/**
 * Cache hit rate = cacheRead / (uncached input + cacheRead + cacheWrite). 0..1, or null if no data.
 * Denominator is the full prompt token count (matches Pi's native footer `CH` calculation);
 * omitting cacheWrite would understate the prompt size and inflate the rate.
 */
function hitRate(t: CacheTelemetry): number | null {
  const denom = t.input + t.cacheRead + t.cacheWrite;
  if (denom <= 0) return null;
  return t.cacheRead / denom;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function contextPercent(usage: ContextUsageSnapshot | null | undefined): number | null {
  const pct = usage?.percent;
  return typeof pct === "number" && Number.isFinite(pct) ? pct : null;
}

function contextTokens(usage: ContextUsageSnapshot | null | undefined): number | null {
  const tokens = usage?.tokens;
  return typeof tokens === "number" && Number.isFinite(tokens) ? tokens : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Compact watchdog (turn + time based fallback)
// ─────────────────────────────────────────────────────────────────────────────

function maybeNudgeCompact(ctx: ExtensionContext, state: CacheOptimizerState): void {
  const now = Date.now();
  const turns = state.turnCount;
  const elapsed = now - state.sessionStartTime;

  if (turns >= COMPACT_TURN_THRESHOLD || elapsed >= COMPACT_TIME_MS) {
    ctx.ui.notify(
      chalk.cyan(
        `💡 Consider running /compact soon — ${turns} turns or ${Math.round(
          elapsed / 60000
        )}m elapsed. Drops dead weight and preserves cache efficiency.`
      ),
      "info"
    );
    // Reset counter after warning so we don't spam
    state.turnCount = 0;
    state.sessionStartTime = now;
    saveState(state);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Extension Factory
// ─────────────────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Load persistent state once per process lifetime
  const state = loadState();
  state.sessionStartTime = Date.now(); // reset per process start
  saveState(state);

  // Per-process telemetry + control flags
  let telemetry = freshTelemetry();
  let warnedThisSession = false;   // context-pressure warning already shown
  let compacting = false;          // guard against re-entrant auto-compaction

  // ── 1. Session Start Hook ────────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    // Always ensure strict ignore file exists (global behavior)
    ensureIgnoreFile(ctx.cwd, ctx);

    // Invalidate the ignore-pattern cache for this cwd (file may have changed)
    ignoreCache.delete(ctx.cwd);

    // Repo-hop detection
    checkRepoHop(ctx.cwd, ctx, state);

    // Reset per-session counters + telemetry
    state.turnCount = 0;
    saveState(state);
    telemetry = freshTelemetry();
    warnedThisSession = false;
  });

  // ── Feature #1: Live cache telemetry (accumulated for /cache-status) ──────
  // Note: we intentionally do NOT render a widget hit-rate line — Pi's native
  // footer already shows the latest cache hit rate as `CH`. Duplicating it here
  // only invited a second, differently-computed (and inflated) number.
  pi.on("message_end", async (event, _ctx) => {
    if (event.message.role !== "assistant") return;
    const u = event.message.usage;
    if (!u) return;

    telemetry.input += u.input ?? 0;
    telemetry.output += u.output ?? 0;
    telemetry.cacheRead += u.cacheRead ?? 0;
    telemetry.cacheWrite += u.cacheWrite ?? 0;
    telemetry.cost += u.cost?.total ?? 0;
    telemetry.assistantMessages += 1;
  });

  // ── 2. Turn Counter + context-pressure auto-compaction ───────────────────
  pi.on("turn_end", async (_event, ctx) => {
    state.turnCount += 1;
    saveState(state);

    // Real context-pressure signal (preferred over turn/time heuristic)
    const usage = ctx.getContextUsage();
    const pct = contextPercent(usage);
    const tokens = contextTokens(usage);

    if (pct !== null) {
      const tooSmallToCompact = tokens !== null && tokens < AUTO_COMPACT_MIN_TOKENS;

      if (
        AUTO_COMPACT_ENABLED &&
        pct >= AUTO_COMPACT_PERCENT &&
        tooSmallToCompact &&
        !warnedThisSession &&
        !compacting
      ) {
        warnedThisSession = true;
        ctx.ui.notify(
          chalk.cyan(
            `💡 Context at ${pct.toFixed(0)}% (${fmtTokens(tokens!)} tok), ` +
            `below the ${fmtTokens(AUTO_COMPACT_MIN_TOKENS)}-token auto-compaction floor.`
          ),
          "info"
        );
        return;
      }

      if (AUTO_COMPACT_ENABLED && pct >= AUTO_COMPACT_PERCENT && !tooSmallToCompact && !compacting) {
        compacting = true;
        ctx.ui.notify(
          chalk.cyan(
            `🗜  Context at ${pct.toFixed(0)}% — auto-compacting to preserve cache & headroom…`
          ),
          "info"
        );
        ctx.compact({
          customInstructions:
            "Preserve the current task, recent file edits, and active decisions. Drop stale tool output.",
          onComplete: () => {
            compacting = false;
            warnedThisSession = false;
            ctx.ui.notify(chalk.green("✓ Auto-compaction complete."), "info");
          },
          onError: (err) => {
            compacting = false;
            ctx.ui.notify(chalk.yellow(`Auto-compaction failed: ${err.message}`), "warn");
          },
        });
        return;
      }

      if (pct >= WARN_COMPACT_PERCENT && !warnedThisSession && !compacting) {
        warnedThisSession = true;
        ctx.ui.notify(
          chalk.cyan(
            `💡 Context at ${pct.toFixed(0)}% (${fmtTokens(tokens ?? 0)} tok). ` +
            `Auto-compaction will trigger at ${AUTO_COMPACT_PERCENT.toFixed(0)}%.`
          ),
          "info"
        );
      }
      return; // token signal available → skip the legacy heuristic
    }

    // Fallback: turn/time heuristic when token usage is unknown
    maybeNudgeCompact(ctx, state);
  });

  // ── Feature #3: Cache-bust guard on tool reads ───────────────────────────
  pi.on("tool_call", async (event, ctx) => {
    if (!GUARD_ENABLED) return;

    // Resolve the candidate path for read / bash-cat style calls
    let target: string | null = null;
    if (isToolCallEventType("read", event)) {
      target = event.input.path;
    } else if (isToolCallEventType("bash", event)) {
      // Best-effort: catch `cat <file>` on a single ignored/huge file
      const m = event.input.command?.match(/^\s*cat\s+(?:-\S+\s+)*("?)([^"|;&]+)\1\s*$/);
      if (m) target = m[2].trim();
    }
    if (!target) return;

    const abs = resolve(ctx.cwd, target);
    const rel = abs.startsWith(ctx.cwd) ? abs.slice(ctx.cwd.length + 1) : target;

    // a) ignored-file match
    const patterns = loadIgnorePatterns(ctx.cwd);
    const hit = matchedIgnorePattern(rel, patterns) ?? matchedIgnorePattern(basename(abs), patterns);
    if (hit) {
      const msg = `cache-optimizer: "${rel}" matches ignore rule "${hit}" — reading it bloats context and busts the cached prefix.`;
      if (GUARD_BLOCK_IGNORED) {
        return { block: true, reason: msg + " Blocked. Remove the rule or read a specific slice if truly needed." };
      }
      ctx.ui.notify(chalk.yellow("⚠ " + msg), "warn");
      return;
    }

    // b) oversized-file guard
    try {
      if (existsSync(abs)) {
        const size = statSync(abs).size;
        if (size > GUARD_MAX_FILE_BYTES) {
          const kb = Math.round(size / 1024);
          return {
            block: true,
            reason:
              `cache-optimizer: "${rel}" is ${kb} KB (> ${Math.round(GUARD_MAX_FILE_BYTES / 1024)} KB). ` +
              `Reading it whole wrecks cache efficiency. Use read offset/limit or grep instead.`,
          };
        }
      }
    } catch {
      // stat failure is non-fatal; let the read proceed
    }
  });

  // ── 3. /cache-status command ──────────────────────────────────────────────
  pi.registerCommand("cache-status", {
    description: "Show pi-cache-optimizer state, live cache telemetry, and recommendations",
    handler: async (_args, ctx) => {
      const s = loadState();
      const cwd = ctx.cwd;
      const hr = hitRate(telemetry);
      const usage = ctx.getContextUsage();
      const pct = contextPercent(usage);

      ctx.ui.notify(
        [
          chalk.bold("pi-cache-optimizer status"),
          "",
          chalk.bold("Cache telemetry (this session):"),
          `  Hit rate:     ${hr === null ? "—" : (hr * 100).toFixed(1) + "%"}`,
          `  Cache read:   ${fmtTokens(telemetry.cacheRead)} tok`,
          `  Cache write:  ${fmtTokens(telemetry.cacheWrite)} tok`,
          `  Input/Output: ${fmtTokens(telemetry.input)} / ${fmtTokens(telemetry.output)} tok`,
          `  Est. cost:    $${telemetry.cost.toFixed(4)} over ${telemetry.assistantMessages} msgs`,
          "",
          chalk.bold("Context window:"),
          pct !== null
            ? `  Usage:        ${pct.toFixed(0)}% (${fmtTokens(contextTokens(usage) ?? 0)}/${fmtTokens(usage.contextWindow ?? 0)})`
            : "  Usage:        (unknown)",
          `  Auto-compact: ${AUTO_COMPACT_ENABLED ? `at ${AUTO_COMPACT_PERCENT.toFixed(0)}% (${fmtTokens(AUTO_COMPACT_MIN_TOKENS)} token floor)` : "disabled"}`,
          "",
          chalk.bold("Session:"),
          `  Last repo:    ${s.lastCwd || "(none)"}`,
          `  Turns:        ${s.turnCount}`,
          `  Age:          ${Math.round((Date.now() - s.sessionStartTime) / 60000)}m`,
          `  Guard:        ${GUARD_ENABLED ? `on (block ignored: ${GUARD_BLOCK_IGNORED}, max ${Math.round(GUARD_MAX_FILE_BYTES / 1024)}KB)` : "off"}`,
          `  .claudecodeignore present: ${existsSync(join(cwd, ".claudecodeignore"))}`,
        ].join("\n"),
        "info"
      );
    },
  });
}
