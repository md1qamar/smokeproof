import type { Page } from 'playwright-core';
import type { BoundingBox, Finding } from '../types.js';
import type { RuntimeCollector } from './runtimeCheck.js';

const DESTRUCTIVE_LABEL_PATTERN =
  /\b(delete|remove|destroy|drop|logout|log out|sign out|pay|checkout|purchase|buy|unsubscribe|revoke|terminate|reset|clear all)\b/i;

interface CandidateControl {
  index: number;
  selector: string;
  label: string;
  isSubmit: boolean;
  box: BoundingBox;
}

/**
 * Safely click non-destructive buttons and tabs on the route to detect controls that throw
 * runtime/network errors or appear completely wired to nothing ("dead buttons").
 */
export async function runSafeInteractionProbes(
  page: Page,
  route: string,
  collector: RuntimeCollector,
  maxProbes: number,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  if (maxProbes <= 0) return findings;

  const candidates = await page.evaluate((limit: number) => {
    const out: CandidateControl[] = [];
    const els = Array.from(document.querySelectorAll('button, [role="button"], [role="tab"]'));

    const getSelector = (el: Element): string => {
      if (el.id) return `#${el.id}`;
      const tag = el.tagName.toLowerCase();
      const cls =
        typeof el.className === 'string' && el.className.trim()
          ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
          : '';
      return `${tag}${cls}`;
    };

    els.forEach((el, idx) => {
      if (out.length >= limit * 2) return;
      if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') return;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      // Mark element so Playwright can target the exact node safely
      el.setAttribute('data-smokeproof-probe', String(idx));
      const label = (
        el.textContent ||
        el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        ''
      )
        .trim()
        .replace(/\s+/g, ' ');

      const typeAttr = (el.getAttribute('type') || '').toLowerCase();
      const isSubmit = typeAttr === 'submit' || (el.tagName === 'BUTTON' && !typeAttr && Boolean(el.closest('form')));

      out.push({
        index: idx,
        selector: getSelector(el),
        label,
        isSubmit,
        box: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      });
    });

    return out;
  }, maxProbes);

  let probed = 0;
  for (const ctrl of candidates) {
    if (probed >= maxProbes) break;
    if (ctrl.isSubmit) continue;
    if (DESTRUCTIVE_LABEL_PATTERN.test(ctrl.label)) continue;

    const locator = page.locator(`[data-smokeproof-probe="${ctrl.index}"]`).first();
    if ((await locator.count()) === 0) continue;

    probed++;
    const beforeUrl = page.url();
    const beforeSnapshot = await captureDomDigest(page, ctrl.index);
    const mark = collector.resetDeltaMark();

    try {
      await locator.click({ timeout: 1500 });
      await page.waitForTimeout(250);
    } catch {
      continue;
    }

    const afterUrl = page.url();
    const afterSnapshot = await captureDomDigest(page, ctrl.index);
    const delta = collector.getDeltaSince(mark);

    if (delta.newRuntimeErrors.length > 0 || delta.newNetworkErrors.length > 0) {
      findings.push({
        id: `int-err-${route}-${ctrl.index}`,
        rule: 'interaction/error-on-click',
        category: 'interaction',
        severity: 'high',
        route,
        message: `Clicking "${ctrl.label || ctrl.selector}" triggered runtime or network errors.`,
        evidence: [...delta.newRuntimeErrors, ...delta.newNetworkErrors].slice(0, 3).join(' | '),
        selector: ctrl.selector,
        box: ctrl.box,
        suggestion: 'Fix the click handler or backend endpoint triggered by this control.',
      });
    } else if (
      beforeUrl === afterUrl &&
      beforeSnapshot.bodySignature === afterSnapshot.bodySignature &&
      beforeSnapshot.controlAttrs === afterSnapshot.controlAttrs
    ) {
      findings.push({
        id: `int-dead-${route}-${ctrl.index}`,
        rule: 'interaction/dead-control',
        category: 'interaction',
        severity: 'medium',
        route,
        message: `Control "${ctrl.label || ctrl.selector}" produced no observable UI, URL, attribute, or network change when clicked.`,
        selector: ctrl.selector,
        box: ctrl.box,
        suggestion: 'Wire up the onClick handler or mark disabled/informative if non-interactive.',
      });
    }

    // If clicking navigated to another page, return to original route before testing remaining controls
    if (afterUrl !== beforeUrl) {
      await page.goto(beforeUrl, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(250);
      break;
    }
  }

  // Clean up probe markers
  await page
    .evaluate(() => {
      document.querySelectorAll('[data-smokeproof-probe]').forEach((el) => el.removeAttribute('data-smokeproof-probe'));
    })
    .catch(() => {});

  return findings;
}

async function captureDomDigest(
  page: Page,
  probeIndex: number,
): Promise<{ bodySignature: string; controlAttrs: string }> {
  return page
    .evaluate((idx: number) => {
      const body = document.body;
      const htmlLen = body ? body.innerHTML.length : 0;
      const text = (body?.innerText || '').trim();
      const dialogs = document.querySelectorAll('[role="dialog"], dialog[open], [data-state="open"]').length;
      const el = document.querySelector(`[data-smokeproof-probe="${idx}"]`);
      const controlAttrs = el
        ? `${el.getAttribute('aria-expanded')}|${el.getAttribute('aria-selected')}|${el.getAttribute('aria-pressed')}|${el.getAttribute('data-state')}|${el.className}`
        : 'detached';
      return {
        bodySignature: `${htmlLen}:${text.length}:${dialogs}:${text.slice(0, 120)}:${text.slice(-120)}`,
        controlAttrs,
      };
    }, probeIndex)
    .catch(() => ({ bodySignature: 'navigated', controlAttrs: 'navigated' }));
}
