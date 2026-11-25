import { SEVERITY_ORDER } from '../config.js';
import type {
  AuditConfig,
  AuditSummary,
  Finding,
  FindingCategory,
  RouteAuditResult,
  Severity,
} from '../types.js';

const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 25,
  high: 12,
  medium: 5,
  low: 2,
};

/**
 * Compute deterministic 0-100 ship readiness score and pass/fail status across all routes & source findings.
 */
export function computeAuditSummary(
  routes: RouteAuditResult[],
  sourceFindings: Finding[],
  config: Pick<AuditConfig, 'failOn' | 'minScore'>,
  durationMs: number,
): AuditSummary {
  const allFindings = [...routes.flatMap((r) => r.findings), ...sourceFindings];

  const bySeverity: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };
  const byCategory: Partial<Record<FindingCategory, number>> = {};

  // Cap penalty per (rule, route) group so repeated identical warnings don't collapse score unfairly
  const penaltyByRuleRoute = new Map<string, number>();

  for (const f of allFindings) {
    bySeverity[f.severity]++;
    byCategory[f.category] = (byCategory[f.category] || 0) + 1;

    const key = `${f.rule}::${f.route}`;
    const prev = penaltyByRuleRoute.get(key) || 0;
    const cap = SEVERITY_WEIGHT[f.severity] * 2;
    const next = Math.min(cap, prev + SEVERITY_WEIGHT[f.severity]);
    penaltyByRuleRoute.set(key, next);
  }

  let totalPenalty = 0;
  for (const p of penaltyByRuleRoute.values()) {
    totalPenalty += p;
  }

  const score = Math.max(0, Math.min(100, 100 - totalPenalty));

  let hasBlockingSeverity = false;
  if (config.failOn !== 'none') {
    const thresholdRank = SEVERITY_ORDER[config.failOn];
    hasBlockingSeverity = allFindings.some((f) => SEVERITY_ORDER[f.severity] >= thresholdRank);
  }

  const passed = score >= config.minScore && !hasBlockingSeverity;

  return {
    score,
    passed,
    routesAudited: routes.length,
    totalFindings: allFindings.length,
    bySeverity,
    byCategory,
    durationMs,
  };
}
