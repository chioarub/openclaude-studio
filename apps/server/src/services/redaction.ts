const redactedValue = '<redacted>';
const secretKeyPattern =
  /(?:api[_-]?keys?|access[_-]?key(?:[_-]?id)?|secret[_-]?access[_-]?key|private[_-]?key|key[_-]?id|access[_-]?token|refresh[_-]?token|connection[_-]?string|token|secret|password|authorization|auth[_-]?header[_-]?value|credential|account[_-]?id|custom[_-]?headers?)/i;
const environmentSecretAssignmentKey =
  '[A-Z_][A-Z0-9_]*(?:API_KEYS?|ACCESS_KEY(?:_ID)?|SECRET_ACCESS_KEY|PRIVATE_KEY|KEY_ID|ACCESS_TOKEN|REFRESH_TOKEN|TOKEN|SECRET|PASSWORD|AUTH_HEADER_VALUE|CREDENTIAL|CUSTOM_HEADERS|ACCOUNT_ID|CONNECTION_STRING)';
const quotedEnvironmentSecretAssignmentPattern = new RegExp(
  `\\b(${environmentSecretAssignmentKey}\\s*=\\s*)(["'])([^\\r\\n]*?)\\2`,
  'g',
);
const bearerEnvironmentSecretAssignmentPattern = new RegExp(
  `\\b(${environmentSecretAssignmentKey}\\s*=\\s*)Bearer\\s+([^\\s"']+)`,
  'g',
);
const unquotedEnvironmentSecretAssignmentPattern = new RegExp(
  `\\b(${environmentSecretAssignmentKey}\\s*=\\s*)([^\\s"']+)`,
  'g',
);
const jwtLikeFragmentPattern = /(?:[A-Za-z0-9_-]+\.){2}[A-Za-z0-9_-]+/;
const opaqueTokenLikeFragmentPattern = /(?=[A-Za-z0-9_+/=-]{24,})(?=.*[0-9+/=_])[A-Za-z0-9_+/=-]{24,}/;

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
      /\b([a-z][a-z0-9+.-]*:\/\/)([^@\s"'/?#]+(?::[^@\s"'/?#]*)?@)/gi,
      `$1${redactedValue}@`,
    )
    .replace(
      /([?&][A-Za-z0-9_-]*(?:api[_-]?keys?|access[_-]?key(?:[_-]?id)?|secret[_-]?access[_-]?key|private[_-]?key|key[_-]?id|access[_-]?token|refresh[_-]?token|connection[_-]?string|token|secret|password|authorization|auth[_-]?header[_-]?value|credential|account[_-]?id)[A-Za-z0-9_-]*=)([^&#\s"']+)/gi,
      `$1${redactedValue}`,
    )
    .replace(
      quotedEnvironmentSecretAssignmentPattern,
      `$1$2${redactedValue}$2`,
    )
    .replace(
      bearerEnvironmentSecretAssignmentPattern,
      `$1${redactedValue}`,
    )
    .replace(
      unquotedEnvironmentSecretAssignmentPattern,
      `$1${redactedValue}`,
    )
    .replace(
      /\b(sk-[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{20,})\b/g,
      redactedValue,
    )
    .replace(
      /\b(((?:OPENAI|ANTHROPIC|GEMINI|MISTRAL|MIMO|CODEX|XAI|GITHUB)[A-Z0-9_]*KEY|token)\s*=\s*)(["']?)([^\s"']+)/gi,
      `$1$3${redactedValue}`,
    )
    .replace(/\b(bearer\s+)([A-Za-z0-9._~+/=-]{8,})\b/gi, `$1${redactedValue}`)
    .replace(/\b(https?:\/\/[^\s"'#]+)#([^\s"']+)/gi, (match: string, url: string, fragment: string) => {
      return isSecretFragment(fragment) ? `${url}#${redactedValue}` : match;
    });
}

export function redactUrl(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    if (isSecretFragment(url.hash.slice(1))) {
      url.hash = redactedValue;
    }

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

function isSecretFragment(fragment: string): boolean {
  return fragment.includes('=') ||
    fragment.includes('&') ||
    secretKeyPattern.test(fragment) ||
    jwtLikeFragmentPattern.test(fragment) ||
    opaqueTokenLikeFragmentPattern.test(fragment);
}
