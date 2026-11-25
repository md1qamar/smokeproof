import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  computeAuditSummary,
  findSecretsInText,
  formatHtmlReport,
  formatMarkdownReport,
  formatSarifReport,
  normalizeBaseUrl,
  redactSecret,
  resolveAuditConfig,
  scanWorkspaceSource,
} from '../src/index.js';
import type { AuditReport, RouteAuditResult } from '../src/types.js';

test('secretPatterns detects and redacts keys while ignoring placeholders', () => {
  const fakeOpenAi = ['sk', 'proj', '1234567890abcdef1234567890'].join('-');
  const fakeGh = ['ghp', '1234567890abcdef1234567890abcdef'].join('_');
  const fakeDb = ['postgres', '://admin:supersecret99@db.acme-prod.internal:5432/prod'].join('');
  const placeholder = ['sk', 'proj', 'your_key_example_placeholder_12345'].join('-');
  const awsDocExample = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');

  const sample = `const a="${fakeOpenAi}"; const b="${fakeGh}"; const c="${fakeDb}"; const d="${placeholder}"; const e="${awsDocExample}";`;
  const matches = findSecretsInText(sample);

  assert.equal(matches.length, 3);
  assert.ok(matches.every((m) => !m.redacted.includes('supersecret99')));
  assert.ok(matches.every((m) => !m.redacted.includes('abcdef1234567890')));
  assert.equal(redactSecret('short'), '****');
});

test('normalizeBaseUrl adds http protocol and validates', () => {
  assert.equal(normalizeBaseUrl('localhost:3000'), 'http://localhost:3000/');
  assert.equal(normalizeBaseUrl('https://example.com/app'), 'https://example.com/app');
  assert.throws(() => normalizeBaseUrl(''));
});

test('resolveAuditConfig merges .smokeproof.json and explicit overrides', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-cfg-'));
  try {
    fs.writeFileSync(
      path.join(tmpDir, '.smokeproof.json'),
      JSON.stringify({ maxPages: 4, minScore: 85, failOn: 'medium' }),
    );
    const cfg = resolveAuditConfig('http://localhost:4000', { cwd: tmpDir, maxPages: 7 });
    assert.equal(cfg.maxPages, 7);
    assert.equal(cfg.minScore, 85);
    assert.equal(cfg.failOn, 'medium');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('computeAuditSummary evaluates score deductions and failOn threshold', () => {
  const routes: RouteAuditResult[] = [
    {
      route: '/',
      url: 'http://localhost:3000/',
      status: 200,
      loadTimeMs: 120,
      title: 'Test',
      discoveredLinks: [],
      screenshots: {},
      findings: [
        {
          id: '1',
          rule: 'runtime/console-error',
          category: 'runtime',
          severity: 'high',
          route: '/',
          message: 'Console error',
          suggestion: 'Fix it',
        },
        {
          id: '2',
          rule: 'a11y/missing-lang',
          category: 'a11y',
          severity: 'low',
          route: '/',
          message: 'Missing lang',
          suggestion: 'Add lang',
        },
      ],
    },
  ];

  const strict = computeAuditSummary(routes, [], { failOn: 'high', minScore: 70 }, 500);
  assert.equal(strict.score, 86);
  assert.equal(strict.passed, false);

  const lenient = computeAuditSummary(routes, [], { failOn: 'critical', minScore: 70 }, 500);
  assert.equal(lenient.score, 86);
  assert.equal(lenient.passed, true);
});

test('scanWorkspaceSource detects committed .env, client secrets, and hardcoded localhost', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-src-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    const envDb = ['postgres', '://user:pass1234@localhost:5432/app'].join('');
    fs.writeFileSync(path.join(tmpDir, '.env'), `DATABASE_URL=${envDb}\n`);
    const leaked = ['sk', 'live', 'abcdef1234567890abcdef'].join('_');
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'client.ts'),
      `export const API_URL = "http://localhost:8080/api";\nexport const KEY = "${leaked}";\n`,
    );

    const strictFindings = scanWorkspaceSource(tmpDir, { strict: true });
    const strictRules = new Set(strictFindings.map((f) => f.rule));
    assert.ok(strictRules.has('security/committed-env-file'));
    assert.ok(strictRules.has('security/source-stripe-live-key') || strictRules.has('security/source-openai-key'));
    assert.ok(strictRules.has('runtime/hardcoded-localhost'));

    const defaultFindings = scanWorkspaceSource(tmpDir);
    const defaultRules = new Set(defaultFindings.map((f) => f.rule));
    assert.ok(defaultRules.has('security/committed-env-file'));
    assert.ok(!defaultRules.has('runtime/hardcoded-localhost'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('formatters output valid SARIF 2.1.0, Markdown, and standalone HTML', () => {
  const sampleReport: AuditReport = {
    tool: 'smokeproof',
    version: '0.1.0',
    timestamp: '2026-11-25T00:00:00.000Z',
    targetUrl: 'http://localhost:3000',
    browser: 'Google Chrome',
    summary: {
      score: 88,
      passed: false,
      routesAudited: 1,
      totalFindings: 1,
      bySeverity: { critical: 0, high: 1, medium: 0, low: 0 },
      byCategory: { layout: 1 },
      durationMs: 320,
    },
    routes: [
      {
        route: '/',
        url: 'http://localhost:3000/',
        status: 200,
        loadTimeMs: 100,
        title: 'Home',
        discoveredLinks: [],
        screenshots: {},
        findings: [
          {
            id: 'f1',
            rule: 'layout/horizontal-overflow',
            category: 'layout',
            severity: 'high',
            route: '/',
            viewport: 'mobile',
            message: 'Horizontal overflow on mobile',
            selector: '.wide-card',
            suggestion: 'Use max-w-full',
          },
        ],
      },
    ],
    sourceFindings: [],
  };

  const md = formatMarkdownReport(sampleReport);
  assert.match(md, /SmokeProof Audit Report \(FAIL — 88\/100\)/);
  assert.match(md, /layout\/horizontal-overflow/);

  const sarif = JSON.parse(formatSarifReport(sampleReport));
  assert.equal(sarif.version, '2.1.0');
  assert.equal(sarif.runs[0].results.length, 1);
  assert.equal(sarif.runs[0].results[0].ruleId, 'layout/horizontal-overflow');

  const html = formatHtmlReport(sampleReport);
  assert.match(html, /SmokeProof Pre-Ship Audit/);
  assert.match(html, /Horizontal overflow on mobile/);
});
