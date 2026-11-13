import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import {
  EFFORT_LEVELS,
  modelExposureApi,
  type CursorModelAlias,
  type EffortLevel,
} from '@/services/api/modelExposure';
import { useNotificationStore } from '@/stores';
import { getErrorMessage } from '@/utils/helpers';
import {
  providerExposureFor,
  suggestAliasFromFamily,
  suggestAliasName,
} from './modelExposureModel';
import { Chip } from './PatternChips';
import type { ModelsData } from './ModelsPage';
import styles from './ModelsPage.module.scss';

interface AliasForm {
  alias: string;
  family: string;
  defaultEffort: EffortLevel;
  variants: Partial<Record<EffortLevel, string>>;
}

const emptyForm = (): AliasForm => ({
  alias: '',
  family: '',
  defaultEffort: 'medium',
  variants: {},
});

export function CursorAliasesTab({
  data,
  onSaved,
}: {
  data: ModelsData;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const showConfirmation = useNotificationStore((state) => state.showConfirmation);
  const [saving, setSaving] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState<AliasForm>(emptyForm);
  const [formError, setFormError] = useState('');

  const cursorModels = useMemo(
    () => data.catalog.models.filter((model) => model.provider === 'cursor'),
    [data.catalog.models]
  );
  const families = useMemo(
    () =>
      Array.from(
        new Set(cursorModels.map((model) => model.cursorFamily).filter(Boolean) as string[])
      ).sort((a, b) => a.localeCompare(b)),
    [cursorModels]
  );
  const cursorPrefix =
    providerExposureFor(data.exposure, 'cursor', cursorModels[0]?.prefix).prefix || 'cursor';

  const variantOptions = useMemo(() => {
    const pool = form.family
      ? cursorModels.filter((model) => model.cursorFamily === form.family)
      : cursorModels;
    const ids = new Set(pool.map((model) => model.id));
    Object.values(form.variants).forEach((id) => id && ids.add(id));
    return [
      { value: '', label: t('model_exposure.alias_variant_unset') },
      ...Array.from(ids)
        .sort((a, b) => a.localeCompare(b))
        .map((id) => ({ value: id, label: id })),
    ];
  }, [cursorModels, form.family, form.variants, t]);

  const definedLevels = EFFORT_LEVELS.filter((level) => form.variants[level]);

  const persist = async (next: CursorModelAlias[]) => {
    setSaving(true);
    try {
      await modelExposureApi.saveCursorAliases(next);
      showNotification(t('model_exposure.saved'), 'success');
      await onSaved();
      return true;
    } catch (err) {
      showNotification(getErrorMessage(err, t('model_exposure.save_failed')), 'error');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const openEditor = (index: number | null) => {
    setEditingIndex(index);
    setFormError('');
    if (index === null) {
      setForm(emptyForm());
    } else {
      const alias = data.aliases[index];
      const firstTarget = Object.values(alias.variants).find(Boolean);
      const family = cursorModels.find((model) => model.id === firstTarget)?.cursorFamily ?? '';
      setForm({
        alias: alias.alias,
        family,
        defaultEffort: alias.defaultEffort,
        variants: { ...alias.variants },
      });
    }
    setModalOpen(true);
  };

  const pickFamily = (family: string) => {
    if (!family) {
      setForm((prev) => ({ ...prev, family }));
      return;
    }
    const suggestion = suggestAliasFromFamily(family, cursorModels);
    setForm((prev) => ({
      ...prev,
      family,
      alias: prev.alias || suggestAliasName(family),
      variants: suggestion.variants,
      defaultEffort: suggestion.defaultEffort,
    }));
  };

  const setVariant = (level: EffortLevel, id: string) =>
    setForm((prev) => {
      const variants = { ...prev.variants };
      if (id) variants[level] = id;
      else delete variants[level];
      const defined = EFFORT_LEVELS.filter((item) => variants[item]);
      const defaultEffort = variants[prev.defaultEffort]
        ? prev.defaultEffort
        : (defined[0] ?? 'medium');
      return { ...prev, variants, defaultEffort };
    });

  const submit = async () => {
    const alias = form.alias.trim();
    if (!alias) return setFormError(t('model_exposure.alias_error_name'));
    if (/[\s/]/.test(alias)) return setFormError(t('model_exposure.alias_error_chars'));
    const duplicate = data.aliases.some(
      (item, index) => index !== editingIndex && item.alias.toLowerCase() === alias.toLowerCase()
    );
    if (duplicate) return setFormError(t('model_exposure.alias_error_duplicate'));
    if (definedLevels.length === 0) return setFormError(t('model_exposure.alias_error_variants'));
    const entry: CursorModelAlias = {
      alias,
      defaultEffort: form.variants[form.defaultEffort] ? form.defaultEffort : definedLevels[0],
      variants: form.variants,
    };
    const next = [...data.aliases];
    if (editingIndex === null) next.push(entry);
    else next[editingIndex] = entry;
    if (await persist(next)) setModalOpen(false);
  };

  const remove = (index: number) =>
    showConfirmation({
      title: t('model_exposure.alias_delete_title'),
      message: t('model_exposure.alias_delete_confirm', { alias: data.aliases[index].alias }),
      variant: 'danger',
      confirmText: t('common.delete'),
      onConfirm: async () => {
        await persist(data.aliases.filter((_, itemIndex) => itemIndex !== index));
      },
    });

  return (
    <section className={styles.surface} data-testid="cursor-aliases">
      <div className={styles.header}>
        <div className={styles.headerText}>
          <h2 className={styles.sectionTitle}>{t('model_exposure.aliases_title')}</h2>
          <div className={styles.muted}>{t('model_exposure.aliases_hint')}</div>
        </div>
        <Button size="sm" onClick={() => openEditor(null)} disabled={saving}>
          {t('model_exposure.alias_add')}
        </Button>
      </div>

      {data.aliases.length === 0 ? (
        <EmptyState
          title={t('model_exposure.aliases_empty_title')}
          description={t('model_exposure.aliases_empty_desc')}
        />
      ) : (
        <div className={styles.list}>
          {data.aliases.map((alias, index) => (
            <div key={alias.alias} className={styles.row}>
              <div className={styles.rowMain}>
                <div className={styles.rowTitle}>
                  <strong>{alias.alias}</strong>
                  <code>
                    {cursorPrefix}/{alias.alias}
                  </code>
                  <span className={styles.muted}>
                    {t('model_exposure.alias_default_effort')}: {alias.defaultEffort}
                  </span>
                </div>
                <div className={styles.chips}>
                  {EFFORT_LEVELS.filter((level) => alias.variants[level]).map((level) => (
                    <Chip key={level} value={`${level} → ${alias.variants[level]}`} />
                  ))}
                </div>
              </div>
              <div className={styles.actions}>
                <Button
                  variant="secondary"
                  size="xs"
                  onClick={() => openEditor(index)}
                  disabled={saving}
                >
                  {t('common.edit')}
                </Button>
                <Button variant="ghost" size="xs" onClick={() => remove(index)} disabled={saving}>
                  {t('common.delete')}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        open={modalOpen}
        title={
          editingIndex === null
            ? t('model_exposure.alias_add_title')
            : t('model_exposure.alias_edit_title')
        }
        onClose={() => setModalOpen(false)}
        closeDisabled={saving}
        width={640}
        footer={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setModalOpen(false)}
              disabled={saving}
            >
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={() => void submit()} loading={saving}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div className={styles.list}>
          <div className="form-group">
            <label>{t('model_exposure.alias_family')}</label>
            <Select
              value={form.family}
              options={[
                { value: '', label: t('model_exposure.alias_family_any') },
                ...families.map((family) => ({ value: family, label: family })),
              ]}
              onChange={pickFamily}
              ariaLabel={t('model_exposure.alias_family')}
              disabled={saving}
            />
            <div className="hint">{t('model_exposure.alias_family_hint')}</div>
          </div>
          <Input
            label={t('model_exposure.alias_name')}
            value={form.alias}
            placeholder="deepseek-v4.1-flash"
            onChange={(event) => setForm((prev) => ({ ...prev, alias: event.target.value }))}
            hint={t('model_exposure.alias_name_hint', {
              id: `${cursorPrefix}/${form.alias.trim() || '…'}`,
            })}
            disabled={saving}
          />
          <div className="form-group">
            <label>{t('model_exposure.alias_variants')}</label>
            <div className={styles.variantGrid}>
              {EFFORT_LEVELS.map((level) => (
                <div key={level} style={{ display: 'contents' }}>
                  <span className={styles.muted}>{level}</span>
                  <Select
                    value={form.variants[level] ?? ''}
                    options={variantOptions}
                    onChange={(id) => setVariant(level, id)}
                    ariaLabel={`${t('model_exposure.alias_variants')} ${level}`}
                    disabled={saving}
                  />
                </div>
              ))}
            </div>
          </div>
          <div className="form-group">
            <label>{t('model_exposure.alias_default_effort')}</label>
            <Select
              value={form.defaultEffort}
              options={(definedLevels.length ? definedLevels : [form.defaultEffort]).map(
                (level) => ({
                  value: level,
                  label: level,
                })
              )}
              onChange={(level) =>
                setForm((prev) => ({ ...prev, defaultEffort: level as EffortLevel }))
              }
              ariaLabel={t('model_exposure.alias_default_effort')}
              disabled={saving || definedLevels.length === 0}
            />
            <div className="hint">{t('model_exposure.alias_default_effort_hint')}</div>
          </div>
          {formError ? <div className="error-box">{formError}</div> : null}
        </div>
      </Modal>
    </section>
  );
}
