import { createHash } from 'node:crypto';
import { join } from 'node:path';

import type {
  Diagnostic,
  ProviderCustomHeaderSummary,
  ProviderProfileField,
  ProviderProfileTemplate,
  ProviderCredentialState,
  ProviderProfileValidation,
  ProviderProfileValidationIssue,
  ProviderProfilesResponse,
  ProviderTemplateId,
  SafeProviderProfile,
  StartupProviderProfileSummary,
} from '@openclaude-studio/shared';

import type { OpenClaudePaths } from './paths.js';
import { redactUrl } from './redaction.js';
import { readRawOpenClaudeConfig, type OpenClaudeConfig } from './openclaudeData.js';
import { readBoundedTextFile } from './safeFile.js';
import {
  configuredStartupCredentials,
  configuredStartupNonSecretFields,
  isSupportedStartupProfile,
  recognizeStudioProvider,
  startupBaseUrlFromEnv,
  summarizeProviderCredentialState,
  summarizeStartupCredentialState,
} from './providerRecognition.js';

type UnknownRecord = Record<string, unknown>;

type ProfileContext = {
  duplicateIds: Set<string>;
};

const httpTokenPattern = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const startupProfileFileName = '.openclaude-profile.json';
const maxStartupProfileBytes = 64 * 1024;

const templates: ProviderProfileTemplate[] = [
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    category: 'hosted',
    description: 'Anthropic API profile for Claude models.',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: '',
    modelPlaceholder: 'Claude model id',
    requiresSecret: true,
    requiredFields: ['name', 'provider', 'baseUrl', 'model', 'credential'],
    advancedFields: ['authHeader', 'authScheme', 'customHeaders'],
    apiFormat: null,
    authHeader: null,
    authScheme: null,
    customHeaders: [],
    credential: {
      label: 'Anthropic credential',
      envVar: 'ANTHROPIC_API_KEY',
      placeholder: 'Set outside Studio before using this profile',
    },
  },
  {
    id: 'openai',
    label: 'OpenAI GPT',
    category: 'hosted',
    description: 'OpenAI-compatible profile for OpenAI hosted models.',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: '',
    modelPlaceholder: 'OpenAI model id',
    requiresSecret: true,
    requiredFields: ['name', 'provider', 'baseUrl', 'model', 'credential'],
    advancedFields: ['apiFormat', 'authHeader', 'authScheme', 'customHeaders'],
    apiFormat: 'responses',
    authHeader: null,
    authScheme: null,
    customHeaders: [],
    credential: {
      label: 'OpenAI credential',
      envVar: 'OPENAI_API_KEY',
      placeholder: 'Set outside Studio before using this profile',
    },
  },
  {
    id: 'gemini',
    label: 'Gemini',
    category: 'hosted',
    description: 'Google Gemini endpoint through the OpenAI-compatible API surface.',
    provider: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: '',
    modelPlaceholder: 'Gemini model id',
    requiresSecret: true,
    requiredFields: ['name', 'provider', 'baseUrl', 'model', 'credential'],
    advancedFields: ['customHeaders'],
    apiFormat: null,
    authHeader: null,
    authScheme: null,
    customHeaders: [],
    credential: {
      label: 'Gemini credential',
      envVar: 'GEMINI_API_KEY',
      placeholder: 'Set outside Studio before using this profile',
    },
  },
  {
    id: 'zai-coding-plan',
    label: 'Z.AI GLM Coding Plan',
    category: 'subscription',
    description: 'Z.AI coding subscription endpoint with OpenAI-compatible request shape.',
    provider: 'zai',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    model: '',
    modelPlaceholder: 'GLM model id',
    requiresSecret: true,
    requiredFields: ['name', 'provider', 'baseUrl', 'model', 'credential'],
    advancedFields: ['apiFormat', 'authHeader', 'authScheme', 'customHeaders'],
    apiFormat: null,
    authHeader: null,
    authScheme: null,
    customHeaders: [],
    credential: {
      label: 'Z.AI credential',
      envVar: 'OPENAI_API_KEY',
      placeholder: 'Set outside Studio before using this profile',
    },
  },
  {
    id: 'codex-oauth',
    label: 'Codex OAuth / codexplan',
    category: 'subscription',
    description: 'Codex backend profile that relies on existing OpenClaude OAuth credentials.',
    provider: 'openai',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    model: 'codexplan',
    modelPlaceholder: 'codexplan',
    requiresSecret: false,
    requiredFields: ['name', 'provider', 'baseUrl', 'model'],
    advancedFields: [],
    apiFormat: null,
    authHeader: null,
    authScheme: null,
    customHeaders: [],
    credential: null,
  },
  {
    id: 'ollama',
    label: 'Ollama',
    category: 'local',
    description: 'Local Ollama profile using its OpenAI-compatible endpoint.',
    provider: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'llama3.1:8b',
    modelPlaceholder: 'Ollama model tag',
    requiresSecret: false,
    requiredFields: ['name', 'provider', 'baseUrl', 'model'],
    advancedFields: ['authHeader', 'authScheme', 'customHeaders'],
    apiFormat: null,
    authHeader: null,
    authScheme: null,
    customHeaders: [],
    credential: null,
  },
  {
    id: 'mistral',
    label: 'Mistral',
    category: 'hosted',
    description: 'Mistral hosted API profile.',
    provider: 'mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    model: '',
    modelPlaceholder: 'Mistral model id',
    requiresSecret: true,
    requiredFields: ['name', 'provider', 'baseUrl', 'model', 'credential'],
    advancedFields: ['authHeader', 'authScheme', 'customHeaders'],
    apiFormat: null,
    authHeader: null,
    authScheme: null,
    customHeaders: [],
    credential: {
      label: 'Mistral credential',
      envVar: 'MISTRAL_API_KEY',
      placeholder: 'Set outside Studio before using this profile',
    },
  },
  {
    id: 'custom-openai',
    label: 'Custom OpenAI-compatible',
    category: 'custom',
    description: 'Any OpenAI-compatible endpoint with a user-supplied URL and model.',
    provider: 'openai',
    baseUrl: '',
    model: '',
    modelPlaceholder: 'Model id',
    requiresSecret: true,
    requiredFields: ['name', 'provider', 'baseUrl', 'model'],
    advancedFields: ['apiFormat', 'authHeader', 'authScheme', 'customHeaders'],
    apiFormat: 'chat_completions',
    authHeader: null,
    authScheme: null,
    customHeaders: [],
    credential: {
      label: 'Provider credential',
      envVar: 'OPENAI_API_KEY',
      placeholder: 'Set outside Studio before using this profile',
    },
  },
];

