import type {
  ProviderCredentialState,
  StudioProviderAuthKind,
  StudioProviderCategory,
  StudioProviderDiscoveryMode,
  StudioProviderRecognition,
  StudioProviderTransport,
} from '@openclaude-studio/shared';

type UnknownRecord = Record<string, unknown>;

type StudioProviderDescriptor = StudioProviderRecognition & {
  providerIds: string[];
  exactBaseUrls?: string[];
  hostPatterns?: string[];
};

type RecognitionInput = {
  provider?: string | null;
  baseUrl?: string | null;
  apiKeySet?: boolean;
};

type CredentialStateInput = {
  savedApiKey?: unknown;
  savedAuthHeaderValue?: unknown;
  env?: Record<string, string | undefined>;
  credentialEnvVars: string[];
  envSourceLabel: string;
};

const openAiCredentialEnvVars = ['OPENAI_API_KEYS', 'OPENAI_API_KEY'] as const;

// Provider descriptors and startup env names are synced from OpenClaude upstream
// main at 66ddbece19ed2b9735c7e6501c3cfbba4181ca75. Keep this static and
// re-check upstream route descriptors plus providerProfile PROFILE_ENV_KEYS when
// updating recognition; Studio must not import OpenClaude at runtime.
const startupCredentialKeys = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'OPENAI_API_KEYS',
  'OPENAI_API_KEY',
  'OPENAI_AUTH_HEADER_VALUE',
  'DEEPSEEK_API_KEY',
  'GITHUB_COPILOT_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'CODEX_API_KEY',
  'CODEX_CREDENTIAL_SOURCE',
  'CHATGPT_ACCOUNT_ID',
  'CODEX_ACCOUNT_ID',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_ACCESS_TOKEN',
  'MISTRAL_API_KEY',
  'BNKR_API_KEY',
  'XAI_API_KEY',
  'XAI_CREDENTIAL_SOURCE',
  'VENICE_API_KEY',
  'MIMO_API_KEY',
  'ATLAS_CLOUD_API_KEY',
  'NEARAI_API_KEY',
  'FIREWORKS_API_KEY',
  'OPENCODE_API_KEY',
  'NVIDIA_API_KEY',
  'OPENGATEWAY_API_KEY',
  'GROQ_API_KEY',
  'HICAP_API_KEY',
  'OPENROUTER_API_KEY',
  'TOGETHER_API_KEY',
  'DASHSCOPE_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'KIMI_API_KEY',
  'MOONSHOT_API_KEY',
  'MINIMAX_API_KEY',
]);

const startupNonSecretKeys = new Set([
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GITHUB',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_MISTRAL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS',
  'CLAUDE_CODE_DEFAULT_STARTUP_PROVIDER',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'OPENAI_MODEL',
  'OPENAI_API_FORMAT',
  'OPENAI_AUTH_HEADER',
  'OPENAI_AUTH_SCHEME',
  'GITHUB_ENTERPRISE_URL',
  'GEMINI_AUTH_MODE',
  'GEMINI_MODEL',
  'GEMINI_BASE_URL',
  'NVIDIA_NIM',
  'NVIDIA_MODEL',
  'MINIMAX_BASE_URL',
  'MINIMAX_MODEL',
  'MISTRAL_BASE_URL',
  'MISTRAL_MODEL',
  'BANKR_BASE_URL',
  'BANKR_MODEL',
]);

