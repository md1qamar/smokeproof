import fs from 'fs';
import path from 'path';
import type { AuditConfig, Severity } from './types.js';

export const DEFAULT_CONFIG: Omit<AuditConfig, 'url'> = {
  cwd: process.cwd(),
  maxPages: 12,
  maxDepth: 2,
  timeoutMs: 15000,
  settleMs: 500,
  mobile: true,
  interact: true,
  chaos: false,
  strict: false,
  maxInteractionsPerRoute: 6,
  screenshots: true,
  scanSource: false,
  artifactsDir: '.smokeproof',
  include: [],
  exclude: [],
  routes: [],
  ignoreRules: [],
  failOn: 'high',
  minScore: 70,
  headers: {},
};

const VALID_SEVERITIES = new Set<string>(['critical', 'high', 'medium', 'low', 'none']);

/**
 * Load optional `.smokeproof.json` overrides from `cwd` and merge with explicit CLI/MCP options.
 */
export function resolveAuditConfig(
  url: string,
  overrides: Partial<AuditConfig> = {},
): AuditConfig {
  const cwd = path.resolve(overrides.cwd ?? process.cwd());
  const fileConfig = readProjectConfigFile(cwd);

  const merged: AuditConfig = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    ...stripUndefined(overrides),
    cwd,
    url: normalizeBaseUrl(url || fileConfig.url || ''),
  };

  if (!VALID_SEVERITIES.has(merged.failOn)) {
    merged.failOn = 'high';
  }
  merged.artifactsDir = path.isAbsolute(merged.artifactsDir)
    ? merged.artifactsDir
    : path.join(cwd, merged.artifactsDir);

  return merged;
}

function readProjectConfigFile(cwd: string): Partial<AuditConfig> {
  const configPath = path.join(cwd, '.smokeproof.json');
  if (!fs.existsSync(configPath)) return {};
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Partial<AuditConfig>) : {};
  } catch {
    return {};
  }
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

/**
 * Ensure the target URL includes an HTTP(S) protocol and valid structure.
 */
export function normalizeBaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error('Target URL is required (e.g. http://localhost:3000).');
  }
  const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const parsed = new URL(withProto);
  return parsed.toString();
}

export const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};