export async function readProviderProfiles(
  paths: OpenClaudePaths,
  env: Record<string, string | undefined> = process.env,
): Promise<ProviderProfilesResponse> {
  const { path, exists, config, diagnostics: configDiagnostics } = await readRawOpenClaudeConfig(paths);
  const rawProfiles = getProviderProfiles(config);
  const ids = rawProfiles.map((profile, index) => profileId(profile, index));
  const duplicateIds = duplicateValues(ids);
  const configuredActiveId = stringFromUnknown(config.activeProviderProfileId);
  const selectedActiveIndex = selectActiveProviderIndex(config, rawProfiles);
  const selectedActiveId = selectedActiveIndex === null ? null : profileId(rawProfiles[selectedActiveIndex] ?? {}, selectedActiveIndex);
  const diagnostics: Diagnostic[] = [...configDiagnostics];
  const startupProfile = await readStartupProviderProfile(paths);

  if (rawProfiles.length === 0) {
    diagnostics.push({ level: 'warn', message: 'No provider profiles are configured.' });
  } else if (!configuredActiveId) {
    diagnostics.push({
      level: 'warn',
      message: 'No active provider profile is configured; using the first provider profile.',
    });
  } else if (configuredActiveId !== selectedActiveId) {
    diagnostics.push({
      level: 'warn',
      message: 'Configured active provider profile was not found; using the first provider profile.',
    });
  }

  const profiles = rawProfiles.map((profile, index) =>
    toSafeProviderProfile(profile, index, selectedActiveIndex, { duplicateIds }, env),
  );
  const summary = summarizeProfiles(profiles, startupProfile);

  return {
    path,
    exists,
    activeProviderProfileId: configuredActiveId,
    sensitiveFieldsRedacted: true,
    profiles,
    startupProfile,
    templates: getProviderProfileTemplates(),
    summary: {
      ...summary,
      templates: templates.length,
    },
    diagnostics,
  };
}

export function getProviderProfileTemplates(): ProviderProfileTemplate[] {
  return templates.map((template) => ({
    ...template,
    requiredFields: [...template.requiredFields],
    advancedFields: [...template.advancedFields],
    customHeaders: template.customHeaders.map((header) => ({ ...header })),
    credential: template.credential ? { ...template.credential } : null,
  }));
}

