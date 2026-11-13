import { apiClient } from './client';

export interface CursorSpendGuardConfig {
  enabled: boolean;
  maxOverageUsd: number;
  pollInterval: string;
  failClosedWhenUnknown: boolean;
  unknownGracePolls: number;
  defaultRequestReserveUsd: number;
}

export type SpendGuardReasonCode = 'cap_reached' | 'estimate_reached' | 'usage_unknown' | string;

export interface SpendGuardAccountLimit {
  type: 'team' | 'individual' | 'unknown';
  limitUsd: number | null;
  pooledUsedUsd: number | null;
  usageBasedAllowed: boolean | null;
}

export interface SpendGuardCredentialStatus {
  authIndex: string;
  label: string;
  blocked: boolean;
  reason: { code: SpendGuardReasonCode; message: string } | null;
  checkedAt: string;
  periodStart: string;
  periodEnd: string;
  includedUsedUsd: number | null;
  includedLimitUsd: number | null;
  includedRemainingUsd: number | null;
  includedExhausted: boolean;
  overageUsd: number | null;
  estimateUsd: number | null;
  capUsd: number | null;
  accountLimit: SpendGuardAccountLimit;
  consecutiveFailures: number;
  lastError: string | null;
}

export interface SpendGuardStatus {
  enabled: boolean;
  capUsd: number | null;
  pollInterval: string;
  credentials: SpendGuardCredentialStatus[];
}

export const SPEND_GUARD_DEFAULTS: CursorSpendGuardConfig = {
  enabled: false,
  maxOverageUsd: 20,
  pollInterval: '60s',
  failClosedWhenUnknown: true,
  unknownGracePolls: 3,
  defaultRequestReserveUsd: 0.5,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

export const normalizeSpendGuardConfig = (data: unknown): CursorSpendGuardConfig => {
  const raw =
    isRecord(data) && isRecord(data['cursor-spend-guard']) ? data['cursor-spend-guard'] : data;
  const record = isRecord(raw) ? raw : {};
  const d = SPEND_GUARD_DEFAULTS;
  return {
    enabled: bool(record.enabled, d.enabled),
    maxOverageUsd: num(record['max-overage-usd']) ?? d.maxOverageUsd,
    pollInterval: str(record['poll-interval']) || d.pollInterval,
    failClosedWhenUnknown: bool(record['fail-closed-when-unknown'], d.failClosedWhenUnknown),
    unknownGracePolls: num(record['unknown-grace-polls']) ?? d.unknownGracePolls,
    defaultRequestReserveUsd:
      num(record['default-request-reserve-usd']) ?? d.defaultRequestReserveUsd,
  };
};

const serializeSpendGuardConfig = (config: CursorSpendGuardConfig) => ({
  'cursor-spend-guard': {
    enabled: config.enabled,
    'max-overage-usd': config.maxOverageUsd,
    'poll-interval': config.pollInterval.trim(),
    'fail-closed-when-unknown': config.failClosedWhenUnknown,
    'unknown-grace-polls': config.unknownGracePolls,
    'default-request-reserve-usd': config.defaultRequestReserveUsd,
  },
});

const normalizeAccountLimit = (raw: unknown): SpendGuardAccountLimit => {
  const record = isRecord(raw) ? raw : {};
  const type = record.type === 'team' || record.type === 'individual' ? record.type : 'unknown';
  return {
    type,
    limitUsd: num(record.limit_usd),
    pooledUsedUsd: num(record.pooled_used_usd),
    usageBasedAllowed:
      typeof record.usage_based_allowed === 'boolean' ? record.usage_based_allowed : null,
  };
};

const normalizeCredential = (raw: unknown): SpendGuardCredentialStatus | null => {
  if (!isRecord(raw)) return null;
  const authIndex = str(raw.auth_index) || String(raw.auth_index ?? '');
  if (!authIndex) return null;
  const reason = isRecord(raw.reason)
    ? { code: str(raw.reason.code), message: str(raw.reason.message) }
    : null;
  return {
    authIndex,
    label: str(raw.label) || authIndex,
    blocked: raw.blocked === true,
    reason,
    checkedAt: str(raw.checked_at),
    periodStart: str(raw.period_start),
    periodEnd: str(raw.period_end),
    includedUsedUsd: num(raw.included_used_usd),
    includedLimitUsd: num(raw.included_limit_usd),
    includedRemainingUsd: num(raw.included_remaining_usd),
    includedExhausted: raw.included_exhausted === true,
    overageUsd: num(raw.overage_usd),
    estimateUsd: num(raw.estimate_usd),
    capUsd: num(raw.cap_usd),
    accountLimit: normalizeAccountLimit(raw.account_limit),
    consecutiveFailures: num(raw.consecutive_failures) ?? 0,
    lastError: str(raw.last_error) || null,
  };
};

export const normalizeSpendGuardStatus = (data: unknown): SpendGuardStatus => {
  const record = isRecord(data) ? data : {};
  const credentials = Array.isArray(record.credentials) ? record.credentials : [];
  return {
    enabled: record.enabled === true,
    capUsd: num(record.cap_usd),
    pollInterval: str(record.poll_interval),
    credentials: credentials
      .map(normalizeCredential)
      .filter((item): item is SpendGuardCredentialStatus => item !== null),
  };
};

export const cursorSpendGuardApi = {
  async getConfig(): Promise<CursorSpendGuardConfig> {
    return normalizeSpendGuardConfig(await apiClient.get('/cursor-spend-guard'));
  },
  async saveConfig(config: CursorSpendGuardConfig): Promise<void> {
    await apiClient.put('/cursor-spend-guard', serializeSpendGuardConfig(config));
  },
  async getStatus(): Promise<SpendGuardStatus> {
    return normalizeSpendGuardStatus(await apiClient.get('/cursor-spend-guard/status'));
  },
  async recheck(): Promise<SpendGuardStatus> {
    return normalizeSpendGuardStatus(await apiClient.post('/cursor-spend-guard/recheck'));
  },
};
