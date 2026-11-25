import fs from 'fs';
import path from 'path';
import type { Browser, Page } from 'playwright-core';
import { launchAuditBrowser } from '../browser/resolver.js';
import { runSafeInteractionProbes } from '../checks/interactionCheck.js';
import { runLayoutChecks } from '../checks/layoutCheck.js';
import { runMetaAndA11yChecks } from '../checks/metaA11yCheck.js';
import { attachRuntimeCollector } from '../checks/runtimeCheck.js';
import { scanWorkspaceSource } from '../checks/sourceScanner.js';
import { resolveAuditConfig } from '../config.js';
import { captureAnnotatedScreenshot } from '../report/annotator.js';
import { formatHtmlReport } from '../report/formatters.js';
import { computeAuditSummary } from '../report/scorer.js';
import { startTargetServer, type RunningServer } from '../runner/serverLauncher.js';
import type {
  AuditConfig,
  AuditReport,
  Finding,
  FixVerificationResult,
  RouteAuditResult,
} from '../types.js';

export const TOOL_VERSION = '0.1.0';

const SKIP_BINARY_EXT_PATTERN =
  /\.(?:png|jpe?g|gif|webp|svg|ico|pdf|zip|tar|gz|mp4|webm|mp3|woff2?|ttf|eot)$/i;

interface QueueItem {
  url: string;
  route: string;
  depth: number;
}

/**
 * Crawl and audit a live or command-launched web application in real headless Chromium.
 */
export async function runSmokeAudit(
  targetUrl: string,
  overrides: Partial<AuditConfig> = {},
): Promise<AuditReport> {
  const startedAt = Date.now();
  const config = resolveAuditConfig(targetUrl, overrides);
  const startUrl = new URL(config.url);
  const baseOrigin = startUrl.origin;

  let server: RunningServer | null = null;
  let browser: Browser | null = null;
  let browserLabel = 'Chromium';

  try {
    if (config.cmd) {
      server = await startTargetServer(config.cmd, config.url, config.cwd, Math.max(config.timeoutMs, 25000));
    }

    const launched = await launchAuditBrowser(config.browserPath);
    browser = launched.browser;
    browserLabel = launched.browserLabel;

    const visited = new Set<string>();
    const queue: QueueItem[] = [
      {
        url: startUrl.toString(),
        route: normalizeRouteKey(startUrl),
        depth: 0,
      },
    ];
    const routes: RouteAuditResult[] = [];
    const ignoredRules = new Set<string>(config.ignoreRules);

    while (queue.length > 0 && routes.length < config.maxPages) {
      const item = queue.shift()!;
      if (visited.has(item.route)) continue;
      if (!matchesRouteFilters(item.route, config.include, config.exclude)) continue;
      visited.add(item.route);

      const result = await auditSingleRoute(browser, item.url, item.route, baseOrigin, config, ignoredRules);
      routes.push(result);

      if (item.depth < config.maxDepth) {
        for (const nextUrlStr of result.discoveredLinks) {
          try {
            const parsed = new URL(nextUrlStr);
            if (parsed.origin !== baseOrigin) continue;
            if (SKIP_BINARY_EXT_PATTERN.test(parsed.pathname)) continue;
            const nextRoute = normalizeRouteKey(parsed);
            if (!visited.has(nextRoute) && !queue.some((q) => q.route === nextRoute)) {
              queue.push({ url: parsed.toString(), route: nextRoute, depth: item.depth + 1 });
            }
          } catch {
            // Skip invalid discovered hrefs
          }
        }
      }
    }

    const sourceFindings = config.scanSource
      ? scanWorkspaceSource(config.cwd).filter((f) => !ignoredRules.has(f.rule))
      : [];

    const durationMs = Date.now() - startedAt;
    const summary = computeAuditSummary(routes, sourceFindings, config, durationMs);

    const report: AuditReport = {
      tool: 'smokeproof',
      version: TOOL_VERSION,
      timestamp: new Date().toISOString(),
      targetUrl: config.url,
      browser: browserLabel,
      summary,
      routes,
      sourceFindings,
      artifactsDir: config.screenshots ? config.artifactsDir : undefined,
    };

    if (config.screenshots) {
      fs.mkdirSync(config.artifactsDir, { recursive: true });
      fs.writeFileSync(path.join(config.artifactsDir, 'smokeproof-report.json'), JSON.stringify(report, null, 2));
      fs.writeFileSync(path.join(config.artifactsDir, 'smokeproof-report.html'), formatHtmlReport(report));
    }

    return report;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    if (server) {
      await server.stop().catch(() => {});
    }
  }
}

/**
 * Re-run smoke checks against previously audited routes and return resolved/remaining/introduced findings.
 */
export async function verifySmokeFixes(
  targetUrl: string,
  previousReport: AuditReport,
  overrides: Partial<AuditConfig> = {},
): Promise<FixVerificationResult> {
  const routesToVerify = previousReport.routes.map((r) => r.route);
  const current = await runSmokeAudit(targetUrl, {
    ...overrides,
    maxPages: Math.max(routesToVerify.length, overrides.maxPages ?? 12),
  });

  const prevFindings = [
    ...previousReport.routes.flatMap((r) => r.findings),
    ...(previousReport.sourceFindings || []),
  ];
  const currFindings = [
    ...current.routes.flatMap((r) => r.findings),
    ...(current.sourceFindings || []),
  ];

  const prevMap = new Map(prevFindings.map((f) => [fingerprintFinding(f), f]));
  const currMap = new Map(currFindings.map((f) => [fingerprintFinding(f), f]));

  const resolved: Finding[] = [];
  const remaining: Finding[] = [];
  const introduced: Finding[] = [];

  for (const [key, f] of prevMap) {
    if (currMap.has(key)) remaining.push(currMap.get(key)!);
    else resolved.push(f);
  }
  for (const [key, f] of currMap) {
    if (!prevMap.has(key)) introduced.push(f);
  }

  return {
    targetUrl: current.targetUrl,
    previousFindings: prevFindings.length,
    currentFindings: currFindings.length,
    resolved,
    remaining,
    introduced,
    passed: current.summary.passed,
    score: current.summary.score,
  };
}

