import fs from 'fs';
import path from 'path';
import type { VisualAnnotation } from '../types.js';

function annotationsFilePath(cwd: string, artifactsDir = '.smokeproof'): string {
  const base = path.isAbsolute(artifactsDir) ? artifactsDir : path.join(cwd, artifactsDir);
  return path.join(base, 'annotations.json');
}

/**
 * Load persisted click-to-prompt visual annotations for a workspace.
 */
export function loadAnnotations(cwd: string, artifactsDir = '.smokeproof'): VisualAnnotation[] {
  const file = annotationsFilePath(cwd, artifactsDir);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? (parsed as VisualAnnotation[]) : [];
  } catch {
    return [];
  }
}

/**
 * Persist a new visual feedback pin into `.smokeproof/annotations.json`.
 */
export function addAnnotation(
  cwd: string,
  input: Omit<VisualAnnotation, 'id' | 'status' | 'createdAt'>,
  artifactsDir = '.smokeproof',
): VisualAnnotation {
  const all = loadAnnotations(cwd, artifactsDir);
  const created: VisualAnnotation = {
    ...input,
    id: `pin_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    status: 'open',
    createdAt: new Date().toISOString(),
  };
  all.unshift(created);
  writeAnnotations(cwd, all, artifactsDir);
  return created;
}

/**
 * Mark an open visual annotation as resolved (or reopen it).
 */
export function setAnnotationStatus(
  cwd: string,
  id: string,
  status: 'open' | 'resolved',
  artifactsDir = '.smokeproof',
): VisualAnnotation | null {
  const all = loadAnnotations(cwd, artifactsDir);
  const target = all.find((a) => a.id === id);
  if (!target) return null;
  target.status = status;
  writeAnnotations(cwd, all, artifactsDir);
  return target;
}

/**
 * Delete a visual annotation by ID.
 */
export function deleteAnnotation(
  cwd: string,
  id: string,
  artifactsDir = '.smokeproof',
): boolean {
  const all = loadAnnotations(cwd, artifactsDir);
  const next = all.filter((a) => a.id !== id);
  if (next.length === all.length) return false;
  writeAnnotations(cwd, next, artifactsDir);
  return true;
}

/**
 * Format open visual annotations into a concise, actionable prompt for AI coding agents.
 */
export function formatAnnotationsPrompt(annotations: VisualAnnotation[]): string {
  const open = annotations.filter((a) => a.status === 'open');
  if (open.length === 0) return 'No open visual review annotations.';

  const blocks = open.map((a, idx) => {
    const lines = [
      `### ${idx + 1}. [${a.route}] ${a.comment}`,
      `- Selector: \`${a.selector}\` (\`<${a.tagName}>\`)`,
      `- Viewport: ${a.viewport.width}x${a.viewport.height}`,
    ];
    if (a.textSnippet) lines.push(`- Element text: "${a.textSnippet}"`);
    if (a.recentErrors.length > 0) {
      lines.push(`- Runtime errors observed: ${a.recentErrors.slice(-3).join(' | ')}`);
    }
    return lines.join('\n');
  });

  return [
    '# Visual UI Review Fixes (from SmokeProof Studio)',
    '',
    ...blocks,
    '',
    'After fixing, re-verify with SmokeProof (`smokeproof_verify_fix` or `npx smokeproof`).',
  ].join('\n');
}

function writeAnnotations(cwd: string, items: VisualAnnotation[], artifactsDir: string): void {
  const file = annotationsFilePath(cwd, artifactsDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(items, null, 2) + '\n', 'utf8');
}
