export type Severity = 'critical' | 'high' | 'medium' | 'low';

export type FindingCategory =
  | 'runtime'
  | 'network'
  | 'layout'
  | 'asset'
  | 'interaction'
  | 'chaos'
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
  reproGif?: string;
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
  reproGif?: string;
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
  chaos: boolean;
  strict: boolean;
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

export interface VisualAnnotation {
  id: string;
  route: string;
  selector: string;
  tagName: string;
  textSnippet: string;
  comment: string;
  viewport: { width: number; height: number };
  box?: BoundingBox;
  recentErrors: string[];
  screenshot?: string;
  status: 'open' | 'resolved';
  createdAt: string;
}

export interface DemoStep {
  action: 'wait' | 'click' | 'type' | 'scroll' | 'goto';
  selector?: string;
  text?: string;
  url?: string;
  caption?: string;
  zoom?: number;
  holdMs?: number;
}

export interface DemoResult {
  gifPath: string;
  frameCount: number;
  durationMs: number;
  sizeBytes: number;
  stepsExecuted: string[];
  targetUrl: string;
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
