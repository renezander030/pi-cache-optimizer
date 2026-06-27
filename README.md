# pi-cache-optimizer

Global Pi extension providing:

- **Live cache telemetry** — real per-message cache read/write, token, and cost tracking (surfaced via `/cache-status`; the hit-rate itself is already shown by Pi's native footer as `CH`)
- **Context-pressure auto-compaction** — triggers `/compact` automatically at a token threshold (not just a text nudge)
- **Cache-bust guard** — blocks reads of ignored or oversized files that would bloat context and invalidate the cached prefix
- Auto-injection of strict `.claudecodeignore` (and `.cursorignore` awareness)
- Repository-hop detection with 3-hour window warning
- Internal turn/time watchdog fallback that gently nudges `/compact`
- Recommended `models.json` overrides for warm KV-cache OpenRouter routing

## Installation & Activation (Global)

Run these commands exactly once on your machine:

```bash
# 1. Ensure the extension package is in the global extensions directory
mkdir -p ~/.pi/agent/extensions/pi-cache-optimizer/src

# 2. Install runtime dependencies (chalk for colored notifications)
cd ~/.pi/agent/extensions/pi-cache-optimizer
npm install --omit=dev

# 3. Hot-reload all global extensions (or restart your terminal session)
pi --reload   # or simply start a fresh `pi` session
```

The extension lives at:

```
~/.pi/agent/extensions/pi-cache-optimizer/
├── package.json
├── src/
│   └── index.ts
└── node_modules/...
```

It is **project-independent** — once installed it applies to every `pi` invocation regardless of working directory.

## Global Model Routing (OpenRouter Warm KV Cache)

Merge the following structure into your global model configuration. The file is located at:

`~/.pi/agent/models.json`   (or `settings.json` under the `"models"` key)

```jsonc
{
  "routing": {
    "preferProviders": ["openrouter"],
    "providerHints": {
      "openrouter": {
        // Prioritize high-TTL, warm KV-cache backends
        "order": ["together", "deepinfra", "fireworks", "groq"],
        "cache": {
          "strategy": "lru",
          "maxAgeHours": 12,
          "warmOnStart": true
        }
      }
    }
  },
  "providers": {
    "openrouter": {
      "apiKey": "$OPENROUTER_API_KEY",
      "baseUrl": "https://openrouter.ai/api/v1",
      "models": [
        {
          "id": "anthropic/claude-opus-4.8",
          "name": "Claude Opus 4.8 (OpenRouter, latest)",
          "reasoning": true,
          "input": ["text", "image"],
          "cost": { "input": 15, "output": 75, "cacheRead": 1.5, "cacheWrite": 18.75 },
          "contextWindow": 200000,
          "maxTokens": 64000,
          "cacheControl": {
            "supported": true,
            "ttlSeconds": 3600
          }
        },
        {
          "id": "openai/gpt-5.5",
          "name": "GPT-5.5 (OpenRouter, latest)",
          "reasoning": true,
          "input": ["text", "image"],
          "cost": { "input": 10, "output": 40, "cacheRead": 1.0, "cacheWrite": 10 },
          "contextWindow": 256000,
          "maxTokens": 128000,
          "cacheControl": {
            "supported": true,
            "ttlSeconds": 3600
          }
        }
      ]
    }
  }
}
```

Place the snippet in your `~/.pi/agent/models.json` (create the file if it does not exist). The `preferProviders` + `providerHints` block ensures that for any model served through OpenRouter, Pi will route to the warmest KV-cache backends first (Together → DeepInfra → Fireworks → Groq).

## Feature Details

### 1. Live cache telemetry (`message_end`)

Each assistant message reports real `usage` (input, output, `cacheRead`, `cacheWrite`, cost). The extension accumulates these per session and exposes them via `/cache-status`.

Hit rate = `cacheRead / (uncached input + cacheRead + cacheWrite)` — i.e. the share of the full prompt served from cache. This uses the **same formula** as Pi's native footer `CH` (the footer reports the latest message; `/cache-status` reports the session-cumulative rate). The extension no longer renders its own widget line, since that only duplicated `CH` with a second, differently-computed (inflated) number that dropped the `cacheWrite` term from the denominator. A sudden drop in `CH` is your earliest signal that something busted the cached prefix (a repo hop, a volatile prompt, or a large file read).

### 2. Context-pressure auto-compaction (`turn_end`)

Instead of guessing from turn count, the extension reads `ctx.getContextUsage()` after every turn:

- At **65%** of the context window → a one-time gentle nudge.
- At **78%** → automatic `ctx.compact()` with cache-preserving instructions (keep current task, recent edits, active decisions; drop stale tool output).

Thresholds and the on/off switch live at the top of `src/index.ts` (`AUTO_COMPACT_PERCENT`, `WARN_COMPACT_PERCENT`, `AUTO_COMPACT_MIN_TOKENS`, `AUTO_COMPACT_ENABLED`). Pi reports `ContextUsage.percent` on a 0-100 scale, so these constants use the same scale. When token usage is unavailable (e.g. right after compaction) it falls back to the legacy turn/time heuristic.

### 3. Cache-bust guard (`tool_call`)

Makes `.claudecodeignore` actually enforce something. On every `read` (and best-effort on `bash cat <file>`):

- If the target matches an ignore pattern → **blocked** with a clear reason (configurable via `GUARD_BLOCK_IGNORED`).
- If the file exceeds **256 KB** → **blocked** with advice to use `read` offset/limit or `grep` instead (`GUARD_MAX_FILE_BYTES`).

This closes the loop: the policy the ignore file describes is now enforced at read time, protecting the cached prefix for the rest of the session.

## Lifecycle Hooks Used

- `session_start` – injects `.claudecodeignore`, detects repo hops, resets telemetry
- `message_end` – accumulates real cache/cost telemetry for `/cache-status`
- `turn_end` – reads real context usage; warns at 65%, auto-compacts at 78% (turn/time fallback otherwise)
- `tool_call` – cache-bust guard blocking ignored / oversized file reads

All behavior is completely global and non-project-specific.

## Commands Added

- `/cache-status` – shows live cache telemetry (hit-rate, tokens, cost), context-window usage, guard settings, last repo, turns, and session age.

## Maintenance

To update the ignore template or thresholds, simply edit `src/index.ts` and run `/reload` inside any Pi session. No reinstall needed.
