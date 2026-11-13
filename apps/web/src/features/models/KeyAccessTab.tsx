import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { SelectionCheckbox } from '@/components/ui/SelectionCheckbox';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { modelExposureApi, type ApiKeyPolicy } from '@/services/api/modelExposure';
import { useNotificationStore } from '@/stores';
import { sha256Hex } from '@/utils/apiKeyHash';
import { maskApiKey } from '@/utils/format';
import { getErrorMessage } from '@/utils/helpers';
import {
  buildExposedList,
  comboAllowEntry,
  policyAllows,
  type ExposedEntry,
} from './modelExposureModel';
import { Chip } from './PatternChips';
import type { ModelsData } from './ModelsPage';
import styles from './ModelsPage.module.scss';

type PolicyDraft = Pick<ApiKeyPolicy, 'restricted' | 'allow'>;

const sameEntry = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

const entryValue = (entry: ExposedEntry) =>
  entry.kind === 'combo' ? comboAllowEntry(entry.id) : entry.id;

/** Allow-list entries that select this exact item (a bare combo name counts as combo:<name>). */
const isEntrySelected = (allow: string[], entry: ExposedEntry) =>
  allow.some(
    (item) =>
      sameEntry(item, entryValue(entry)) || (entry.kind === 'combo' && sameEntry(item, entry.id))
  );

