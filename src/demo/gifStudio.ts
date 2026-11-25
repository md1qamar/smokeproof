import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import type { Browser, Page } from 'playwright-core';
import { launchAuditBrowser } from '../browser/resolver.js';
import { normalizeBaseUrl } from '../config.js';
import { startTargetServer, type RunningServer } from '../runner/serverLauncher.js';
import type { DemoResult, DemoStep } from '../types.js';

const require = createRequire(import.meta.url);

export interface DemoKeyframe {
  screenshotPng: Buffer;
  viewportWidth: number;
  viewportHeight: number;
  caption: string;
  cursorX: number;
  cursorY: number;
  zoom: number;
  clickEffect?: boolean;
  statusTag?: 'ok' | 'bug' | 'chaos';
  holdMs?: number;
}

export interface DemoOptions {
  url: string;
  cmd?: string;
  cwd?: string;
  outPath?: string;
  artifactsDir?: string;
  browserPath?: string;
  steps?: DemoStep[];
  maxSteps?: number;
  width?: number;
  height?: number;
  fps?: number;
  timeoutMs?: number;
}

/**
 * Render captured browser keyframes into a Screen-Studio-style animated GIF with
 * macOS window chrome, smooth cubic-eased cursor movement, dynamic zoom-pan,
 * click ripples, and floating step captions — using zero native/FFmpeg binaries.
 */
