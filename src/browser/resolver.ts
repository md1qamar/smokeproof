import fs from 'fs';
import os from 'os';
import path from 'path';
import { chromium, type Browser, type LaunchOptions } from 'playwright-core';

export interface ResolvedBrowser {
  label: string;
  channel?: 'chrome' | 'msedge';
  executablePath?: string;
}

const CANDIDATES_BY_PLATFORM: Record<string, Array<{ label: string; paths: string[] }>> = {
  win32: [
    {
      label: 'Google Chrome',
      paths: [
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ],
    },
    {
      label: 'Microsoft Edge',
      paths: [
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ],
    },
    {
      label: 'Brave Browser',
      paths: [
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      ],
    },
  ],
  darwin: [
    {
      label: 'Google Chrome',
      paths: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    },
    {
      label: 'Microsoft Edge',
      paths: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    },
    {
      label: 'Brave Browser',
      paths: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
    },
  ],
  linux: [
    {
      label: 'Google Chrome',
      paths: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'],
    },
    {
      label: 'Chromium',
      paths: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
    },
    {
      label: 'Microsoft Edge',
      paths: ['/usr/bin/microsoft-edge'],
    },
  ],
};

/**
 * Resolve an already-installed Chromium-based browser on the host so users avoid a forced 300MB download.
 * Falls back to Playwright's bundled Chromium if present.
 */
export function detectInstalledBrowser(explicitPath?: string): ResolvedBrowser | null {
  const override = explicitPath || process.env.SMOKEPROOF_BROWSER_PATH;
  if (override) {
    if (!fs.existsSync(override)) {
      throw new Error(`Configured browser path does not exist: ${override}`);
    }
    return { label: `Custom (${path.basename(override)})`, executablePath: override };
  }

  const candidates = CANDIDATES_BY_PLATFORM[process.platform] || CANDIDATES_BY_PLATFORM.linux;
  for (const candidate of candidates) {
    for (const candidatePath of candidate.paths) {
      if (fs.existsSync(candidatePath)) {
        return { label: candidate.label, executablePath: candidatePath };
      }
    }
  }

  // Fallback to Playwright's own cached Chromium binary if installed via `npx playwright install chromium`.
  try {
    const pwPath = chromium.executablePath();
    if (pwPath && fs.existsSync(pwPath)) {
      return { label: 'Playwright Chromium', executablePath: pwPath };
    }
  } catch {
    // Ignore when playwright cache is empty
  }

  return null;
}

/**
 * Launch a headless browser using the resolved executable or Playwright channels.
 */
export async function launchAuditBrowser(explicitPath?: string): Promise<{
  browser: Browser;
  browserLabel: string;
}> {
  const detected = detectInstalledBrowser(explicitPath);
  const baseOptions: LaunchOptions = {
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  };

  if (detected?.executablePath) {
    const browser = await chromium.launch({
      ...baseOptions,
      executablePath: detected.executablePath,
    });
    return { browser, browserLabel: detected.label };
  }

  // Last-resort channel probes before surfacing a clear installation hint
  for (const channel of ['chrome', 'msedge'] as const) {
    try {
      const browser = await chromium.launch({ ...baseOptions, channel });
      return { browser, browserLabel: channel === 'chrome' ? 'Google Chrome' : 'Microsoft Edge' };
    } catch {
      // Try next channel
    }
  }

  throw new Error(
    'No Chromium-based browser found. Install Google Chrome / Microsoft Edge, pass --browser-path, or run: npx playwright-core install chromium',
  );
}
