import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import https from 'https';
import net from 'net';
import path from 'path';
import { normalizeBaseUrl } from '../config.js';
import { recordProductDemo } from '../demo/gifStudio.js';
import { runSmokeAudit } from '../engine/auditor.js';
import { startTargetServer, type RunningServer } from '../runner/serverLauncher.js';
import {
  addAnnotation,
  deleteAnnotation,
  formatAnnotationsPrompt,
  loadAnnotations,
  setAnnotationStatus,
} from './annotationsStore.js';

export interface StudioOptions {
  url: string;
  cmd?: string;
  cwd?: string;
  port?: number;
  proxyPort?: number;
  artifactsDir?: string;
  browserPath?: string;
  open?: boolean;
}

export interface RunningStudio {
  studioUrl: string;
  proxyUrl: string;
  targetUrl: string;
  stop: () => Promise<void>;
}

const BRIDGE_JS = `(function () {
  if (window.__smokeproofStudioLoaded) return;
  window.__smokeproofStudioLoaded = true;

  var recentErrors = [];
  function pushErr(msg) {
    recentErrors.push(String(msg).slice(0, 200));
    if (recentErrors.length > 10) recentErrors.shift();
  }

  var origErr = console.error;
  console.error = function () {
    try { pushErr(Array.prototype.slice.call(arguments).join(' ')); } catch (e) {}
    return origErr.apply(console, arguments);
  };
  window.addEventListener('error', function (ev) { pushErr(ev.message || 'Uncaught error'); });
  window.addEventListener('unhandledrejection', function (ev) { pushErr('Unhandled rejection: ' + (ev.reason && ev.reason.message ? ev.reason.message : ev.reason)); });

  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function () {
      return origFetch.apply(this, arguments).then(function (res) {
        if (res && res.status >= 400) pushErr('HTTP ' + res.status + ' ' + res.url);
        return res;
      });
    };
  }

  var pinMode = false;
  var highlightEl = null;
  var tooltipEl = null;

  function ensureOverlay() {
    if (!highlightEl) {
      highlightEl = document.createElement('div');
      highlightEl.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #818cf8;background:rgba(99,102,241,0.14);border-radius:4px;display:none;box-sizing:border-box;';
      document.documentElement.appendChild(highlightEl);
    }
    if (!tooltipEl) {
      tooltipEl = document.createElement('div');
      tooltipEl.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;background:#4f46e5;color:#fff;font:600 11px ui-monospace,monospace;padding:3px 7px;border-radius:4px;display:none;white-space:nowrap;';
      document.documentElement.appendChild(tooltipEl);
    }
  }

  function buildSelector(el) {
    if (!el || el.nodeType !== 1) return 'body';
    if (el.id) return '#' + el.id;
    var parts = [];
    var curr = el;
    for (var depth = 0; curr && curr.nodeType === 1 && depth < 4; depth++) {
      var seg = curr.tagName.toLowerCase();
      if (curr.id) { parts.unshift('#' + curr.id); break; }
      if (typeof curr.className === 'string' && curr.className.trim()) {
        seg += '.' + curr.className.trim().split(/\\s+/).slice(0, 2).join('.');
      }
      parts.unshift(seg);
      curr = curr.parentElement;
    }
    return parts.join(' > ');
  }

  function hideOverlay() {
    if (highlightEl) highlightEl.style.display = 'none';
    if (tooltipEl) tooltipEl.style.display = 'none';
  }

  document.addEventListener('mousemove', function (ev) {
    if (!pinMode) return;
    var target = ev.target;
    if (!target || target === highlightEl || target === tooltipEl) return;
    ensureOverlay();
    var r = target.getBoundingClientRect();
    highlightEl.style.display = 'block';
    highlightEl.style.left = r.left + 'px';
    highlightEl.style.top = r.top + 'px';
    highlightEl.style.width = r.width + 'px';
    highlightEl.style.height = r.height + 'px';
    tooltipEl.style.display = 'block';
    tooltipEl.textContent = buildSelector(target);
    tooltipEl.style.left = Math.max(4, r.left) + 'px';
    tooltipEl.style.top = Math.max(4, r.top - 24) + 'px';
  }, true);

  document.addEventListener('click', function (ev) {
    if (!pinMode) return;
    ev.preventDefault();
    ev.stopPropagation();
    var el = ev.target;
    if (!el) return;
    var r = el.getBoundingClientRect();
    pinMode = false;
    hideOverlay();
    window.parent.postMessage({
      type: 'smokeproof:element-pinned',
      payload: {
        route: window.location.pathname + window.location.search,
        selector: buildSelector(el),
        tagName: el.tagName.toLowerCase(),
        textSnippet: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 120),
        viewport: { width: window.innerWidth, height: window.innerHeight },
        box: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
        recentErrors: recentErrors.slice()
      }
    }, '*');
  }, true);

  window.addEventListener('message', function (ev) {
    if (ev.data && ev.data.type === 'smokeproof:set-pin-mode') {
      pinMode = Boolean(ev.data.enabled);
      document.documentElement.style.cursor = pinMode ? 'crosshair' : '';
      if (!pinMode) hideOverlay();
    }
  });
})();`;

