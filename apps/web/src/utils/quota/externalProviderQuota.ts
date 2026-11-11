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
export const MISTRAL_SUBSCRIPTION_QUOTA_URL = 'https://api.mistral.ai/v1/billing/subscription';
export const ZAI_QUOTA_LIMIT_URL = 'https://api.z.ai/api/monitor/usage/quota/limit';
export const OPENCODE_GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';
export const CURSOR_PERIOD_USAGE_URL =
  'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage';
export const CURSOR_PLAN_INFO_URL =
  'https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo';
export const CURSOR_AUTH_USAGE_URL = 'https://api2.cursor.sh/auth/usage';

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
  options: { observedAtMs?: number; subscriptionPayload?: unknown } = {}
): ExternalProviderQuotaData | null {
  const root = parseJsonBody(rawPayload);
  if (!root) return null;

  const subRoot = options.subscriptionPayload ? parseJsonBody(options.subscriptionPayload) : null;
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
    const rawInitial = budget.initial_budget ?? budget.initialBudget ?? budget.limit;
    const initialBudget =
      typeof rawInitial === 'number'
        ? rawInitial
        : typeof rawInitial === 'string' && rawInitial.trim()
          ? Number(rawInitial)
          : NaN;
    if (usedPercent === null && reset.resetAtMs === null && !Number.isFinite(initialBudget)) {
      return;
    }

    let amountLabel: string | undefined;
    let usedAmountUsd: number | null = null;
    let limitAmountUsd: number | null = null;
    let remainingAmountUsd: number | null = null;

    if (Number.isFinite(initialBudget) && initialBudget > 0) {
      const pct = usedPercent ?? 0;
      usedAmountUsd = Number(((initialBudget * pct) / 100).toFixed(2));
      limitAmountUsd = Number(initialBudget.toFixed(2));
      remainingAmountUsd = Number(Math.max(0, initialBudget - usedAmountUsd).toFixed(2));
      const rawCurrency =
        typeof budget.currency === 'string' ? budget.currency.trim().toUpperCase() : 'USD';
      const symbol = rawCurrency === 'EUR' ? '€' : '$';
      amountLabel = `${symbol}${usedAmountUsd.toFixed(2)} / ${symbol}${limitAmountUsd.toFixed(2)} (${symbol}${remainingAmountUsd.toFixed(2)} left)`;
    }

    windows.push({
      id,
      label,
      usedPercent: usedPercent ?? (Number.isFinite(initialBudget) ? 0 : null),
      resetAtMs: reset.resetAtMs,
      resetAccuracy: reset.resetAccuracy,
      limitWindowSeconds: 30 * 86400,
      quotaProgressObservedAtMs: usedPercent !== null || Number.isFinite(initialBudget) ? observedAtMs : null,
      amountLabel,
      usedAmountUsd,
      limitAmountUsd,
      remainingAmountUsd,
    });
  };

  addBudgetWindow(root.vibe_budget ?? root.vibeBudget, 'vibe-code-allowance', 'Vibe Code Allowance');
  addBudgetWindow(root.api_budget ?? root.apiBudget, 'api-allowance', 'API Allowance');

  if (windows.length === 0) {
    addBudgetWindow(root, 'monthly-budget', 'Monthly Budget');
  }

  if (windows.length === 0) return null;

  const rawPlan =
    subRoot?.plan_name ??
    subRoot?.planName ??
    subRoot?.tier ??
    root.plan_name ??
    root.planName ??
    root.plan;

  return {
    windows,
    observedAtMs,
    plan: typeof rawPlan === 'string' ? rawPlan.trim() || null : null,
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

export function parseCursorQuotaPayload(
  rawPayload: unknown,
  options: { observedAtMs?: number; planInfoPayload?: unknown; authUsagePayload?: unknown } = {}
): ExternalProviderQuotaData | null {
  const root = parseJsonBody(rawPayload);
  const planRoot = options.planInfoPayload ? parseJsonBody(options.planInfoPayload) : null;
  const authUsageRoot = options.authUsagePayload ? parseJsonBody(options.authUsagePayload) : null;

  const observedAtMs = options.observedAtMs ?? Date.now();
  const windows: ExternalProviderQuotaWindow[] = [];

  const planInfoObj =
    planRoot?.planInfo && typeof planRoot.planInfo === 'object' && !Array.isArray(planRoot.planInfo)
      ? (planRoot.planInfo as Record<string, unknown>)
      : planRoot;

  const cycleStart = parseFlexibleResetAt(
    root?.billingCycleStart ?? planInfoObj?.billingCycleStart
  );
  const cycleEnd = parseFlexibleResetAt(
    root?.billingCycleEnd ?? planInfoObj?.billingCycleEnd ?? authUsageRoot?.startOfMonth
  );
  const limitWindowSeconds =
    cycleStart.resetAtMs && cycleEnd.resetAtMs && cycleEnd.resetAtMs > cycleStart.resetAtMs
      ? Math.round((cycleEnd.resetAtMs - cycleStart.resetAtMs) / 1000)
      : 30 * 86400;

  if (root?.planUsage && typeof root.planUsage === 'object' && !Array.isArray(root.planUsage)) {
    const planUsage = root.planUsage as Record<string, unknown>;
    const includedSpendCents = Number(planUsage.includedSpend ?? planUsage.totalSpend ?? 0);
    const limitCents = Number(planUsage.limit ?? 0);
    const remainingCents = Number(
      planUsage.remaining ?? (limitCents > 0 ? Math.max(0, limitCents - includedSpendCents) : 0)
    );
    const hasLimit = Number.isFinite(limitCents) && limitCents > 0;
    const hasSpend = Number.isFinite(includedSpendCents) && includedSpendCents >= 0;
    const usedPercent = hasLimit
      ? Math.min(100, Math.max(0, (includedSpendCents / limitCents) * 100))
      : parseClampedPercent(planUsage.totalPercentUsed ?? planUsage.autoPercentUsed);

    const usedAmountUsd = hasSpend ? Number((includedSpendCents / 100).toFixed(2)) : null;
    const limitAmountUsd = hasLimit ? Number((limitCents / 100).toFixed(2)) : null;
    const remainingAmountUsd =
      hasLimit && Number.isFinite(remainingCents)
        ? Number(Math.max(0, remainingCents / 100).toFixed(2))
        : null;
    const amountLabel =
      usedAmountUsd !== null && limitAmountUsd !== null && remainingAmountUsd !== null
        ? `$${usedAmountUsd.toFixed(2)} / $${limitAmountUsd.toFixed(2)} ($${remainingAmountUsd.toFixed(2)} left)`
        : usedAmountUsd !== null
          ? `$${usedAmountUsd.toFixed(2)} used`
          : undefined;

    if (usedPercent !== null || amountLabel) {
      windows.push({
        id: 'included-usage',
        label: 'Included Usage',
        usedPercent,
        resetAtMs: cycleEnd.resetAtMs,
        resetAccuracy: cycleEnd.resetAccuracy,
        limitWindowSeconds,
        quotaProgressObservedAtMs: observedAtMs,
        amountLabel,
        usedAmountUsd,
        limitAmountUsd,
        remainingAmountUsd,
      });
    }
  }

  if (
    root?.spendLimitUsage &&
    typeof root.spendLimitUsage === 'object' &&
    !Array.isArray(root.spendLimitUsage)
  ) {
    const spendLimit = root.spendLimitUsage as Record<string, unknown>;
    const limitCents = Number(
      spendLimit.pooledLimit ?? spendLimit.individualLimit ?? spendLimit.limit ?? 0
    );
    const usedCents = Number(spendLimit.pooledUsed ?? spendLimit.totalSpend ?? 0);
    const remainingCents = Number(
      spendLimit.pooledRemaining ?? (limitCents > 0 ? Math.max(0, limitCents - usedCents) : 0)
    );
    const hasLimit = Number.isFinite(limitCents) && limitCents > 0;
    const hasSpend = Number.isFinite(usedCents) && usedCents > 0;

    if (hasLimit || hasSpend) {
      const usedAmountUsd = Number((Math.max(0, usedCents) / 100).toFixed(2));
      const limitAmountUsd = hasLimit ? Number((limitCents / 100).toFixed(2)) : null;
      const remainingAmountUsd =
        hasLimit && Number.isFinite(remainingCents)
          ? Number(Math.max(0, remainingCents / 100).toFixed(2))
          : null;
      const usedPercent = hasLimit
        ? Math.min(100, Math.max(0, (usedCents / limitCents) * 100))
        : null;
      const limitType =
        typeof spendLimit.limitType === 'string' ? spendLimit.limitType.trim().toLowerCase() : '';
      const label = limitType === 'team' ? 'Team Spend Limit' : 'Spend Limit';
      const amountLabel =
        limitAmountUsd !== null && remainingAmountUsd !== null
          ? `$${usedAmountUsd.toFixed(2)} / $${limitAmountUsd.toFixed(2)} ($${remainingAmountUsd.toFixed(2)} left)`
          : `$${usedAmountUsd.toFixed(2)} used`;

      windows.push({
        id: 'spend-limit',
        label,
        usedPercent,
        resetAtMs: cycleEnd.resetAtMs,
        resetAccuracy: cycleEnd.resetAccuracy,
        limitWindowSeconds,
        quotaProgressObservedAtMs: usedPercent !== null ? observedAtMs : null,
        amountLabel,
        usedAmountUsd,
        limitAmountUsd,
        remainingAmountUsd,
      });
    }
  }

  if (windows.length === 0 && authUsageRoot) {
    Object.entries(authUsageRoot).forEach(([modelKey, val]) => {
      if (!val || typeof val !== 'object' || Array.isArray(val)) return;
      const bucket = val as Record<string, unknown>;
      const used = Number(bucket.numRequests ?? 0);
      const max = Number(bucket.maxRequestUsage ?? 0);
      if (!Number.isFinite(max) || max <= 0) return;
      const usedPercent = Math.min(100, Math.max(0, (used / max) * 100));
      windows.push({
        id: `requests-${modelKey}`,
        label: `${modelKey} Requests`,
        usedPercent,
        resetAtMs: cycleEnd.resetAtMs,
        resetAccuracy: cycleEnd.resetAccuracy,
        limitWindowSeconds,
        quotaProgressObservedAtMs: observedAtMs,
        amountLabel: `${used} / ${max} reqs`,
      });
    });
  }

  if (windows.length === 0) return null;

  const rawPlan =
    planInfoObj?.planName ??
    planInfoObj?.plan_name ??
    root?.planName ??
    root?.plan;

  return {
    windows,
    observedAtMs,
    plan: typeof rawPlan === 'string' ? rawPlan.trim() || null : null,
    quotaInventoryObserved: true,
  };
}

export const fetchMistralQuota = async (
  file: AuthFileItem,
  t: TFunction,
  requestScope?: ApiClientRequestScope
): Promise<ExternalProviderQuotaData> => {
  const rawAuthIndex = file['auth_index'] ?? file.authIndex;
  const authIndex = normalizeAuthIndex(rawAuthIndex);
  if (!authIndex) {
    throw new Error(t('common.quota_missing_identity', { defaultValue: 'Missing credential auth_index' }));
  }

  const reqConfig = requestScope ? createScopedApiRequestConfig(requestScope) : undefined;
  const [budgetRes, subRes] = await Promise.all([
    apiCallApi.request(
      {
        authIndex,
        method: 'GET',
        url: MISTRAL_BUDGET_QUOTA_URL,
        header: {
          Authorization: 'Bearer $TOKEN$',
          Accept: 'application/json',
        },
      },
      reqConfig
    ),
    apiCallApi
      .request(
        {
          authIndex,
          method: 'GET',
          url: MISTRAL_SUBSCRIPTION_QUOTA_URL,
          header: {
            Authorization: 'Bearer $TOKEN$',
            Accept: 'application/json',
          },
        },
        reqConfig
      )
      .catch(() => null),
  ]);

  if (budgetRes.statusCode < 200 || budgetRes.statusCode >= 300) {
    throw createStatusError(getApiCallErrorMessage(budgetRes), budgetRes.statusCode);
  }

  const quotaData = parseMistralQuotaPayload(budgetRes.body ?? budgetRes.bodyText, {
    observedAtMs: Date.now(),
    subscriptionPayload:
      subRes && subRes.statusCode >= 200 && subRes.statusCode < 300
        ? (subRes.body ?? subRes.bodyText)
        : undefined,
  });
  if (!quotaData) {
    throw new Error(t('common.quota_empty_data', { defaultValue: 'No quota data returned by upstream' }));
  }
  return quotaData;
};

export const fetchCursorQuota = async (
  file: AuthFileItem,
  t: TFunction,
  requestScope?: ApiClientRequestScope
): Promise<ExternalProviderQuotaData> => {
  const rawAuthIndex = file['auth_index'] ?? file.authIndex;
  const authIndex = normalizeAuthIndex(rawAuthIndex);
  if (!authIndex) {
    throw new Error(t('common.quota_missing_identity', { defaultValue: 'Missing credential auth_index' }));
  }

  const reqConfig = requestScope ? createScopedApiRequestConfig(requestScope) : undefined;
  const connectHeaders = {
    Authorization: 'Bearer $TOKEN$',
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'Connect-Protocol-Version': '1',
  };

  const [periodRes, planRes, authUsageRes] = await Promise.all([
    apiCallApi.request(
      {
        authIndex,
        method: 'POST',
        url: CURSOR_PERIOD_USAGE_URL,
        header: connectHeaders,
        data: '{}',
      },
      reqConfig
    ),
    apiCallApi
      .request(
        {
          authIndex,
          method: 'POST',
          url: CURSOR_PLAN_INFO_URL,
          header: connectHeaders,
          data: '{}',
        },
        reqConfig
      )
      .catch(() => null),
    apiCallApi
      .request(
        {
          authIndex,
          method: 'GET',
          url: CURSOR_AUTH_USAGE_URL,
          header: {
            Authorization: 'Bearer $TOKEN$',
            Accept: 'application/json',
          },
        },
        reqConfig
      )
      .catch(() => null),
  ]);

  const periodOk = periodRes.statusCode >= 200 && periodRes.statusCode < 300;
  const authUsageOk =
    authUsageRes !== null && authUsageRes.statusCode >= 200 && authUsageRes.statusCode < 300;

  if (!periodOk && !authUsageOk) {
    throw createStatusError(getApiCallErrorMessage(periodRes), periodRes.statusCode);
  }

  const quotaData = parseCursorQuotaPayload(
    periodOk ? (periodRes.body ?? periodRes.bodyText) : null,
    {
      observedAtMs: Date.now(),
      planInfoPayload:
        planRes && planRes.statusCode >= 200 && planRes.statusCode < 300
          ? (planRes.body ?? planRes.bodyText)
          : undefined,
      authUsagePayload: authUsageOk ? (authUsageRes.body ?? authUsageRes.bodyText) : undefined,
    }
  );
  if (!quotaData) {
    throw new Error(t('common.quota_empty_data', { defaultValue: 'No quota data returned by upstream' }));
  }
  return quotaData;
};

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