export async function renderKeyframesToGif(
  browser: Browser,
  keyframes: DemoKeyframe[],
  outPath: string,
  options: { width?: number; height?: number; fps?: number; urlLabel?: string } = {},
): Promise<{ gifPath: string; frameCount: number; sizeBytes: number }> {
  if (keyframes.length === 0) {
    throw new Error('Cannot render GIF from empty keyframe list.');
  }

  const width = options.width ?? 840;
  const height = options.height ?? 480;
  const fps = options.fps ?? 10;
  const delayMs = Math.round(1000 / fps);
  const urlLabel = options.urlLabel || 'localhost';

  const gifencPath = require.resolve('gifenc');
  const gifencCode = fs.readFileSync(gifencPath, 'utf8');

  const renderContext = await browser.newContext({ viewport: { width, height } });
  const page = await renderContext.newPage();

  try {
    await page.setContent(
      `<!DOCTYPE html><html><body style="margin:0;background:#090d16;"><canvas id="c" width="${width}" height="${height}"></canvas></body></html>`,
    );

    await page.addScriptTag({
      content: `(function(){ var module = { exports: {} }; var exports = module.exports; ${gifencCode}\n window.__gifenc = module.exports && Object.keys(module.exports).length ? module.exports : exports; })();`,
    });

    const serializedFrames = keyframes.map((kf) => ({
      dataUri: `data:image/png;base64,${kf.screenshotPng.toString('base64')}`,
      vw: kf.viewportWidth,
      vh: kf.viewportHeight,
      caption: kf.caption,
      cursorX: kf.cursorX,
      cursorY: kf.cursorY,
      zoom: kf.zoom,
      clickEffect: Boolean(kf.clickEffect),
      statusTag: kf.statusTag || 'ok',
      holdFrames: Math.max(3, Math.round((kf.holdMs ?? 700) / delayMs)),
    }));

    const encoded = await page.evaluate(
      async ({ frames, w, h, frameDelayMs, label }) => {
        const gf = (window as unknown as {
          __gifenc: {
            GIFEncoder: () => {
              writeFrame: (idx: Uint8Array, w: number, h: number, opts: unknown) => void;
              finish: () => void;
              bytes: () => Uint8Array;
            };
            quantize: (rgba: Uint8ClampedArray, colors: number) => number[][];
            applyPalette: (rgba: Uint8ClampedArray, palette: number[][]) => Uint8Array;
          };
        }).__gifenc;

        const canvas = document.getElementById('c') as HTMLCanvasElement;
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

        const loadedImgs = await Promise.all(
          frames.map(
            (f) =>
              new Promise<HTMLImageElement>((resolve, reject) => {
                const img = new Image();
                img.onload = () => resolve(img);
                img.onerror = reject;
                img.src = f.dataUri;
              }),
          ),
        );

        const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
        const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

        interface RenderTick {
          img: HTMLImageElement;
          vw: number;
          vh: number;
          cx: number;
          cy: number;
          zoom: number;
          caption: string;
          ripple: number; // 0 = none, 0..1 = expanding click pulse
          statusTag: string;
        }

        const ticks: RenderTick[] = [];
        for (let i = 0; i < frames.length; i++) {
          const curr = frames[i];
          const currImg = loadedImgs[i];
          if (i > 0) {
            const prev = frames[i - 1];
            const prevImg = loadedImgs[i - 1];
            const tweens = 4;
            for (let s = 1; s <= tweens; s++) {
              const t = ease(s / (tweens + 1));
              ticks.push({
                img: t < 0.7 ? prevImg : currImg,
                vw: curr.vw,
                vh: curr.vh,
                cx: lerp(prev.cursorX, curr.cursorX, t),
                cy: lerp(prev.cursorY, curr.cursorY, t),
                zoom: lerp(prev.zoom, curr.zoom, t),
                caption: curr.caption,
                ripple: 0,
                statusTag: curr.statusTag,
              });
            }
          }

          for (let hIdx = 0; hIdx < curr.holdFrames; hIdx++) {
            const ripple = curr.clickEffect && hIdx < 4 ? (hIdx + 1) / 4 : 0;
            ticks.push({
              img: currImg,
              vw: curr.vw,
              vh: curr.vh,
              cx: curr.cursorX,
              cy: curr.cursorY,
              zoom: curr.zoom,
              caption: curr.caption,
              ripple,
              statusTag: curr.statusTag,
            });
          }
        }

        const roundRectPath = (x: number, y: number, rw: number, rh: number, r: number) => {
          ctx.beginPath();
          ctx.moveTo(x + r, y);
          ctx.lineTo(x + rw - r, y);
          ctx.quadraticCurveTo(x + rw, y, x + rw, y + r);
          ctx.lineTo(x + rw, y + rh - r);
          ctx.quadraticCurveTo(x + rw, y + rh, x + rw - r, y + rh);
          ctx.lineTo(x + r, y + rh);
          ctx.quadraticCurveTo(x, y + rh, x, y + rh - r);
          ctx.lineTo(x, y + r);
          ctx.quadraticCurveTo(x, y, x + r, y);
          ctx.closePath();
        };

        const encoder = gf.GIFEncoder();
        const padX = 28;
        const padTop = 20;
        const padBottom = 38;
        const winW = w - padX * 2;
        const barH = 26;
        const winH = h - padTop - padBottom;
        const viewH = winH - barH;

        for (let idx = 0; idx < ticks.length; idx++) {
          const tick = ticks[idx];

          // 1. Studio gradient backdrop
          const grad = ctx.createLinearGradient(0, 0, w, h);
          grad.addColorStop(0, '#090d1a');
          grad.addColorStop(0.55, '#111936');
          grad.addColorStop(1, '#1c1238');
          ctx.fillStyle = grad;
          ctx.fillRect(0, 0, w, h);

          // 2. macOS window shadow & frame
          ctx.save();
          ctx.shadowColor = 'rgba(0,0,0,0.55)';
          ctx.shadowBlur = 24;
          ctx.shadowOffsetY = 10;
          roundRectPath(padX, padTop, winW, winH, 12);
          ctx.fillStyle = '#0f172a';
          ctx.fill();
          ctx.restore();

          // Clip everything inside window
          ctx.save();
          roundRectPath(padX, padTop, winW, winH, 12);
          ctx.clip();

          // Titlebar
          ctx.fillStyle = '#141c2e';
          ctx.fillRect(padX, padTop, winW, barH);
          const dots = ['#ef4444', '#f59e0b', '#22c55e'];
          dots.forEach((col, dIdx) => {
            ctx.beginPath();
            ctx.arc(padX + 16 + dIdx * 14, padTop + barH / 2, 4.2, 0, Math.PI * 2);
            ctx.fillStyle = col;
            ctx.fill();
          });

          // Address pill
          const pillW = Math.min(280, winW * 0.45);
          const pillX = padX + (winW - pillW) / 2;
          roundRectPath(pillX, padTop + 5, pillW, 16, 6);
          ctx.fillStyle = '#0b1220';
          ctx.fill();
          ctx.fillStyle = '#94a3b8';
          ctx.font = '10px ui-monospace, monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(label.slice(0, 40), padX + winW / 2, padTop + 13);

          // 3. Zoomed & panned viewport content
          ctx.save();
          ctx.beginPath();
          ctx.rect(padX, padTop + barH, winW, viewH);
          ctx.clip();

          const scaleX = winW / tick.vw;
          const scaleY = viewH / tick.vh;
          const baseScale = Math.min(scaleX, scaleY);
          const zoom = Math.max(1, tick.zoom);
          const drawW = tick.vw * baseScale * zoom;
          const drawH = tick.vh * baseScale * zoom;

          const normX = Math.max(0, Math.min(1, tick.cx / tick.vw));
          const normY = Math.max(0, Math.min(1, tick.cy / tick.vh));

          let drawX = padX + winW / 2 - normX * drawW;
          let drawY = padTop + barH + viewH / 2 - normY * drawH;
          // Clamp pan within window bounds
          drawX = Math.min(padX, Math.max(padX + winW - drawW, drawX));
          drawY = Math.min(padTop + barH, Math.max(padTop + barH + viewH - drawH, drawY));

          ctx.drawImage(tick.img, drawX, drawY, drawW, drawH);

          // 4. Cursor & click ripple in zoomed screen coordinates
          const screenCursorX = drawX + normX * drawW;
          const screenCursorY = drawY + normY * drawH;

          if (tick.ripple > 0) {
            const rad = 8 + tick.ripple * 24;
            ctx.beginPath();
            ctx.arc(screenCursorX, screenCursorY, rad, 0, Math.PI * 2);
            ctx.strokeStyle =
              tick.statusTag === 'bug'
                ? `rgba(239, 68, 68, ${1 - tick.ripple})`
                : `rgba(56, 189, 248, ${1 - tick.ripple})`;
            ctx.lineWidth = 3;
            ctx.stroke();
          }

          // Pointer triangle
          ctx.save();
          ctx.translate(screenCursorX, screenCursorY);
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.lineTo(0, 16);
          ctx.lineTo(4.5, 12.5);
          ctx.lineTo(9, 19);
          ctx.lineTo(11.5, 17.5);
          ctx.lineTo(7, 11);
          ctx.lineTo(12, 11);
          ctx.closePath();
          ctx.fillStyle = '#ffffff';
          ctx.fill();
          ctx.strokeStyle = '#0f172a';
          ctx.lineWidth = 1.6;
          ctx.stroke();
          ctx.restore();

          ctx.restore(); // end viewport clip
          ctx.restore(); // end window clip

          // 5. Window border stroke
          roundRectPath(padX, padTop, winW, winH, 12);
          ctx.strokeStyle = 'rgba(255,255,255,0.14)';
          ctx.lineWidth = 1;
          ctx.stroke();

          // 6. Floating bottom caption pill
          if (tick.caption) {
            ctx.font = '600 12px system-ui, -apple-system, sans-serif';
            const textW = Math.min(winW - 40, ctx.measureText(tick.caption).width + 44);
            const capX = (w - textW) / 2;
            const capY = h - 30;
            roundRectPath(capX, capY, textW, 22, 11);
            ctx.fillStyle =
              tick.statusTag === 'bug'
                ? 'rgba(127, 29, 29, 0.92)'
                : tick.statusTag === 'chaos'
                  ? 'rgba(120, 53, 15, 0.92)'
                  : 'rgba(15, 23, 42, 0.92)';
            ctx.fill();
            ctx.strokeStyle =
              tick.statusTag === 'bug'
                ? 'rgba(248, 113, 113, 0.7)'
                : tick.statusTag === 'chaos'
                  ? 'rgba(251, 191, 36, 0.7)'
                  : 'rgba(99, 102, 241, 0.65)';
            ctx.lineWidth = 1;
            ctx.stroke();

            ctx.fillStyle = '#f8fafc';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(tick.caption.slice(0, 66), w / 2, capY + 11.5);
          }

          const rgba = ctx.getImageData(0, 0, w, h).data;
          const palette = gf.quantize(rgba, 256);
          const index = gf.applyPalette(rgba, palette);
          encoder.writeFrame(index, w, h, {
            palette,
            delay: frameDelayMs,
            repeat: idx === 0 ? 0 : undefined,
          });
        }

        encoder.finish();
        const bytes = encoder.bytes();
        // Convert Uint8Array to base64 in chunks to avoid call-stack overflow
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
        }
        return { base64: btoa(binary), frameCount: ticks.length };
      },
      { frames: serializedFrames, w: width, h: height, frameDelayMs: delayMs, label: urlLabel },
    );

    const gifBuf = Buffer.from(encoded.base64, 'base64');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, gifBuf);

    return {
      gifPath: outPath,
      frameCount: encoded.frameCount,
      sizeBytes: gifBuf.length,
    };
  } finally {
    await renderContext.close().catch(() => {});
  }
}

