import path from 'path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { renderKeyframesToGif, type DemoKeyframe } from '../demo/gifStudio.js';
import { routeToSlug } from '../report/annotator.js';
import type { Finding } from '../types.js';
import type { RuntimeCollector } from './runtimeCheck.js';

const XSS_PROBE = `<img src=x onerror="window.__smokeproofXss=1">`;
const LONG_STR_PROBE = 'A'.repeat(1800) + ' 🚀 ';

export interface ChaosRunResult {
  findings: Finding[];
  reproGif?: string;
}

/**
 * Attack live forms, interactive controls, and offline network resilience to surface
 * crashes, XSS sinks, 5xx failures, and blank screens — generating an animated Repro GIF on failure.
 */
export async function runChaosProbes(
  page: Page,
  context: BrowserContext,
  browser: Browser,
  route: string,
  collector: RuntimeCollector,
  artifactsDir: string,
): Promise<ChaosRunResult> {
  const findings: Finding[] = [];
  const keyframes: DemoKeyframe[] = [];
  const vp = page.viewportSize() || { width: 1280, height: 720 };
  const routeUrl = page.url();

  const pushFrame = async (
    caption: string,
    cx: number,
    cy: number,
    zoom: number,
    statusTag: 'ok' | 'bug' | 'chaos',
    clickEffect = false,
  ) => {
    const png = await page.screenshot({ type: 'png' }).catch(() => null);
    if (!png) return;
    keyframes.push({
      screenshotPng: png,
      viewportWidth: vp.width,
      viewportHeight: vp.height,
      caption,
      cursorX: cx,
      cursorY: cy,
      zoom,
      clickEffect,
      statusTag,
      holdMs: statusTag === 'bug' ? 1100 : 600,
    });
  };

  await pushFrame(`Chaos scan on ${route}`, vp.width * 0.5, vp.height * 0.35, 1.0, 'chaos');

  // 1. Form & Input Fuzzing (Empty submit, Oversized string, Harmless XSS canary)
  const inputHandles = await page.evaluate(() => {
    const fields = Array.from(
      document.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]), textarea'),
    );
    const out: Array<{ marker: string; selector: string }> = [];
    fields.slice(0, 3).forEach((el, idx) => {
      const style = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || r.width <= 0 || r.height <= 0) return;
      const marker = `chaos-in-${idx}`;
      el.setAttribute('data-sp-chaos', marker);
      const tag = el.tagName.toLowerCase();
      out.push({ marker, selector: el.id ? `#${el.id}` : tag });
    });
    return out;
  });

  if (inputHandles.length > 0) {
    const payloads = [
      { label: 'empty input', value: '' },
      { label: 'XSS canary payload', value: XSS_PROBE },
      { label: '1800-char + emoji burst', value: LONG_STR_PROBE },
    ];

    for (const payload of payloads) {
      const mark = collector.resetDeltaMark();
      let lastBox = { x: vp.width * 0.5, y: vp.height * 0.45, width: 100, height: 30 };

      for (const field of inputHandles) {
        const loc = page.locator(`[data-sp-chaos="${field.marker}"]`).first();
        if ((await loc.count()) === 0) continue;
        const b = await loc.boundingBox().catch(() => null);
        if (b) lastBox = b;
        await loc.fill(payload.value, { timeout: 1200 }).catch(() => {});
      }

      // Trigger form submit if a safe submit button exists
      const submitBtn = page.locator('form button[type="submit"], form input[type="submit"]').first();
      if ((await submitBtn.count()) > 0) {
        await submitBtn.click({ timeout: 1200 }).catch(() => {});
      }

      await page.waitForTimeout(250);
      const xssTriggered = await page
        .evaluate(() => {
          const w = window as unknown as { __smokeproofXss?: number };
          const hit = Boolean(w.__smokeproofXss);
          w.__smokeproofXss = 0;
          return hit;
        })
        .catch(() => false);
      const isBlank = await page.evaluate(() => (document.body?.innerText || '').trim().length === 0).catch(() => false);
      const delta = collector.getDeltaSince(mark);

      let hadFailure = false;
      if (xssTriggered) {
        hadFailure = true;
        findings.push({
          id: `chaos-xss-${route}`,
          rule: 'chaos/xss-execution',
          category: 'chaos',
          severity: 'critical',
          route,
          message: `XSS payload executed via ${payload.label} on ${route}!`,
          evidence: XSS_PROBE,
          selector: inputHandles[0].selector,
          suggestion: 'Escape or sanitize user input before injecting into DOM/HTML templates.',
        });
        await pushFrame('CRITICAL: XSS Payload Executed!', lastBox.x + lastBox.width / 2, lastBox.y + lastBox.height / 2, 1.35, 'bug', true);
      }
      if (isBlank) {
        hadFailure = true;
        findings.push({
          id: `chaos-blank-${route}-${payload.label}`,
          rule: 'chaos/blank-after-fuzz',
          category: 'chaos',
          severity: 'critical',
          route,
          message: `Page crashed to blank screen after fuzzing ${payload.label}.`,
          selector: inputHandles[0].selector,
          suggestion: 'Add error boundaries and defensive input validation before rendering state.',
        });
        await pushFrame(`CRASH: Blank Screen on ${payload.label}`, lastBox.x + lastBox.width / 2, lastBox.y + lastBox.height / 2, 1.2, 'bug', true);
      }
      if (delta.newRuntimeErrors.length > 0 || delta.newNetworkErrors.length > 0) {
        hadFailure = true;
        findings.push({
          id: `chaos-err-${route}-${payload.label}`,
          rule: 'chaos/input-crash',
          category: 'chaos',
          severity: 'high',
          route,
          message: `Fuzzing ${payload.label} triggered runtime/API failure.`,
          evidence: [...delta.newRuntimeErrors, ...delta.newNetworkErrors].slice(0, 2).join(' | '),
          selector: inputHandles[0].selector,
          suggestion: 'Validate empty/oversized/special-character inputs on both client and server.',
        });
        await pushFrame(`BUG: Error on ${payload.label}`, lastBox.x + lastBox.width / 2, lastBox.y + lastBox.height / 2, 1.3, 'bug', true);
      }
      if (!hadFailure) {
        await pushFrame(`Fuzz OK: ${payload.label}`, lastBox.x + lastBox.width / 2, lastBox.y + lastBox.height / 2, 1.22, 'chaos', true);
      }

      if (page.url() !== routeUrl) {
        await page.goto(routeUrl, { waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(200);
      }
    }
  }

  // 2. Rapid Double-Click Stress Probe on primary non-destructive button
  const primaryBtn = await page.evaluate(() => {
    const destructive = /\b(delete|remove|destroy|logout|sign out|pay|checkout|buy)\b/i;
    const btn = Array.from(document.querySelectorAll('button:not([type="submit"]), [role="button"]')).find((el) => {
      const r = el.getBoundingClientRect();
      const txt = (el.textContent || el.getAttribute('aria-label') || '').trim();
      return !(el as HTMLButtonElement).disabled && r.width > 16 && r.height > 16 && !destructive.test(txt);
    });
    if (!btn) return null;
    btn.setAttribute('data-sp-chaos-dbl', '1');
    const r = btn.getBoundingClientRect();
    return {
      selector: btn.id ? `#${btn.id}` : 'button',
      cx: r.left + r.width / 2,
      cy: r.top + r.height / 2,
    };
  });

  if (primaryBtn) {
    const mark = collector.resetDeltaMark();
    const loc = page.locator('[data-sp-chaos-dbl="1"]').first();
    await loc.dblclick({ timeout: 1200 }).catch(() => {});
    await page.waitForTimeout(250);
    const delta = collector.getDeltaSince(mark);
    if (delta.newRuntimeErrors.length > 0 || delta.newNetworkErrors.length > 0) {
      findings.push({
        id: `chaos-dbl-${route}`,
        rule: 'chaos/double-click-crash',
        category: 'chaos',
        severity: 'high',
        route,
        message: `Rapid double-click on ${primaryBtn.selector} triggered runtime or API errors.`,
        evidence: [...delta.newRuntimeErrors, ...delta.newNetworkErrors].slice(0, 2).join(' | '),
        selector: primaryBtn.selector,
        suggestion: 'Debounce async handlers or guard loading state during pending requests.',
      });
      await pushFrame('BUG: Double-Click Race Failure', primaryBtn.cx, primaryBtn.cy, 1.35, 'bug', true);
    }
  }

  // 3. Offline Resilience Probe
  const offlineMark = collector.resetDeltaMark();
  try {
    await context.setOffline(true);
    if (primaryBtn) {
      await page.locator('[data-sp-chaos-dbl="1"]').first().click({ timeout: 800 }).catch(() => {});
      await page.waitForTimeout(200);
    }
    const delta = collector.getDeltaSince(offlineMark);
    if (delta.newRuntimeErrors.length > 0) {
      findings.push({
        id: `chaos-offline-${route}`,
        rule: 'chaos/unhandled-offline-error',
        category: 'chaos',
        severity: 'medium',
        route,
        message: 'App threw unhandled runtime errors when network went offline.',
        evidence: delta.newRuntimeErrors.slice(0, 2).join(' | '),
        suggestion: 'Catch fetch/network rejections and render a graceful offline retry state.',
      });
      await pushFrame('BUG: Unhandled Offline Crash', vp.width * 0.5, vp.height * 0.5, 1.15, 'bug');
    }
  } finally {
    await context.setOffline(false).catch(() => {});
  }

  // Render animated Repro GIF when chaos detects real failures
  let reproGif: string | undefined;
  if (findings.length > 0 && keyframes.length >= 2) {
    const outPath = path.join(artifactsDir, 'repro', `chaos-${routeToSlug(route)}.gif`);
    const rendered = await renderKeyframesToGif(browser, keyframes, outPath, {
      width: 800,
      height: 450,
      fps: 9,
      urlLabel: `CHAOS: ${route}`,
    }).catch(() => null);
    if (rendered) {
      reproGif = rendered.gifPath;
      findings.forEach((f) => {
        f.reproGif = reproGif;
      });
    }
  }

  return { findings, reproGif };
}
