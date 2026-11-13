import {
  EFFORT_LEVELS,
  type CatalogModel,
  type CursorModelAlias,
  type EffortLevel,
  type ModelExposureConfig,
  type ProviderExposure,
} from '@/services/api/modelExposure';

const escapeRegExp = (value: string) => value.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/** '*' matches any run of characters; case-insensitive full match (contract with CLIProxyAPI). */
export const matchesPattern = (pattern: string, value: string): boolean => {
  const trimmed = pattern.trim();
  if (!trimmed) return false;
  const source = trimmed.split('*').map(escapeRegExp).join('.*');
  return new RegExp(`^${source}$`, 'i').test(value);
};

export const matchesAny = (patterns: string[], value: string) =>
  patterns.some((pattern) => matchesPattern(pattern, value));

export const providerExposureFor = (
  config: ModelExposureConfig,
  provider: string,
  catalogPrefix?: string
): ProviderExposure =>
  config.providers[provider] ?? {
    prefix: catalogPrefix || provider,
    mode: 'all',
    allow: [],
    deny: [],
  };

/** Native id with the provider's own id prefix stripped (cursor-claude-opus-5 -> claude-opus-5). */
export const deprefixedId = (model: CatalogModel): string => {
  const slash = model.exposedId.indexOf('/');
  return slash >= 0 ? model.exposedId.slice(slash + 1) : model.id;
};

export const exposedIdFor = (model: CatalogModel, exposure: ProviderExposure) =>
  `${exposure.prefix.trim() || model.provider}/${deprefixedId(model)}`;

export const isIdExposed = (id: string, exposure: ProviderExposure): boolean => {
  if (exposure.mode === 'none') return false;
  if (exposure.mode === 'allowlist' && !matchesAny(exposure.allow, id)) return false;
  return !matchesAny(exposure.deny, id);
};

export const isModelExposed = (model: CatalogModel, exposure: ProviderExposure): boolean =>
  isIdExposed(deprefixedId(model), exposure);

/** A deny pattern other than the exact id blocks this id; a toggle cannot expose it. */
export const isBlockedByDenyPattern = (id: string, exposure: ProviderExposure): boolean =>
  exposure.deny.some(
    (pattern) => pattern.toLowerCase() !== id.toLowerCase() && matchesPattern(pattern, id)
  );

export interface ExposedEntry {
  id: string;
  kind: 'model' | 'alias' | 'combo';
  provider?: string;
  /** Alias whose target provider has no registered models (no Cursor credential): CPA does not list it. */
  unavailable?: boolean;
}

/** The /v1/models list the draft config would produce (combos unprefixed, aliases under the cursor prefix). */
export const buildExposedList = (
  config: ModelExposureConfig,
  models: CatalogModel[],
  aliases: CursorModelAlias[],
  combos: string[]
): ExposedEntry[] => {
  const seen = new Set<string>();
  const out: ExposedEntry[] = [];
  const push = (entry: ExposedEntry) => {
    const key = entry.id.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(entry);
  };
  combos.forEach((name) => push({ id: name, kind: 'combo' }));
  const cursorSample = models.find((model) => model.provider === 'cursor');
  const cursorPrefix =
    providerExposureFor(config, 'cursor', cursorSample?.prefix).prefix || 'cursor';
  aliases.forEach((alias) =>
    push({
      id: `${cursorPrefix}/${alias.alias}`,
      kind: 'alias',
      provider: 'cursor',
      ...(cursorSample ? {} : { unavailable: true }),
    })
  );
  models.forEach((model) => {
    if (!config.enabled) {
      push({ id: model.id, kind: 'model', provider: model.provider });
      return;
    }
    const exposure = providerExposureFor(config, model.provider, model.prefix);
    if (!isModelExposed(model, exposure)) return;
    push({ id: exposedIdFor(model, exposure), kind: 'model', provider: model.provider });
    if (!config.listPrefixedOnly) push({ id: model.id, kind: 'model', provider: model.provider });
  });
  return out;
};