export function inferProviderTemplateId(profile: {
  provider?: string | null;
  baseUrl?: string | null;
}): ProviderTemplateId {
  const recognizedProvider = recognizeStudioProvider({
    provider: profile.provider ?? null,
    baseUrl: profile.baseUrl ?? null,
    apiKeySet: false,
  });
  return templateIdFromProfile(profile.provider, recognizedProvider.id);
}

function toSafeProviderProfile(
  profile: UnknownRecord,
  index: number,
  selectedActiveIndex: number | null,
  context: ProfileContext,
  env: Record<string, string | undefined>,
): SafeProviderProfile {
  const id = profileId(profile, index);
  const name = trimmedString(profile.name) ?? 'Unnamed provider';
  const provider = trimmedString(profile.provider) ?? 'unknown';
  const model = trimmedString(profile.model) ?? 'default';
  const baseUrlRaw = trimmedString(profile.baseUrl);
  const apiKeySet =
    hasNonEmptyString(profile.apiKey) ||
    hasNonEmptyString(profile.authHeaderValue) ||
    hasNonEmptyString(env.CODEX_API_KEY);
  const recognizedProvider = recognizeStudioProvider({
    provider,
    baseUrl: baseUrlRaw,
    apiKeySet,
  });
  const credential = summarizeProviderCredentialState({
    savedApiKey: profile.apiKey,
    savedAuthHeaderValue: profile.authHeaderValue,
    env,
    credentialEnvVars: recognizedProvider.credentialEnvVars,
    envSourceLabel: 'Studio server env',
  });
  const templateId = templateIdFromProfile(provider, recognizedProvider.id);
  const template = templates.find((item) => item.id === templateId) ?? templates[templates.length - 1]!;
  const apiFormat = trimmedString(profile.apiFormat);
  const authHeader = trimmedString(profile.authHeader);
  const authScheme = trimmedString(profile.authScheme);
  const validation = validateProfile(profile, index, context, credential);

  return {
    id,
    name,
    provider,
    model,
    baseUrl: redactUrl(baseUrlRaw),
    active: index === selectedActiveIndex,
    apiKeySet: hasNonEmptyString(profile.apiKey),
    authHeaderValueSet: hasNonEmptyString(profile.authHeaderValue),
    apiFormat,
    authHeader,
    authScheme,
    customHeaders: summarizeCustomHeaders(profile.customHeaders),
    recognizedProvider,
    credential,
    templateId,
    templateLabel: template.label,
    validation,
  };
}

