import type { Page } from 'playwright-core';
import type { BoundingBox, Finding } from '../types.js';

interface RawMetaFinding {
  rule: string;
  category: 'meta' | 'a11y' | 'content';
  severity: 'high' | 'medium' | 'low';
  message: string;
  evidence?: string;
  selector?: string;
  box?: BoundingBox;
  suggestion: string;
}

/**
 * Audit essential ship metadata, core accessibility labels, and accidentally rendered
 * placeholder or template crash text (`[object Object]`, `NaN`, `Lorem ipsum`).
 */
export async function runMetaAndA11yChecks(
  page: Page,
  route: string,
  options: { strict?: boolean } = {},
): Promise<{
  title: string;
  findings: Finding[];
}> {
  const strict = Boolean(options.strict);
  const result = await page.evaluate((strictMode: boolean) => {
    const findings: RawMetaFinding[] = [];

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
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const toBox = (r: DOMRect): BoundingBox => ({
      x: Math.round(r.left),
      y: Math.round(r.top),
      width: Math.round(r.width),
      height: Math.round(r.height),
    });

    const title = (document.title || '').trim();
    if (!title) {
      findings.push({
        rule: 'meta/missing-title',
        category: 'meta',
        severity: 'medium',
        message: 'Document is missing a non-empty <title> tag.',
        suggestion: 'Add a descriptive <title> for browser tabs, bookmarks, and search results.',
      });
    }

    const viewportMeta = document.querySelector('meta[name="viewport"]');
    if (!viewportMeta?.getAttribute('content')?.includes('width=device-width')) {
      findings.push({
        rule: 'meta/missing-viewport',
        category: 'meta',
        severity: 'high',
        message: 'Missing responsive <meta name="viewport" content="width=device-width, initial-scale=1">.',
        suggestion: 'Include the standard viewport meta tag in <head> so mobile layouts scale properly.',
      });
    }

    if (strictMode && !document.documentElement.getAttribute('lang')) {
      findings.push({
        rule: 'a11y/missing-lang',
        category: 'a11y',
        severity: 'low',
        message: 'Root <html> element is missing a lang attribute.',
        suggestion: 'Add lang="en" (or your primary language) to <html> for screen readers.',
      });
    }

    const h1s = Array.from(document.querySelectorAll('h1')).filter((h) => h.textContent?.trim());
    if (strictMode && h1s.length === 0) {
      findings.push({
        rule: 'a11y/missing-h1',
        category: 'a11y',
        severity: 'low',
        message: 'Page has no visible <h1> heading.',
        suggestion: 'Provide one primary <h1> heading summarizing the page content.',
      });
    }

    // Check unlabeled interactive controls (icon-only buttons/links without aria-label)
    const controls = Array.from(document.querySelectorAll('button, a[href]')).filter(isVisible);
    let unlabeledCount = 0;
    for (const el of controls) {
      const text = (el.textContent || '').trim();
      const aria = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title');
      const imgAlt = el.querySelector('img[alt]')?.getAttribute('alt');
      if (!text && !aria && !imgAlt) {
        unlabeledCount++;
        if (unlabeledCount <= 3) {
          findings.push({
            rule: 'a11y/unlabeled-control',
            category: 'a11y',
            severity: 'medium',
            message: `Interactive ${el.tagName.toLowerCase()} has no accessible text or aria-label: ${getSelector(el)}`,
            selector: getSelector(el),
            box: toBox(el.getBoundingClientRect()),
            suggestion: 'Add visible text or an aria-label attribute to describe the button/link action.',
          });
        }
      }
    }

    // Check form inputs lacking accessible labels
    const inputs = Array.from(
      document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea'),
    ).filter(isVisible);
    let unlabeledInputCount = 0;
    for (const inp of inputs) {
      const id = inp.getAttribute('id');
      const hasForLabel = id ? Boolean(document.querySelector(`label[for="${CSS.escape(id)}"]`)) : false;
      const hasParentLabel = Boolean(inp.closest('label'));
      const hasAria = Boolean(inp.getAttribute('aria-label') || inp.getAttribute('aria-labelledby'));
      const hasPlaceholder = Boolean(inp.getAttribute('placeholder')?.trim());
      if (!hasForLabel && !hasParentLabel && !hasAria && (strictMode || !hasPlaceholder)) {
        unlabeledInputCount++;
        if (unlabeledInputCount <= 3) {
          findings.push({
            rule: 'a11y/unlabeled-input',
            category: 'a11y',
            severity: hasPlaceholder ? 'low' : 'medium',
            message: `Form field missing <label> or aria-label: ${getSelector(inp)}`,
            selector: getSelector(inp),
            box: toBox(inp.getBoundingClientRect()),
            suggestion: 'Associate a <label for="..."> or add aria-label for accessibility and reliable automation.',
          });
        }
      }
    }

    // Check images missing alt (strict mode only so unstyled decorative drafts do not create noise)
    const imgsMissingAlt = strictMode
      ? Array.from(document.querySelectorAll('img')).filter(
          (img) => isVisible(img) && img.getAttribute('alt') === null,
        )
      : [];
    if (imgsMissingAlt.length > 0) {
      const first = imgsMissingAlt[0];
      findings.push({
        rule: 'a11y/image-missing-alt',
        category: 'a11y',
        severity: 'low',
        message: `${imgsMissingAlt.length} visible <img> element(s) missing alt attribute.`,
        selector: getSelector(first),
        box: toBox(first.getBoundingClientRect()),
        suggestion: 'Add descriptive alt text (or alt="" for purely decorative images).',
      });
    }

    // Check rendered text for template crashes / placeholder leaks (ignore code/pre blocks)
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    const leakedPatterns: Array<{
      rule: string;
      severity: 'high' | 'medium';
      regex: RegExp;
      label: string;
    }> = [
      {
        rule: 'content/object-object-leak',
        severity: 'high',
        regex: /\[object Object\]/,
        label: 'Serialized "[object Object]" rendered in UI',
      },
      {
        rule: 'content/nan-or-undefined-leak',
        severity: 'high',
        regex: /(?:^|:\s*)(?:NaN|undefined)(?:\s*$)/,
        label: 'Unformatted NaN / undefined value rendered in UI',
      },
      {
        rule: 'content/placeholder-lorem-ipsum',
        severity: 'medium',
        regex: /lorem ipsum dolor sit amet/i,
        label: 'Placeholder Lorem Ipsum copy left in UI',
      },
    ];

    const seenContentRules = new Set<string>();
    let node: Node | null;
    while ((node = walker.nextNode()) !== null) {
      const parent = node.parentElement;
      if (!parent || parent.closest('script, style, code, pre, noscript') || !isVisible(parent)) {
        continue;
      }
      const txt = (node.textContent || '').trim();
      if (!txt) continue;

      for (const pat of leakedPatterns) {
        if (!seenContentRules.has(pat.rule) && pat.regex.test(txt)) {
          seenContentRules.add(pat.rule);
          findings.push({
            rule: pat.rule,
            category: 'content',
            severity: pat.severity,
            message: `${pat.label}: "${txt.slice(0, 80)}"`,
            selector: getSelector(parent),
            box: toBox(parent.getBoundingClientRect()),
            suggestion: 'Replace placeholder text or handle missing/object state before rendering.',
          });
        }
      }
    }

    return { title, findings };
  }, strict);

  return {
    title: result.title,
    findings: result.findings.map((f, idx) => ({
      id: `meta-${route}-${idx + 1}`,
      route,
      ...f,
    })),
  };
}
