import { apiClient } from './client';

export type ExposureMode = 'all' | 'allowlist' | 'none';

export interface ProviderExposure {
  prefix: string;
  mode: ExposureMode;
  allow: string[];
  deny: string[];
}

export interface ModelExposureConfig {
  enabled: boolean;
  listPrefixedOnly: boolean;
  acceptBareIds: boolean;
  providers: Record<string, ProviderExposure>;
}

export interface CatalogModel {
  provider: string;
  prefix: string;
  id: string;
  exposedId: string;
  displayName: string;
  ownedBy: string;
  exposed: boolean;
  reason: string;
  cursorFamily?: string;
  effortLevel?: string;
}

export const EFFORT_LEVELS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export interface CursorModelAlias {
  alias: string;
  defaultEffort: EffortLevel;
  variants: Partial<Record<EffortLevel, string>>;
}

export interface ModelCatalog {
  models: CatalogModel[];
  combos: string[];
  aliases: CursorModelAlias[];
}

export interface ApiKeyPolicy {
  key: string;
  restricted: boolean;
  allow: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const pick = (record: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
};

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const strList = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((item) => str(item)).filter(Boolean) : [];

const unwrap = (data: unknown, ...keys: string[]): unknown => {
  if (!isRecord(data)) return data;
  const inner = pick(data, ...keys);
  return inner === undefined ? data : inner;
};

const normalizeMode = (value: unknown): ExposureMode =>
  value === 'allowlist' || value === 'none' ? value : 'all';

export const normalizeProviderExposure = (raw: unknown, key: string): ProviderExposure => {
  const record = isRecord(raw) ? raw : {};
  return {
    prefix: str(record.prefix) || key,
    mode: normalizeMode(record.mode),
    allow: strList(record.allow),
    deny: strList(record.deny),
  };
};

export const normalizeModelExposure = (data: unknown): ModelExposureConfig => {
  const raw = unwrap(data, 'model-exposure', 'modelExposure');
  const record = isRecord(raw) ? raw : {};
  const providersRaw = pick(record, 'providers');
  const providers: Record<string, ProviderExposure> = {};
  if (isRecord(providersRaw)) {
    for (const [key, value] of Object.entries(providersRaw)) {
      const name = key.trim();
      if (name) providers[name] = normalizeProviderExposure(value, name);
    }
  }
  return {
    enabled: pick(record, 'enabled') === true,
    listPrefixedOnly: pick(record, 'list-prefixed-only', 'listPrefixedOnly') === true,
    acceptBareIds: pick(record, 'accept-bare-ids', 'acceptBareIds') !== false,
    providers,
  };
};

export const serializeModelExposure = (config: ModelExposureConfig) => ({
  enabled: config.enabled,
  'list-prefixed-only': config.listPrefixedOnly,
  'accept-bare-ids': config.acceptBareIds,
  providers: Object.fromEntries(
    Object.entries(config.providers).map(([key, value]) => [
      key,
      {
        prefix: value.prefix.trim() || key,
        mode: value.mode,
        allow: value.allow,
        deny: value.deny,
      },
    ])
  ),
});

const normalizeEffort = (value: unknown, fallback: EffortLevel): EffortLevel => {
  const level = str(value).toLowerCase();
  return (EFFORT_LEVELS as readonly string[]).includes(level) ? (level as EffortLevel) : fallback;
};

export const normalizeCursorAlias = (raw: unknown): CursorModelAlias | null => {
  if (!isRecord(raw)) return null;
  const alias = str(raw.alias);
  if (!alias) return null;
  const variants: Partial<Record<EffortLevel, string>> = {};
  const variantsRaw = raw.variants;
  if (isRecord(variantsRaw)) {
    for (const [level, target] of Object.entries(variantsRaw)) {
      const effort = normalizeEffort(level, 'medium');
      const id = str(target);
      if (id && effort === level.trim().toLowerCase()) variants[effort] = id;
    }
  }
  return {
    alias,
    defaultEffort: normalizeEffort(pick(raw, 'default-effort', 'defaultEffort'), 'medium'),
    variants,
  };
};

const normalizeAliasList = (data: unknown): CursorModelAlias[] => {
  const raw = unwrap(data, 'cursor-model-aliases', 'cursorModelAliases', 'aliases', 'items');
  return Array.isArray(raw)
    ? (raw.map(normalizeCursorAlias).filter(Boolean) as CursorModelAlias[])
    : [];
};

export const serializeCursorAlias = (alias: CursorModelAlias) => ({
  alias: alias.alias.trim(),
  'default-effort': alias.defaultEffort,
  variants: Object.fromEntries(
    EFFORT_LEVELS.filter((level) => alias.variants[level]).map((level) => [
      level,
      alias.variants[level],
    ])
  ),
});

const normalizeCatalogModel = (raw: unknown): CatalogModel | null => {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  const provider = str(raw.provider);
  if (!id || !provider) return null;
  const prefix = str(raw.prefix) || provider;
  const cursorFamily = str(pick(raw, 'cursor_family', 'cursor-family', 'cursorFamily'));
  const effortLevel = str(pick(raw, 'effort_level', 'effort-level', 'effortLevel'));
  return {
    provider,
    prefix,
    id,
    exposedId: str(pick(raw, 'exposed_id', 'exposed-id', 'exposedId')) || `${prefix}/${id}`,
    displayName: str(pick(raw, 'display_name', 'display-name', 'displayName')),
    ownedBy: str(pick(raw, 'owned_by', 'owned-by', 'ownedBy')),
    exposed: raw.exposed === true,
    reason: str(raw.reason),
    ...(cursorFamily ? { cursorFamily } : {}),
    ...(effortLevel ? { effortLevel } : {}),
  };
};

export const normalizeCatalog = (data: unknown): ModelCatalog => {
  const record = isRecord(data) ? data : {};
  const modelsRaw = Array.isArray(data) ? data : pick(record, 'models', 'items', 'catalog');
  const combosRaw = pick(record, 'combos');
  return {
    models: Array.isArray(modelsRaw)
      ? (modelsRaw.map(normalizeCatalogModel).filter(Boolean) as CatalogModel[])
      : [],
    combos: Array.isArray(combosRaw)
      ? combosRaw.map((item) => (isRecord(item) ? str(item.name) : str(item))).filter(Boolean)
      : [],
    aliases: normalizeAliasList(
      pick(
        record,
        'cursor-model-aliases',
        'cursor_model_aliases',
        'cursorModelAliases',
        'aliases'
      ) ?? []
    ),
  };
};

const normalizePolicy = (raw: unknown): ApiKeyPolicy | null => {
  if (!isRecord(raw)) return null;
  const key = str(raw.key);
  if (!key) return null;
  return { key, restricted: raw.restricted === true, allow: strList(raw.allow) };
};

export const normalizePolicies = (data: unknown): ApiKeyPolicy[] => {
  const raw = unwrap(data, 'key-policies', 'keyPolicies', 'api-key-policies', 'policies', 'items');
  return Array.isArray(raw) ? (raw.map(normalizePolicy).filter(Boolean) as ApiKeyPolicy[]) : [];
};

const serializePolicy = (policy: ApiKeyPolicy) => ({
  key: policy.key,
  restricted: policy.restricted,
  allow: policy.allow,
});

export const modelExposureApi = {
  async getExposure(): Promise<ModelExposureConfig> {
    return normalizeModelExposure(await apiClient.get('/model-exposure'));
  },
  async saveExposure(config: ModelExposureConfig): Promise<void> {
    await apiClient.put('/model-exposure', { 'model-exposure': serializeModelExposure(config) });
  },
  async getCatalog(): Promise<ModelCatalog> {
    return normalizeCatalog(await apiClient.get('/model-exposure/catalog'));
  },
  async getCursorAliases(): Promise<CursorModelAlias[]> {
    return normalizeAliasList(await apiClient.get('/cursor-model-aliases'));
  },
  async saveCursorAliases(aliases: CursorModelAlias[]): Promise<void> {
    await apiClient.put('/cursor-model-aliases', {
      'cursor-model-aliases': aliases.map(serializeCursorAlias),
    });
  },
  async getKeyPolicies(): Promise<ApiKeyPolicy[]> {
    return normalizePolicies(await apiClient.get('/api-key-policies'));
  },
  async saveKeyPolicies(policies: ApiKeyPolicy[]): Promise<void> {
    await apiClient.put('/api-key-policies', { 'key-policies': policies.map(serializePolicy) });
  },
};
