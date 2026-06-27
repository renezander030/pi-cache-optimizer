# pi-cache-optimizer

Global Pi extension providing:

- Auto-injection of strict `.claudecodeignore` (and `.cursorignore` awareness)
- Repository-hop detection with 3-hour window warning
- Internal turn/time watchdog that gently nudges `/compact`
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

## Lifecycle Hooks Used

- `session_start` – injects `.claudecodeignore`, detects repo hops
- `turn_end` – increments internal watchdog counter and may emit a compact reminder

All behavior is completely global and non-project-specific.

## Commands Added

- `/cache-status` – shows the internal optimizer state, last repo, turns, etc.

## Maintenance

To update the ignore template or thresholds, simply edit `src/index.ts` and run `/reload` inside any Pi session. No reinstall needed.