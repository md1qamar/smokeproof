import type { Page } from 'playwright-core';
import type { BoundingBox, Finding, ViewportName } from '../types.js';

interface RawLayoutSignal {
  rule: string;
  category: 'layout' | 'asset';
  severity: 'critical' | 'high' | 'medium' | 'low';
  message: string;
  evidence?: string;
  selector?: string;
  box?: BoundingBox;
  suggestion: string;
}

/**
 * Inspect the live DOM at the active viewport for blank screens, horizontal overflow,
 * broken images, overlapping controls, and undersized mobile tap targets.
 */
export async function runLayoutChecks(
  page: Page,
  route: string,
  viewport: ViewportName,
  options: { strict?: boolean } = {},
): Promise<Finding[]> {
  const strict = Boolean(options.strict);
  const rawSignals = await page.evaluate(({ vp, strictMode }: { vp: ViewportName; strictMode: boolean }) => {
    const signals: RawLayoutSignal[] = [];

    const getSelector = (el: Element): string => {
      if (el.id) return `#${el.id}`;
      const tag = el.tagName.toLowerCase();
      const cls =
        typeof el.className === 'string' && el.className.trim()
          ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
          : '';
      return `${tag}${cls}`;
    };

    const isVisible = (el: Element): boolean => {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const toBox = (r: DOMRect): BoundingBox => ({
      x: Math.round(r.left),
      y: Math.round(r.top),
      width: Math.round(r.width),
      height: Math.round(r.height),
    });

    // 1. Blank screen / crashed render check
    const bodyText = (document.body?.innerText || '').trim();
    const visibleVisuals = document.querySelectorAll('img, svg, canvas, video, input, button').length;
    if (bodyText.length === 0 && visibleVisuals === 0) {
      signals.push({
        rule: 'layout/blank-screen',
        category: 'layout',
        severity: 'critical',
        message: `Page rendered a blank screen on ${vp} viewport (no visible text or elements).`,
        suggestion: 'Check for crashed client hydration, missing root mount, or unhandled render errors.',
      });
      return signals;
    }

    // 2. Horizontal overflow check
    const docClientW = document.documentElement.clientWidth;
    const docScrollW = document.documentElement.scrollWidth;
    if (docScrollW > docClientW + 2) {
      const offenders: Array<{ selector: string; overflowPx: number; box: BoundingBox }> = [];
      const all = Array.from(document.querySelectorAll('body *'));
      for (const el of all) {
        if (!isVisible(el)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.right > docClientW + 2 && rect.width < docScrollW + 50) {
          // Prefer leaf-ish offending elements so selectors are actionable
          if (el.children.length <= 3 || rect.width > docClientW) {
            offenders.push({
              selector: getSelector(el),
              overflowPx: Math.round(rect.right - docClientW),
              box: toBox(rect),
            });
          }
        }
        if (offenders.length >= 3) break;
      }

      const primary = offenders[0];
      signals.push({
        rule: 'layout/horizontal-overflow',
        category: 'layout',
        severity: vp === 'mobile' ? 'high' : 'medium',
        message: `Horizontal overflow detected on ${vp} (${docScrollW}px content > ${docClientW}px viewport).`,
        evidence: offenders.length
          ? `Offending elements: ${offenders.map((o) => `${o.selector} (+${o.overflowPx}px)`).join(', ')}`
          : undefined,
        selector: primary?.selector,
        box: primary?.box,
        suggestion: 'Apply max-w-full / overflow-x-hidden or fix fixed-width containers/tables exceeding viewport width.',
      });
    }

    // 3. Broken images check
    const images = Array.from(document.querySelectorAll('img'));
    for (const img of images) {
      const style = window.getComputedStyle(img);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (img.complete && img.naturalWidth === 0) {
        const src = img.getAttribute('src') || '(no src)';
        const rect = img.getBoundingClientRect();
        signals.push({
          rule: 'asset/broken-image',
          category: 'asset',
          severity: 'high',
          message: `Broken image failed to load: ${src}`,
          selector: getSelector(img),
          box: rect.width > 0 || rect.height > 0 ? toBox(rect) : undefined,
          suggestion: 'Verify the image URL/path exists in public assets and returns HTTP 200.',
        });
      }
    }

    // 4. Overlapping interactive controls + tiny mobile tap targets
    const interactive = Array.from(
      document.querySelectorAll('button, a[href], input:not([type="hidden"]), select, [role="button"]'),
    ).filter(isVisible);

    const rects = interactive.map((el) => ({
      el,
      rect: el.getBoundingClientRect(),
      selector: getSelector(el),
    }));

    const reportedOverlapPairs = new Set<string>();
    for (let i = 0; i < rects.length && i < 60; i++) {
      for (let j = i + 1; j < rects.length && j < 60; j++) {
        const a = rects[i];
        const b = rects[j];
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;

        const ix = Math.max(0, Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left));
        const iy = Math.max(0, Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top));
        const intersection = ix * iy;
        const minArea = Math.min(a.rect.width * a.rect.height, b.rect.width * b.rect.height);

        if (minArea > 100 && intersection / minArea > 0.35) {
          const pairKey = `${a.selector}<->${b.selector}`;
          if (!reportedOverlapPairs.has(pairKey)) {
            reportedOverlapPairs.add(pairKey);
            signals.push({
              rule: 'layout/overlapping-controls',
              category: 'layout',
              severity: 'medium',
              message: `Interactive elements overlap on ${vp}: ${a.selector} and ${b.selector}`,
              selector: a.selector,
              box: toBox(a.rect),
              suggestion: 'Adjust z-index, flex/grid gap, or responsive positioning so controls do not collide.',
            });
          }
        }
      }
    }

    if (vp === 'mobile' && strictMode) {
      let tinyCount = 0;
      for (const item of rects) {
        const isInlineTextLink =
          item.el.tagName.toLowerCase() === 'a' && Boolean(item.el.closest('p, li, span'));
        if (isInlineTextLink) continue;
        if (item.rect.width < 28 || item.rect.height < 28) {
          tinyCount++;
          if (tinyCount <= 2) {
            signals.push({
              rule: 'layout/small-tap-target',
              category: 'layout',
              severity: 'low',
              message: `Small mobile tap target (${Math.round(item.rect.width)}x${Math.round(item.rect.height)}px): ${item.selector}`,
              selector: item.selector,
              box: toBox(item.rect),
              suggestion: 'Increase button/link tap area to at least 36-44px for mobile usability.',
            });
          }
        }
      }
    }

    return signals;
  }, { vp: viewport, strictMode: strict });

  return rawSignals.map((sig, idx) => ({
    id: `layout-${viewport}-${route}-${idx + 1}`,
    route,
    viewport,
    ...sig,
  }));
}
