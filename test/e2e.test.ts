import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runSmokeAudit, verifySmokeFixes } from '../src/index.js';
import { startBrokenFixtureServer, type TestServerHandle } from './fixtures/brokenServer.js';

let fixture: TestServerHandle;

test.before(async () => {
  fixture = await startBrokenFixtureServer();
});

test.after(async () => {
  await fixture.close();
});

test('E2E: clean route passes with 100 score and zero findings', async () => {
  const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-e2e-clean-'));
  try {
    const report = await runSmokeAudit(`${fixture.baseUrl}/clean`, {
      maxPages: 1,
      maxDepth: 0,
      artifactsDir,
      screenshots: true,
      mobile: true,
      interact: true,
    });

    assert.equal(report.summary.passed, true);
    assert.equal(report.summary.score, 100);
    assert.equal(report.summary.totalFindings, 0);
    assert.equal(report.routes.length, 1);
  } finally {
    fs.rmSync(artifactsDir, { recursive: true, force: true });
  }
});

test('E2E: broken route detects runtime, network, layout, interaction, a11y, content, and redacted secret bugs', async () => {
  const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-e2e-broken-'));
  try {
    const report = await runSmokeAudit(`${fixture.baseUrl}/broken`, {
      maxPages: 4,
      maxDepth: 1,
      artifactsDir,
      screenshots: true,
      mobile: true,
      interact: true,
      settleMs: 300,
    });

    assert.equal(report.summary.passed, false);
    assert.ok(report.routes.some((r) => r.route === '/sub'), 'Should crawl linked /sub route');

    const brokenRoute = report.routes.find((r) => r.route === '/broken');
    assert.ok(brokenRoute, 'Broken route audit result must exist');

    const rules = new Set(brokenRoute.findings.map((f) => f.rule));
    assert.ok(rules.has('runtime/uncaught-exception'), 'Should catch uncaught pageerror');
    assert.ok(rules.has('runtime/console-error'), 'Should catch console.error');
    assert.ok(rules.has('network/http-5xx'), 'Should catch 500 API response');
    assert.ok(rules.has('asset/broken-image'), 'Should catch broken image');
    assert.ok(rules.has('layout/horizontal-overflow'), 'Should catch mobile overflow');
    assert.ok(rules.has('interaction/dead-control'), 'Should catch dead button');
    assert.ok(rules.has('interaction/error-on-click'), 'Should catch throwing button');
    assert.ok(rules.has('content/object-object-leak'), 'Should catch [object Object] UI leak');
    assert.ok(rules.has('meta/missing-viewport'), 'Should catch missing viewport meta');
    assert.ok(rules.has('a11y/unlabeled-control'), 'Should catch unlabeled button');
    assert.ok(rules.has('security/exposed-openai-key'), 'Should catch exposed client secret');

    const secretFinding = brokenRoute.findings.find((f) => f.rule === 'security/exposed-openai-key');
    assert.ok(secretFinding?.evidence && !secretFinding.evidence.includes('9876543210abcdefghij9876543210'));

    assert.ok(brokenRoute.screenshots.desktop && fs.existsSync(brokenRoute.screenshots.desktop));
    assert.ok(brokenRoute.screenshots.mobile && fs.existsSync(brokenRoute.screenshots.mobile));
    assert.ok(fs.existsSync(path.join(artifactsDir, 'smokeproof-report.html')));
    assert.ok(fs.existsSync(path.join(artifactsDir, 'smokeproof-report.json')));
  } finally {
    fs.rmSync(artifactsDir, { recursive: true, force: true });
  }
});

test('E2E: verifySmokeFixes reports resolved issues after fix', async () => {
  const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-e2e-verify-'));
  try {
    fixture.setFixed(false);
    const before = await runSmokeAudit(`${fixture.baseUrl}/mutable`, {
      maxPages: 1,
      maxDepth: 0,
      artifactsDir,
      screenshots: false,
    });
    assert.equal(before.summary.passed, false);
    assert.ok(before.summary.totalFindings > 0);

    fixture.setFixed(true);
    const diff = await verifySmokeFixes(`${fixture.baseUrl}/mutable`, before, {
      maxPages: 1,
      maxDepth: 0,
      artifactsDir,
      screenshots: false,
    });
    assert.equal(diff.passed, true);
    assert.equal(diff.remaining.length, 0);
    assert.ok(diff.resolved.length > 0);
  } finally {
    fixture.setFixed(false);
    fs.rmSync(artifactsDir, { recursive: true, force: true });
  }
});

test('E2E: MCP server responds to initialize and tools/list over stdio', async () => {
  const cliPath = path.resolve(process.cwd(), 'dist', 'cli.js');
  const child = spawn(process.execPath, [cliPath, '--mcp'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  try {
    const responses: Array<{ id?: number; result?: { tools?: Array<{ name: string }> } }> = [];
    let buffer = '';

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          responses.push(JSON.parse(line));
        } catch {
          // Ignore partial or non-JSON line
        }
      }
    });

    const initReq = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'smokeproof-test', version: '1.0.0' },
      },
    };
    const initializedNote = {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    };
    const listReq = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    };

    child.stdin.write(JSON.stringify(initReq) + '\n');
    await new Promise((r) => setTimeout(r, 250));
    child.stdin.write(JSON.stringify(initializedNote) + '\n');
    child.stdin.write(JSON.stringify(listReq) + '\n');

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !responses.some((r) => r.id === 2)) {
      await new Promise((r) => setTimeout(r, 100));
    }

    const listResp = responses.find((r) => r.id === 2);
    assert.ok(listResp?.result?.tools, 'MCP server should return registered tools');
    const names = listResp.result.tools.map((t) => t.name);
    assert.ok(names.includes('smokeproof_audit'));
    assert.ok(names.includes('smokeproof_check_route'));
    assert.ok(names.includes('smokeproof_verify_fix'));
    assert.ok(names.includes('smokeproof_scan_source'));
  } finally {
    child.kill();
  }
});

test('E2E: CLI --cmd launches server, audits in browser, prints JSON, and exits cleanly', async () => {
  const cliPath = path.resolve(process.cwd(), 'dist', 'cli.js');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-cli-cmd-'));
  const port = 43127;
  const serverScript = path.join(tmpDir, 'srv.mjs');
  fs.writeFileSync(
    serverScript,
    `import http from 'node:http';
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!DOCTYPE html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>CLI OK</title></head><body><h1>CLI Target</h1></body></html>');
}).listen(${port}, '127.0.0.1');
`,
  );

  try {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(
        process.execPath,
        [
          cliPath,
          '--cmd',
          `"${process.execPath}" "${serverScript}"`,
          `http://127.0.0.1:${port}`,
          '--json',
          '--no-screenshots',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
      child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });

    assert.equal(result.code, 0, `Expected exit 0, got ${result.code}. stderr=${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.summary.passed, true);
    assert.equal(parsed.summary.score, 100);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
