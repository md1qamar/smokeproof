import http from 'http';

export interface TestServerHandle {
  baseUrl: string;
  setFixed: (fixed: boolean) => void;
  close: () => Promise<void>;
}

/**
 * Start a local HTTP fixture server exposing `/clean`, `/broken`, `/sub`, and `/mutable`
 * routes to exercise SmokeProof end-to-end in a real browser.
 */
export async function startBrokenFixtureServer(): Promise<TestServerHandle> {
  let fixed = false;
  // Build synthetic token dynamically so secret scanners do not flag test fixtures
  const syntheticOpenAi = ['sk', 'proj', '9876543210abcdefghij9876543210'].join('-');

  const server = http.createServer((req, res) => {
    const reqPath = (req.url || '/').split('?')[0];

    if (reqPath === '/clean') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Clean App</title>
  <style>
    body { margin: 0; font-family: sans-serif; padding: 24px; }
    button { min-height: 40px; padding: 8px 16px; }
  </style>
</head>
<body>
  <main>
    <h1>Healthy Dashboard</h1>
    <p>Everything operates smoothly.</p>
    <button id="toggle-btn" type="button">Load Details</button>
    <div id="status">Idle</div>
  </main>
  <script>
    document.getElementById('toggle-btn').addEventListener('click', () => {
      document.getElementById('status').textContent = 'Loaded';
    });
  </script>
</body>
</html>`);
      return;
    }

    if (reqPath === '/api/broken') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Database timeout' }));
      return;
    }

    if (reqPath === '/sub') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Sub Route</title>
</head>
<body>
  <h1>Secondary Route</h1>
  <p>Crawled link works.</p>
</body>
</html>`);
      return;
    }

    if (reqPath === '/mutable') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (fixed) {
        res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Fixed App</title>
</head>
<body>
  <h1>Fixed View</h1>
  <p>Clean state restored.</p>
</body>
</html>`);
      } else {
        res.end(`<!DOCTYPE html>
<html>
<head><title>Broken Mutable App</title></head>
<body>
  <h1>Needs Fix</h1>
  <div>User payload: [object Object]</div>
  <script>console.error('Mutable route boom');</script>
</body>
</html>`);
      }
      return;
    }

    if (reqPath === '/chaos-target') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Chaos Target</title>
</head>
<body>
  <h1>Feedback Form</h1>
  <form id="f">
    <input id="msg" type="text" aria-label="Message" />
    <button type="submit">Send</button>
  </form>
  <button id="dbl-btn" type="button">Rapid Action</button>
  <div id="preview"></div>
  <script>
    document.getElementById('f').addEventListener('submit', (e) => {
      e.preventDefault();
      const val = document.getElementById('msg').value;
      if (val.length > 500) {
        throw new Error('Payload too huge for client state');
      }
      document.getElementById('preview').innerHTML = val;
    });
    let clicks = 0;
    document.getElementById('dbl-btn').addEventListener('click', () => {
      clicks++;
      if (clicks >= 2) throw new Error('Duplicate rapid click crash');
    });
  </script>
</body>
</html>`);
      return;
    }

    if (reqPath === '/broken') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <style>
    body { margin: 0; font-family: sans-serif; }
    .wide-banner { width: 920px; height: 40px; background: #eee; }
  </style>
</head>
<body>
  <div class="wide-banner">Wide Desktop Element</div>
  <img src="/missing-hero.png" alt="Missing hero" width="120" height="80" />
  <p>Profile: [object Object]</p>
  <button id="icon-only" type="button" style="width:20px;height:20px;"></button>
  <button id="dead-btn" type="button">Dead Button</button>
  <button id="boom-btn" type="button">Explode</button>
  <a href="/sub">Go Sub</a>
  <script>
    window.__LEAKED_KEY__ = "${syntheticOpenAi}";
    console.error("Broken checkout widget failed");
    fetch("/api/broken");
    document.getElementById("boom-btn").addEventListener("click", () => {
      throw new Error("Boom on click");
    });
    setTimeout(() => {
      throw new Error("Uncaught async page crash");
    }, 30);
  </script>
</body>
</html>`);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to bind test server port');
  }

  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    setFixed: (val: boolean) => {
      fixed = val;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