/**
 * Automatically record a polished Screen-Studio-style product walkthrough GIF
 * from any live URL or `--cmd` app server (supports auto-discovery or custom steps).
 */
export async function recordProductDemo(options: DemoOptions): Promise<DemoResult> {
  const startedAt = Date.now();
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const targetUrl = normalizeBaseUrl(options.url);
  const artifactsDir = path.resolve(cwd, options.artifactsDir ?? '.smokeproof');
  const outPath = path.resolve(cwd, options.outPath ?? path.join(artifactsDir, 'smokeproof-demo.gif'));
  const vw = 1280;
  const vh = 720;

  let server: RunningServer | null = null;
  let browser: Browser | null = null;

  try {
    if (options.cmd) {
      server = await startTargetServer(options.cmd, targetUrl, cwd, options.timeoutMs ?? 25000);
    }

    const launched = await launchAuditBrowser(options.browserPath);
    browser = launched.browser;
    const context = await browser.newContext({ viewport: { width: vw, height: vh } });
    const page = await context.newPage();

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs ?? 15000 });
    await page.waitForLoadState('networkidle', { timeout: 2500 }).catch(() => {});
    await page.waitForTimeout(350);

    const title = ((await page.title()) || new URL(targetUrl).hostname).trim();
    const keyframes: DemoKeyframe[] = [];
    const stepsExecuted: string[] = [];

    // Initial Hero Overview Keyframe
    keyframes.push({
      screenshotPng: await page.screenshot({ type: 'png' }),
      viewportWidth: vw,
      viewportHeight: vh,
      caption: `Launch ${title}`,
      cursorX: vw * 0.5,
      cursorY: vh * 0.35,
      zoom: 1.0,
      holdMs: 850,
    });
    stepsExecuted.push(`Open ${targetUrl}`);

    const plan = options.steps && options.steps.length > 0
      ? options.steps
      : await discoverAutoDemoSteps(page, options.maxSteps ?? 4);

    for (const step of plan) {
      const kf = await executeDemoStep(page, step, vw, vh);
      if (kf) {
        keyframes.push(kf);
        stepsExecuted.push(kf.caption);
      }
    }

    await context.close();

    const rendered = await renderKeyframesToGif(browser, keyframes, outPath, {
      width: options.width ?? 840,
      height: options.height ?? 480,
      fps: options.fps ?? 10,
      urlLabel: new URL(targetUrl).host,
    });

    return {
      gifPath: rendered.gifPath,
      frameCount: rendered.frameCount,
      durationMs: Date.now() - startedAt,
      sizeBytes: rendered.sizeBytes,
      stepsExecuted,
      targetUrl,
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await server.stop().catch(() => {});
  }
}

