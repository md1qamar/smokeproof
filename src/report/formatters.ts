import fs from 'fs';
import type { AuditReport, Finding, Severity } from '../types.js';

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

const SEV_BADGE: Record<Severity, { label: string; color: string }> = {
  critical: { label: 'CRIT', color: ANSI.red },
  high: { label: 'HIGH', color: ANSI.magenta },
  medium: { label: 'MED ', color: ANSI.yellow },
  low: { label: 'LOW ', color: ANSI.blue },
};

/**
 * Render a concise, high-signal terminal report with color support.
 */
export function formatTerminalReport(report: AuditReport, useColor = process.stdout.isTTY): string {
  const c = (code: string, text: string) => (useColor ? `${code}${text}${ANSI.reset}` : text);
  const { summary } = report;
  const statusBadge = summary.passed
    ? c(ANSI.green + ANSI.bold, ' PASS ')
    : c(ANSI.red + ANSI.bold, ' FAIL ');

  const lines: string[] = [
    '',
    `${c(ANSI.bold, 'SmokeProof')} ${c(ANSI.dim, `v${report.version}`)}  ${statusBadge}  ${c(ANSI.bold, `Score: ${summary.score}/100`)}`,
    `${c(ANSI.dim, 'Target:')} ${report.targetUrl}  ${c(ANSI.dim, '| Browser:')} ${report.browser}  ${c(ANSI.dim, '| Duration:')} ${(summary.durationMs / 1000).toFixed(2)}s`,
    `${c(ANSI.dim, 'Routes:')} ${summary.routesAudited}  ${c(ANSI.dim, '| Findings:')} ${summary.totalFindings} (${summary.bySeverity.critical} critical, ${summary.bySeverity.high} high, ${summary.bySeverity.medium} medium, ${summary.bySeverity.low} low)`,
    '',
  ];

  for (const r of report.routes) {
    const routeStatus = r.status ?? 'ERR';
    const countLabel =
      r.findings.length === 0
        ? c(ANSI.green, '0 issues')
        : c(ANSI.yellow, `${r.findings.length} issue(s)`);
    lines.push(`${c(ANSI.cyan + ANSI.bold, r.route)} ${c(ANSI.dim, `[HTTP ${routeStatus}, ${r.loadTimeMs}ms]`)} - ${countLabel}`);

    for (const f of r.findings) {
      const sev = SEV_BADGE[f.severity];
      const vp = f.viewport ? `[${f.viewport}] ` : '';
      lines.push(`  ${c(sev.color + ANSI.bold, `[${sev.label}]`)} ${vp}${f.message} ${c(ANSI.dim, `(${f.rule})`)}`);
      if (f.selector) {
        lines.push(`         ${c(ANSI.dim, `Selector: ${f.selector}`)}`);
      }
      if (f.evidence) {
        lines.push(`         ${c(ANSI.dim, `Evidence: ${f.evidence}`)}`);
      }
      lines.push(`         ${c(ANSI.dim, `Fix: ${f.suggestion}`)}`);
    }

    if (r.screenshots.desktop || r.screenshots.mobile) {
      const shots = [r.screenshots.desktop, r.screenshots.mobile].filter(Boolean).join(' , ');
      lines.push(`  ${c(ANSI.dim, `Screenshots: ${shots}`)}`);
    }
    if (r.reproGif) {
      lines.push(`  ${c(ANSI.magenta, `Repro GIF: ${r.reproGif}`)}`);
    }
    lines.push('');
  }

  if (report.sourceFindings.length > 0) {
    lines.push(c(ANSI.bold, 'Workspace Source Scan Findings:'));
    for (const f of report.sourceFindings) {
      const sev = SEV_BADGE[f.severity];
      lines.push(`  ${c(sev.color + ANSI.bold, `[${sev.label}]`)} ${f.message} ${c(ANSI.dim, `(${f.rule})`)}`);
      lines.push(`         ${c(ANSI.dim, `Fix: ${f.suggestion}`)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Render a Markdown report ready for GitHub PR comments or AI agent fix loops.
 */
export function formatMarkdownReport(report: AuditReport): string {
  const { summary } = report;
  const verdict = summary.passed ? 'PASS' : 'FAIL';
  const lines: string[] = [
    `# SmokeProof Audit Report (${verdict} — ${summary.score}/100)`,
    '',
    `- **Target:** \`${report.targetUrl}\``,
    `- **Browser:** ${report.browser}`,
    `- **Routes Audited:** ${summary.routesAudited}`,
    `- **Findings:** ${summary.totalFindings} (${summary.bySeverity.critical} critical, ${summary.bySeverity.high} high, ${summary.bySeverity.medium} medium, ${summary.bySeverity.low} low)`,
    '',
  ];

  const all = [...report.routes.flatMap((r) => r.findings), ...report.sourceFindings];
  if (all.length === 0) {
    lines.push('No runtime, layout, accessibility, or security issues detected.');
    return lines.join('\n');
  }

  lines.push('| Severity | Route | Viewport | Rule | Finding | Fix |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const f of all) {
    lines.push(
      `| **${f.severity.toUpperCase()}** | \`${escapeMd(f.route)}\` | ${f.viewport || '-'} | \`${f.rule}\` | ${escapeMd(f.message)} | ${escapeMd(f.suggestion)} |`,
    );
  }

  return lines.join('\n');
}

/**
 * Generate a SARIF v2.1.0 report for GitHub Code Scanning / CI integrations.
 */
export function formatSarifReport(report: AuditReport): string {
  const allFindings = [...report.routes.flatMap((r) => r.findings), ...report.sourceFindings];
  const rulesMap = new Map<string, { id: string; shortDescription: { text: string } }>();

  for (const f of allFindings) {
    if (!rulesMap.has(f.rule)) {
      rulesMap.set(f.rule, {
        id: f.rule,
        shortDescription: { text: f.suggestion },
      });
    }
  }

  const levelMap: Record<Severity, 'error' | 'warning' | 'note'> = {
    critical: 'error',
    high: 'error',
    medium: 'warning',
    low: 'note',
  };

  const sarif = {
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'smokeproof',
            version: report.version,
            rules: Array.from(rulesMap.values()),
          },
        },
        results: allFindings.map((f) => ({
          ruleId: f.rule,
          level: levelMap[f.severity],
          message: { text: `${f.message}${f.evidence ? `\nEvidence: ${f.evidence}` : ''}` },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.file || f.route },
                ...(f.line ? { region: { startLine: f.line } } : {}),
              },
            },
          ],
        })),
      },
    ],
  };

  return JSON.stringify(sarif, null, 2);
}

