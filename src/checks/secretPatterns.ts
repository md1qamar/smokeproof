export interface SecretPatternRule {
  id: string;
  label: string;
  regex: RegExp;
  severity: 'critical' | 'high';
}

export interface SecretMatch {
  ruleId: string;
  label: string;
  severity: 'critical' | 'high';
  redacted: string;
  index: number;
}

/**
 * Shared secret detection rules used across both live browser bundle inspection
 * and static workspace pre-flight scanning.
 */
export const SECRET_PATTERNS: SecretPatternRule[] = [
  {
    id: 'openai-key',
    label: 'OpenAI / Provider Secret Key',
    regex: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}\b/g,
    severity: 'critical',
  },
  {
    id: 'anthropic-key',
    label: 'Anthropic API Key',
    regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    severity: 'critical',
  },
  {
    id: 'stripe-live-key',
    label: 'Stripe Live Secret Key',
    regex: /\bsk_live_[A-Za-z0-9]{16,}\b/g,
    severity: 'critical',
  },
  {
    id: 'github-pat',
    label: 'GitHub Personal Access Token',
    regex: /\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{24,}\b/g,
    severity: 'critical',
  },
  {
    id: 'aws-access-key',
    label: 'AWS Access Key ID',
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
    severity: 'critical',
  },
  {
    id: 'slack-token',
    label: 'Slack Bot / App Token',
    regex: /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g,
    severity: 'critical',
  },
  {
    id: 'private-key-pem',
    label: 'Private Key PEM Block',
    regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
    severity: 'critical',
  },
  {
    id: 'db-uri-credentials',
    label: 'Database URI with Embedded Password',
    regex: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^:\s/'"`\\]+:[^@\s'"`\\]{4,}@[^\s'"`\\]+/gi,
    severity: 'critical',
  },
  {
    id: 'google-api-key',
    label: 'Google API Key',
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    severity: 'high',
  },
];

/**
 * Mask a secret string while keeping only enough prefix/suffix to help the developer locate it.
 */
export function redactSecret(secret: string): string {
  if (secret.length <= 10) return '****';
  if (secret.includes('://') && secret.includes('@')) {
    return secret.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:****@');
  }
  return `${secret.slice(0, 6)}...${secret.slice(-4)}`;
}

/**
 * Scan arbitrary text for exposed secrets, deduplicating identical matches and returning redacted snippets.
 */
export function findSecretsInText(text: string): SecretMatch[] {
  if (!text) return [];
  const matches: SecretMatch[] = [];
  const seen = new Set<string>();

  for (const rule of SECRET_PATTERNS) {
    const regex = new RegExp(rule.regex.source, rule.regex.flags);
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      const raw = m[0];
      // Skip obvious doc/example placeholders
      if (/example|placeholder|your[_-]?key|dummy|xxxxxxxx/i.test(raw)) {
        continue;
      }
      const redacted = redactSecret(raw);
      const dedupeKey = `${rule.id}:${redacted}`;
      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey);
        matches.push({
          ruleId: rule.id,
          label: rule.label,
          severity: rule.severity,
          redacted,
          index: m.index,
        });
      }
    }
  }
  return matches;
}
