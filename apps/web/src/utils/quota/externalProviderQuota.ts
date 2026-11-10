/**
 * Pure parsers and request handlers for Mistral, Z.ai GLM Coding, and OpenCode Go quotas.
 */

import type { TFunction } from 'i18next';
import type {
  AuthFileItem,
  ExternalProviderQuotaData,
  ExternalProviderQuotaWindow,
  QuotaResetAccuracy,
} from '@/types';
import { apiCallApi, getApiCallErrorMessage } from '@/services/api/apiCall';
import { createScopedApiRequestConfig, type ApiClientRequestScope } from '@/services/api/client';
import { normalizeAuthIndex } from './parsers';
import { createStatusError } from './formatters';

export const MISTRAL_BUDGET_QUOTA_URL = 'https://api.mistral.ai/v1/billing/budget';
export const ZAI_QUOTA_LIMIT_URL = 'https://api.z.ai/api/monitor/usage/quota/limit';
export const OPENCODE_GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';

const parseClampedPercent = (value: unknown): number | null => {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  let num: number;
  if (typeof value === 'number') {
    num = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || !/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
    num = Number(trimmed);
  } else {
    return null;
  }
  if (!Number.isFinite(num)) return null;
  return Math.min(100, Math.max(0, num));
};

const parseFlexibleResetAt = (
  value: unknown
): { resetAtMs: number | null; resetAccuracy: QuotaResetAccuracy } => {
  if (value === null || value === undefined || typeof value === 'boolean') {
    return { resetAtMs: null, resetAccuracy: 'unknown' };
  }

  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const ms = value > 1e11 ? value : value * 1000;
    return { resetAtMs: Math.round(ms), resetAccuracy: 'exact' };
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return { resetAtMs: null, resetAccuracy: 'unknown' };
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (Number.isFinite(numeric) && numeric > 0) {
        const ms = numeric > 1e11 ? numeric : numeric * 1000;
        return { resetAtMs: Math.round(ms), resetAccuracy: 'exact' };
      }
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed) && parsed > 0) {
      return { resetAtMs: parsed, resetAccuracy: 'exact' };
    }
  }

  return { resetAtMs: null, resetAccuracy: 'unknown' };
};

const parseJsonBody = (rawPayload: unknown): Record<string, unknown> | null => {
  let body = rawPayload;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return null;
    }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null;
  }
  return body as Record<string, unknown>;
};

export function parseMistralQuotaPayload(
  rawPayload: unknown,
  options: { observedAtMs?: number } = {}
): ExternalProviderQuotaData | null {
  const root = parseJsonBody(rawPayload);
  if (!root) return null;

  const observedAtMs = options.observedAtMs ?? Date.now();
  const windows: ExternalProviderQuotaWindow[] = [];

  const addBudgetWindow = (
    rawBudget: unknown,
    id: string,
    label: string
  ) => {
    if (!rawBudget || typeof rawBudget !== 'object' || Array.isArray(rawBudget)) return;
    const budget = rawBudget as Record<string, unknown>;
    const usedPercent = parseClampedPercent(
      budget.usage_percentage ?? budget.usagePercentage ?? budget.used_percent ?? budget.usedPercent
    );
    const reset = parseFlexibleResetAt(budget.reset_at ?? budget.resetAt ?? budget.resets_at);
    if (usedPercent === null && reset.resetAtMs === null && budget.initial_budget === undefined) {
      return;
    }
    windows.push({
      id,
      label,
      usedPercent,
      resetAtMs: reset.resetAtMs,
      resetAccuracy: reset.resetAccuracy,
      limitWindowSeconds: 30 * 86400,
      quotaProgressObservedAtMs: usedPercent !== null ? observedAtMs : null,
    });
  };

  addBudgetWindow(root.vibe_budget ?? root.vibeBudget, 'vibe-code-allowance', 'Vibe Code Allowance');
  addBudgetWindow(root.api_budget ?? root.apiBudget, 'api-allowance', 'API Allowance');

  if (windows.length === 0) return null;

  return {
    windows,
    observedAtMs,
    plan: typeof root.plan === 'string' ? root.plan.trim() || null : null,
    quotaInventoryObserved: true,
  };
}

export function parseZaiQuotaPayload(
  rawPayload: unknown,
  options: { observedAtMs?: number } = {}
): ExternalProviderQuotaData | null {
  const root = parseJsonBody(rawPayload);
  if (!root) return null;

  const observedAtMs = options.observedAtMs ?? Date.now();
  const dataObj =
    root.data && typeof root.data === 'object' && !Array.isArray(root.data)
      ? (root.data as Record<string, unknown>)
      : root;
  const rawLimits = Array.isArray(dataObj.limits)
    ? dataObj.limits
    : Array.isArray(root.limits)
      ? root.limits
      : null;

  if (!rawLimits || rawLimits.length === 0) return null;

  const windows: ExternalProviderQuotaWindow[] = [];
  rawLimits.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
    const limit = entry as Record<string, unknown>;
    const limitType = typeof limit.type === 'string' ? limit.type.trim().toUpperCase() : '';
    if (limitType && limitType !== 'TOKENS_LIMIT' && limitType !== 'CREDIT_LIMIT') {
      return;
    }
    const usedPercent = parseClampedPercent(
      limit.percentage ?? limit.used_percent ?? limit.usedPercent
    );
    const reset = parseFlexibleResetAt(
      limit.nextResetTime ?? limit.next_reset_time ?? limit.reset_at ?? limit.resetAt
    );
    const unit = Number(limit.unit);
    const num = Number(limit.number) || 5;

    let id = `zai-limit-${index + 1}`;
    let label = limitType === 'CREDIT_LIMIT' ? 'Credit Limit' : 'Quota Limit';
    let limitWindowSeconds: number | null = null;

    if (unit === 3) {
      id = `session-${num}h`;
      label = `Session (${num}h)`;
      limitWindowSeconds = num * 3600;
    } else if (unit === 6) {
      id = 'weekly-7d';
      label = 'Weekly (7d)';
      limitWindowSeconds = 7 * 86400;
    }

    windows.push({
      id,
      label,
      usedPercent,
      resetAtMs: reset.resetAtMs,
      resetAccuracy: reset.resetAccuracy,
      limitWindowSeconds,
      quotaProgressObservedAtMs: usedPercent !== null ? observedAtMs : null,
    });
  });

  if (windows.length === 0) return null;

  return {
    windows,
    observedAtMs,
    plan: null,
    quotaInventoryObserved: true,
  };
}

