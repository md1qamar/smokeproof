---
name: smokeproof
description: Real-browser chaos testing, Screen-Studio demo & bug-repro GIF recording, and click-to-prompt visual review skill for AI coding agents. Use before declaring any web app task complete, when fuzzing forms/flows, when creating README demo GIFs, or when checking visual review annotations left by the user.
license: MIT
compatibility: "Requires Node.js >= 20 and Chrome, Edge, or Playwright Chromium."
---

# SmokeProof — Chaos Testing, Repro GIFs & Visual Review Protocol

See [skills/smokeproof/SKILL.md](./skills/smokeproof/SKILL.md) and [skills/smokeproof/references/severity-contract.md](./skills/smokeproof/references/severity-contract.md).

Quick commands:
- Chaos bug-breaker + Repro GIF: `npx smokeproof chaos http://localhost:3000`
- Screen-Studio Demo GIF: `npx smokeproof demo http://localhost:3000`
- Click-to-Prompt Visual Review Studio: `npx smokeproof studio http://localhost:3000`
- MCP Server: `npx smokeproof --mcp`
