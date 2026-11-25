import { spawn, type ChildProcess } from 'child_process';

export interface RunningServer {
  stop: () => Promise<void>;
  logs: () => string[];
}

/**
 * Spawn a user-supplied dev/preview command, wait until `url` accepts HTTP requests,
 * and guarantee clean cross-platform process-tree teardown afterward.
 */
export async function startTargetServer(
  cmd: string,
  url: string,
  cwd: string,
  timeoutMs = 30000,
): Promise<RunningServer> {
  const recentLogs: string[] = [];
  const isWin = process.platform === 'win32';

  const child: ChildProcess = spawn(cmd, {
    cwd,
    shell: true,
    detached: !isWin,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0' },
  });

  const pushLines = (chunk: Buffer) => {
    const lines = chunk.toString('utf8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      recentLogs.push(line);
      if (recentLogs.length > 80) recentLogs.shift();
    }
  };

  child.stdout?.on('data', pushLines);
  child.stderr?.on('data', pushLines);

  let exitedEarly = false;
  let exitCode: number | null = null;
  child.on('exit', (code) => {
    exitedEarly = true;
    exitCode = code;
  });

  const stop = async () => {
    if (child.killed || child.exitCode !== null) return;
    if (isWin && child.pid) {
      await new Promise<void>((resolve) => {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
        });
        killer.on('close', () => resolve());
        killer.on('error', () => resolve());
      });
    } else if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }
  };

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exitedEarly) {
      throw new Error(
        `Command "${cmd}" exited early (code ${exitCode}) before ${url} became ready.\nRecent logs:\n${recentLogs.slice(-15).join('\n')}`,
      );
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      const res = await fetch(url, { method: 'GET', signal: controller.signal });
      clearTimeout(timer);
      if (res.status < 500 || res.status === 500) {
        // Server is accepting HTTP traffic (even if app returns 500 on a broken route we want to audit)
        return { stop, logs: () => [...recentLogs] };
      }
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  await stop();
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${url} from command "${cmd}".\nRecent logs:\n${recentLogs.slice(-15).join('\n')}`,
  );
}
