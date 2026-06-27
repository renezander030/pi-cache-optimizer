/**
 * pi-cache-optimizer
 * Global extension for context caching optimization, ignore-file management,
 * repo-hop detection, compact watchdog, and warm KV-cache provider routing.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
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
const COMPACT_TURN_THRESHOLD = 18;           // turns
const COMPACT_TIME_MS = 45 * 60 * 1000;      // 45 minutes continuous

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
// Compact watchdog (turn + time based)
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

  // ── 1. Session Start Hook ────────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    // Always ensure strict ignore file exists (global behavior)
    ensureIgnoreFile(ctx.cwd, ctx);

    // Repo-hop detection
    checkRepoHop(ctx.cwd, ctx, state);

    // Reset turn counter on fresh session
    state.turnCount = 0;
    saveState(state);
  });

  // ── 2. Turn Counter (for compact watchdog) ───────────────────────────────
  pi.on("turn_end", async (_event, ctx) => {
    state.turnCount += 1;
    saveState(state);
    maybeNudgeCompact(ctx, state);
  });

  // ── 3. (Optional) expose a quick status command ──────────────────────────
  pi.registerCommand("cache-status", {
    description: "Show pi-cache-optimizer state and recommendations",
    handler: async (_args, ctx) => {
      const s = loadState();
      const cwd = ctx.cwd;
      ctx.ui.notify(
        [
          chalk.bold("pi-cache-optimizer status"),
          `Last repo: ${s.lastCwd || "(none)"}`,
          `Turns this session: ${s.turnCount}`,
          `Session age: ${Math.round((Date.now() - s.sessionStartTime) / 60000)}m`,
          `.claudecodeignore present: ${existsSync(join(cwd, ".claudecodeignore"))}`,
        ].join("\n"),
        "info"
      );
    },
  });
}