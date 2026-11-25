# SmokeProof

**Real-browser pre-ship verification for AI coding agents and humans.**  
Don't trust *"tsc passed"* — crawl your running app in headless Chromium, catch silent runtime bugs, mobile overflows, dead buttons, broken images, and leaked secrets, and get annotated screenshots + machine-readable JSON fixes.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-339933.svg)](https://nodejs.org/)
[![MCP Compatible](https://img.shields.io/badge/MCP-compatible-6366f1.svg)](#mcp-server-for-claude-code-cursor-antigravity--codex)
[![Agent Skills Standard](https://img.shields.io/badge/Agent_Skills-SKILL.md-black.svg)](#install-as-an-agent-skill)

---

## Why SmokeProof?

AI coding agents are great at making code compile — and notorious for shipping broken runtime behavior:

| What slips past `tsc` & unit tests | What SmokeProof catches in a real browser |
| --- | --- |
| Silent `console.error` & uncaught exceptions | Captures `pageerror`, `console.error`, and framework hydration warnings |
| Broken API endpoints (`4xx` / `5xx`) | Intercepts failed XHR/fetch/asset requests with status & route evidence |
| Mobile layout explosions | Audits both `1440x900` desktop and `390x844` mobile for horizontal overflow & overlapping controls |
| Dead buttons with empty handlers | Safely probes non-destructive buttons/tabs (`--interact`) and detects throws or zero-effect clicks |
| Leaked API keys in client bundles | Scans live JS/SSR responses & `.env` files for `sk-`, `ghp_`, `AKIA`, DB URIs (auto-redacted) |
| `[object Object]`, `NaN`, `Lorem ipsum` | Detects broken template rendering and missing `<title>`, `<meta viewport>`, labels, and `alt` text |

**Zero forced 300 MB browser download:** SmokeProof automatically detects your existing **Google Chrome**, **Microsoft Edge**, **Brave**, or **Playwright Chromium** installation.

---

## 10-Second Quickstart

### 1. Audit any running URL
```bash
npx smokeproof http://localhost:3000
```

### 2. Boot your dev server, audit, and tear down cleanly (Best for CI & Agents)
```bash
npx smokeproof --cmd "npm run dev" http://localhost:3000 --scan-source
```

### 3. Machine-readable output for coding agents
```bash
npx smokeproof http://localhost:3000 --json
npx smokeproof http://localhost:3000 --markdown
npx smokeproof http://localhost:3000 --sarif --out smokeproof.sarif
```

Outputs are also saved automatically to `.smokeproof/`:
- `.smokeproof/smokeproof-report.json` — machine-readable findings & selectors
- `.smokeproof/smokeproof-report.html` — self-contained visual report with embedded screenshots
- `.smokeproof/screenshots/*.png` — annotated screenshots highlighting exact failing bounding boxes

---

## Install as an Agent Skill

Compatible with **Claude Code**, **Cursor**, **Antigravity**, **Codex**, and **Gemini CLI** via the [Agent Skills open standard](./skills/smokeproof/SKILL.md):

```bash
npx skills add md1qamar/smokeproof
```

Once installed, your agent knows to run static secret checks, crawl the live app, inspect annotated screenshots, fix root causes, and re-verify before reporting completion.

---

## MCP Server (Claude Code, Cursor, Antigravity, Codex)

Start SmokeProof over stdio MCP:

```bash
npx smokeproof --mcp
```

Add to your MCP config (`claude_desktop_config.json`, `.cursor/mcp.json`, etc.):

```json
{
  "mcpServers": {
    "smokeproof": {
      "command": "npx",
      "args": ["-y", "smokeproof", "--mcp"]
    }
  }
}
```

### Exposed MCP Tools

| Tool | Purpose |
| --- | --- |
| `smokeproof_audit` | Full same-origin crawl across desktop & mobile with screenshots, interaction probing, and optional `--cmd` server wrapper |
| `smokeproof_check_route` | Fast single-route deep inspection after editing a specific page |
| `smokeproof_verify_fix` | Re-runs the audit and returns `{ resolved, remaining, introduced, passed, score }` |
| `smokeproof_scan_source` | Instant static scan (no browser) for `.env` leaks, client-prefixed secrets, `dangerouslySetInnerHTML`, and hardcoded localhost URLs |

---

## CLI Reference

```text
smokeproof <url> [options]

Options:
  --cmd <command>          Start dev/preview server and shut down cleanly after audit
  --cwd <dir>              Target workspace directory (default: .)
  --max-pages <n>          Maximum same-origin routes to crawl (default: 12)
  --max-depth <n>          Maximum link crawl depth (default: 2)
  --timeout <ms>           Navigation/server startup timeout in ms (default: 15000)
  --no-mobile              Skip 390x844 mobile viewport layout audit
  --no-interact            Skip safe interactive button/tab probing
  --no-screenshots         Skip saving annotated PNG screenshots
  --scan-source            Include static workspace secret/.env scan
  --scan-only              Run static workspace scan only (no browser launch)
  --fail-on <level>        critical | high | medium | low | none (default: high)
  --min-score <0-100>      Minimum passing ship score (default: 70)
  --json                   Output machine-readable JSON
  --markdown               Output Markdown report
  --sarif                  Output SARIF v2.1.0 JSON
  --html                   Output self-contained HTML report
  --out <path>             Write formatted output to a file
  --artifacts-dir <dir>    Directory for screenshots & reports (default: .smokeproof)
  --browser-path <path>    Explicit Chrome/Edge/Chromium executable path
  --include <pattern>      Only crawl matching routes (repeatable)
  --exclude <pattern>      Skip matching routes (repeatable)
  --ignore-rule <ruleId>   Suppress a specific rule ID (repeatable)
  --mcp                    Start stdio MCP server
  --init                   Scaffold .smokeproof.json and GitHub Actions workflow
```

---

## Programmatic API

```ts
import { runSmokeAudit, verifySmokeFixes, scanWorkspaceSource } from 'smokeproof';

const report = await runSmokeAudit('http://localhost:3000', {
  maxPages: 10,
  mobile: true,
  interact: true,
  scanSource: true,
});

console.log(`Score: ${report.summary.score}/100 (${report.summary.passed ? 'PASS' : 'FAIL'})`);
```

---

## Project Config (`.smokeproof.json`) & GitHub Actions

Bootstrap configuration + CI workflow in one command:

```bash
npx smokeproof --init
```

---

## Development

```bash
npm install
npm run typecheck
npm test
```

## License

MIT