/**
 * Start the interactive SmokeProof Visual Review & Click-to-Prompt Studio server
 * alongside a same-origin iframe-friendly reverse proxy for the target app.
 */
export async function startVisualStudio(options: StudioOptions): Promise<RunningStudio> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const targetUrl = normalizeBaseUrl(options.url);
  const target = new URL(targetUrl);
  const artifactsDir = path.resolve(cwd, options.artifactsDir ?? '.smokeproof');

  let wrappedServer: RunningServer | null = null;
  if (options.cmd) {
    wrappedServer = await startTargetServer(options.cmd, targetUrl, cwd, 30000);
  }

  // 1. Reverse proxy server (removes frame blockers + injects click-to-pin bridge)
  const proxyHandler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    if ((req.url || '').split('?')[0] === '/__smokeproof_bridge.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(BRIDGE_JS);
      return;
    }

    const mod = target.protocol === 'https:' ? https : http;
    const headers: Record<string, string | string[] | undefined> = {
      ...req.headers,
      host: target.host,
      'accept-encoding': 'identity',
    };

    const proxyReq = mod.request(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: req.url || '/',
        method: req.method,
        headers,
      },
      (proxyRes) => {
        const resHeaders = { ...proxyRes.headers };
        delete resHeaders['x-frame-options'];
        delete resHeaders['content-security-policy'];
        const contentType = String(resHeaders['content-type'] || '');

        if (contentType.includes('text/html')) {
          delete resHeaders['content-length'];
          const chunks: Buffer[] = [];
          proxyRes.on('data', (c: Buffer) => chunks.push(c));
          proxyRes.on('end', () => {
            let html = Buffer.concat(chunks).toString('utf8');
            const tag = '<script src="/__smokeproof_bridge.js"></script>';
            if (/<\/body>/i.test(html)) html = html.replace(/<\/body>/i, `${tag}</body>`);
            else html += tag;
            res.writeHead(proxyRes.statusCode || 200, resHeaders);
            res.end(html);
          });
        } else {
          res.writeHead(proxyRes.statusCode || 200, resHeaders);
          proxyRes.pipe(res);
        }
      },
    );

    proxyReq.on('error', (err) => {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end(`SmokeProof Studio proxy error: ${err.message}`);
    });
    req.pipe(proxyReq);
  };
  const proxyServer = http.createServer(proxyHandler);

  // Tunnel WebSocket upgrades (e.g., Vite / Next.js HMR)
  proxyServer.on('upgrade', (req, clientSocket, head) => {
    const upstreamPort = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
    const upstream = net.connect(upstreamPort, target.hostname, () => {
      const headerLines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i];
        const v = k.toLowerCase() === 'host' ? target.host : req.rawHeaders[i + 1];
        headerLines.push(`${k}: ${v}`);
      }
      upstream.write(headerLines.join('\r\n') + '\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });

  const actualProxyPort = await listenOnPreferredPort(proxyServer, options.proxyPort ?? 4181);
  const proxyUrl = `http://127.0.0.1:${actualProxyPort}`;

  // 2. Studio UI & API Server
  const studioServer = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = reqUrl.pathname;

    if (pathname === '/' && req.method === 'GET') {
      const initialRoute = `${target.pathname}${target.search}`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderStudioHtml(targetUrl, `${proxyUrl}${initialRoute}`));
      return;
    }

    if (pathname === '/api/annotations' && req.method === 'GET') {
      const annotations = loadAnnotations(cwd, artifactsDir);
      sendJson(res, 200, { annotations, prompt: formatAnnotationsPrompt(annotations) });
      return;
    }

    if (pathname === '/api/annotations' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.selector || !body.comment) {
        sendJson(res, 400, { error: 'Both selector and comment are required.' });
        return;
      }
      const pin = addAnnotation(
        cwd,
        {
          route: String(body.route || '/'),
          selector: String(body.selector),
          tagName: String(body.tagName || 'element'),
          textSnippet: String(body.textSnippet || ''),
          comment: String(body.comment),
          viewport: body.viewport && typeof body.viewport === 'object'
            ? { width: Number(body.viewport.width) || 1440, height: Number(body.viewport.height) || 900 }
            : { width: 1440, height: 900 },
          box: body.box,
          recentErrors: Array.isArray(body.recentErrors) ? body.recentErrors.map(String) : [],
        },
        artifactsDir,
      );
      const annotations = loadAnnotations(cwd, artifactsDir);
      sendJson(res, 201, { pin, annotations, prompt: formatAnnotationsPrompt(annotations) });
      return;
    }

    const resolveMatch = pathname.match(/^\/api\/annotations\/([^/]+)\/resolve$/);
    if (resolveMatch && req.method === 'POST') {
      const updated = setAnnotationStatus(cwd, decodeURIComponent(resolveMatch[1]), 'resolved', artifactsDir);
      if (!updated) {
        sendJson(res, 404, { error: 'Annotation not found' });
        return;
      }
      const annotations = loadAnnotations(cwd, artifactsDir);
      sendJson(res, 200, { updated, annotations, prompt: formatAnnotationsPrompt(annotations) });
      return;
    }

    const delMatch = pathname.match(/^\/api\/annotations\/([^/]+)$/);
    if (delMatch && req.method === 'DELETE') {
      deleteAnnotation(cwd, decodeURIComponent(delMatch[1]), artifactsDir);
      const annotations = loadAnnotations(cwd, artifactsDir);
      sendJson(res, 200, { annotations, prompt: formatAnnotationsPrompt(annotations) });
      return;
    }

    if (pathname === '/api/run-chaos' && req.method === 'POST') {
      try {
        const report = await runSmokeAudit(targetUrl, {
          cwd,
          artifactsDir,
          browserPath: options.browserPath,
          chaos: true,
          maxPages: 3,
        });
        const reproGifs = report.routes
          .map((r) => r.reproGif)
          .filter((p): p is string => Boolean(p))
          .map((p) => `/api/artifacts/${path.relative(artifactsDir, p).replace(/\\/g, '/')}`);
        sendJson(res, 200, {
          report,
          reproGifs,
          htmlReportUrl: '/api/artifacts/smokeproof-report.html',
        });
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    if (pathname === '/api/run-demo' && req.method === 'POST') {
      try {
        const demo = await recordProductDemo({
          url: targetUrl,
          cwd,
          artifactsDir,
          browserPath: options.browserPath,
        });
        const rel = path.relative(artifactsDir, demo.gifPath).replace(/\\/g, '/');
        sendJson(res, 200, {
          ...demo,
          gifUrl: `/api/artifacts/${rel}?t=${Date.now()}`,
        });
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    if (pathname.startsWith('/api/artifacts/') && req.method === 'GET') {
      const rel = decodeURIComponent(pathname.slice('/api/artifacts/'.length));
      const candidate = path.resolve(artifactsDir, rel);
      if (!candidate.startsWith(artifactsDir) || !fs.existsSync(candidate)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const ext = path.extname(candidate).toLowerCase();
      const mime =
        ext === '.gif'
          ? 'image/gif'
          : ext === '.png'
            ? 'image/png'
            : ext === '.html'
              ? 'text/html; charset=utf-8'
              : 'application/json';
      res.writeHead(200, { 'Content-Type': mime });
      fs.createReadStream(candidate).pipe(res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  const actualStudioPort = await listenOnPreferredPort(studioServer, options.port ?? 4180);
  const studioUrl = `http://127.0.0.1:${actualStudioPort}`;

  if (options.open) {
    openBrowserUrl(studioUrl);
  }

  return {
    studioUrl,
    proxyUrl,
    targetUrl,
    stop: async () => {
      await Promise.all([
        new Promise<void>((r) => studioServer.close(() => r())),
        new Promise<void>((r) => proxyServer.close(() => r())),
      ]);
      if (wrappedServer) await wrappedServer.stop().catch(() => {});
    },
  };
}

async function listenOnPreferredPort(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && port !== 0) {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          resolve(typeof addr === 'object' && addr ? addr.port : port);
        });
      } else {
        reject(err);
      }
    });
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : port);
    });
  });
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function openBrowserUrl(url: string): void {
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '""', url], { stdio: 'ignore', detached: true }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
  } else {
    spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
  }
}

