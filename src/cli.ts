#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { scanWorkspaceSource } from './checks/sourceScanner.js';
import { recordProductDemo } from './demo/gifStudio.js';
import { TOOL_VERSION, runSmokeAudit } from './engine/auditor.js';
import { startMcpServer } from './mcp/server.js';
import {
  formatHtmlReport,
  formatMarkdownReport,
  formatSarifReport,
  formatTerminalReport,
} from './report/formatters.js';
import { computeAuditSummary } from './report/scorer.js';
import { startVisualStudio } from './studio/studioServer.js';
import type { AuditConfig, AuditReport, Severity } from './types.js';

type Mode = 'audit' | 'chaos' | 'demo' | 'studio';

interface CliArgs {
  mode: Mode;
  url: string;
  mcp: boolean;
  init: boolean;
  scanOnly: boolean;
  openBrowser: boolean;
  studioPort?: number;
  format: 'terminal' | 'json' | 'markdown' | 'sarif' | 'html';
  out?: string;
  overrides: Partial<AuditConfig>;
  help: boolean;
  version: boolean;
}

const SUBCOMMANDS = new Set<string>(['audit', 'chaos', 'demo', 'studio']);

function parseCliArgs(argv: string[]): CliArgs {
  const parsed: CliArgs = {
    mode: 'audit',
    url: '',
    mcp: false,
    init: false,
    scanOnly: false,
    openBrowser: true,
    format: 'terminal',
    overrides: {
      include: [],
      exclude: [],
      ignoreRules: [],
    },
    help: false,
    version: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (i === 0 && SUBCOMMANDS.has(arg)) {
      parsed.mode = arg as Mode;
      if (arg === 'chaos') parsed.overrides.chaos = true;
      continue;
    }

    switch (arg) {
      case '-h':
      case '--help':
        parsed.help = true;
        break;
      case '-v':
      case '--version':
        parsed.version = true;
        break;
      case '--mcp':
        parsed.mcp = true;
        break;
      case '--init':
        parsed.init = true;
        break;
      case '--scan-only':
        parsed.scanOnly = true;
        break;
      case '--chaos':
        parsed.mode = 'chaos';
        parsed.overrides.chaos = true;
        break;
      case '--demo':
        parsed.mode = 'demo';
        break;
      case '--studio':
        parsed.mode = 'studio';
        break;
      case '--strict':
        parsed.overrides.strict = true;
        break;
      case '--no-open':
        parsed.openBrowser = false;
        break;
      case '--port':
        parsed.studioPort = Number(requireValue(arg, next));
        i++;
        break;
      case '--json':
        parsed.format = 'json';
        break;
      case '--markdown':
      case '--md':
        parsed.format = 'markdown';
        break;
      case '--sarif':
        parsed.format = 'sarif';
        break;
      case '--html':
        parsed.format = 'html';
        break;
      case '--out':
        parsed.out = requireValue(arg, next);
        i++;
        break;
      case '--cmd':
        parsed.overrides.cmd = requireValue(arg, next);
        i++;
        break;
      case '--cwd':
        parsed.overrides.cwd = requireValue(arg, next);
        i++;
        break;
      case '--max-pages':
        parsed.overrides.maxPages = Number(requireValue(arg, next));
        i++;
        break;
      case '--max-depth':
        parsed.overrides.maxDepth = Number(requireValue(arg, next));
        i++;
        break;
      case '--timeout':
        parsed.overrides.timeoutMs = Number(requireValue(arg, next));
        i++;
        break;
      case '--settle':
        parsed.overrides.settleMs = Number(requireValue(arg, next));
        i++;
        break;
      case '--no-mobile':
        parsed.overrides.mobile = false;
        break;
      case '--no-interact':
        parsed.overrides.interact = false;
        break;
      case '--no-screenshots':
        parsed.overrides.screenshots = false;
        break;
      case '--scan-source':
        parsed.overrides.scanSource = true;
        break;
      case '--artifacts-dir':
        parsed.overrides.artifactsDir = requireValue(arg, next);
        i++;
        break;
      case '--browser-path':
        parsed.overrides.browserPath = requireValue(arg, next);
        i++;
        break;
      case '--include':
        parsed.overrides.include!.push(requireValue(arg, next));
        i++;
        break;
      case '--exclude':
        parsed.overrides.exclude!.push(requireValue(arg, next));
        i++;
        break;
      case '--ignore-rule':
        parsed.overrides.ignoreRules!.push(requireValue(arg, next));
        i++;
        break;
      case '--fail-on':
        parsed.overrides.failOn = requireValue(arg, next) as Severity | 'none';
        i++;
        break;
      case '--min-score':
        parsed.overrides.minScore = Number(requireValue(arg, next));
        i++;
        break;
      default:
        if (!arg.startsWith('-') && !parsed.url) {
          parsed.url = arg;
        } else if (arg.startsWith('-')) {
          throw new Error(`Unknown flag: ${arg}. Run "smokeproof --help" for usage.`);
        }
        break;
    }
  }

  return parsed;
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith('--')) {
    throw new Error(`Flag ${flag} requires a value.`);
  }
  return value;
}

