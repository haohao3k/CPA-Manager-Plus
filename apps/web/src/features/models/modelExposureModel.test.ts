import { describe, expect, it } from 'vitest';
import type { CatalogModel, ProviderExposure } from '@/services/api/modelExposure';
import {
  buildExposedList,
  isModelExposed,
  policyAllows,
  setModelExposed,
  suggestAliasFromFamily,
} from './modelExposureModel';

const cursor = (id: string, extra: Partial<CatalogModel> = {}): CatalogModel => ({
  provider: 'cursor',
  prefix: 'cursor',
  id: `cursor-${id}`,
  exposedId: `cursor/${id}`,
  displayName: id,
  ownedBy: 'cursor',
  exposed: true,
  reason: 'mode',
  ...extra,
});

const exposure = (patch: Partial<ProviderExposure>): ProviderExposure => ({
  prefix: 'cursor',
  mode: 'all',
  allow: [],
  deny: [],
  ...patch,
});

describe('exposure rules (must agree with CLIProxyAPI)', () => {
  it('matches allow/deny wildcards case-insensitively against the de-prefixed id, deny last', () => {
    const rules = exposure({ mode: 'allowlist', allow: ['GPT-5.6*'], deny: ['*-fast'] });
    expect(isModelExposed(cursor('gpt-5.6-high'), rules)).toBe(true);
    expect(isModelExposed(cursor('gpt-5.6-fast'), rules)).toBe(false);
    expect(isModelExposed(cursor('xgpt-5.6'), rules)).toBe(false);
    expect(isModelExposed(cursor('gpt-5.6'), exposure({ mode: 'none', allow: ['*'] }))).toBe(false);
  });

  it('a per-model toggle flips only that model, also when a pattern covers it', () => {
    const models = [cursor('a'), cursor('b')];
    const starts = [
      exposure({ mode: 'allowlist' }),
      exposure({ mode: 'allowlist', allow: ['*'] }),
      exposure({ mode: 'all' }),
    ];
    for (const start of starts) {
      for (const target of [false, true]) {
        const first = setModelExposed(start, ['a'], target);
        const before = isModelExposed(models[1], first);
        const next = setModelExposed(first, ['a'], !target);
        expect(isModelExposed(models[0], first)).toBe(target);
        expect(models.map((m) => isModelExposed(m, next))).toEqual([!target, before]);
      }
    }
  });

  it('lists combos unprefixed, aliases under the cursor prefix, hides bare ids when prefixed-only', () => {
    const config = {
      enabled: true,
      listPrefixedOnly: true,
      acceptBareIds: true,
      providers: { cursor: exposure({ prefix: 'cur', deny: ['b'] }) },
    };
    const ids = buildExposedList(
      config,
      [cursor('a'), cursor('b')],
      [{ alias: 'flash', defaultEffort: 'medium', variants: { medium: 'cursor-b' } }],
      ['glm-5.3-flash']
    ).map((entry) => entry.id);
    expect(ids).toEqual(['glm-5.3-flash', 'cur/flash', 'cur/a']);
    const alias = {
      alias: 'flash',
      defaultEffort: 'medium' as const,
      variants: { medium: 'cursor-b' },
    };
    expect(buildExposedList(config, [], [alias], [])[0]).toMatchObject({ unavailable: true });
  });
});

describe('key policy matching', () => {
  it('treats a bare combo name like combo:<name> and keeps model patterns off combos', () => {
    const combo = { id: 'glm-5.3-flash', kind: 'combo' as const };
    const model = { id: 'cursor/glm-5.3-flash', kind: 'model' as const };
    expect(policyAllows(['combo:glm-5.3-flash'], combo)).toBe(true);
    expect(policyAllows(['glm-5.3-flash'], combo)).toBe(true);
    expect(policyAllows(['*'], model)).toBe(true);
    expect(policyAllows(['cursor/*'], combo)).toBe(false);
    expect(policyAllows(['combo:glm-5.3-flash'], model)).toBe(false);
    expect(policyAllows([], model)).toBe(false);
  });
});

describe('cursor alias suggestion', () => {
  it('maps a family to one variant per effort level, defaulting to medium', () => {
    const family = 'cursor-deepseek-v41-flash';
    const models = [
      cursor('deepseek-v41-flash-1017-high', { cursorFamily: family }),
      cursor('deepseek-v41-flash-1017', { cursorFamily: family }),
      cursor('deepseek-v41-flash-1017-low', { cursorFamily: family }),
      cursor('other', { cursorFamily: 'x' }),
    ];
    expect(suggestAliasFromFamily(family, models)).toEqual({
      defaultEffort: 'medium',
      variants: {
        low: 'cursor-deepseek-v41-flash-1017-low',
        medium: 'cursor-deepseek-v41-flash-1017',
        high: 'cursor-deepseek-v41-flash-1017-high',
      },
    });
    const declaredMedium = cursor('deepseek-v41-flash-1017-medium', {
      cursorFamily: family,
      effortLevel: 'medium',
    });
    expect(suggestAliasFromFamily(family, [...models, declaredMedium]).variants.medium).toBe(
      'cursor-deepseek-v41-flash-1017-medium'
    );
  });
});