function renderStudioHtml(targetUrl: string, proxyUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SmokeProof Visual Review Studio</title>
  <style>
    :root { color-scheme: dark; --bg: #070b14; --panel: #0f172a; --border: #1e293b; --accent: #6366f1; --text: #f8fafc; --muted: #94a3b8; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
    header { height: 54px; display: flex; align-items: center; justify-content: space-between; padding: 0 16px; border-bottom: 1px solid var(--border); background: var(--panel); gap: 10px; }
    .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 15px; }
    .badge { font-size: 11px; padding: 3px 8px; border-radius: 999px; background: #1e293b; color: #cbd5e1; font-family: ui-monospace, monospace; }
    .actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    button { background: #1e293b; color: var(--text); border: 1px solid #334155; padding: 7px 12px; border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer; }
    button:hover { border-color: #64748b; }
    button.active, button.primary { background: var(--accent); border-color: #818cf8; color: #fff; }
    button.warn { background: #7c2d12; border-color: #ea580c; }
    main { flex: 1; display: grid; grid-template-columns: 1fr 370px; overflow: hidden; }
    .stage { display: flex; align-items: center; justify-content: center; background: radial-gradient(circle at top, #111936, #070b14); padding: 14px; overflow: auto; }
    iframe { width: 100%; height: 100%; border: 1px solid #334155; border-radius: 10px; background: #fff; transition: width 0.2s ease; }
    iframe.mobile { width: 390px; height: 780px; border-width: 8px; border-color: #1e293b; border-radius: 24px; }
    aside { border-left: 1px solid var(--border); background: var(--panel); display: flex; flex-direction: column; overflow: hidden; }
    .pane { padding: 14px; border-bottom: 1px solid var(--border); }
    .scroll { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
    .label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px; }
    .selector-box { font-family: ui-monospace, monospace; font-size: 12px; background: #020617; border: 1px solid #1e293b; padding: 8px; border-radius: 6px; word-break: break-all; margin-bottom: 8px; color: #a5b4fc; }
    textarea { width: 100%; min-height: 68px; background: #020617; color: var(--text); border: 1px solid #334155; border-radius: 8px; padding: 8px; font: inherit; font-size: 13px; resize: vertical; }
    .pin { background: #0b1222; border: 1px solid var(--border); border-radius: 8px; padding: 10px; }
    .pin.resolved { opacity: 0.55; }
    .pin-top { display: flex; justify-content: space-between; align-items: center; gap: 6px; font-size: 11px; color: var(--muted); margin-bottom: 4px; }
    .pin-comment { font-size: 13px; font-weight: 600; margin-bottom: 6px; }
    .media-box { background: #020617; border: 1px solid var(--border); border-radius: 8px; padding: 8px; }
    .media-box img { width: 100%; border-radius: 6px; margin-top: 6px; }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <span>SmokeProof Studio</span>
      <span class="badge">${targetUrl}</span>
    </div>
    <div class="actions">
      <button id="pinBtn" type="button">Pin Element</button>
      <button id="vpBtn" type="button">Mobile View</button>
      <button id="chaosBtn" type="button" class="warn">Run Chaos Audit</button>
      <button id="demoBtn" type="button" class="primary">Record Demo GIF</button>
      <button id="copyBtn" type="button">Copy Agent Prompt</button>
    </div>
  </header>
  <main>
    <section class="stage">
      <iframe id="appFrame" src="${proxyUrl}" title="Target App Preview"></iframe>
    </section>
    <aside>
      <div class="pane">
        <div class="label">Click-to-Prompt Pin</div>
        <div id="selBox" class="selector-box">Click "Pin Element", then click any UI element on the left.</div>
        <textarea id="commentInput" placeholder="Describe what the coding agent should fix..."></textarea>
        <div style="display:flex;gap:8px;margin-top:8px;">
          <button id="savePinBtn" type="button" class="primary" style="flex:1;" disabled>Save Pin</button>
        </div>
      </div>
      <div id="statusPane" class="pane" style="display:none;"></div>
      <div id="pinsList" class="scroll"></div>
    </aside>
  </main>
  <script>
    const frame = document.getElementById('appFrame');
    const pinBtn = document.getElementById('pinBtn');
    const vpBtn = document.getElementById('vpBtn');
    const chaosBtn = document.getElementById('chaosBtn');
    const demoBtn = document.getElementById('demoBtn');
    const copyBtn = document.getElementById('copyBtn');
    const selBox = document.getElementById('selBox');
    const commentInput = document.getElementById('commentInput');
    const savePinBtn = document.getElementById('savePinBtn');
    const pinsList = document.getElementById('pinsList');
    const statusPane = document.getElementById('statusPane');

    let pinMode = false;
    let mobileMode = false;
    let pendingTarget = null;
    let latestPrompt = '';

    pinBtn.onclick = () => {
      pinMode = !pinMode;
      pinBtn.classList.toggle('active', pinMode);
      frame.contentWindow?.postMessage({ type: 'smokeproof:set-pin-mode', enabled: pinMode }, '*');
    };

    vpBtn.onclick = () => {
      mobileMode = !mobileMode;
      frame.classList.toggle('mobile', mobileMode);
      vpBtn.classList.toggle('active', mobileMode);
      vpBtn.textContent = mobileMode ? 'Desktop View' : 'Mobile View';
    };

    window.addEventListener('message', (ev) => {
      if (ev.data?.type === 'smokeproof:element-pinned') {
        pinMode = false;
        pinBtn.classList.remove('active');
        pendingTarget = ev.data.payload;
        selBox.textContent = pendingTarget.route + ' -> ' + pendingTarget.selector;
        savePinBtn.disabled = false;
        commentInput.focus();
      }
    });

    savePinBtn.onclick = async () => {
      if (!pendingTarget || !commentInput.value.trim()) return;
      savePinBtn.disabled = true;
      const res = await fetch('/api/annotations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...pendingTarget, comment: commentInput.value.trim() }),
      });
      const data = await res.json();
      commentInput.value = '';
      pendingTarget = null;
      selBox.textContent = 'Saved! Click "Pin Element" to add another.';
      renderPins(data.annotations, data.prompt);
    };

    copyBtn.onclick = async () => {
      if (!latestPrompt) return;
      await navigator.clipboard.writeText(latestPrompt);
      copyBtn.textContent = 'Copied!';
      setTimeout(() => (copyBtn.textContent = 'Copy Agent Prompt'), 1500);
    };

    demoBtn.onclick = async () => {
      demoBtn.disabled = true;
      demoBtn.textContent = 'Recording GIF...';
      statusPane.style.display = 'block';
      statusPane.innerHTML = '<div class="label">Screen-Studio Demo GIF</div><div>Recording & encoding animated GIF...</div>';
      const res = await fetch('/api/run-demo', { method: 'POST' });
      const data = await res.json();
      demoBtn.disabled = false;
      demoBtn.textContent = 'Record Demo GIF';
      if (data.error) {
        statusPane.innerHTML = '<div class="label">Demo Error</div><div>' + data.error + '</div>';
      } else {
        statusPane.innerHTML = '<div class="media-box"><div class="label">Demo GIF Ready (' + Math.round(data.sizeBytes/1024) + ' KB)</div><img src="' + data.gifUrl + '" alt="Demo GIF" /></div>';
      }
    };

    chaosBtn.onclick = async () => {
      chaosBtn.disabled = true;
      chaosBtn.textContent = 'Attacking App...';
      statusPane.style.display = 'block';
      statusPane.innerHTML = '<div class="label">Chaos Bug-Breaker</div><div>Fuzzing forms, double-clicks, and offline state...</div>';
      const res = await fetch('/api/run-chaos', { method: 'POST' });
      const data = await res.json();
      chaosBtn.disabled = false;
      chaosBtn.textContent = 'Run Chaos Audit';
      if (data.error) {
        statusPane.innerHTML = '<div class="label">Chaos Error</div><div>' + data.error + '</div>';
      } else {
        const s = data.report.summary;
        const gifHtml = data.reproGifs?.length ? '<img src="' + data.reproGifs[0] + '" alt="Repro GIF" />' : '';
        statusPane.innerHTML = '<div class="media-box"><div class="label">Chaos Score: ' + s.score + '/100 (' + s.totalFindings + ' issue(s))</div><a href="' + data.htmlReportUrl + '" target="_blank" style="color:#a5b4fc;font-size:12px;">Open Full Report</a>' + gifHtml + '</div>';
      }
    };

    async function refresh() {
      const res = await fetch('/api/annotations');
      const data = await res.json();
      renderPins(data.annotations, data.prompt);
    }

    function renderPins(items, prompt) {
      latestPrompt = prompt || '';
      if (!items.length) {
        pinsList.innerHTML = '<div style="color:#64748b;font-size:13px;">No visual pins yet. Click "Pin Element" to annotate live UI.</div>';
        return;
      }
      pinsList.innerHTML = items.map((p) => {
        return '<div class="pin ' + (p.status === 'resolved' ? 'resolved' : '') + '">'
          + '<div class="pin-top"><span>' + p.route + ' &middot; ' + p.viewport.width + 'x' + p.viewport.height + '</span><span>' + p.status + '</span></div>'
          + '<div class="pin-comment">' + escapeHtml(p.comment) + '</div>'
          + '<div class="selector-box">' + escapeHtml(p.selector) + '</div>'
          + '<div style="display:flex;gap:6px;">'
          + (p.status === 'open' ? '<button onclick="resolvePin(\\'' + p.id + '\\')">Mark Resolved</button>' : '')
          + '<button onclick="deletePin(\\'' + p.id + '\\')">Delete</button>'
          + '</div></div>';
      }).join('');
    }

    window.resolvePin = async (id) => {
      const res = await fetch('/api/annotations/' + id + '/resolve', { method: 'POST' });
      const data = await res.json();
      renderPins(data.annotations, data.prompt);
    };
    window.deletePin = async (id) => {
      const res = await fetch('/api/annotations/' + id, { method: 'DELETE' });
      const data = await res.json();
      renderPins(data.annotations, data.prompt);
    };
    function escapeHtml(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    refresh();
  </script>
</body>
</html>`;
}