const descriptors: StudioProviderDescriptor[] = [
  provider({
    id: 'anthropic',
    label: 'Anthropic',
    category: 'hosted',
    defaultBaseUrl: 'https://api.anthropic.com',
    authKind: 'api-key',
    credentialEnvVars: ['ANTHROPIC_API_KEY'],
    transport: 'anthropic-native',
    discoveryMode: 'static',
    safeTemplateAvailable: true,
    hostPatterns: ['api.anthropic.com'],
  }),
  provider({
    id: 'atlas-cloud',
    label: 'Atlas Cloud',
    category: 'hosted',
    defaultBaseUrl: 'https://api.atlascloud.ai/v1',
    authKind: 'api-key',
    credentialEnvVars: ['ATLAS_CLOUD_API_KEY'],
    transport: 'openai-compatible',
    discoveryMode: 'static',
    hostPatterns: ['api.atlascloud.ai'],
  }),
  provider({
    id: 'bankr',
    label: 'Bankr',
    category: 'hosted',
    defaultBaseUrl: 'https://llm.bankr.bot/v1',
    authKind: 'api-key',
    credentialEnvVars: ['BNKR_API_KEY', 'OPENAI_API_KEYS', 'OPENAI_API_KEY'],
    transport: 'openai-compatible',
    discoveryMode: 'static',
    hostPatterns: ['llm.bankr.bot'],
  }),
  provider({
    id: 'deepseek',
    label: 'DeepSeek',
    category: 'hosted',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    authKind: 'api-key',
    credentialEnvVars: ['DEEPSEEK_API_KEY', 'OPENAI_API_KEYS', 'OPENAI_API_KEY'],
    transport: 'openai-compatible',
    discoveryMode: 'static',
  }),
  provider({
    id: 'fireworks',
    label: 'Fireworks AI',
    category: 'hosted',
    defaultBaseUrl: 'https://api.fireworks.ai/inference/v1',
    authKind: 'api-key',
    credentialEnvVars: ['FIREWORKS_API_KEY', 'OPENAI_API_KEYS', 'OPENAI_API_KEY'],
    transport: 'openai-compatible',
    discoveryMode: 'static',
    hostPatterns: ['api.fireworks.ai'],
  }),
  provider({
    id: 'gemini',
    label: 'Google Gemini',
    category: 'hosted',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    authKind: 'api-key',
    credentialEnvVars: ['GEMINI_API_KEY'],
    transport: 'gemini-native',
    discoveryMode: 'static',
    safeTemplateAvailable: true,
    hostPatterns: ['generativelanguage.googleapis.com'],
  }),
  provider({
    id: 'minimax',
    label: 'MiniMax',
    category: 'hosted',
    defaultBaseUrl: 'https://api.minimax.io/anthropic',
    authKind: 'api-key',
    credentialEnvVars: ['MINIMAX_API_KEY'],
    transport: 'anthropic-proxy',
    discoveryMode: 'static',
    hostPatterns: ['api.minimax.io', 'api.minimax.chat'],
  }),
  provider({
    id: 'moonshot',
    label: 'Moonshot AI',
    category: 'hosted',
    defaultBaseUrl: 'https://api.moonshot.ai/v1',
    authKind: 'api-key',
    credentialEnvVars: ['MOONSHOT_API_KEY', 'OPENAI_API_KEYS', 'OPENAI_API_KEY'],
    transport: 'openai-compatible',
    discoveryMode: 'static',
    providerIds: ['moonshot', 'moonshotai'],
  }),
  provider({
    id: 'nearai',
    label: 'NEAR AI',
    category: 'hosted',
    defaultBaseUrl: 'https://cloud-api.near.ai/v1',
    authKind: 'api-key',
    credentialEnvVars: ['NEARAI_API_KEY', 'OPENAI_API_KEYS', 'OPENAI_API_KEY'],
    transport: 'openai-compatible',
    discoveryMode: 'static',
    hostPatterns: ['cloud-api.near.ai', 'completions.near.ai', '*.completions.near.ai'],
  }),
  provider({
    id: 'openai',
    label: 'OpenAI',
    category: 'hosted',
    defaultBaseUrl: 'https://api.openai.com/v1',
    authKind: 'api-key',
    credentialEnvVars: ['OPENAI_API_KEYS', 'OPENAI_API_KEY'],
    transport: 'openai-compatible',
    discoveryMode: 'static',
    safeTemplateAvailable: true,
  }),
  provider({
    id: 'venice',
    label: 'Venice',
    category: 'hosted',
    defaultBaseUrl: 'https://api.venice.ai/api/v1',
    authKind: 'api-key',
    credentialEnvVars: ['VENICE_API_KEY', 'OPENAI_API_KEYS', 'OPENAI_API_KEY'],
    transport: 'openai-compatible',
    discoveryMode: 'static',
    hostPatterns: ['api.venice.ai'],
  }),
  provider({
    id: 'xai',
    label: 'xAI',
    category: 'hosted',
    defaultBaseUrl: 'https://api.x.ai/v1',
    authKind: 'api-key',
    credentialEnvVars: ['XAI_API_KEY', 'OPENAI_API_KEYS', 'OPENAI_API_KEY'],
    transport: 'openai-compatible',
    discoveryMode: 'static',
    hostPatterns: ['api.x.ai'],
  }),
  provider({
    id: 'xiaomi-mimo',
    label: 'Xiaomi MiMo',
    category: 'hosted',
    defaultBaseUrl: 'https://api.xiaomimimo.com/v1',
    authKind: 'api-key',
    credentialEnvVars: ['MIMO_API_KEY', 'OPENAI_API_KEYS', 'OPENAI_API_KEY'],
    transport: 'openai-compatible',
    discoveryMode: 'static',
    hostPatterns: ['api.xiaomimimo.com', 'api.mimo-v2.com'],
  }),
  provider({
    id: 'zai',
    label: 'Z.AI',
    category: 'subscription',
    defaultBaseUrl: 'https://api.z.ai/api/coding/paas/v4',
    authKind: 'api-key',
    credentialEnvVars: ['OPENAI_API_KEYS', 'OPENAI_API_KEY'],
    transport: 'openai-compatible',
    discoveryMode: 'static',
    safeTemplateAvailable: true,
    hostPatterns: ['api.z.ai'],
  }),
  provider({
    id: 'atomic-chat',
    label: 'Atomic Chat',
    category: 'local',
    defaultBaseUrl: 'http://127.0.0.1:1337/v1',
    authKind: 'none',
    credentialEnvVars: ['OPENAI_API_KEYS', 'OPENAI_API_KEY'],
    transport: 'local',
    discoveryMode: 'local',
    exactBaseUrls: ['http://localhost:1337/v1', 'http://127.0.0.1:1337/v1'],
  }),
  provider({
    id: 'azure-openai',
    label: 'Azure OpenAI',
    category: 'hosted',
    defaultBaseUrl: 'https://YOUR-RESOURCE-NAME.openai.azure.com/openai/v1',
    authKind: 'api-key',
    credentialEnvVars: ['AZURE_OPENAI_API_KEY', 'OPENAI_API_KEYS', 'OPENAI_API_KEY'],
    transport: 'openai-compatible',
    discoveryMode: 'static',
    hostPatterns: ['*.openai.azure.com'],
  }),
  provider({
    id: 'bedrock',
    label: 'AWS Bedrock',
    category: 'cloud',
    defaultBaseUrl: null,
    authKind: 'adc',
    credentialEnvVars: [],
    transport: 'bedrock',
    discoveryMode: 'static',
    inspectionOnly: true,
  }),
  provider({
    id: 'foundry',
    label: 'Microsoft Foundry',
    category: 'cloud',
    defaultBaseUrl: null,
    authKind: 'api-key',
    credentialEnvVars: ['ANTHROPIC_FOUNDRY_API_KEY'],
    transport: 'foundry',
    discoveryMode: 'static',
    inspectionOnly: true,
  }),
  provider({
    id: 'custom',
    label: 'Custom OpenAI-compatible',
    category: 'custom',
    defaultBaseUrl: null,
    authKind: 'api-key',
    credentialEnvVars: ['OPENAI_API_KEYS', 'OPENAI_API_KEY'],
    transport: 'openai-compatible',
    discoveryMode: 'hybrid',
    safeTemplateAvailable: true,
    providerIds: ['custom', 'custom-openai'],
  }),
  provider({
    id: 'dashscope-cn',
    label: 'Alibaba Coding Plan (China)',
    category: 'hosted',
    defaultBaseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
    authKind: 'api-key',
    credentialEnvVars: ['DASHSCOPE_API_KEY', 'OPENAI_API_KEYS', 'OPENAI_API_KEY'],
    transport: 'openai-compatible',
    discoveryMode: 'static',
  }),
  provider({
    id: 'dashscope-intl',
    label: 'Alibaba Coding Plan',
    category: 'hosted',
    defaultBaseUrl: 'https://coding-intl.dashscope.aliyuncs.com/v1',
    authKind: 'api-key',
    credentialEnvVars: ['DASHSCOPE_API_KEY', 'OPENAI_API_KEYS', 'OPENAI_API_KEY'],
    transport: 'openai-compatible',
    discoveryMode: 'static',
  }),
  provider({
    id: 'github-enterprise',
    label: 'GitHub Copilot Enterprise',
    category: 'hosted',
    defaultBaseUrl: 'https://api.githubcopilot.com',
    authKind: 'token',
    credentialEnvVars: ['GITHUB_COPILOT_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'OPENAI_API_KEYS', 'OPENAI_API_KEY'],
    transport: 'openai-compatible',
    discoveryMode: 'static',
    inspectionOnly: true,
  }),
  provider({
    id: 'github',
    label: 'GitHub Copilot',
    category: 'hosted',
    defaultBaseUrl: 'https://api.githubcopilot.com',
    authKind: 'token',
    credentialEnvVars: ['GITHUB_TOKEN', 'GH_TOKEN', 'OPENAI_API_KEYS', 'OPENAI_API_KEY'],
    transport: 'openai-compatible',
    discoveryMode: 'static',
    hostPatterns: ['api.githubcopilot.com'],
    inspectionOnly: true,
  }),
  provider({
    id: 'gitlawb-opengateway',
    label: 'Gitlawb Opengateway',
    category: 'aggregating',
    defaultBaseUrl: 'https://opengateway.gitlawb.com/v1',
    authKind: 'api-key',
    credentialEnvVars: ['OPENGATEWAY_API_KEY', 'OPENAI_API_KEYS', 'OPENAI_API_KEY'],
    transport: 'openai-compatible',
    discoveryMode: 'static',
    hostPatterns: ['opengateway.gitlawb.com', 'opengateway.fly.dev'],
  }),
  provider({
    id: 'groq',
    label: 'Groq',
    category: 'aggregating',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    authKind: 'api-key',
    credentialEnvVars: ['GROQ_API_KEY', 'OPENAI_API_KEYS', 'OPENAI_API_KEY'],
    transport: 'openai-compatible',
    discoveryMode: 'hybrid',
  }),
  provider({
    id: 'hicap',
    label: 'Hicap',
    category: 'aggregating',
    defaultBaseUrl: 'https://api.hicap.ai/v1',
    authKind: 'api-key',
    credentialEnvVars: ['HICAP_API_KEY', 'OPENAI_API_KEYS', 'OPENAI_API_KEY'],
    transport: 'openai-compatible',
    discoveryMode: 'hybrid',
    hostPatterns: ['api.hicap.ai'],
  }),
  provider({
    id: 'kimi-code',
    label: 'Moonshot AI - Kimi Code',
    category: 'subscription',
    defaultBaseUrl: 'https://api.kimi.com/coding/v1',
    authKind: 'api-key',
    credentialEnvVars: ['KIMI_API_KEY', 'OPENAI_API_KEYS', 'OPENAI_API_KEY'],
    transport: 'openai-compatible',
    discoveryMode: 'static',
  }),
  provider({
    id: 'lmstudio',
    label: 'LM Studio',
    category: 'local',
    defaultBaseUrl: 'http://localhost:1234/v1',
    authKind: 'none',
    credentialEnvVars: ['OPENAI_API_KEYS', 'OPENAI_API_KEY'],
    transport: 'local',
    discoveryMode: 'local',
    exactBaseUrls: ['http://localhost:1234/v1', 'http://127.0.0.1:1234/v1'],
  }),
  provider({
    id: 'mistral',
    label: 'Mistral AI',
    category: 'hosted',
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    authKind: 'api-key',
    credentialEnvVars: ['MISTRAL_API_KEY', 'OPENAI_API_KEYS', 'OPENAI_API_KEY'],
    transport: 'openai-compatible',
    discoveryMode: 'static',
    safeTemplateAvailable: true,
  }),
  provider({
    id: 'nvidia-nim',
    label: 'NVIDIA NIM',
    category: 'hosted',
    defaultBaseUrl: 'https://integrate.api.nvidia.com/v1',
    authKind: 'api-key',
    credentialEnvVars: ['NVIDIA_API_KEY', 'OPENAI_API_KEYS', 'OPENAI_API_KEY'],
    transport: 'openai-compatible',
    discoveryMode: 'hybrid',
  }),
  provider({
    id: 'ollama',
    label: 'Ollama',
    category: 'local',
    defaultBaseUrl: 'http://localhost:11434/v1',
    authKind: 'none',
    credentialEnvVars: ['OPENAI_API_KEYS', 'OPENAI_API_KEY'],
    transport: 'local',
    discoveryMode: 'local',
    safeTemplateAvailable: true,
    exactBaseUrls: ['http://localhost:11434/v1', 'http://127.0.0.1:11434/v1'],
  }),
  provider({
    id: 'opencode-go',
    label: 'OpenCode Go',
    category: 'aggregating',
    defaultBaseUrl: 'https://opencode.ai/zen/go/v1',
    authKind: 'api-key',
    credentialEnvVars: ['OPENCODE_API_KEY', 'OPENAI_API_KEYS', 'OPENAI_API_KEY'],
    transport: 'openai-compatible',
    discoveryMode: 'static',
  }),
  provider({
    id: 'opencode',
    label: 'OpenCode Zen',
    category: 'aggregating',
    defaultBaseUrl: 'https://opencode.ai/zen/v1',
    authKind: 'api-key',
    credentialEnvVars: ['OPENCODE_API_KEY', 'OPENAI_API_KEYS', 'OPENAI_API_KEY'],
    transport: 'openai-compatible',
    discoveryMode: 'static',
  }),
  provider({
    id: 'openrouter',
    label: 'OpenRouter',
    category: 'aggregating',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    authKind: 'api-key',
    credentialEnvVars: ['OPENROUTER_API_KEY', 'OPENAI_API_KEYS', 'OPENAI_API_KEY'],
    transport: 'openai-compatible',
    discoveryMode: 'hybrid',
  }),
  provider({
    id: 'together',
    label: 'Together AI',
    category: 'aggregating',
    defaultBaseUrl: 'https://api.together.xyz/v1',
    authKind: 'api-key',
    credentialEnvVars: ['TOGETHER_API_KEY', 'OPENAI_API_KEYS', 'OPENAI_API_KEY'],
    transport: 'openai-compatible',
    discoveryMode: 'static',
  }),
  provider({
    id: 'vertex',
    label: 'Google Vertex AI',
    category: 'cloud',
    defaultBaseUrl: null,
    authKind: 'adc',
    credentialEnvVars: [],
    transport: 'vertex',
    discoveryMode: 'static',
    inspectionOnly: true,
  }),
  provider({
    id: 'xiaomi-mimo-token',
    label: 'Xiaomi MiMo (Token Plan)',
    category: 'hosted',
    defaultBaseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
    authKind: 'api-key',
    credentialEnvVars: ['MIMO_API_KEY', 'OPENAI_API_KEYS', 'OPENAI_API_KEY'],
    transport: 'openai-compatible',
    discoveryMode: 'static',
    hostPatterns: ['token-plan-sgp.xiaomimimo.com', 'token-plan-cn.xiaomimimo.com'],
  }),
  provider({
    id: 'codex',
    label: 'Codex',
    category: 'subscription',
    defaultBaseUrl: 'https://chatgpt.com/backend-api/codex',
    authKind: 'api-key',
    credentialEnvVars: ['CODEX_API_KEY'],
    transport: 'openai-compatible',
    discoveryMode: 'static',
    providerIds: ['codex'],
    inspectionOnly: true,
  }),
  provider({
    id: 'codex-oauth',
    label: 'Codex OAuth',
    category: 'subscription',
    defaultBaseUrl: 'https://chatgpt.com/backend-api/codex',
    authKind: 'oauth',
    credentialEnvVars: [],
    transport: 'openai-compatible',
    discoveryMode: 'static',
    providerIds: ['codex-oauth'],
    safeTemplateAvailable: true,
    inspectionOnly: true,
  }),
];

export function getStudioProviderDescriptors(): StudioProviderRecognition[] {
  return descriptors.map(toRecognition);
}

export function recognizeStudioProvider(input: RecognitionInput): StudioProviderRecognition {
  const providerId = normalizeIdentifier(input.provider);
  const normalizedBaseUrl = normalizeComparableBaseUrl(input.baseUrl);

  if (isCodexBaseUrl(input.baseUrl)) {
    return toRecognition(descriptorById(input.apiKeySet ? 'codex' : 'codex-oauth'));
  }

  if (providerId === 'codex') {
    return toRecognition(descriptorById(input.apiKeySet ? 'codex' : 'codex-oauth'));
  }

  if (providerId && providerId !== 'openai' && providerId !== 'custom' && providerId !== 'custom-openai') {
    const byProvider = descriptors.find((descriptor) => descriptor.providerIds.includes(providerId));
    if (byProvider) {
      return toRecognition(byProvider);
    }
  }

  const byLocalPort = descriptorByLocalPort(input.baseUrl);
  if (byLocalPort) {
    return toRecognition(byLocalPort);
  }

  const byBaseUrl = descriptors.find((descriptor) => matchesDescriptorBaseUrl(descriptor, input.baseUrl, normalizedBaseUrl));
  if (byBaseUrl && byBaseUrl.id !== 'codex') {
    return toRecognition(byBaseUrl);
  }

  if (providerId === 'openai' && input.baseUrl) {
    return toRecognition(descriptorById('custom'));
  }

  if (providerId) {
    const byProvider = descriptors.find((descriptor) => descriptor.providerIds.includes(providerId));
    if (byProvider) {
      return toRecognition(byProvider);
    }
  }

  return toRecognition(descriptorById('custom'));
}

export function summarizeProviderCredentialState(input: CredentialStateInput): ProviderCredentialState {
  const savedApiKey = credentialStateFromValue(input.savedApiKey, 'saved profile apiKey');
  if (savedApiKey.credentialMode !== 'none' || savedApiKey.credentialInvalid) {
    return savedApiKey;
  }

  const savedAuthHeader = credentialStateFromValue(input.savedAuthHeaderValue, 'saved profile authHeaderValue');
  if (savedAuthHeader.credentialMode !== 'none' || savedAuthHeader.credentialInvalid) {
    return savedAuthHeader;
  }

  return credentialStateFromEnv(input.env ?? {}, input.credentialEnvVars, input.envSourceLabel);
}

export function summarizeStartupCredentialState(env: UnknownRecord): ProviderCredentialState {
  const startupEnv = Object.fromEntries(
    Object.entries(env).filter(([, value]) => typeof value === 'string'),
  ) as Record<string, string | undefined>;
  return credentialStateFromEnv(startupEnv, Object.keys(startupEnv).filter(isKnownStartupCredentialFieldName), 'startup profile env');
}

export function configuredStartupCredentials(env: UnknownRecord): Array<{ name: string; configured: boolean }> {
  return Object.keys(env)
    .filter(isKnownStartupCredentialFieldName)
    .sort((left, right) => left.localeCompare(right))
    .map((name) => ({ name, configured: hasNonEmptyString(env[name]) }));
}

export function configuredStartupNonSecretFields(env: UnknownRecord): string[] {
  return Object.keys(env)
    .filter((name) => startupNonSecretKeys.has(name) && hasNonEmptyString(env[name]))
    .sort((left, right) => left.localeCompare(right));
}

export function startupBaseUrlFromEnv(env: UnknownRecord): string | null {
  return stringFromUnknown(env.OPENAI_BASE_URL) ??
    stringFromUnknown(env.OPENAI_API_BASE) ??
    stringFromUnknown(env.ANTHROPIC_BASE_URL) ??
    stringFromUnknown(env.GEMINI_BASE_URL) ??
    stringFromUnknown(env.MISTRAL_BASE_URL) ??
    stringFromUnknown(env.ANTHROPIC_BEDROCK_BASE_URL) ??
    stringFromUnknown(env.ANTHROPIC_VERTEX_BASE_URL);
}

export function isSupportedStartupProfile(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function provider(input: Omit<StudioProviderDescriptor, 'providerIds' | 'inspectionOnly' | 'safeTemplateAvailable'> & {
  providerIds?: string[];
  inspectionOnly?: boolean;
  safeTemplateAvailable?: boolean;
}): StudioProviderDescriptor {
  return {
    ...input,
    inspectionOnly: input.inspectionOnly ?? false,
    safeTemplateAvailable: input.safeTemplateAvailable ?? false,
    providerIds: input.providerIds ?? [input.id],
  };
}

function toRecognition(descriptor: StudioProviderDescriptor): StudioProviderRecognition {
  return {
    id: descriptor.id,
    label: descriptor.label,
    category: descriptor.category,
    defaultBaseUrl: descriptor.defaultBaseUrl,
    authKind: descriptor.authKind,
    credentialEnvVars: [...descriptor.credentialEnvVars],
    transport: descriptor.transport,
    discoveryMode: descriptor.discoveryMode,
    safeTemplateAvailable: descriptor.safeTemplateAvailable,
    inspectionOnly: descriptor.inspectionOnly,
  };
}

function descriptorById(id: string): StudioProviderDescriptor {
  const descriptor = descriptors.find((item) => item.id === id);
  if (!descriptor) {
    throw new Error(`Unknown Studio provider descriptor: ${id}`);
  }
  return descriptor;
}

function descriptorByLocalPort(baseUrl: string | null | undefined): StudioProviderDescriptor | null {
  try {
    const url = new URL(baseUrl ?? '');
    if (!isLoopbackHostname(url.hostname)) {
      return null;
    }
    if (url.port === '11434') return descriptorById('ollama');
    if (url.port === '1234') return descriptorById('lmstudio');
    if (url.port === '1337') return descriptorById('atomic-chat');
  } catch {
    return null;
  }
  return null;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '[::1]';
}

function matchesDescriptorBaseUrl(
  descriptor: StudioProviderDescriptor,
  baseUrl: string | null | undefined,
  normalizedBaseUrl: string | null,
): boolean {
  if (!baseUrl) {
    return false;
  }

  const exactBaseUrls = [
    descriptor.defaultBaseUrl,
    ...(descriptor.exactBaseUrls ?? []),
  ].filter((value): value is string => Boolean(value));
  if (normalizedBaseUrl && exactBaseUrls.some((value) => normalizeComparableBaseUrl(value) === normalizedBaseUrl)) {
    return true;
  }

  const hostname = hostnameFromUrl(baseUrl);
  if (!hostname) {
    return false;
  }
  const hostPatterns = descriptor.hostPatterns ?? [];
  return hostPatterns.some((pattern) => matchHostPattern(hostname, pattern));
}

function isCodexBaseUrl(baseUrl: string | null | undefined): boolean {
  try {
    const url = new URL(baseUrl ?? '');
    return url.hostname.toLowerCase() === 'chatgpt.com' &&
      url.pathname.replace(/\/+$/, '') === '/backend-api/codex';
  } catch {
    return false;
  }
}

function hostnameFromUrl(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function normalizeComparableBaseUrl(value: string | null | undefined): string | null {
  if (!value?.trim()) {
    return null;
  }

  try {
    const url = new URL(value);
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/+$/, '').toLowerCase();
  } catch {
    return value.trim().replace(/\/+$/, '').toLowerCase() || null;
  }
}

function matchHostPattern(hostname: string, pattern: string): boolean {
  const normalized = pattern.toLowerCase();
  if (normalized.startsWith('*.')) {
    return hostname.endsWith(normalized.slice(1));
  }
  return hostname === normalized;
}

function normalizeIdentifier(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

function credentialStateFromEnv(
  env: Record<string, string | undefined>,
  credentialEnvVars: string[],
  sourceLabel: string,
): ProviderCredentialState {
  const consumed = new Set<string>();
  for (const envVar of credentialEnvVars) {
    if (consumed.has(envVar)) {
      continue;
    }

    if (envVar === 'OPENAI_API_KEYS' || envVar === 'OPENAI_API_KEY') {
      consumed.add('OPENAI_API_KEYS');
      consumed.add('OPENAI_API_KEY');
      const pooled = credentialStateFromValue(env.OPENAI_API_KEYS, `${sourceLabel}: OPENAI_API_KEYS`);
      if (pooled.credentialMode !== 'none' || pooled.credentialInvalid) {
        return pooled;
      }
      const singular = credentialStateFromValue(env.OPENAI_API_KEY, `${sourceLabel}: OPENAI_API_KEY`);
      if (singular.credentialMode !== 'none' || singular.credentialInvalid) {
        return singular;
      }
      continue;
    }

    const result = credentialStateFromValue(env[envVar], `${sourceLabel}: ${envVar}`);
    if (result.credentialMode !== 'none' || result.credentialInvalid) {
      return result;
    }
  }

  return emptyCredentialState();
}

function credentialStateFromValue(value: unknown, source: string): ProviderCredentialState {
  if (typeof value !== 'string') {
    return emptyCredentialState();
  }

  const credentials = parseCredentialList(value);
  if (credentials.length === 0) {
    return emptyCredentialState();
  }
  if (credentials.some((credential) => credential === 'SUA_CHAVE')) {
    return {
      credentialMode: 'unknown',
      credentialCount: credentials.length,
      credentialConfigured: false,
      credentialInvalid: true,
      credentialSources: [source],
    };
  }

  return {
    credentialMode: credentials.length > 1 ? 'pool' : 'single',
    credentialCount: credentials.length,
    credentialConfigured: true,
    credentialInvalid: false,
    credentialSources: [source],
  };
}

function emptyCredentialState(): ProviderCredentialState {
  return {
    credentialMode: 'none',
    credentialCount: 0,
    credentialConfigured: false,
    credentialInvalid: false,
    credentialSources: [],
  };
}

function parseCredentialList(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function isKnownStartupCredentialFieldName(name: string): boolean {
  return startupCredentialKeys.has(name) || /^GH_TOKEN$/i.test(name);
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function stringFromUnknown(value: unknown): string | null {
  return hasNonEmptyString(value) ? (value as string).trim() : null;
}
