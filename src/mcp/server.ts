import fs from 'fs';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { scanWorkspaceSource } from '../checks/sourceScanner.js';
import { recordProductDemo } from '../demo/gifStudio.js';
import { TOOL_VERSION, runSmokeAudit, verifySmokeFixes } from '../engine/auditor.js';
import { formatAnnotationsPrompt, loadAnnotations, setAnnotationStatus } from '../studio/annotationsStore.js';
import type { AuditReport } from '../types.js';

/**
 * Start SmokeProof as a stdio Model Context Protocol (MCP) server for AI coding agents.
 * Note: Never write to stdout here; stdout is reserved strictly for JSON-RPC frames.
 */
export async function startMcpServer(): Promise<void> {
  const server = new McpServer({
    name: 'smokeproof',
    version: TOOL_VERSION,
  });

  let lastReport: AuditReport | null = null;

  server.registerTool(
    'smokeproof_audit',
    {
      title: 'Audit Live Web App',
      description:
        'Crawl a local or live web application in headless Chromium, check desktop and mobile layouts, capture runtime/console/API 4xx/5xx errors, probe non-destructive buttons, optionally run chaos fuzzing, detect client-side exposed secrets, and save annotated failure screenshots.',
      inputSchema: z.object({
        url: z.string().describe('Target HTTP(S) URL, e.g. http://localhost:3000'),
        cmd: z.string().optional().describe('Optional dev/preview command to start before auditing and shut down afterward'),
        cwd: z.string().optional().describe('Workspace directory (defaults to current working directory)'),
        maxPages: z.number().int().min(1).max(50).optional().describe('Maximum routes to crawl (default 12)'),
        routes: z.array(z.string()).optional().describe('Optional explicit list of routes to audit without crawling'),
        mobile: z.boolean().optional().describe('Audit 390x844 mobile viewport (default true)'),
        interact: z.boolean().optional().describe('Safely probe non-destructive buttons/tabs (default true)'),
        chaos: z.boolean().optional().describe('Run chaos form fuzzing, double-click race, and offline probes with Repro GIF (default false)'),
        strict: z.boolean().optional().describe('Include strict a11y/SEO/localhost checks (default false)'),
        screenshots: z.boolean().optional().describe('Save annotated PNG screenshots on issues (default true)'),
        scanSource: z.boolean().optional().describe('Also run static secret/env scan on cwd (default false)'),
        failOn: z.enum(['critical', 'high', 'medium', 'low', 'none']).optional(),
        minScore: z.number().min(0).max(100).optional(),
      }),
    },
    async (args) => {
      const report = await runSmokeAudit(args.url, {
        cmd: args.cmd,
        cwd: args.cwd,
        maxPages: args.maxPages,
        routes: args.routes,
        mobile: args.mobile,
        interact: args.interact,
        chaos: args.chaos,
        strict: args.strict,
        screenshots: args.screenshots,
        scanSource: args.scanSource,
        failOn: args.failOn,
        minScore: args.minScore,
      });
      lastReport = report;
      return {
        content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
      };
    },
  );

  server.registerTool(
    'smokeproof_chaos_test',
    {
      title: 'Chaos Bug-Breaker + Repro GIF',
      description:
        'Attack a running web application with empty/oversized/XSS form fuzzing, rapid double-clicks, and offline resilience checks. Automatically generates an animated Bug-Repro GIF on failure.',
      inputSchema: z.object({
        url: z.string().describe('Target HTTP(S) URL'),
        cmd: z.string().optional().describe('Optional dev server command'),
        cwd: z.string().optional(),
        maxPages: z.number().int().min(1).max(20).optional(),
      }),
    },
    async (args) => {
      const report = await runSmokeAudit(args.url, {
        cmd: args.cmd,
        cwd: args.cwd,
        maxPages: args.maxPages ?? 5,
        chaos: true,
        interact: true,
        mobile: true,
        screenshots: true,
      });
      lastReport = report;
      return {
        content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
      };
    },
  );

  server.registerTool(
    'smokeproof_record_demo',
    {
      title: 'Record Screen-Studio Demo GIF',
      description:
        'Record an automated or scripted Screen-Studio-style walkthrough GIF with smooth cursor zoom, click ripples, macOS window chrome, and step captions — zero cloud or FFmpeg required.',
      inputSchema: z.object({
        url: z.string().describe('Target HTTP(S) URL'),
        cmd: z.string().optional().describe('Optional dev server command'),
        cwd: z.string().optional(),
        outPath: z.string().optional().describe('Output GIF file path (defaults to .smokeproof/smokeproof-demo.gif)'),
        steps: z
          .array(
            z.object({
              action: z.enum(['wait', 'click', 'type', 'scroll', 'goto']),
              selector: z.string().optional(),
              text: z.string().optional(),
              url: z.string().optional(),
              caption: z.string().optional(),
              zoom: z.number().min(1).max(2).optional(),
            }),
          )
          .optional(),
      }),
    },
    async (args) => {
      const result = await recordProductDemo({
        url: args.url,
        cmd: args.cmd,
        cwd: args.cwd,
        outPath: args.outPath,
        steps: args.steps,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    'smokeproof_check_route',
    {
      title: 'Check Single Route',
      description:
        'Run a fast deep check on a single URL/route without crawling further links. Ideal for verifying a targeted page edit.',
      inputSchema: z.object({
        url: z.string().describe('Full URL of the specific route, e.g. http://localhost:3000/checkout'),
        cwd: z.string().optional(),
        mobile: z.boolean().optional(),
        interact: z.boolean().optional(),
        chaos: z.boolean().optional(),
        screenshots: z.boolean().optional(),
      }),
    },
    async (args) => {
      const report = await runSmokeAudit(args.url, {
        cwd: args.cwd,
        maxPages: 1,
        maxDepth: 0,
        mobile: args.mobile ?? true,
        interact: args.interact ?? true,
        chaos: args.chaos ?? false,
        screenshots: args.screenshots ?? true,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
      };
    },
  );

  server.registerTool(
    'smokeproof_verify_fix',
    {
      title: 'Verify Bug Fixes',
      description:
        'Re-audit the application after making code fixes and return a machine-readable diff of resolved, remaining, and newly introduced findings.',
      inputSchema: z.object({
        url: z.string().describe('Target URL to re-verify'),
        previousReportPath: z
          .string()
          .optional()
          .describe('Path to previous smokeproof-report.json (defaults to last run or .smokeproof/smokeproof-report.json)'),
        cmd: z.string().optional(),
        cwd: z.string().optional(),
      }),
    },
    async (args) => {
      const cwd = path.resolve(args.cwd ?? process.cwd());
      const fallbackPath = path.join(cwd, '.smokeproof', 'smokeproof-report.json');
      const reportPath = args.previousReportPath || fallbackPath;

      let prev: AuditReport | null = lastReport;
      if (fs.existsSync(reportPath)) {
        prev = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as AuditReport;
      }

      if (!prev) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'No previous SmokeProof report found. Run smokeproof_audit first or provide previousReportPath.',
            },
          ],
        };
      }

      const diff = await verifySmokeFixes(args.url, prev, {
        cmd: args.cmd,
        cwd,
      });

      return {
        content: [{ type: 'text', text: JSON.stringify(diff, null, 2) }],
      };
    },
  );

  server.registerTool(
    'smokeproof_scan_source',
    {
      title: 'Static Pre-Ship Workspace Scan',
      description:
        'Quickly scan workspace files without opening a browser for committed .env secrets, client-prefixed API keys, and unsafe JSX HTML injection.',
      inputSchema: z.object({
        cwd: z.string().optional().describe('Workspace root path (defaults to current directory)'),
        strict: z.boolean().optional().describe('Include advisory localhost URL checks'),
      }),
    },
    async (args) => {
      const cwd = path.resolve(args.cwd ?? process.cwd());
      const findings = scanWorkspaceSource(cwd, { strict: args.strict });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                cwd,
                totalFindings: findings.length,
                findings,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'smokeproof_get_annotations',
    {
      title: 'Get Visual Review Annotations',
      description:
        'Read open click-to-prompt visual UI feedback pins created by the human in SmokeProof Studio (.smokeproof/annotations.json) along with a formatted prompt.',
      inputSchema: z.object({
        cwd: z.string().optional().describe('Workspace directory (defaults to current working directory)'),
        includeResolved: z.boolean().optional().describe('Include resolved pins (default false)'),
      }),
    },
    async (args) => {
      const cwd = path.resolve(args.cwd ?? process.cwd());
      const all = loadAnnotations(cwd);
      const filtered = args.includeResolved ? all : all.filter((a) => a.status === 'open');
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                total: filtered.length,
                annotations: filtered,
                prompt: formatAnnotationsPrompt(all),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'smokeproof_resolve_annotation',
    {
      title: 'Resolve Visual Review Pin',
      description: 'Mark a SmokeProof Studio visual annotation pin as resolved after fixing the UI.',
      inputSchema: z.object({
        id: z.string().describe('Annotation pin ID'),
        cwd: z.string().optional(),
      }),
    },
    async (args) => {
      const cwd = path.resolve(args.cwd ?? process.cwd());
      const updated = setAnnotationStatus(cwd, args.id, 'resolved');
      if (!updated) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Annotation "${args.id}" not found.` }],
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }],
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`SmokeProof MCP server v${TOOL_VERSION} listening on stdio`);
}
