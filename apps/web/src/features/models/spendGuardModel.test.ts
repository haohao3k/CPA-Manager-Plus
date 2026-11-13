import { describe, expect, it } from 'vitest';
import { SPEND_GUARD_DEFAULTS } from '@/services/api/cursorSpendGuard';
import { cursorLimitNotice, parseGoDuration, validateSpendGuardConfig } from './spendGuardModel';

describe('spend guard config validation (backend accepts poll >= 15s)', () => {
  it('parses Go durations and enforces the poll minimum', () => {
    expect(parseGoDuration('1m30s')).toBe(90);
    expect(parseGoDuration('60')).toBeNull();
    expect(validateSpendGuardConfig(SPEND_GUARD_DEFAULTS)).toEqual({});
    expect(
      validateSpendGuardConfig({ ...SPEND_GUARD_DEFAULTS, pollInterval: '14s' })
    ).toHaveProperty('pollInterval');
    expect(validateSpendGuardConfig({ ...SPEND_GUARD_DEFAULTS, pollInterval: '15s' })).toEqual({});
    expect(
      validateSpendGuardConfig({
        ...SPEND_GUARD_DEFAULTS,
        maxOverageUsd: -1,
        unknownGracePolls: 1.5,
      })
    ).toEqual({
      maxOverageUsd: 'spend_guard.error_non_negative',
      unknownGracePolls: 'spend_guard.error_non_negative_int',
    });
  });
});

describe('Cursor account limit notice', () => {
  const limit = (usageBasedAllowed: boolean | null, limitUsd: number | null) => ({
    type: 'team' as const,
    limitUsd,
    pooledUsedUsd: 100,
    usageBasedAllowed,
  });

  it('warns only when Cursor itself would let spend pass the cap', () => {
    expect(cursorLimitNotice(limit(true, null), 20)).toBe('cursor_will_not_stop');
    expect(cursorLimitNotice(limit(true, 50), 20)).toBe('cursor_will_not_stop');
    expect(cursorLimitNotice(limit(true, 10), 20)).toBeNull();
    expect(cursorLimitNotice(limit(false, null), 20)).toBe('cursor_blocks_on_demand');
    expect(cursorLimitNotice(limit(null, null), 20)).toBeNull();
  });
});