async function discoverAutoDemoSteps(page: Page, maxSteps: number): Promise<DemoStep[]> {
  const discovered = await page.evaluate((limit: number) => {
    const steps: DemoStep[] = [];
    const destructive = /\b(delete|remove|logout|sign out|pay|checkout|destroy)\b/i;

    // 1. Safe text/search input if present
    const input = Array.from(
      document.querySelectorAll('input[type="text"], input[type="search"], input[type="email"], input:not([type])'),
    ).find((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 40 && r.height > 16;
    });
    if (input) {
      input.setAttribute('data-sp-demo', 'input-1');
      const isEmail = input.getAttribute('type') === 'email' || /email/i.test(input.getAttribute('placeholder') || '');
      steps.push({
        action: 'type',
        selector: '[data-sp-demo="input-1"]',
        text: isEmail ? 'alex@acme.dev' : 'SmokeProof live demo',
        caption: `Type into ${input.getAttribute('placeholder') || 'input field'}`,
        zoom: 1.28,
      });
    }

    // 2. Primary non-destructive button
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).filter((el) => {
      const r = el.getBoundingClientRect();
      const label = (el.textContent || el.getAttribute('aria-label') || '').trim();
      return r.width > 24 && r.height > 20 && !destructive.test(label) && label.length > 0 && label.length < 40;
    });
    for (let i = 0; i < Math.min(2, buttons.length); i++) {
      const btn = buttons[i];
      const attr = `btn-${i + 1}`;
      btn.setAttribute('data-sp-demo', attr);
      const label = (btn.textContent || btn.getAttribute('aria-label') || 'Action').trim().replace(/\s+/g, ' ');
      steps.push({
        action: 'click',
        selector: `[data-sp-demo="${attr}"]`,
        caption: `Click "${label}"`,
        zoom: 1.32,
      });
    }

    // 3. Scroll showcase if page is taller than viewport
    if (document.documentElement.scrollHeight > window.innerHeight * 1.25) {
      steps.push({
        action: 'scroll',
        caption: 'Scroll lower sections',
        zoom: 1.05,
      });
    }

    return steps.slice(0, limit);
  }, maxSteps);

  return discovered;
}