async function auditSingleRoute(
  browser: Browser,
  url: string,
  route: string,
  baseOrigin: string,
  config: AuditConfig,
  ignoredRules: Set<string>,
): Promise<RouteAuditResult> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    extraHTTPHeaders: config.headers,
  });
  const page = await context.newPage();
  const collector = attachRuntimeCollector(page, route, baseOrigin);
  const routeFindings: Finding[] = [];
  const screenshots: { desktop?: string; mobile?: string } = {};

  let status: number | null = null;
  let title = '';
  let discoveredLinks: string[] = [];
  const navStart = Date.now();

  try {
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: config.timeoutMs,
    });
    status = response?.status() ?? null;

    // Give SPA hydration and immediate fetch calls a chance to settle
    await page.waitForLoadState('networkidle', { timeout: 2500 }).catch(() => {});
    if (config.settleMs > 0) {
      await page.waitForTimeout(config.settleMs);
    }

    if (status !== null && status >= 500) {
      routeFindings.push({
        id: `route-5xx-${route}`,
        rule: 'network/route-http-5xx',
        category: 'network',
        severity: 'critical',
        route,
        message: `Document route ${route} returned HTTP ${status}.`,
        suggestion: 'Fix the server-side render/handler error for this route.',
      });
    } else if (status !== null && status >= 400) {
      routeFindings.push({
        id: `route-4xx-${route}`,
        rule: 'network/route-http-4xx',
        category: 'network',
        severity: 'high',
        route,
        message: `Document route ${route} returned HTTP ${status}.`,
        suggestion: 'Verify route registration, redirects, or auth middleware.',
      });
    }

    discoveredLinks = await extractSameOriginLinks(page, baseOrigin);
    const desktopLayout = await runLayoutChecks(page, route, 'desktop');
    const metaA11y = await runMetaAndA11yChecks(page, route);
    title = metaA11y.title;

    const interactionFindings = config.interact
      ? await runSafeInteractionProbes(page, route, collector, config.maxInteractionsPerRoute)
      : [];

    routeFindings.push(...desktopLayout, ...metaA11y.findings, ...interactionFindings);

    const desktopPreMerge = [...routeFindings, ...collector.getFindings()].filter(
      (f) => !ignoredRules.has(f.rule),
    );
    if (config.screenshots && (desktopPreMerge.length > 0 || route === '/')) {
      screenshots.desktop = await captureAnnotatedScreenshot(
        page,
        route,
        'desktop',
        desktopPreMerge,
        config.artifactsDir,
      );
    }

    if (config.mobile) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(250);
      const mobileFindings = await runLayoutChecks(page, route, 'mobile');
      routeFindings.push(...mobileFindings);

      const mobileOnly = mobileFindings.filter((f) => !ignoredRules.has(f.rule));
      if (config.screenshots && mobileOnly.length > 0) {
        screenshots.mobile = await captureAnnotatedScreenshot(
          page,
          route,
          'mobile',
          mobileOnly,
          config.artifactsDir,
        );
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    routeFindings.push({
      id: `nav-err-${route}`,
      rule: 'runtime/navigation-failed',
      category: 'runtime',
      severity: 'critical',
      route,
      message: `Failed to load route ${route}: ${msg}`,
      suggestion: 'Ensure the target server is reachable and responds within the configured timeout.',
    });
  } finally {
    collector.dispose();
    await context.close().catch(() => {});
  }

  const collected = collector.getFindings();
  const merged = deduplicateFindings([...routeFindings, ...collected]).filter(
    (f) => !ignoredRules.has(f.rule),
  );

  return {
    route,
    url,
    status,
    loadTimeMs: Date.now() - navStart,
    title,
    findings: merged,
    screenshots,
    discoveredLinks,
  };
}

async function extractSameOriginLinks(page: Page, baseOrigin: string): Promise<string[]> {
  return page
    .evaluate((origin: string) => {
      const urls = new Set<string>();
      document.querySelectorAll('a[href]').forEach((a) => {
        const href = a.getAttribute('href');
        if (!href || href.startsWith('#') || /^(?:mailto:|tel:|javascript:)/i.test(href)) return;
        try {
          const resolved = new URL(href, window.location.href);
          if (resolved.origin === origin) {
            resolved.hash = '';
            urls.add(resolved.toString());
          }
        } catch {
          // Ignore malformed hrefs
        }
      });
      return Array.from(urls);
    }, baseOrigin)
    .catch(() => []);
}

function normalizeRouteKey(u: URL): string {
  const cleanPath = u.pathname === '/' ? '/' : u.pathname.replace(/\/+$/, '');
  return `${cleanPath}${u.search}`;
}

function matchesRouteFilters(route: string, include: string[], exclude: string[]): boolean {
  if (include.length > 0 && !include.some((p) => matchSimplePattern(route, p))) {
    return false;
  }
  if (exclude.some((p) => matchSimplePattern(route, p))) {
    return false;
  }
  return true;
}

function matchSimplePattern(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(value) || value.includes(pattern);
}

function deduplicateFindings(items: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const item of items) {
    const key = `${item.rule}|${item.route}|${item.viewport || ''}|${item.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

function fingerprintFinding(f: Finding): string {
  return `${f.rule}|${f.route}|${f.viewport || ''}|${f.selector || ''}`;
}
