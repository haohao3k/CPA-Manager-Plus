import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  cursorSpendGuardApi,
  type CursorSpendGuardConfig,
  type SpendGuardCredentialStatus,
  type SpendGuardStatus,
} from '@/services/api/cursorSpendGuard';
import { useNotificationStore } from '@/stores';
import { formatDateTime } from '@/utils/format';
import { getErrorMessage } from '@/utils/helpers';
import { formatUsd } from '@/utils/usage';
import {
  MIN_POLL_SECONDS,
  cursorLimitNotice,
  parseGoDuration,
  usedPercent,
  validateSpendGuardConfig,
} from './spendGuardModel';
import styles from './ModelsPage.module.scss';

const STATUS_REFRESH_MS = MIN_POLL_SECONDS * 1000;

const usd = (value: number | null) => (value === null ? '—' : formatUsd(value));

function UsageBar({ percent }: { percent: number | null }) {
  const tone =
    percent === null ? 'unknown' : percent >= 100 ? 'full' : percent >= 75 ? 'warn' : 'ok';
  return (
    <div className={styles.usageTrack}>
      <div
        className={styles.usageFill}
        data-tone={tone}
        style={{ width: `${Math.round(percent ?? 0)}%` }}
      />
    </div>
  );
}

function CredentialCard({ item }: { item: SpendGuardCredentialStatus }) {
  const { t, i18n } = useTranslation();
  const notice = cursorLimitNotice(item.accountLimit, item.capUsd);
  const reasonText = item.reason
    ? t(`spend_guard.reason_${item.reason.code}`, { defaultValue: item.reason.code })
    : '';
  const { accountLimit } = item;
  return (
    <div className={styles.row} data-testid="spend-guard-card" data-blocked={item.blocked}>
      <div className={styles.rowMain}>
        <div className={styles.rowTitle}>
          <strong>{item.label}</strong>
          <span className={styles.badge} data-tone={item.blocked ? 'danger' : 'ok'}>
            {item.blocked ? t('spend_guard.blocked') : t('spend_guard.allowed')}
          </span>
          {item.includedExhausted ? (
            <span className={styles.badge} data-tone="warn">
              {t('spend_guard.included_exhausted')}
            </span>
          ) : null}
        </div>
        {item.blocked && item.reason ? (
          <div className={styles.errorBox}>
            <strong>{reasonText}</strong>
            {item.reason.message ? ` — ${item.reason.message}` : ''}
          </div>
        ) : null}

        <div className={styles.metricBlock}>
          <div className={styles.metricLine}>
            <span>{t('spend_guard.included')}</span>
            <strong>
              {usd(item.includedUsedUsd)} / {usd(item.includedLimitUsd)}
            </strong>
            <span className={styles.muted}>
              {t('spend_guard.remaining', { amount: usd(item.includedRemainingUsd) })}
            </span>
          </div>
          <UsageBar percent={usedPercent(item.includedUsedUsd, item.includedLimitUsd)} />
        </div>

        <div className={styles.metricBlock}>
          <div className={styles.metricLine}>
            <span>{t('spend_guard.overage')}</span>
            <strong>
              {usd(item.overageUsd)} / {usd(item.capUsd)}
            </strong>
            {item.estimateUsd !== null ? (
              <span className={styles.muted}>
                {t('spend_guard.estimate', { amount: usd(item.estimateUsd) })}
              </span>
            ) : null}
          </div>
          <UsageBar percent={usedPercent(item.estimateUsd ?? item.overageUsd, item.capUsd)} />
          <div className={styles.muted}>{t('spend_guard.overage_hint')}</div>
        </div>

        <div className={styles.metricLine}>
          <span className={styles.muted}>
            {accountLimit.type === 'unknown' && accountLimit.usageBasedAllowed === null
              ? t('spend_guard.account_limit_unknown')
              : t('spend_guard.account_limit', {
                  type: t(`spend_guard.limit_type_${accountLimit.type}`),
                  limit:
                    accountLimit.limitUsd === null
                      ? t('spend_guard.no_limit')
                      : usd(accountLimit.limitUsd),
                })}
          </span>
          {accountLimit.type === 'team' && accountLimit.pooledUsedUsd !== null ? (
            <span className={styles.muted}>
              {t('spend_guard.team_pooled', { amount: usd(accountLimit.pooledUsedUsd) })}
            </span>
          ) : null}
        </div>
        {notice === 'cursor_will_not_stop' ? (
          <div className={styles.warningBox}>{t('spend_guard.notice_cursor_will_not_stop')}</div>
        ) : notice === 'cursor_blocks_on_demand' ? (
          <div className={styles.infoBox}>{t('spend_guard.notice_cursor_blocks_on_demand')}</div>
        ) : null}
        {item.lastError ? (
          <div className={styles.warningBox}>
            {t('spend_guard.last_error', {
              count: item.consecutiveFailures,
              error: item.lastError,
            })}
          </div>
        ) : null}

        <div className={styles.muted}>
          {t('spend_guard.checked_at', {
            time: item.checkedAt ? formatDateTime(item.checkedAt, i18n.language) : '—',
          })}
          {item.periodStart && item.periodEnd
            ? ` · ${t('spend_guard.period', {
                start: formatDateTime(item.periodStart, i18n.language),
                end: formatDateTime(item.periodEnd, i18n.language),
              })}`
            : ''}
        </div>
      </div>
    </div>
  );
}

