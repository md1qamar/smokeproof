---
name: smokeproof
description: Real-browser pre-ship verification skill for AI coding agents. Use before declaring any web app task complete, after fixing UI/API bugs, or when auditing localhost/staging apps for console errors, HTTP 4xx/5xx failures, mobile horizontal overflow, broken images, dead buttons, unlabeled controls, and exposed client secrets.
license: MIT
compatibility: "Requires Node.js >= 20 and Chrome, Edge, or Playwright Chromium."
---

# SmokeProof — Pre-Ship Browser Verification Protocol

Never mark a web application task "done" solely because `tsc`, linting, or build succeeded. Run SmokeProof against the real running app to verify runtime behavior in Chromium across Desktop (`1440x900`) and Mobile (`390x844`) viewports.

## When to Trigger This Skill

- Before reporting a frontend, full-stack, or UI feature as finished
- After refactoring routing, layouts, forms, auth gates, or API handlers
- When debugging visual overflow, blank screens, broken assets, or unresponsive buttons
- Before opening a PR or deploying to production

## Workflow

### Phase 1: Static Pre-Flight Scan (Zero Browser Startup)

Run the static source scanner first to catch exposed `.env` files, leaked API keys, unsafe `dangerouslySetInnerHTML`, or hardcoded `localhost` API calls:

- **MCP:** call `smokeproof_scan_source` with `{ "cwd": "." }`
- **CLI:** `npx smokeproof --scan-only --json`

Fix any `critical` or `high` secret exposure immediately before continuing.

### Phase 2: Real-Browser Runtime & Layout Crawl

Run SmokeProof against either an already-running local server or let SmokeProof launch and tear down the app command automatically:

- **MCP:** call `smokeproof_audit` with `{ "url": "http://localhost:3000", "cmd": "npm run dev", "mobile": true, "interact": true, "screenshots": true }`
- **CLI:** `npx smokeproof --cmd "npm run dev" http://localhost:3000 --scan-source --json`

### Phase 3: Triage Findings & Inspect Annotated Screenshots

1. Sort findings by severity: `critical` -> `high` -> `medium` -> `low`.
2. When `screenshots` is enabled, inspect the generated PNGs in `.smokeproof/screenshots/` (each failing selector is highlighted with a numbered dashed box).
3. Address root causes in source code rather than suppressing rules. See `references/severity-contract.md` for rule definitions and fix guidance.

### Phase 4: Re-Verify Fix Diff

After applying code edits, verify that targeted issues are resolved and no regressions were introduced:

- **MCP:** call `smokeproof_verify_fix` with `{ "url": "http://localhost:3000" }`
- **CLI:** `npx smokeproof --cmd "npm run dev" http://localhost:3000 --json`

Only report success to the user once `summary.passed === true` (zero `critical`/`high` runtime defects and `score >= 70`).
