export { runSmokeAudit, verifySmokeFixes, TOOL_VERSION } from './engine/auditor.js';
export { recordProductDemo, renderKeyframesToGif } from './demo/gifStudio.js';
export { runChaosProbes } from './checks/chaosCheck.js';
export { startVisualStudio } from './studio/studioServer.js';
export {
  loadAnnotations,
  addAnnotation,
  setAnnotationStatus,
  deleteAnnotation,
  formatAnnotationsPrompt,
} from './studio/annotationsStore.js';
export { scanWorkspaceSource } from './checks/sourceScanner.js';
export { findSecretsInText, redactSecret } from './checks/secretPatterns.js';
export { resolveAuditConfig, normalizeBaseUrl } from './config.js';
export { computeAuditSummary } from './report/scorer.js';
export {
  formatTerminalReport,
  formatMarkdownReport,
  formatSarifReport,
  formatHtmlReport,
} from './report/formatters.js';
export type * from './types.js';