/**
 * Generate a self-contained single-file HTML visual report embedding screenshots as data URIs.
 */
export function formatHtmlReport(report: AuditReport): string {
  const { summary } = report;
  const allFindings = [...report.routes.flatMap((r) => r.findings), ...report.sourceFindings];

  const routeCards = report.routes
    .map((r) => {
      const desktopImg = fileToDataUri(r.screenshots.desktop);
      const mobileImg = fileToDataUri(r.screenshots.mobile);
      const reproGifImg = fileToDataUri(r.reproGif, 'image/gif');
      const itemsHtml = r.findings.length
        ? r.findings.map((f) => renderFindingCard(f)).join('\n')
        : '<div class="ok">All browser checks passed on this route.</div>';

      return `
      <section class="route-card">
        <div class="route-header">
          <div>
            <h2>${escapeHtml(r.route)}</h2>
            <span class="meta">HTTP ${r.status ?? 'ERR'} &middot; ${r.loadTimeMs}ms &middot; ${escapeHtml(r.title || 'No title')}</span>
          </div>
          <span class="pill ${r.findings.length ? 'pill-warn' : 'pill-ok'}">${r.findings.length} finding(s)</span>
        </div>
        <div class="findings-list">${itemsHtml}</div>
        ${
          desktopImg || mobileImg || reproGifImg
            ? `<div class="shots">
                ${reproGifImg ? `<figure><figcaption>Chaos / Bug Repro GIF</figcaption><img src="${reproGifImg}" alt="Repro GIF for ${escapeHtml(r.route)}" /></figure>` : ''}
                ${desktopImg ? `<figure><figcaption>Desktop (1440x900)</figcaption><img src="${desktopImg}" alt="Desktop screenshot for ${escapeHtml(r.route)}" /></figure>` : ''}
                ${mobileImg ? `<figure><figcaption>Mobile (390x844)</figcaption><img src="${mobileImg}" alt="Mobile screenshot for ${escapeHtml(r.route)}" /></figure>` : ''}
               </div>`
            : ''
        }
      </section>`;
    })
    .join('\n');

  const sourceBlock = report.sourceFindings.length
    ? `<section class="route-card">
        <div class="route-header"><h2>Workspace Source Findings</h2><span class="pill pill-warn">${report.sourceFindings.length}</span></div>
        <div class="findings-list">${report.sourceFindings.map(renderFindingCard).join('\n')}</div>
       </section>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SmokeProof Report — ${escapeHtml(report.targetUrl)}</title>
  <style>
    :root { color-scheme: dark; --bg: #0b0f17; --card: #111827; --border: #1f2937; --text: #f3f4f6; --muted: #9ca3af; }
    body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; }
    .wrap { max-width: 1120px; margin: 0 auto; padding: 32px 20px 64px; }
    header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 16px; padding-bottom: 24px; border-bottom: 1px solid var(--border); margin-bottom: 24px; }
    h1 { margin: 0; font-size: 26px; letter-spacing: -0.02em; }
    .score-box { display: flex; align-items: center; gap: 12px; background: var(--card); border: 1px solid var(--border); padding: 12px 18px; border-radius: 12px; }
    .score-num { font-size: 28px; font-weight: 800; color: ${summary.passed ? '#34d399' : '#f87171'}; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 28px; }
    .stat { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 14px; }
    .stat b { display: block; font-size: 22px; margin-top: 4px; }
    .route-card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; margin-bottom: 20px; }
    .route-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 14px; }
    .route-header h2 { margin: 0; font-size: 18px; font-family: ui-monospace, monospace; }
    .meta { color: var(--muted); font-size: 13px; }
    .pill { padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }
    .pill-ok { background: #064e3b; color: #6ee7b7; }
    .pill-warn { background: #451a03; color: #fdba74; }
    .finding { border-left: 3px solid #6b7280; background: #0f172a; padding: 12px 14px; border-radius: 6px; margin-bottom: 10px; }
    .sev-critical { border-left-color: #ef4444; }
    .sev-high { border-left-color: #f97316; }
    .sev-medium { border-left-color: #eab308; }
    .sev-low { border-left-color: #3b82f6; }
    .finding-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-weight: 600; }
    .tag { font-size: 11px; text-transform: uppercase; padding: 2px 6px; border-radius: 4px; background: #1f2937; color: #e5e7eb; }
    .code { font-family: ui-monospace, monospace; font-size: 12px; color: var(--muted); margin-top: 4px; word-break: break-word; }
    .fix { font-size: 13px; color: #a7f3d0; margin-top: 6px; }
    .ok { color: #6ee7b7; font-size: 14px; }
    .shots { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; margin-top: 16px; }
    figure { margin: 0; }
    figcaption { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
    img { width: 100%; border-radius: 8px; border: 1px solid var(--border); background: #000; }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div>
        <h1>SmokeProof Pre-Ship Audit</h1>
        <div class="meta">${escapeHtml(report.targetUrl)} &middot; ${escapeHtml(report.browser)} &middot; ${escapeHtml(report.timestamp)}</div>
      </div>
      <div class="score-box">
        <div>
          <div class="meta">Ship Score (${summary.passed ? 'PASS' : 'FAIL'})</div>
          <div class="score-num">${summary.score}/100</div>
        </div>
      </div>
    </header>
    <div class="grid">
      <div class="stat"><span class="meta">Routes Audited</span><b>${summary.routesAudited}</b></div>
      <div class="stat"><span class="meta">Total Findings</span><b>${allFindings.length}</b></div>
      <div class="stat"><span class="meta">Critical / High</span><b>${summary.bySeverity.critical + summary.bySeverity.high}</b></div>
      <div class="stat"><span class="meta">Duration</span><b>${(summary.durationMs / 1000).toFixed(2)}s</b></div>
    </div>
    ${routeCards}
    ${sourceBlock}
  </div>
</body>
</html>`;
}

function renderFindingCard(f: Finding): string {
  return `<div class="finding sev-${f.severity}">
    <div class="finding-top">
      <span class="tag">${escapeHtml(f.severity)}</span>
      <span class="tag">${escapeHtml(f.rule)}</span>
      ${f.viewport ? `<span class="tag">${escapeHtml(f.viewport)}</span>` : ''}
      <span>${escapeHtml(f.message)}</span>
    </div>
    ${f.selector ? `<div class="code">Selector: ${escapeHtml(f.selector)}</div>` : ''}
    ${f.evidence ? `<div class="code">Evidence: ${escapeHtml(f.evidence)}</div>` : ''}
    <div class="fix">Fix: ${escapeHtml(f.suggestion)}</div>
  </div>`;
}

function fileToDataUri(filePath?: string, mime = 'image/png'): string | null {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const b64 = fs.readFileSync(filePath).toString('base64');
    return `data:${mime};base64,${b64}`;
  } catch {
    return null;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeMd(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