async function readStartupProviderProfile(paths: OpenClaudePaths): Promise<StartupProviderProfileSummary> {
  const path = join(paths.openClaudeHome, startupProfileFileName);
  const fallbackRecognition = recognizeStudioProvider({ provider: null, baseUrl: null, apiKeySet: false });
  const emptyCredential: ProviderCredentialState = {
    credentialMode: 'none',
    credentialCount: 0,
    credentialConfigured: false,
    credentialInvalid: false,
    credentialSources: [],
  };
  const unavailableSummary = (diagnostics: Diagnostic[]): StartupProviderProfileSummary => ({
    path,
    exists: true,
    profile: null,
    createdAt: null,
    configuredNonSecretFields: [],
    credentials: [],
    credential: emptyCredential,
    recognizedProvider: fallbackRecognition,
    diagnostics,
  });

  let result: Awaited<ReturnType<typeof readBoundedTextFile>>;
  try {
    result = await readBoundedTextFile(path, { maxBytes: maxStartupProfileBytes });
  } catch (error) {
    return unavailableSummary([
      {
        level: 'warn',
        message: `Unable to read startup profile: ${startupProfileReadFailureMessage(error)}`,
        path,
      },
    ]);
  }

  if (!result.exists) {
    return {
      path,
      exists: false,
      profile: null,
      createdAt: null,
      configuredNonSecretFields: [],
      credentials: [],
      credential: emptyCredential,
      recognizedProvider: fallbackRecognition,
      diagnostics: result.diagnostics,
    };
  }

  if (result.truncated) {
    return {
      path,
      exists: true,
      profile: null,
      createdAt: null,
      configuredNonSecretFields: [],
      credentials: [],
      credential: emptyCredential,
      recognizedProvider: fallbackRecognition,
      diagnostics: [
        ...result.diagnostics,
        {
          level: 'error',
          message: `Startup profile exceeds the ${maxStartupProfileBytes} byte read limit.`,
          path,
        },
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.content);
  } catch {
    return {
      path,
      exists: true,
      profile: null,
      createdAt: null,
      configuredNonSecretFields: [],
      credentials: [],
      credential: emptyCredential,
      recognizedProvider: fallbackRecognition,
      diagnostics: [
        {
          level: 'error',
          message: 'Unable to parse startup profile as JSON.',
          path,
        },
      ],
    };
  }

  if (!isRecord(parsed) || !isSupportedStartupProfile(parsed.profile) || !isRecord(parsed.env) || (
    parsed.createdAt !== undefined && typeof parsed.createdAt !== 'string'
  )) {
    return {
      path,
      exists: true,
      profile: null,
      createdAt: null,
      configuredNonSecretFields: [],
      credentials: [],
      credential: emptyCredential,
      recognizedProvider: fallbackRecognition,
      diagnostics: [
        {
          level: 'error',
          message: 'Startup profile must contain a non-empty profile string, env object, and optional createdAt string.',
          path,
        },
      ],
    };
  }

  const baseUrl = startupBaseUrlFromEnv(parsed.env);
  const recognizedProvider = recognizeStudioProvider({
    provider: parsed.profile,
    baseUrl,
    apiKeySet: hasNonEmptyString(parsed.env.CODEX_API_KEY),
  });
  const credential = summarizeStartupCredentialState(parsed.env, recognizedProvider.credentialEnvVars);
  return {
    path,
    exists: true,
    profile: parsed.profile,
    createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : null,
    configuredNonSecretFields: configuredStartupNonSecretFields(parsed.env),
    credentials: configuredStartupCredentials(parsed.env),
    credential,
    recognizedProvider,
    diagnostics: result.diagnostics,
  };
}

function validateProfile(
  profile: UnknownRecord,
  index: number,
  context: ProfileContext,
  credential: ProviderCredentialState,
): ProviderProfileValidation {
  const issues: ProviderProfileValidationIssue[] = [];
  const id = profileId(profile, index);
  const name = trimmedString(profile.name);
  const provider = trimmedString(profile.provider);
  const baseUrl = trimmedString(profile.baseUrl);
  const model = trimmedString(profile.model);
  const apiFormat = trimmedString(profile.apiFormat);
  const authHeader = trimmedString(profile.authHeader);
  const authScheme = trimmedString(profile.authScheme);
  const templateId = inferProviderTemplateId({ provider, baseUrl });
  const template = templates.find((item) => item.id === templateId);

  if (context.duplicateIds.has(id)) {
    issues.push({
      severity: 'error',
      field: 'id',
      message: 'Provider profile id is duplicated.',
    });
  }
  if (!name) {
    issues.push({
      severity: 'error',
      field: 'name',
      message: 'Provider profile name is required.',
    });
  }
  if (!provider) {
    issues.push({
      severity: 'error',
      field: 'provider',
      message: 'Provider identifier is required.',
    });
  }
  if (!model) {
    issues.push({
      severity: 'error',
      field: 'model',
      message: 'Model is required.',
    });
  }
  if (!baseUrl) {
    issues.push({
      severity: 'error',
      field: 'baseUrl',
      message: 'Base URL is required.',
    });
  } else {
    validateBaseUrl(baseUrl, issues);
  }
  if (apiFormat && apiFormat !== 'responses' && apiFormat !== 'chat_completions') {
    issues.push({
      severity: 'warn',
      field: 'apiFormat',
      message: 'API format is not one of the recognized OpenAI-compatible modes.',
    });
  }
  if (authHeader && !httpTokenPattern.test(authHeader)) {
    issues.push({
      severity: 'warn',
      field: 'authHeader',
      message: 'Auth header name is not a valid HTTP token.',
    });
  }
  if (authScheme && authScheme !== 'bearer' && authScheme !== 'raw') {
    issues.push({
      severity: 'warn',
      field: 'authScheme',
      message: 'Auth scheme is not one of the recognized modes.',
    });
  }
  for (const headerName of customHeaderNames(profile.customHeaders)) {
    if (!httpTokenPattern.test(headerName)) {
      issues.push({
        severity: 'warn',
        field: 'customHeaders',
        message: `Custom header "${headerName}" is not a valid HTTP token.`,
      });
    }
  }
  if (credential.credentialInvalid) {
    issues.push({
      severity: 'warn',
      field: 'credential',
      message: 'Configured credential appears to be invalid or a placeholder.',
    });
  }
  if (
    template?.requiresSecret &&
    !hasNonEmptyString(profile.apiKey) &&
    !hasNonEmptyString(profile.authHeaderValue) &&
    !credential.credentialConfigured
  ) {
    issues.push({
      severity: 'warn',
      field: 'credential',
      message: 'No saved credential is visible in this profile.',
    });
  }

  return {
    status: issues.some((issue) => issue.severity === 'error')
      ? 'error'
      : issues.some((issue) => issue.severity === 'warn')
        ? 'warning'
        : 'valid',
    issues,
  };
}

function validateBaseUrl(baseUrl: string, issues: ProviderProfileValidationIssue[]): void {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      issues.push({
        severity: 'error',
        field: 'baseUrl',
        message: 'Base URL must use http or https.',
      });
      return;
    }
    if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
      issues.push({
        severity: 'warn',
        field: 'baseUrl',
        message: 'HTTP base URLs should be limited to loopback or trusted local networks.',
      });
    }
  } catch {
    issues.push({
      severity: 'error',
      field: 'baseUrl',
      message: 'Base URL must be an absolute URL.',
    });
  }
}

