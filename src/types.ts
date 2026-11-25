export type Severity = 'critical' | 'high' | 'medium' | 'low';

export type FindingCategory =
  | 'runtime'
  | 'network'
  | 'layout'
  | 'asset'
  | 'interaction'
  | 'security'
  | 'a11y'
  | 'meta'
  | 'content';

export type ViewportName = 'desktop' | 'mobile';

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Finding {
  id: string;
  rule: string;
  category: FindingCategory;
  severity: Severity;
  route: string;
  viewport?: ViewportName;
  message: string;
  evidence?: string;
  selector?: string;
  box?: BoundingBox;
  suggestion: string;
  file?: string;
  line?: number;
}

export interface RouteAuditResult {
  route: string;
  url: string;
  status: number | null;
  loadTimeMs: number;
  title: string;
  findings: Finding[];
  screenshots: {
    desktop?: string;
    mobile?: string;
  };
  discoveredLinks: string[];
}

export interface AuditSummary {
  score: number;
  passed: boolean;
  routesAudited: number;
  totalFindings: number;
  bySeverity: Record<Severity, number>;
  byCategory: Partial<Record<FindingCategory, number>>;
  durationMs: number;
}

export interface AuditReport {
  tool: 'smokeproof';
  version: string;
  timestamp: string;
  targetUrl: string;
  browser: string;
  summary: AuditSummary;
  routes: RouteAuditResult[];
  sourceFindings: Finding[];
  artifactsDir?: string;
}

export interface AuditConfig {
  url: string;
  cmd?: string;
  cwd: string;
  maxPages: number;
  maxDepth: number;
  timeoutMs: number;
  settleMs: number;
  mobile: boolean;
  interact: boolean;
  maxInteractionsPerRoute: number;
  screenshots: boolean;
  scanSource: boolean;
  artifactsDir: string;
  browserPath?: string;
  include: string[];
  exclude: string[];
  ignoreRules: string[];
  failOn: Severity | 'none';
  minScore: number;
  headers: Record<string, string>;
}

export interface FixVerificationResult {
  targetUrl: string;
  previousFindings: number;
  currentFindings: number;
  resolved: Finding[];
  remaining: Finding[];
  introduced: Finding[];
  passed: boolean;
  score: number;
}