export function KeyAccessTab({
  data,
  onSaved,
  focusKeyHash,
}: {
  data: ModelsData;
  onSaved: () => Promise<void>;
  focusKeyHash: string;
}) {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const [saving, setSaving] = useState(false);
  const [pickerKey, setPickerKey] = useState<string | null>(null);
  const [pickerSearch, setPickerSearch] = useState('');
  const [patternDrafts, setPatternDrafts] = useState<Record<string, string>>({});
  const focusRef = useRef<HTMLDivElement | null>(null);

  const initial = useMemo(() => {
    const result: Record<string, PolicyDraft> = {};
    data.apiKeys.forEach((key) => {
      const policy = data.policies.find((item) => item.key === key);
      result[key] = { restricted: policy?.restricted ?? false, allow: policy?.allow ?? [] };
    });
    return result;
  }, [data.apiKeys, data.policies]);
  const [drafts, setDrafts] = useState(initial);

  const hashes = useMemo(
    () => Object.fromEntries(data.apiKeys.map((key) => [key, sha256Hex(key).toLowerCase()])),
    [data.apiKeys]
  );

  const exposed = useMemo(
    () =>
      buildExposedList(
        { ...data.exposure, listPrefixedOnly: true },
        data.catalog.models,
        data.aliases,
        data.catalog.combos
      ),
    [data.aliases, data.catalog.combos, data.catalog.models, data.exposure]
  );

  useEffect(() => {
    focusRef.current?.scrollIntoView({ block: 'center' });
  }, []);

  const update = (key: string, patch: Partial<PolicyDraft>) =>
    setDrafts((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));

  const addEntry = (key: string, value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const allow = drafts[key].allow;
    if (allow.some((item) => sameEntry(item, trimmed))) return;
    update(key, { allow: [...allow, trimmed] });
  };

  const toggleEntry = (key: string, entry: ExposedEntry, selected: boolean) => {
    const allow = drafts[key].allow;
    if (selected) {
      addEntry(key, entryValue(entry));
      return;
    }
    update(key, {
      allow: allow.filter(
        (item) =>
          !sameEntry(item, entryValue(entry)) &&
          !(entry.kind === 'combo' && sameEntry(item, entry.id))
      ),
    });
  };

  const dirty = JSON.stringify(drafts) !== JSON.stringify(initial);

  const save = async () => {
    const policies: ApiKeyPolicy[] = data.apiKeys
      .filter((key) => drafts[key].restricted || drafts[key].allow.length > 0)
      .map((key) => ({ key, ...drafts[key] }));
    setSaving(true);
    try {
      await modelExposureApi.saveKeyPolicies(policies);
      showNotification(t('model_exposure.saved'), 'success');
      await onSaved();
    } catch (err) {
      showNotification(getErrorMessage(err, t('model_exposure.save_failed')), 'error');
    } finally {
      setSaving(false);
    }
  };

  const pickerQuery = pickerSearch.trim().toLowerCase();
  const pickerEntries = exposed.filter((entry) => entry.id.toLowerCase().includes(pickerQuery));
  const pickerCombos = pickerEntries.filter((entry) => entry.kind === 'combo');
  const pickerModels = pickerEntries.filter((entry) => entry.kind !== 'combo');
  const pickerGroups = Array.from(
    new Set(pickerModels.map((entry) => entry.provider ?? ''))
  ).sort();

  const labelOf = (key: string, index: number) =>
    data.keyLabels[hashes[key]] || t('model_exposure.key_fallback_label', { index: index + 1 });

  return (
    <section className={styles.surface} data-testid="key-access">
      <div className={styles.header}>
        <div className={styles.headerText}>
          <h2 className={styles.sectionTitle}>{t('model_exposure.access_title')}</h2>
          <div className={styles.muted}>{t('model_exposure.access_hint')}</div>
        </div>
        <div className={styles.actions}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setDrafts(initial)}
            disabled={!dirty || saving}
          >
            {t('model_exposure.discard')}
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={!dirty} loading={saving}>
            {t('model_exposure.save')}
          </Button>
        </div>
      </div>

      {data.apiKeys.length === 0 ? (
        <EmptyState
          title={t('model_exposure.access_empty_title')}
          description={t('model_exposure.access_empty_desc')}
        />
      ) : (
        <div className={styles.list}>
          {data.apiKeys.map((key, index) => {
            const draft = drafts[key];
            const focused = Boolean(focusKeyHash) && hashes[key] === focusKeyHash.toLowerCase();
            const allowedCount = draft.restricted
              ? exposed.filter((entry) => policyAllows(draft.allow, entry)).length
              : exposed.length;
            return (
              <div
                key={key}
                className={styles.row}
                data-highlight={focused}
                ref={focused ? focusRef : undefined}
                data-testid="key-access-row"
              >
                <div className={styles.rowMain}>
                  <div className={styles.rowTitle}>
                    <strong>{labelOf(key, index)}</strong>
                    <code>{maskApiKey(key)}</code>
                    <span className={styles.muted}>
                      {t('model_exposure.access_allowed_count', {
                        allowed: allowedCount,
                        total: exposed.length,
                      })}
                    </span>
                  </div>
                  <ToggleSwitch
                    label={t('model_exposure.restricted')}
                    checked={draft.restricted}
                    onChange={(restricted) => update(key, { restricted })}
                    disabled={saving}
                  />
                  {draft.restricted ? (
                    <>
                      {draft.allow.length === 0 ? (
                        <div className={styles.warningBox}>
                          {t('model_exposure.access_nothing')}
                        </div>
                      ) : null}
                      <div className={styles.chips}>
                        {draft.allow.map((entry) => (
                          <Chip
                            key={entry}
                            value={entry}
                            kind={entry.toLowerCase().startsWith('combo:') ? 'combo' : 'allow'}
                            disabled={saving}
                            onRemove={() =>
                              update(key, { allow: draft.allow.filter((item) => item !== entry) })
                            }
                          />
                        ))}
                        <button
                          type="button"
                          className={styles.addChip}
                          onClick={() => {
                            setPickerSearch('');
                            setPickerKey(key);
                          }}
                          disabled={saving}
                        >
                          + {t('model_exposure.access_add')}
                        </button>
                      </div>
                      <div className={styles.patternInput}>
                        <Input
                          value={patternDrafts[key] ?? ''}
                          placeholder={t('model_exposure.access_pattern_placeholder')}
                          aria-label={t('model_exposure.access_pattern_placeholder')}
                          disabled={saving}
                          onChange={(event) =>
                            setPatternDrafts((prev) => ({ ...prev, [key]: event.target.value }))
                          }
                          onKeyDown={(event) => {
                            if (event.key !== 'Enter') return;
                            event.preventDefault();
                            addEntry(key, patternDrafts[key] ?? '');
                            setPatternDrafts((prev) => ({ ...prev, [key]: '' }));
                          }}
                        />
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={saving || !(patternDrafts[key] ?? '').trim()}
                          onClick={() => {
                            addEntry(key, patternDrafts[key] ?? '');
                            setPatternDrafts((prev) => ({ ...prev, [key]: '' }));
                          }}
                        >
                          {t('model_exposure.add_pattern')}
                        </Button>
                      </div>
                    </>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Modal
        open={pickerKey !== null}
        title={
          pickerKey
            ? t('model_exposure.access_picker_title', {
                label: labelOf(pickerKey, data.apiKeys.indexOf(pickerKey)),
              })
            : ''
        }
        onClose={() => setPickerKey(null)}
        width={640}
        footer={
          <Button size="sm" onClick={() => setPickerKey(null)}>
            {t('model_exposure.done')}
          </Button>
        }
      >
        {pickerKey ? (
          <div className={styles.list}>
            <Input
              type="search"
              value={pickerSearch}
              placeholder={t('model_exposure.search_placeholder')}
              aria-label={t('model_exposure.search_placeholder')}
              onChange={(event) => setPickerSearch(event.target.value)}
            />
            <div className={styles.pickerList}>
              {pickerCombos.length > 0 ? (
                <div className={styles.pickerGroup}>{t('model_exposure.picker_combos')}</div>
              ) : null}
              {pickerCombos.map((entry) => (
                <SelectionCheckbox
                  key={entry.id}
                  className={styles.pickerItem}
                  checked={isEntrySelected(drafts[pickerKey].allow, entry)}
                  onChange={(value) => toggleEntry(pickerKey, entry, value)}
                  label={entry.id}
                />
              ))}
              {pickerGroups.map((provider) => (
                <div key={provider}>
                  <div className={styles.pickerGroup}>{provider}</div>
                  {pickerModels
                    .filter((entry) => (entry.provider ?? '') === provider)
                    .map((entry) => (
                      <SelectionCheckbox
                        key={entry.id}
                        className={styles.pickerItem}
                        checked={isEntrySelected(drafts[pickerKey].allow, entry)}
                        onChange={(value) => toggleEntry(pickerKey, entry, value)}
                        label={entry.id}
                      />
                    ))}
                </div>
              ))}
              {pickerEntries.length === 0 ? (
                <div className={styles.muted}>{t('model_exposure.picker_empty')}</div>
              ) : null}
            </div>
          </div>
        ) : null}
      </Modal>
    </section>
  );
}
