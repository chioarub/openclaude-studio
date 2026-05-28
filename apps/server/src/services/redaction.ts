const redactedValue = '<redacted>';
const secretKeyPattern =
  /(?:api[_-]?key|token|secret|password|authorization|auth[_-]?header[_-]?value|credential)/i;

export function redactSecrets<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item)) as T;
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = secretKeyPattern.test(key) ? redactedValue : redactSecrets(item);
  }

  return output as T;
}

export function redactTextSecrets(content: string): string {
  return content
    .replace(
      /\b(sk-[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{20,})\b/g,
      redactedValue,
    )
    .replace(
      /\b((?:OPENAI|ANTHROPIC|GEMINI|MISTRAL|MIMO|CODEX|XAI|GITHUB)[A-Z0-9_]*KEY\s*=\s*)([^\s"']+)/gi,
      `$1${redactedValue}`,
    )
    .replace(/\b(bearer\s+)([A-Za-z0-9._~+/=-]{8,})\b/gi, `$1${redactedValue}`);
}

export function redactUrl(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';

    for (const key of Array.from(url.searchParams.keys())) {
      if (secretKeyPattern.test(key)) {
        url.searchParams.set(key, redactedValue);
      }
    }

    return url.toString();
  } catch {
    return redactTextSecrets(value);
  }
}
