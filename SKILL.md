---
name: smokeproof
description: Real-browser pre-ship verification skill for AI coding agents. Use before declaring any web app task complete, after fixing UI/API bugs, or when auditing localhost/staging apps for console errors, HTTP 4xx/5xx failures, mobile horizontal overflow, broken images, dead buttons, unlabeled controls, and exposed client secrets.
license: MIT
compatibility: "Requires Node.js >= 20 and Chrome, Edge, or Playwright Chromium."
---

# SmokeProof — Pre-Ship Browser Verification Protocol

See [skills/smokeproof/SKILL.md](./skills/smokeproof/SKILL.md) and [skills/smokeproof/references/severity-contract.md](./skills/smokeproof/references/severity-contract.md) for the full multi-phase verification workflow, MCP tool usage, and machine-readable severity rubric.

Quick commands:
- Static pre-flight: `npx smokeproof --scan-only --json`
- Full browser crawl + dev server wrap: `npx smokeproof --cmd "npm run dev" http://localhost:3000 --scan-source --json`
- Start MCP server: `npx smokeproof --mcp`
