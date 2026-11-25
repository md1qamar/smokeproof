import type { Page, Request, Response } from 'playwright-core';
import type { Finding } from '../types.js';
import { findSecretsInText } from './secretPatterns.js';

export interface RuntimeCollector {
  getFindings: () => Finding[];
  counts: () => { runtimeErrors: number; networkErrors: number };
  resetDeltaMark: () => { runtimeErrors: number; networkErrors: number };
  getDeltaSince: (mark: { runtimeErrors: number; networkErrors: number }) => {
    newRuntimeErrors: string[];
    newNetworkErrors: string[];
  };
  dispose: () => void;
}

const HYDRATION_OR_FRAMEWORK_WARN =
  /(hydration|did not match|cannot update a component|maximum update depth|unhandled rejection)/i;

/**
 * Attach real-time console, pageerror, failed-request, HTTP 4xx/5xx, slow-response,
 * and same-origin payload secret monitors to a Playwright Page.
 */
export function attachRuntimeCollector(
  page: Page,
  route: string,
  baseOrigin: string,
): RuntimeCollector {
  const findings: Finding[] = [];
  const runtimeLogMessages: string[] = [];
  const networkLogMessages: string[] = [];
  const scannedAssetUrls = new Set<string>();
  const requestStartTimes = new Map<Request, number>();
  let counter = 0;

  const nextId = (prefix: string) => `${prefix}-${route}-${++counter}`;

  const onPageError = (err: Error) => {
    const msg = err?.message || String(err);
    runtimeLogMessages.push(msg);
    findings.push({
      id: nextId('rt'),
      rule: 'runtime/uncaught-exception',
      category: 'runtime',
      severity: 'critical',
      route,
      message: `Uncaught page exception: ${msg}`,
      evidence: err?.stack?.split('\n').slice(0, 4).join('\n'),
      suggestion: 'Inspect the stack trace and add null guards or fix the failing initialization logic.',
    });
  };

  const onConsole = (msg: { type: () => string; text: () => string }) => {
    const type = msg.type();
    const text = msg.text();
    if (type === 'error') {
      // Avoid duplicating raw Chromium "Failed to load resource: the server responded with a status of..."
      if (/Failed to load resource: the server responded with a status of/i.test(text)) {
        return;
      }
      runtimeLogMessages.push(text);
      findings.push({
        id: nextId('con'),
        rule: 'runtime/console-error',
        category: 'runtime',
        severity: 'high',
        route,
        message: `Console error: ${truncate(text, 220)}`,
        evidence: truncate(text, 500),
        suggestion: 'Fix the root cause of the console.error before shipping.',
      });
    } else if (type === 'warning' && HYDRATION_OR_FRAMEWORK_WARN.test(text)) {
      runtimeLogMessages.push(text);
      findings.push({
        id: nextId('hyd'),
        rule: 'runtime/hydration-warning',
        category: 'runtime',
        severity: 'high',
        route,
        message: `Framework hydration/runtime warning: ${truncate(text, 220)}`,
        evidence: truncate(text, 500),
        suggestion: 'Ensure SSR markup matches initial client render and avoid side effects during render.',
      });
    }
  };

  const onRequest = (req: Request) => {
    requestStartTimes.set(req, Date.now());
  };

  const onRequestFailed = (req: Request) => {
    const url = req.url();
    const reason = req.failure()?.errorText || 'unknown network failure';
    if (reason.includes('ERR_ABORTED')) return;
    networkLogMessages.push(`${req.method()} ${url} (${reason})`);
    findings.push({
      id: nextId('netfail'),
      rule: 'network/request-failed',
      category: 'network',
      severity: url.startsWith(baseOrigin) ? 'high' : 'medium',
      route,
      message: `Network request failed: ${req.method()} ${shortUrl(url)} (${reason})`,
      evidence: `${req.method()} ${url} -> ${reason}`,
      suggestion: 'Check target endpoint availability, CORS headers, or URL configuration.',
    });
  };

  const onResponse = async (res: Response) => {
    const req = res.request();
    const start = requestStartTimes.get(req);
    const elapsed = start ? Date.now() - start : 0;
    const url = res.url();
    const status = res.status();
    const resourceType = req.resourceType();

    if (status >= 500) {
      networkLogMessages.push(`${status} ${req.method()} ${url}`);
      findings.push({
        id: nextId('http5xx'),
        rule: 'network/http-5xx',
        category: 'network',
        severity: 'critical',
        route,
        message: `Server returned HTTP ${status} for ${req.method()} ${shortUrl(url)}`,
        evidence: `${status} ${req.method()} ${url}`,
        suggestion: 'Fix the server error or unhandled exception on this API/route endpoint.',
      });
    } else if (status >= 400) {
      const isFavicon = /\/favicon\.ico(\?|$)/i.test(url);
      if (!isFavicon) {
        const isApi = resourceType === 'fetch' || resourceType === 'xhr' || url.includes('/api/');
        networkLogMessages.push(`${status} ${req.method()} ${url}`);
        findings.push({
          id: nextId('http4xx'),
          rule: 'network/http-4xx',
          category: 'network',
          severity: isApi ? 'high' : 'medium',
          route,
          message: `HTTP ${status} for ${resourceType} ${shortUrl(url)}`,
          evidence: `${status} ${req.method()} ${url}`,
          suggestion: isApi
            ? 'Verify API route path, payload schema, and auth tokens.'
            : 'Fix the broken static asset or route reference.',
        });
      }
    } else if (elapsed > 3500 && (resourceType === 'fetch' || resourceType === 'xhr' || resourceType === 'document')) {
      findings.push({
        id: nextId('slow'),
        rule: 'network/slow-response',
        category: 'network',
        severity: 'low',
        route,
        message: `Slow ${resourceType} response (${elapsed}ms) for ${shortUrl(url)}`,
        evidence: `${elapsed}ms -> ${url}`,
        suggestion: 'Investigate slow database queries, blocking work, or missing caching.',
      });
    }

    // Scan same-origin HTML/JS/JSON responses for accidentally bundled secrets
    if (
      url.startsWith(baseOrigin) &&
      !scannedAssetUrls.has(url) &&
      (resourceType === 'document' || resourceType === 'script' || resourceType === 'fetch' || resourceType === 'xhr')
    ) {
      scannedAssetUrls.add(url);
      try {
        const contentType = res.headers()['content-type'] || '';
        if (/html|javascript|json|text/i.test(contentType)) {
          const text = await res.text();
          if (text.length <= 750_000) {
            const secrets = findSecretsInText(text);
            for (const secret of secrets) {
              findings.push({
                id: nextId('sec'),
                rule: `security/exposed-${secret.ruleId}`,
                category: 'security',
                severity: secret.severity,
                route,
                message: `Exposed ${secret.label} detected in live ${resourceType} response (${shortUrl(url)})`,
                evidence: `Matched redacted value: ${secret.redacted}`,
                suggestion: 'Move private credentials to server-side environment variables and rotate the exposed key immediately.',
              });
            }
          }
        }
      } catch {
        // Response body may be unavailable for redirects or streams
      }
    }
  };

  page.on('pageerror', onPageError);
  page.on('console', onConsole);
  page.on('request', onRequest);
  page.on('requestfailed', onRequestFailed);
  page.on('response', onResponse);

  return {
    getFindings: () => [...findings],
    counts: () => ({
      runtimeErrors: runtimeLogMessages.length,
      networkErrors: networkLogMessages.length,
    }),
    resetDeltaMark: () => ({
      runtimeErrors: runtimeLogMessages.length,
      networkErrors: networkLogMessages.length,
    }),
    getDeltaSince: (mark) => ({
      newRuntimeErrors: runtimeLogMessages.slice(mark.runtimeErrors),
      newNetworkErrors: networkLogMessages.slice(mark.networkErrors),
    }),
    dispose: () => {
      page.off('pageerror', onPageError);
      page.off('console', onConsole);
      page.off('request', onRequest);
      page.off('requestfailed', onRequestFailed);
      page.off('response', onResponse);
    },
  };
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

function shortUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.pathname}${u.search}`;
  } catch {
    return raw;
  }
}
