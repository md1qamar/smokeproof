import fs from 'fs';
import path from 'path';
import type { Finding } from '../types.js';
import { findSecretsInText } from './secretPatterns.js';

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-test',
  'build',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.smokeproof',
  '.turbo',
  '.cache',
  'coverage',
  '__pycache__',
  '.venv',
]);

const SCANNABLE_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.json',
  '.yaml',
  '.yml',
  '.html',
  '.svelte',
  '.vue',
]);

const MAX_FILE_BYTES = 350_000;
const MAX_FILES = 600;

/**
 * Perform a fast static pre-flight scan over workspace source files for exposed secrets,
 * committed `.env` credentials, unsafe HTML sinks, and hardcoded localhost API URLs.
 */
export function scanWorkspaceSource(cwd: string): Finding[] {
  const findings: Finding[] = [];
  const root = path.resolve(cwd);
  const files = collectFiles(root);
  let counter = 0;

  for (const filePath of files) {
    const rel = path.relative(root, filePath).replace(/\\/g, '/');
    const base = path.basename(filePath);

    let content: string;
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_FILE_BYTES) continue;
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    // 1. Committed .env files with real values
    if (/^\.env($|\.)/.test(base) && !/example|sample|template/i.test(base)) {
      const lines = content.split(/\r?\n/);
      const nonEmptyKeys = lines.filter((l) => /^\s*[A-Z0-9_]+\s*=\s*\S+/.test(l) && !/^\s*#/.test(l));
      if (nonEmptyKeys.length > 0) {
        findings.push({
          id: `src-${++counter}`,
          rule: 'security/committed-env-file',
          category: 'security',
          severity: 'high',
          route: `file://${rel}`,
          file: rel,
          message: `Real environment file "${rel}" exists in workspace with ${nonEmptyKeys.length} defined variable(s).`,
          suggestion: 'Ensure .env* files (except .env.example) are in .gitignore and never committed.',
        });
      }
    }

    // 2. Shared secret pattern detection
    const secrets = findSecretsInText(content);
    for (const secret of secrets) {
      const line = lineNumberAt(content, secret.index);
      const isPublicClientPrefix = /(?:NEXT_PUBLIC_|VITE_|REACT_APP_|PUBLIC_)[A-Z0-9_]*/.test(
        content.slice(Math.max(0, secret.index - 40), secret.index),
      );
      findings.push({
        id: `src-${++counter}`,
        rule: `security/source-${secret.ruleId}`,
        category: 'security',
        severity: secret.severity,
        route: `file://${rel}`,
        file: rel,
        line,
        message: `${secret.label} found in ${rel}:${line}${isPublicClientPrefix ? ' (under client-exposed prefix!)' : ''}`,
        evidence: `Redacted match: ${secret.redacted}`,
        suggestion: 'Remove hardcoded credentials from source code, move to server env, and rotate keys.',
      });
    }

    // Skip code-hygiene checks on test, config, and CLI scaffold files
    const isTestOrConfig = /(?:^|\/)(?:test|tests|__tests__|spec|specs)\/|\.(?:test|spec)\.|(?:config|cli)\./i.test(rel);
    if (!isTestOrConfig && /\.(tsx?|jsx?|vue|svelte)$/.test(base)) {
      const lines = content.split(/\r?\n/);
      lines.forEach((lineText, idx) => {
        if (/dangerouslySetInnerHTML\s*=\s*\{/.test(lineText) && !/sanitize|dompurify/i.test(content)) {
          findings.push({
            id: `src-${++counter}`,
            rule: 'security/unsafe-inner-html',
            category: 'security',
            severity: 'medium',
            route: `file://${rel}`,
            file: rel,
            line: idx + 1,
            message: `Unprotected dangerouslySetInnerHTML in ${rel}:${idx + 1}`,
            suggestion: 'Sanitize HTML with DOMPurify or render structured JSX instead.',
          });
        }

        if (
          /['"`]https?:\/\/(?:localhost|127\.0\.0\.1):\d+/.test(lineText) &&
          !/process\.env|import\.meta\.env/.test(lineText)
        ) {
          findings.push({
            id: `src-${++counter}`,
            rule: 'runtime/hardcoded-localhost',
            category: 'runtime',
            severity: 'low',
            route: `file://${rel}`,
            file: rel,
            line: idx + 1,
            message: `Hardcoded localhost URL in ${rel}:${idx + 1}`,
            evidence: lineText.trim().slice(0, 140),
            suggestion: 'Read the base URL from environment configuration or relative paths before deploying.',
          });
        }
      });
    }
  }

  return findings;
}

function collectFiles(dir: string, acc: string[] = []): string[] {
  if (acc.length >= MAX_FILES) return acc;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }

  for (const entry of entries) {
    if (acc.length >= MAX_FILES) break;
    if (IGNORED_DIRS.has(entry.name)) continue;

    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, acc);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SCANNABLE_EXTS.has(ext) || /^\.env/.test(entry.name)) {
        acc.push(full);
      }
    }
  }
  return acc;
}

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}