function printHelp(): void {
  console.log(`
SmokeProof v${TOOL_VERSION} — Chaos Browser Testing, Demo/Repro GIFs & Visual Review Studio

Usage:
  smokeproof <url> [options]                  Crawl & verify runtime, layout, secrets & clicks
  smokeproof chaos <url> [options]            Fuzz forms, XSS, double-clicks & offline + Repro GIF
  smokeproof demo <url> [options]             Record Screen-Studio walkthrough GIF (zero FFmpeg)
  smokeproof studio <url> [options]           Open Click-to-Prompt Visual Review Studio
  smokeproof --scan-only [--cwd <dir>]        Static workspace secret/.env scan
  smokeproof --mcp                            Start MCP server for Claude Code / Cursor / Antigravity
  smokeproof --init                           Create .smokeproof.json & GitHub Actions workflow

Options:
  --cmd <command>          Start dev/preview server and shut down cleanly afterward
  --cwd <dir>              Target workspace directory (default: .)
  --chaos                  Enable chaos form fuzzing, double-click & offline probes
  --strict                 Include strict a11y/SEO & localhost advisory checks
  --max-pages <n>          Maximum same-origin routes to crawl (default: 12)
  --max-depth <n>          Maximum link crawl depth (default: 2)
  --timeout <ms>           Navigation/server startup timeout in ms (default: 15000)
  --no-mobile              Skip 390x844 mobile viewport layout audit
  --no-interact            Skip safe interactive button/tab probing
  --no-screenshots         Skip saving annotated PNG screenshots
  --scan-source            Include static workspace secret/.env scan
  --fail-on <level>        critical | high | medium | low | none (default: high)
  --min-score <0-100>      Minimum passing ship score (default: 70)
  --json | --markdown | --sarif | --html
  --out <path>             Write report or Demo GIF to custom file path
  --artifacts-dir <dir>    Directory for screenshots, GIFs & reports (default: .smokeproof)
  --browser-path <path>    Explicit Chrome/Edge/Chromium executable path
  --port <port>            Studio UI port (default: 4180)
  --no-open                Do not auto-open browser in studio mode

Examples:
  npx smokeproof demo --cmd "npm run dev" http://localhost:3000
  npx smokeproof chaos http://localhost:3000
  npx smokeproof studio http://localhost:3000
  npx smokeproof --mcp
`);
}