function summarizeProfiles(
  profiles: SafeProviderProfile[],
  startupProfile: StartupProviderProfileSummary,
): ProviderProfilesResponse['summary'] {
  return {
    total: profiles.length,
    active: profiles.filter((profile) => profile.active).length,
    valid: profiles.filter((profile) => profile.validation.status === 'valid').length,
    warnings: profiles.filter((profile) => profile.validation.status === 'warning').length,
    errors: profiles.filter((profile) => profile.validation.status === 'error').length,
    recognized: profiles.filter((profile) => profile.recognizedProvider.id !== 'custom').length,
    startupProfileConfigured: startupProfile.exists && startupProfile.profile !== null,
    templates: templates.length,
  };
}

function templateIdFromProfile(provider: string | null | undefined, recognizedProviderId: string): ProviderTemplateId {
  const providerId = provider?.trim().toLowerCase();
  if (providerId === 'openai' && (
    recognizedProviderId === 'ollama' ||
    recognizedProviderId === 'lmstudio' ||
    recognizedProviderId === 'atomic-chat'
  )) {
    return 'custom-openai';
  }

  switch (recognizedProviderId) {
    case 'anthropic':
      return 'anthropic';
    case 'openai':
      return 'openai';
    case 'gemini':
      return 'gemini';
    case 'zai':
      return 'zai-coding-plan';
    case 'codex':
    case 'codex-oauth':
      return 'codex-oauth';
    case 'ollama':
      return 'ollama';
    case 'mistral':
      return 'mistral';
    default:
      return 'custom-openai';
  }
}

function summarizeCustomHeaders(value: unknown): ProviderCustomHeaderSummary[] {
  if (!isRecord(value)) {
    return [];
  }

  return Object.entries(value)
    .filter(([, headerValue]) => hasNonEmptyString(headerValue))
    .map(([name]) => ({
      name,
      valueSet: true,
      sensitive: isSensitiveHeaderKey(name),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function customHeaderNames(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value) : [];
}

function getProviderProfiles(config: OpenClaudeConfig): UnknownRecord[] {
  return Array.isArray(config.providerProfiles) ? config.providerProfiles.filter(isRecord) : [];
}

function selectActiveProviderIndex(config: OpenClaudeConfig, profiles: UnknownRecord[]): number | null {
  if (profiles.length === 0) {
    return null;
  }

  const activeId = stringFromUnknown(config.activeProviderProfileId);
  if (activeId) {
    const activeIndex = profiles.findIndex((profile, index) => profileId(profile, index) === activeId);
    if (activeIndex !== -1) {
      return activeIndex;
    }
  }

  return 0;
}

function duplicateValues(values: string[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return duplicates;
}

function profileId(profile: UnknownRecord, index: number): string {
  return stringFromUnknown(profile.id) ?? makeFallbackProviderId(profile, index);
}

function makeFallbackProviderId(profile: UnknownRecord, index: number): string {
  const stableInput = [
    stringFromUnknown(profile.name) ?? 'provider',
    stringFromUnknown(profile.provider) ?? 'unknown',
    stringFromUnknown(profile.model) ?? 'default',
    String(index),
  ].join(':');
  return `provider_${createHash('sha256').update(stableInput).digest('hex').slice(0, 12)}`;
}

function trimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function stringFromUnknown(value: unknown): string | null {
  return trimmedString(value);
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function isSensitiveHeaderKey(key: string): boolean {
  return /authorization|token|secret|key|cookie|auth|session|credential/i.test(key);
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function startupProfileReadFailureMessage(error: unknown): string {
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : null;

  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return 'Permission denied.';
    case 'ENOTDIR':
      return 'Startup profile path is unavailable.';
    default:
      return 'Startup profile is unavailable.';
  }
}