async function executeDemoStep(
  page: Page,
  step: DemoStep,
  vw: number,
  vh: number,
): Promise<DemoKeyframe | null> {
  if (step.action === 'goto' && step.url) {
    await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(300);
    return {
      screenshotPng: await page.screenshot({ type: 'png' }),
      viewportWidth: vw,
      viewportHeight: vh,
      caption: step.caption || `Open ${new URL(page.url()).pathname}`,
      cursorX: vw * 0.5,
      cursorY: vh * 0.4,
      zoom: step.zoom ?? 1.0,
      holdMs: step.holdMs ?? 750,
    };
  }

  if (step.action === 'scroll') {
    await page.evaluate(() => window.scrollBy({ top: Math.round(window.innerHeight * 0.65), behavior: 'instant' }));
    await page.waitForTimeout(250);
    return {
      screenshotPng: await page.screenshot({ type: 'png' }),
      viewportWidth: vw,
      viewportHeight: vh,
      caption: step.caption || 'Scroll page content',
      cursorX: vw * 0.5,
      cursorY: vh * 0.55,
      zoom: step.zoom ?? 1.06,
      holdMs: step.holdMs ?? 700,
    };
  }

  if (step.action === 'wait') {
    await page.waitForTimeout(step.holdMs ?? 500);
    return {
      screenshotPng: await page.screenshot({ type: 'png' }),
      viewportWidth: vw,
      viewportHeight: vh,
      caption: step.caption || 'Inspect state',
      cursorX: vw * 0.5,
      cursorY: vh * 0.5,
      zoom: step.zoom ?? 1.0,
      holdMs: step.holdMs ?? 700,
    };
  }

  if (step.selector) {
    const loc = page.locator(step.selector).first();
    if ((await loc.count()) === 0) return null;
    const box = await loc.boundingBox().catch(() => null);
    if (!box) return null;

    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    if (step.action === 'type') {
      await loc.click({ timeout: 1500 }).catch(() => {});
      await loc.fill(step.text ?? 'Hello SmokeProof').catch(() => {});
    } else if (step.action === 'click') {
      await loc.click({ timeout: 1500 }).catch(() => {});
    }

    await page.waitForTimeout(260);
    return {
      screenshotPng: await page.screenshot({ type: 'png' }),
      viewportWidth: vw,
      viewportHeight: vh,
      caption: step.caption || `${step.action} ${step.selector}`,
      cursorX: cx,
      cursorY: cy,
      zoom: step.zoom ?? 1.3,
      clickEffect: true,
      holdMs: step.holdMs ?? 850,
    };
  }

  return null;
}
