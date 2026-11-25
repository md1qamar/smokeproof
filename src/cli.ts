#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { scanWorkspaceSource } from './checks/sourceScanner.js';
import { TOOL_VERSION, runSmokeAudit } from './engine/auditor.js';
import { startMcpServer } from './mcp/server.js';
import {
  formatHtmlReport,
  formatMarkdownReport,
  formatSarifReport,
  formatTerminalReport,
} from './report/formatters.js';
import { computeAuditSummary } from './report/scorer.js';
import type { AuditConfig, AuditReport, Severity } from './types.js';

interface CliArgs {
  url: string;
  mcp: boolean;
  init: boolean;
  scanOnly: boolean;
  format: 'terminal' | 'json' | 'markdown' | 'sarif' | 'html';
  out?: string;
  overrides: Partial<AuditConfig>;
  help: boolean;
  version: boolean;
}

function parseCliArgs(argv: string[]): CliArgs {
  const parsed: CliArgs = {
    url: '',
    mcp: false,
    init: false,
    scanOnly: false,
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
SmokeProof v${TOOL_VERSION} — Real-Browser Pre-Ship Verification for AI Agents & Humans

Usage:
  smokeproof <url> [options]
  smokeproof --cmd "npm run dev" http://localhost:3000 [options]
  smokeproof --scan-only [--cwd <dir>]
  smokeproof --mcp
  smokeproof --init

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
  --mcp                    Start stdio MCP server for Claude Code / Cursor / Antigravity
  --init                   Create .smokeproof.json and GitHub Actions workflow template
  -v, --version            Show version
  -h, --help               Show help

Examples:
  npx smokeproof http://localhost:3000
  npx smokeproof --cmd "npm run preview" http://localhost:4173 --json
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
      - name: Run SmokeProof
        run: npx smokeproof --cmd "npm run preview -- --port 4173" http://localhost:4173 --scan-source --sarif --out smokeproof.sarif
      - name: Upload Screenshots & HTML Report
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

  let report: AuditReport;
  try {
    if (args.scanOnly) {
      const cwd = path.resolve(args.overrides.cwd ?? process.cwd());
      const start = Date.now();
      const sourceFindings = scanWorkspaceSource(cwd);
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
      if (!args.url && !fs.existsSync(path.join(path.resolve(args.overrides.cwd ?? process.cwd()), '.smokeproof.json'))) {
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
