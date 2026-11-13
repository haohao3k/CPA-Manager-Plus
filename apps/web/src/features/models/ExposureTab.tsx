import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  modelExposureApi,
  type CatalogModel,
  type ExposureMode,
  type ModelExposureConfig,
  type ProviderExposure,
} from '@/services/api/modelExposure';
import { useNotificationStore } from '@/stores';
import { getErrorMessage } from '@/utils/helpers';
import {
  buildExposedList,
  deprefixedId,
  exposedIdFor,
  isBlockedByDenyPattern,
  isModelExposed,
  matchesAny,
  providerExposureFor,
  setModelExposed,
} from './modelExposureModel';
import { Chip, PatternChips } from './PatternChips';
import type { ModelsData } from './ModelsPage';
import styles from './ModelsPage.module.scss';

const ROW_LIMIT = 500;

type StatusFilter = 'all' | 'exposed' | 'hidden';

export function ExposureTab({ data, onSaved }: { data: ModelsData; onSaved: () => Promise<void> }) {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const [draft, setDraft] = useState<ModelExposureConfig>(data.exposure);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const { models } = data.catalog;

  const providers = useMemo(() => {
    const keys = new Set<string>(models.map((model) => model.provider));
    Object.keys(draft.providers).forEach((key) => keys.add(key));
    return Array.from(keys).sort((a, b) => a.localeCompare(b));
  }, [draft.providers, models]);
  const [selected, setSelected] = useState(() => providers[0] ?? '');
  const activeProvider = providers.includes(selected) ? selected : (providers[0] ?? '');

  const prefixOf = (provider: string) => models.find((m) => m.provider === provider)?.prefix;
  const exposureOf = (provider: string) => providerExposureFor(draft, provider, prefixOf(provider));
  const modelExposed = (model: CatalogModel) =>
    !draft.enabled || isModelExposed(model, exposureOf(model.provider));

  const counts = useMemo(() => {
    const result: Record<string, { exposed: number; total: number }> = {};
    models.forEach((model) => {
      const entry = (result[model.provider] ??= { exposed: 0, total: 0 });
      entry.total += 1;
      const exposure = providerExposureFor(draft, model.provider, model.prefix);
      if (!draft.enabled || isModelExposed(model, exposure)) entry.exposed += 1;
    });
    return result;
  }, [draft, models]);
  const totalExposed = Object.values(counts).reduce((sum, item) => sum + item.exposed, 0);

  const preview = useMemo(
    () => buildExposedList(draft, models, data.aliases, data.catalog.combos),
    [data.aliases, data.catalog.combos, draft, models]
  );

  const exposure = exposureOf(activeProvider);
  const providerModels = useMemo(
    () => models.filter((model) => model.provider === activeProvider),
    [activeProvider, models]
  );
  const query = search.trim().toLowerCase();
  const filtered = providerModels.filter((model) => {
    if (query) {
      const haystack = [model.id, model.exposedId, model.displayName, model.cursorFamily ?? '']
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    if (statusFilter === 'all') return true;
    return modelExposed(model) === (statusFilter === 'exposed');
  });

  const updateProvider = (patch: Partial<ProviderExposure>) => {
    setDraft((prev) => ({
      ...prev,
      providers: {
        ...prev.providers,
        [activeProvider]: {
          ...providerExposureFor(prev, activeProvider, prefixOf(activeProvider)),
          ...patch,
        },
      },
    }));
  };

  const setExposed = (targets: CatalogModel[], value: boolean) => {
    const ids = targets
      .filter((model) => isModelExposed(model, exposure) !== value)
      .map((model) => deprefixedId(model));
    if (ids.length === 0) return;
    updateProvider(setModelExposed(exposure, ids, value));
  };

  const reasonOf = (model: CatalogModel) => {
    const id = deprefixedId(model);
    if (exposure.mode === 'none') return t('model_exposure.reason_mode_none');
    if (matchesAny(exposure.deny, id)) return t('model_exposure.reason_deny');
    if (exposure.mode === 'allowlist') {
      return matchesAny(exposure.allow, id)
        ? t('model_exposure.reason_allow')
        : t('model_exposure.reason_not_allowed');
    }
    return t('model_exposure.reason_mode_all');
  };

  const dirty = JSON.stringify(draft) !== JSON.stringify(data.exposure);

  const save = async () => {
    setSaving(true);
    try {
      await modelExposureApi.saveExposure(draft);
      showNotification(t('model_exposure.saved'), 'success');
      await onSaved();
    } catch (err) {
      showNotification(getErrorMessage(err, t('model_exposure.save_failed')), 'error');
    } finally {
      setSaving(false);
    }
  };

  const modeOptions: Array<{ value: ExposureMode; label: string }> = [
    { value: 'all', label: t('model_exposure.mode_all') },
    { value: 'allowlist', label: t('model_exposure.mode_allowlist') },
    { value: 'none', label: t('model_exposure.mode_none') },
  ];

  return (
    <>
      <section className={styles.surface} data-testid="exposure-global">
        <div className={styles.header}>
          <h2 className={styles.sectionTitle}>{t('model_exposure.global_title')}</h2>
          <div className={styles.actions}>
            <div className={styles.metrics}>
              <span className={styles.metric}>
                <strong data-testid="exposure-counter">
                  {t('model_exposure.counter', { exposed: totalExposed, total: models.length })}
                </strong>
              </span>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setDraft(data.exposure)}
              disabled={!dirty || saving}
            >
              {t('model_exposure.discard')}
            </Button>
            <Button size="sm" onClick={() => void save()} disabled={!dirty} loading={saving}>
              {t('model_exposure.save')}
            </Button>
          </div>
        </div>
        <div className={styles.toggleRow}>
          <ToggleSwitch
            label={t('model_exposure.enabled')}
            checked={draft.enabled}
            onChange={(enabled) => setDraft((prev) => ({ ...prev, enabled }))}
            disabled={saving}
          />
          <ToggleSwitch
            label={t('model_exposure.list_prefixed_only')}
            checked={draft.listPrefixedOnly}
            onChange={(listPrefixedOnly) => setDraft((prev) => ({ ...prev, listPrefixedOnly }))}
            disabled={saving || !draft.enabled}
          />
          <ToggleSwitch
            label={t('model_exposure.accept_bare_ids')}
            checked={draft.acceptBareIds}
            onChange={(acceptBareIds) => setDraft((prev) => ({ ...prev, acceptBareIds }))}
            disabled={saving || !draft.enabled}
          />
        </div>
        <div className={styles.muted}>{t('model_exposure.global_hint')}</div>
        {!draft.enabled ? (
          <div className={styles.infoBox}>{t('model_exposure.disabled_notice')}</div>
        ) : null}
      </section>

      <section className={styles.surface} data-testid="exposure-provider">
        <h2 className={styles.sectionTitle}>{t('model_exposure.providers_title')}</h2>
        {providers.length === 0 ? (
          <div className={styles.muted}>{t('model_exposure.catalog_empty')}</div>
        ) : (
          <>
            <div className={styles.providerChips} role="tablist">
              {providers.map((provider) => (
                <button
                  key={provider}
                  type="button"
                  role="tab"
                  aria-selected={provider === activeProvider}
                  className={styles.providerChip}
                  data-active={provider === activeProvider}
                  onClick={() => setSelected(provider)}
                >
                  {provider}
                  <span>
                    {counts[provider]?.exposed ?? 0}/{counts[provider]?.total ?? 0}
                  </span>
                </button>
              ))}
            </div>

            <div className={styles.grid}>
              <Input
                label={t('model_exposure.prefix')}
                value={exposure.prefix}
                onChange={(event) => updateProvider({ prefix: event.target.value.trim() })}
                hint={t('model_exposure.prefix_hint', {
                  example: providerModels[0] ? exposedIdFor(providerModels[0], exposure) : '',
                })}
                disabled={saving || !draft.enabled}
              />
              <div className="form-group">
                <label>{t('model_exposure.mode')}</label>
                <Select
                  value={exposure.mode}
                  options={modeOptions}
                  onChange={(mode) => updateProvider({ mode: mode as ExposureMode })}
                  ariaLabel={t('model_exposure.mode')}
                  disabled={saving || !draft.enabled}
                />
              </div>
            </div>

            <div className={styles.grid}>
              <PatternChips
                label={t('model_exposure.allow_patterns')}
                kind="allow"
                values={exposure.allow}
                onChange={(allow) => updateProvider({ allow })}
                placeholder="claude-*"
                disabled={saving || !draft.enabled || exposure.mode !== 'allowlist'}
              />
              <PatternChips
                label={t('model_exposure.deny_patterns')}
                kind="deny"
                values={exposure.deny}
                onChange={(deny) => updateProvider({ deny })}
                placeholder="*-fast"
                disabled={saving || !draft.enabled || exposure.mode === 'none'}
              />
            </div>

            <div className={styles.toolbar}>
              <Input
                type="search"
                value={search}
                placeholder={t('model_exposure.search_placeholder')}
                aria-label={t('model_exposure.search_placeholder')}
                onChange={(event) => setSearch(event.target.value)}
              />
              <div style={{ width: 160 }}>
                <Select
                  value={statusFilter}
                  options={[
                    { value: 'all', label: t('model_exposure.filter_all') },
                    { value: 'exposed', label: t('model_exposure.filter_exposed') },
                    { value: 'hidden', label: t('model_exposure.filter_hidden') },
                  ]}
                  onChange={(value) => setStatusFilter(value as StatusFilter)}
                  ariaLabel={t('model_exposure.filter_label')}
                />
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setExposed(filtered, true)}
                disabled={saving || !draft.enabled || exposure.mode === 'none' || !filtered.length}
              >
                {t('model_exposure.expose_filtered', { count: filtered.length })}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setExposed(filtered, false)}
                disabled={saving || !draft.enabled || exposure.mode === 'none' || !filtered.length}
              >
                {t('model_exposure.hide_filtered', { count: filtered.length })}
              </Button>
            </div>
            {exposure.mode === 'none' && draft.enabled ? (
              <div className={styles.infoBox}>{t('model_exposure.mode_none_hint')}</div>
            ) : null}

            <div className={styles.tableWrap}>
              <table className={styles.table} data-testid="exposure-table">
                <thead>
                  <tr>
                    <th style={{ width: 70 }}>{t('model_exposure.col_exposed')}</th>
                    <th>{t('model_exposure.col_exposed_id')}</th>
                    <th>{t('model_exposure.col_native_id')}</th>
                    <th>{t('model_exposure.col_display_name')}</th>
                    <th>{t('model_exposure.col_reason')}</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(0, ROW_LIMIT).map((model) => {
                    const exposed = modelExposed(model);
                    const blocked = isBlockedByDenyPattern(deprefixedId(model), exposure);
                    return (
                      <tr key={model.id} data-exposed={exposed}>
                        <td>
                          <ToggleSwitch
                            checked={exposed}
                            onChange={(value) => setExposed([model], value)}
                            ariaLabel={exposedIdFor(model, exposure)}
                            disabled={
                              saving ||
                              !draft.enabled ||
                              exposure.mode === 'none' ||
                              (blocked && !exposed)
                            }
                          />
                        </td>
                        <td>
                          <code>{exposedIdFor(model, exposure)}</code>
                        </td>
                        <td>
                          <code>{model.id}</code>
                        </td>
                        <td>
                          {model.displayName}
                          {model.cursorFamily ? (
                            <div className={styles.muted}>
                              {model.cursorFamily}
                              {model.effortLevel ? ` · ${model.effortLevel}` : ''}
                            </div>
                          ) : null}
                        </td>
                        <td>{reasonOf(model)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {filtered.length > ROW_LIMIT ? (
              <div className={styles.muted}>
                {t('model_exposure.rows_truncated', { shown: ROW_LIMIT, total: filtered.length })}
              </div>
            ) : null}
          </>
        )}
      </section>

      <section className={styles.surface} data-testid="exposure-preview">
        <div className={styles.header}>
          <h2 className={styles.sectionTitle}>{t('model_exposure.preview_title')}</h2>
          <span className={styles.muted}>
            {t('model_exposure.preview_count', { count: preview.length })}
          </span>
        </div>
        <div className={styles.muted}>{t('model_exposure.preview_hint')}</div>
        <div className={styles.preview}>
          {preview.map((entry) => (
            <Chip
              key={entry.id}
              value={
                entry.unavailable
                  ? `${entry.id} · ${t('model_exposure.alias_unavailable')}`
                  : entry.id
              }
              kind={entry.unavailable ? 'unavailable' : entry.kind === 'combo' ? 'combo' : 'allow'}
              title={entry.unavailable ? t('model_exposure.alias_unavailable_hint') : undefined}
            />
          ))}
        </div>
      </section>
    </>
  );
}