export function SpendGuardTab() {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const [saved, setSaved] = useState<CursorSpendGuardConfig | null>(null);
  const [draft, setDraft] = useState<CursorSpendGuardConfig | null>(null);
  const [status, setStatus] = useState<SpendGuardStatus | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const mounted = useRef(true);

  const loadStatus = useCallback(async () => {
    try {
      const next = await cursorSpendGuardApi.getStatus();
      if (mounted.current) setStatus(next);
    } catch (err) {
      if (mounted.current) setError(getErrorMessage(err, t('spend_guard.status_failed')));
    }
  }, [t]);

  useEffect(() => {
    mounted.current = true;
    cursorSpendGuardApi
      .getConfig()
      .then((config) => {
        if (!mounted.current) return;
        setSaved(config);
        setDraft(config);
      })
      .catch(
        (err) => mounted.current && setError(getErrorMessage(err, t('spend_guard.load_failed')))
      );
    void loadStatus();
    const timer = window.setInterval(() => void loadStatus(), STATUS_REFRESH_MS);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [loadStatus, t]);

  if (!draft || !saved) {
    return error ? <div className={styles.errorBox}>{error}</div> : <LoadingSpinner />;
  }

  const errors = validateSpendGuardConfig(draft);
  const valid = Object.keys(errors).length === 0;
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const fieldError = (field: keyof typeof errors) =>
    errors[field] ? t(errors[field] as string, { min: `${MIN_POLL_SECONDS}s` }) : undefined;
  const update = (patch: Partial<CursorSpendGuardConfig>) =>
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  const numberValue = (value: string) => (value.trim() === '' ? NaN : Number(value));

  const save = async () => {
    setSaving(true);
    try {
      await cursorSpendGuardApi.saveConfig(draft);
      const fresh = await cursorSpendGuardApi.getConfig();
      setSaved(fresh);
      setDraft(fresh);
      showNotification(t('model_exposure.saved'), 'success');
      void loadStatus();
    } catch (err) {
      showNotification(getErrorMessage(err, t('model_exposure.save_failed')), 'error');
    } finally {
      setSaving(false);
    }
  };

  const recheck = async () => {
    setRechecking(true);
    try {
      setStatus(await cursorSpendGuardApi.recheck());
      setError('');
    } catch (err) {
      showNotification(getErrorMessage(err, t('spend_guard.status_failed')), 'error');
    } finally {
      setRechecking(false);
    }
  };

  const pollSeconds = parseGoDuration(draft.pollInterval);
  const credentials = status?.credentials ?? [];
  const blockedCount = credentials.filter((item) => item.blocked).length;

  return (
    <>
      <section className={styles.surface} data-testid="spend-guard-config">
        <div className={styles.header}>
          <div className={styles.headerText}>
            <h2 className={styles.sectionTitle}>{t('spend_guard.title')}</h2>
            <div className={styles.muted}>{t('spend_guard.hint')}</div>
          </div>
          <div className={styles.actions}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setDraft(saved)}
              disabled={!dirty || saving}
            >
              {t('model_exposure.discard')}
            </Button>
            <Button
              size="sm"
              onClick={() => void save()}
              disabled={!dirty || !valid}
              loading={saving}
            >
              {t('model_exposure.save')}
            </Button>
          </div>
        </div>
        <div className={styles.toggleRow}>
          <ToggleSwitch
            label={t('spend_guard.enabled')}
            checked={draft.enabled}
            onChange={(enabled) => update({ enabled })}
            disabled={saving}
          />
          <ToggleSwitch
            label={t('spend_guard.fail_closed')}
            checked={draft.failClosedWhenUnknown}
            onChange={(failClosedWhenUnknown) => update({ failClosedWhenUnknown })}
            disabled={saving}
          />
        </div>
        <div className={styles.grid}>
          <Input
            label={t('spend_guard.max_overage')}
            type="number"
            min={0}
            step="1"
            value={Number.isNaN(draft.maxOverageUsd) ? '' : String(draft.maxOverageUsd)}
            onChange={(event) => update({ maxOverageUsd: numberValue(event.target.value) })}
            hint={t('spend_guard.max_overage_hint')}
            error={fieldError('maxOverageUsd')}
            disabled={saving}
          />
          <Input
            label={t('spend_guard.poll_interval')}
            value={draft.pollInterval}
            placeholder="60s"
            onChange={(event) => update({ pollInterval: event.target.value })}
            hint={
              pollSeconds !== null
                ? t('spend_guard.poll_interval_hint', { seconds: pollSeconds })
                : undefined
            }
            error={fieldError('pollInterval')}
            disabled={saving}
          />
          <Input
            label={t('spend_guard.grace_polls')}
            type="number"
            min={0}
            step="1"
            value={Number.isNaN(draft.unknownGracePolls) ? '' : String(draft.unknownGracePolls)}
            onChange={(event) => update({ unknownGracePolls: numberValue(event.target.value) })}
            hint={t('spend_guard.grace_polls_hint')}
            error={fieldError('unknownGracePolls')}
            disabled={saving || !draft.failClosedWhenUnknown}
          />
          <Input
            label={t('spend_guard.reserve')}
            type="number"
            min={0}
            step="0.05"
            value={
              Number.isNaN(draft.defaultRequestReserveUsd)
                ? ''
                : String(draft.defaultRequestReserveUsd)
            }
            onChange={(event) =>
              update({ defaultRequestReserveUsd: numberValue(event.target.value) })
            }
            hint={t('spend_guard.reserve_hint')}
            error={fieldError('defaultRequestReserveUsd')}
            disabled={saving}
          />
        </div>
        <div className={styles.infoBox}>{t('spend_guard.no_unblock')}</div>
      </section>

      <section className={styles.surface} data-testid="spend-guard-status">
        <div className={styles.header}>
          <div className={styles.headerText}>
            <h2 className={styles.sectionTitle}>{t('spend_guard.status_title')}</h2>
            <div className={styles.muted}>
              {status
                ? t('spend_guard.status_summary', {
                    state: status.enabled ? t('spend_guard.state_on') : t('spend_guard.state_off'),
                    cap: usd(status.capUsd),
                    interval: status.pollInterval || '—',
                    blocked: blockedCount,
                    total: credentials.length,
                  })
                : ''}
            </div>
          </div>
          <Button size="sm" variant="secondary" onClick={() => void recheck()} loading={rechecking}>
            {t('spend_guard.recheck')}
          </Button>
        </div>
        {error ? <div className={styles.errorBox}>{error}</div> : null}
        {status && !status.enabled ? (
          <div className={styles.infoBox}>{t('spend_guard.disabled_notice')}</div>
        ) : null}
        {!status ? (
          <LoadingSpinner />
        ) : credentials.length === 0 ? (
          <EmptyState
            title={t('spend_guard.empty_title')}
            description={t('spend_guard.empty_desc')}
          />
        ) : (
          <div className={styles.list}>
            {credentials.map((item) => (
              <CredentialCard key={item.authIndex} item={item} />
            ))}
          </div>
        )}
      </section>
    </>
  );
}