/**
 * Flips the given de-prefixed ids by editing exact entries only: hiding removes the id from allow and,
 * if a pattern still exposes it, adds it to deny; exposing removes it from deny and, in allowlist
 * mode, adds it to allow. Ids blocked by a deny pattern stay hidden (the pattern must be edited).
 */
export const setModelExposed = (
  exposure: ProviderExposure,
  ids: string[],
  exposed: boolean
): ProviderExposure => {
  if (exposure.mode === 'none') return exposure;
  const lower = new Set(ids.map((id) => id.toLowerCase()));
  const without = (list: string[]) => list.filter((item) => !lower.has(item.toLowerCase()));
  if (exposed) {
    const next = { ...exposure, deny: without(exposure.deny) };
    const missing = ids.filter((id) => !isIdExposed(id, next) && !isBlockedByDenyPattern(id, next));
    return exposure.mode === 'allowlist' && missing.length
      ? { ...next, allow: [...without(next.allow), ...missing] }
      : next;
  }
  const next = { ...exposure, allow: without(exposure.allow) };
  const stillExposed = ids.filter((id) => isIdExposed(id, next));
  return stillExposed.length ? { ...next, deny: [...without(next.deny), ...stillExposed] } : next;
};

const COMBO_PREFIX = 'combo:';

export const comboAllowEntry = (name: string) => `${COMBO_PREFIX}${name}`;

/** Whether a key-policy allow list admits an exposed id; a bare combo name counts as "combo:<name>". */
export const policyAllows = (allow: string[], entry: ExposedEntry): boolean =>
  allow.some((pattern) => {
    const trimmed = pattern.trim();
    if (entry.kind === 'combo') {
      const name = trimmed.toLowerCase().startsWith(COMBO_PREFIX)
        ? trimmed.slice(COMBO_PREFIX.length)
        : trimmed;
      return matchesPattern(name, entry.id);
    }
    return !trimmed.toLowerCase().startsWith(COMBO_PREFIX) && matchesPattern(trimmed, entry.id);
  });

const EFFORT_SUFFIXES: Array<[RegExp, EffortLevel]> = [
  [/-(xhigh|extra-high)$/i, 'xhigh'],
  [/-max$/i, 'max'],
  [/-high$/i, 'high'],
  [/-medium$/i, 'medium'],
  [/-low$/i, 'low'],
  [/-(none|minimal)$/i, 'none'],
];

const effortOf = (model: CatalogModel): EffortLevel => {
  const declared = model.effortLevel?.toLowerCase();
  if (declared && (EFFORT_LEVELS as readonly string[]).includes(declared)) {
    return declared as EffortLevel;
  }
  const hit = EFFORT_SUFFIXES.find(([pattern]) => pattern.test(model.id));
  return hit ? hit[1] : 'medium';
};

/** Proposes variants for a cursor family: one model per effort level, default = medium when present. */
export const suggestAliasFromFamily = (
  family: string,
  models: CatalogModel[]
): Pick<CursorModelAlias, 'variants' | 'defaultEffort'> => {
  const members = models.filter((model) => model.cursorFamily === family);
  const variants: Partial<Record<EffortLevel, string>> = {};
  // Ids that declare their effort level win over ids whose level is only inferred (the bare base id).
  const declared = (model: CatalogModel) => (model.effortLevel ? 0 : 1);
  members
    .slice()
    .sort((a, b) => declared(a) - declared(b) || a.id.length - b.id.length)
    .forEach((model) => {
      const level = effortOf(model);
      if (!variants[level]) variants[level] = model.id;
    });
  const defined = EFFORT_LEVELS.filter((level) => variants[level]);
  const defaultEffort: EffortLevel = variants.medium ? 'medium' : (defined[0] ?? 'medium');
  return { variants, defaultEffort };
};

export const suggestAliasName = (family: string) => family.replace(/^cursor[-/]/i, '');