function runInit(cwd: string): void {
  const configPath = path.join(cwd, '.smokeproof.json');
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          url: 'http://localhost:3000',
          maxPages: 12,
          mobile: true,
          interact: true,
          chaos: false,
          strict: false,
          scanSource: true,
          failOn: 'high',
          minScore: 75,
          exclude: ['/logout', '/api/*'],
          ignoreRules: [],
        },
        null,
        2,
      ) + '\n',
    );
    console.log(`Created ${configPath}`);
  } else {
    console.log(`Skipped ${configPath} (already exists)`);
  }

  const workflowDir = path.join(cwd, '.github', 'workflows');
  const workflowPath = path.join(workflowDir, 'smokeproof.yml');
  if (!fs.existsSync(workflowPath)) {
    fs.mkdirSync(workflowDir, { recursive: true });
    fs.writeFileSync(
      workflowPath,
      `name: SmokeProof Pre-Ship Audit
on:
  pull_request:
  push:
    branches: [main]

jobs:
  smokeproof:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npm run build
      - name: Run SmokeProof Chaos Gate
        run: npx smokeproof chaos --cmd "npm run preview -- --port 4173" http://localhost:4173 --scan-source --sarif --out smokeproof.sarif
      - name: Upload Screenshots, Repro GIFs & HTML Report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: smokeproof-artifacts
          path: .smokeproof/
`,
    );
    console.log(`Created ${workflowPath}`);
  } else {
    console.log(`Skipped ${workflowPath} (already exists)`);
  }
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (args.version) {
    console.log(TOOL_VERSION);
    process.exit(0);
  }
  if (args.mcp) {
    await startMcpServer();
    return;
  }
  if (args.init) {
    runInit(path.resolve(args.overrides.cwd ?? process.cwd()));
    process.exit(0);
  }

  const cwd = path.resolve(args.overrides.cwd ?? process.cwd());

  if (args.mode === 'demo') {
    if (!args.url) {
      console.error('Error: Provide a target URL (e.g. smokeproof demo http://localhost:3000).');
      process.exit(2);
    }
    try {
      const result = await recordProductDemo({
        url: args.url,
        cmd: args.overrides.cmd,
        cwd,
        outPath: args.out,
        artifactsDir: args.overrides.artifactsDir,
        browserPath: args.overrides.browserPath,
        timeoutMs: args.overrides.timeoutMs,
      });
      if (args.format === 'json') {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\nSmokeProof Demo GIF recorded!`);
        console.log(`  Output: ${result.gifPath} (${Math.round(result.sizeBytes / 1024)} KB, ${result.frameCount} frames)`);
        console.log(`  Steps:  ${result.stepsExecuted.join(' -> ')}\n`);
      }
      process.exit(0);
    } catch (err) {
      console.error(`Demo recording failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    }
  }

  if (args.mode === 'studio') {
    if (!args.url) {
      console.error('Error: Provide a target URL (e.g. smokeproof studio http://localhost:3000).');
      process.exit(2);
    }
    try {
      const studio = await startVisualStudio({
        url: args.url,
        cmd: args.overrides.cmd,
        cwd,
        port: args.studioPort,
        artifactsDir: args.overrides.artifactsDir,
        browserPath: args.overrides.browserPath,
        open: args.openBrowser,
      });
      console.log(`\nSmokeProof Visual Review Studio running!`);
      console.log(`  Studio UI:  ${studio.studioUrl}`);
      console.log(`  App Proxy:  ${studio.proxyUrl} -> ${studio.targetUrl}`);
      console.log(`  Press Ctrl+C to stop.\n`);
      const shutdown = async () => {
        await studio.stop();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      return;
    } catch (err) {
      console.error(`Studio failed to start: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    }
  }

  let report: AuditReport;
  try {
    if (args.scanOnly) {
      const start = Date.now();
      const sourceFindings = scanWorkspaceSource(cwd, { strict: args.overrides.strict });
      const summary = computeAuditSummary(
        [],
        sourceFindings,
        {
          failOn: args.overrides.failOn ?? 'high',
          minScore: args.overrides.minScore ?? 70,
        },
        Date.now() - start,
      );
      report = {
        tool: 'smokeproof',
        version: TOOL_VERSION,
        timestamp: new Date().toISOString(),
        targetUrl: `file://${cwd}`,
        browser: 'Static Scan (No Browser)',
        summary,
        routes: [],
        sourceFindings,
      };
    } else {
      if (!args.url && !fs.existsSync(path.join(cwd, '.smokeproof.json'))) {
        console.error('Error: Provide a target URL (e.g. smokeproof http://localhost:3000) or --scan-only.');
        process.exit(2);
      }
      report = await runSmokeAudit(args.url, args.overrides);
    }
  } catch (err) {
    console.error(`SmokeProof failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  const outputText =
    args.format === 'json'
      ? JSON.stringify(report, null, 2)
      : args.format === 'markdown'
        ? formatMarkdownReport(report)
        : args.format === 'sarif'
          ? formatSarifReport(report)
          : args.format === 'html'
            ? formatHtmlReport(report)
            : formatTerminalReport(report);

  if (args.out) {
    const outPath = path.resolve(args.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, outputText, 'utf8');
    console.error(`Wrote ${args.format} report to ${outPath}`);
  } else {
    console.log(outputText);
  }

  process.exit(report.summary.passed ? 0 : 1);
}

main();
