import fs from 'fs';
import path from 'path';
import type { Page } from 'playwright-core';
import type { Finding, Severity, ViewportName } from '../types.js';

const SEVERITY_COLORS: Record<Severity, string> = {
  critical: '#ef4444',
  high: '#f97316',
  medium: '#eab308',
  low: '#3b82f6',
};

/**
 * Sanitize a route string into a predictable filename segment.
 */
export function routeToSlug(route: string): string {
  const clean = route.replace(/^\/+|\/+$/g, '').replace(/[^a-zA-Z0-9_-]+/g, '_');
  return clean || 'index';
}

/**
 * Temporarily highlight bounding boxes for findings on the active viewport, capture a PNG screenshot,
 * and remove injected overlays cleanly afterward.
 */
export async function captureAnnotatedScreenshot(
  page: Page,
  route: string,
  viewport: ViewportName,
  findings: Finding[],
  artifactsDir: string,
): Promise<string> {
  const screenshotsDir = path.join(artifactsDir, 'screenshots');
  fs.mkdirSync(screenshotsDir, { recursive: true });
  const filePath = path.join(screenshotsDir, `${routeToSlug(route)}.${viewport}.png`);

  const boxesToDraw = findings
    .filter((f) => f.box && (!f.viewport || f.viewport === viewport))
    .slice(0, 12)
    .map((f, idx) => ({
      index: idx + 1,
      box: f.box!,
      color: SEVERITY_COLORS[f.severity],
      label: `${f.rule.split('/')[1] || f.rule}`,
    }));

  if (boxesToDraw.length > 0) {
    await page
      .evaluate((items) => {
        const container = document.createElement('div');
        container.setAttribute('data-smokeproof-overlay', '1');
        container.style.position = 'fixed';
        container.style.inset = '0';
        container.style.pointerEvents = 'none';
        container.style.zIndex = '2147483647';

        for (const item of items) {
          const outline = document.createElement('div');
          outline.style.position = 'fixed';
          outline.style.left = `${Math.max(0, item.box.x)}px`;
          outline.style.top = `${Math.max(0, item.box.y)}px`;
          outline.style.width = `${Math.max(12, item.box.width)}px`;
          outline.style.height = `${Math.max(12, item.box.height)}px`;
          outline.style.border = `2px dashed ${item.color}`;
          outline.style.background = `${item.color}18`;
          outline.style.boxSizing = 'border-box';
          outline.style.borderRadius = '4px';

          const badge = document.createElement('span');
          badge.textContent = `[${item.index}] ${item.label}`;
          badge.style.position = 'absolute';
          badge.style.top = '-18px';
          badge.style.left = '0';
          badge.style.background = item.color;
          badge.style.color = '#ffffff';
          badge.style.fontFamily = 'monospace';
          badge.style.fontSize = '10px';
          badge.style.fontWeight = '700';
          badge.style.padding = '1px 5px';
          badge.style.borderRadius = '3px';
          badge.style.whiteSpace = 'nowrap';

          outline.appendChild(badge);
          container.appendChild(outline);
        }

        document.body?.appendChild(container);
      }, boxesToDraw)
      .catch(() => {});
  }

  try {
    await page.screenshot({ path: filePath, fullPage: false });
  } finally {
    await page
      .evaluate(() => {
        document.querySelectorAll('[data-smokeproof-overlay]').forEach((el) => el.remove());
      })
      .catch(() => {});
  }

  return filePath;
}
