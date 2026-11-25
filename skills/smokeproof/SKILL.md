---
name: smokeproof
description: Real-browser chaos testing, Screen-Studio demo & bug-repro GIF recording, and click-to-prompt visual review skill for AI coding agents. Use before declaring any web app task complete, when fuzzing forms/flows, when creating README demo GIFs, or when checking visual review annotations left by the user.
license: MIT
compatibility: "Requires Node.js >= 20 and Chrome, Edge, or Playwright Chromium."
---

# SmokeProof — Chaos Testing, Repro GIFs & Visual Review Protocol

Never mark a web application task "done" solely because `tsc`, linting, or build succeeded. Use SmokeProof to verify real-browser behavior, inspect visual review annotations, chaos-test user inputs, and generate shareable Screen-Studio demo GIFs.

## When to Trigger This Skill

- Before reporting a frontend, full-stack, or UI feature as finished
- When the user asks to inspect, stress-test, or chaos-test forms, APIs, and offline behavior
- When the user created click-to-prompt visual pins in **SmokeProof Studio** (`smokeproof studio`)
- When the user wants a Screen-Studio-style README or launch **Demo GIF** (`smokeproof demo`)

## Workflow

### Phase 1: Check Visual Review Annotations (If User Left Pins)

Check if the user annotated elements in SmokeProof Studio:
- **MCP:** `smokeproof_get_annotations`
- After fixing each pinned selector, mark it resolved with `smokeproof_resolve_annotation`.

### Phase 2: Static Pre-Flight Scan

Catch exposed `.env` files, leaked API keys, or unsafe HTML sinks instantly:
- **MCP:** `smokeproof_scan_source`
- **CLI:** `npx smokeproof --scan-only --json`

### Phase 3: Real-Browser Audit & Chaos Bug-Breaker

Run SmokeProof against the running app or wrap the dev server command:
- **Standard audit:** `smokeproof_audit` or `npx smokeproof --cmd "npm run dev" http://localhost:3000 --json`
- **Chaos mode (form fuzzing, XSS canary, double-click race, offline resilience + animated Repro GIF):**
  `smokeproof_chaos_test` or `npx smokeproof chaos --cmd "npm run dev" http://localhost:3000 --json`

### Phase 4: Fix & Re-Verify Diff

1. Inspect any generated annotated screenshots (`.smokeproof/screenshots/`) or Repro GIFs (`.smokeproof/repro/`).
2. Fix root causes cleanly. See `references/severity-contract.md` for rule definitions.
3. Call `smokeproof_verify_fix` until `summary.passed === true`.

### Phase 5: Optional README / Launch Demo GIF

Generate a crisp Screen-Studio-style walkthrough GIF (macOS chrome, smooth cursor zoom, click ripples, captions):
- **MCP:** `smokeproof_record_demo`
- **CLI:** `npx smokeproof demo --cmd "npm run dev" http://localhost:3000`
