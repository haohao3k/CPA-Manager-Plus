import type {
  CursorSpendGuardConfig,
  SpendGuardAccountLimit,
} from '@/services/api/cursorSpendGuard';

const UNIT_SECONDS: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600 };

/** Seconds in a Go duration string ("60s", "1m30s", "1.5m"); null when malformed. */
export const parseGoDuration = (value: string): number | null => {
  const text = value.trim();
  if (!/^(\d+(\.\d+)?(ms|s|m|h))+$/.test(text)) return null;
  let total = 0;
  for (const [, amount, , unit] of text.matchAll(/(\d+(\.\d+)?)(ms|s|m|h)/g)) {
    total += Number(amount) * UNIT_SECONDS[unit];
  }
  return total;
};

export const MIN_POLL_SECONDS = 15;

export type SpendGuardField =
  | 'maxOverageUsd'
  | 'pollInterval'
  | 'unknownGracePolls'
  | 'defaultRequestReserveUsd';

/** Field -> i18n key of the first problem, mirroring the backend's accepted ranges. */
export const validateSpendGuardConfig = (
  config: CursorSpendGuardConfig
): Partial<Record<SpendGuardField, string>> => {
  const errors: Partial<Record<SpendGuardField, string>> = {};
  if (!Number.isFinite(config.maxOverageUsd) || config.maxOverageUsd < 0) {
    errors.maxOverageUsd = 'spend_guard.error_non_negative';
  }
  const seconds = parseGoDuration(config.pollInterval);
  if (seconds === null) errors.pollInterval = 'spend_guard.error_duration';
  else if (seconds < MIN_POLL_SECONDS) errors.pollInterval = 'spend_guard.error_poll_min';
  if (!Number.isInteger(config.unknownGracePolls) || config.unknownGracePolls < 0) {
    errors.unknownGracePolls = 'spend_guard.error_non_negative_int';
  }
  if (!Number.isFinite(config.defaultRequestReserveUsd) || config.defaultRequestReserveUsd < 0) {
    errors.defaultRequestReserveUsd = 'spend_guard.error_non_negative';
  }
  return errors;
};

export type CursorLimitNotice = 'cursor_will_not_stop' | 'cursor_blocks_on_demand' | null;

/**
 * What Cursor's own account limit means next to the guard's cap:
 * on-demand allowed with no limit (or a limit above the cap) -> only the guard stops spend;
 * on-demand disallowed -> Cursor already blocks it.
 */
export const cursorLimitNotice = (
  limit: SpendGuardAccountLimit,
  capUsd: number | null
): CursorLimitNotice => {
  if (limit.usageBasedAllowed === false) return 'cursor_blocks_on_demand';
  if (limit.usageBasedAllowed === true) {
    if (limit.limitUsd === null || (capUsd !== null && limit.limitUsd > capUsd)) {
      return 'cursor_will_not_stop';
    }
  }
  return null;
};

/** Percent of `used` against `limit`, clamped to 0..100; null when either is unknown. */
export const usedPercent = (used: number | null, limit: number | null): number | null => {
  if (used === null || limit === null || limit <= 0) return null;
  return Math.min(100, Math.max(0, (used / limit) * 100));
};