export function parseOpencodeQuotaPayload(
  rawPayload: unknown,
  options: { observedAtMs?: number } = {}
): ExternalProviderQuotaData | null {
  const root = parseJsonBody(rawPayload);
  if (!root) return null;

  const observedAtMs = options.observedAtMs ?? Date.now();
  const usageObj =
    root.usage && typeof root.usage === 'object' && !Array.isArray(root.usage)
      ? (root.usage as Record<string, unknown>)
      : root;

  const windows: ExternalProviderQuotaWindow[] = [];
  const addUsageWindow = (
    rawWin: unknown,
    id: string,
    label: string,
    limitWindowSeconds: number
  ) => {
    if (!rawWin || typeof rawWin !== 'object' || Array.isArray(rawWin)) return;
    const win = rawWin as Record<string, unknown>;
    const usedPercent = parseClampedPercent(
      win.percent ?? win.used_percent ?? win.usedPercent ?? win.usage_percentage
    );
    const reset = parseFlexibleResetAt(
      win.resetsAt ?? win.resets_at ?? win.resetAt ?? win.reset_at
    );
    if (usedPercent === null && reset.resetAtMs === null) return;
    windows.push({
      id,
      label,
      usedPercent,
      resetAtMs: reset.resetAtMs,
      resetAccuracy: reset.resetAccuracy,
      limitWindowSeconds,
      quotaProgressObservedAtMs: usedPercent !== null ? observedAtMs : null,
    });
  };

  addUsageWindow(usageObj.rolling, 'rolling-5h', 'Rolling (5h)', 5 * 3600);
  addUsageWindow(usageObj.weekly, 'weekly', 'Weekly', 7 * 86400);
  addUsageWindow(usageObj.monthly, 'monthly', 'Monthly', 30 * 86400);

  if (windows.length === 0) return null;

  return {
    windows,
    observedAtMs,
    plan: typeof root.plan === 'string' ? root.plan.trim() || null : null,
    quotaInventoryObserved: true,
  };
}

const requestExternalProviderQuota = async (
  file: AuthFileItem,
  url: string,
  parser: (rawPayload: unknown, options: { observedAtMs?: number }) => ExternalProviderQuotaData | null,
  t: TFunction,
  requestScope?: ApiClientRequestScope
): Promise<ExternalProviderQuotaData> => {
  const rawAuthIndex = file['auth_index'] ?? file.authIndex;
  const authIndex = normalizeAuthIndex(rawAuthIndex);
  if (!authIndex) {
    throw new Error(t('common.quota_missing_identity', { defaultValue: 'Missing credential auth_index' }));
  }

  const result = await apiCallApi.request(
    {
      authIndex,
      method: 'GET',
      url,
      header: {
        Authorization: 'Bearer $TOKEN$',
        Accept: 'application/json',
      },
    },
    requestScope ? createScopedApiRequestConfig(requestScope) : undefined
  );

  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw createStatusError(getApiCallErrorMessage(result), result.statusCode);
  }

  const quotaData = parser(result.body ?? result.bodyText, {
    observedAtMs: Date.now(),
  });
  if (!quotaData) {
    throw new Error(t('common.quota_empty_data', { defaultValue: 'No quota data returned by upstream' }));
  }
  return quotaData;
};

export const fetchMistralQuota = (
  file: AuthFileItem,
  t: TFunction,
  requestScope?: ApiClientRequestScope
): Promise<ExternalProviderQuotaData> =>
  requestExternalProviderQuota(
    file,
    MISTRAL_BUDGET_QUOTA_URL,
    parseMistralQuotaPayload,
    t,
    requestScope
  );

export const fetchZaiQuota = (
  file: AuthFileItem,
  t: TFunction,
  requestScope?: ApiClientRequestScope
): Promise<ExternalProviderQuotaData> =>
  requestExternalProviderQuota(
    file,
    ZAI_QUOTA_LIMIT_URL,
    parseZaiQuotaPayload,
    t,
    requestScope
  );

export const fetchOpencodeQuota = (
  file: AuthFileItem,
  t: TFunction,
  requestScope?: ApiClientRequestScope
): Promise<ExternalProviderQuotaData> =>
  requestExternalProviderQuota(
    file,
    OPENCODE_GO_USAGE_URL,
    parseOpencodeQuotaPayload,
    t,
    requestScope
  );
