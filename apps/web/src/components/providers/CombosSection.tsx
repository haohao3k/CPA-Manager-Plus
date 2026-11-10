import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { combosApi, type ComboConfig, type ComboStrategy } from '@/services/api';
import { useNotificationStore } from '@/stores';

interface CombosSectionProps {
  disabled?: boolean;
  allModelNames?: string[];
}

interface ComboFormState {
  name: string;
  strategy: ComboStrategy;
  models: string[];
  disabled: boolean;
}

const buildEmptyComboForm = (): ComboFormState => ({
  name: '',
  strategy: 'fallback',
  models: [''],
  disabled: false,
});

export function CombosSection({ disabled = false, allModelNames = [] }: CombosSectionProps) {
  const { t } = useTranslation();
  const { showNotification, showConfirmation } = useNotificationStore();

  const [combos, setCombos] = useState<ComboConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [form, setForm] = useState<ComboFormState>(buildEmptyComboForm);
  const [quickPickModel, setQuickPickModel] = useState('');

  const loadCombos = useCallback(async () => {
    setLoading(true);
    try {
      const list = await combosApi.getCombos();
      setCombos(list);
    } catch {
      // Ignore initial load error if endpoint is unavailable
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCombos();
  }, [loadCombos]);

  const openAddModal = () => {
    setEditingIndex(null);
    setForm(buildEmptyComboForm());
    setQuickPickModel('');
    setModalOpen(true);
  };

  const openEditModal = (index: number) => {
    const target = combos[index];
    if (!target) return;
    setEditingIndex(index);
    setForm({
      name: target.name,
      strategy: target.strategy,
      models: target.models.length ? [...target.models] : [''],
      disabled: Boolean(target.disabled),
    });
    setQuickPickModel('');
    setModalOpen(true);
  };

  const handleCloseModal = () => {
    if (saving) return;
    setModalOpen(false);
    setEditingIndex(null);
  };

  const handleModelChange = (idx: number, value: string) => {
    setForm((prev) => ({
      ...prev,
      models: prev.models.map((item, i) => (i === idx ? value : item)),
    }));
  };

  const handleAddModelSlot = (initialValue = '') => {
    setForm((prev) => ({
      ...prev,
      models: [...prev.models, initialValue],
    }));
  };

  const handleRemoveModelSlot = (idx: number) => {
    setForm((prev) => {
      const next = prev.models.filter((_, i) => i !== idx);
      return {
        ...prev,
        models: next.length ? next : [''],
      };
    });
  };

  const handleMoveModelSlot = (idx: number, direction: -1 | 1) => {
    setForm((prev) => {
      const targetIdx = idx + direction;
      if (targetIdx < 0 || targetIdx >= prev.models.length) return prev;
      const next = [...prev.models];
      const temp = next[idx];
      next[idx] = next[targetIdx];
      next[targetIdx] = temp;
      return { ...prev, models: next };
    });
  };

  const handleSaveCombo = async () => {
    const trimmedName = form.name.trim();
    const cleanedModels = form.models.map((m) => m.trim()).filter(Boolean);
    if (!trimmedName) {
      showNotification(
        t('ai_providers.combos_name_required', { defaultValue: 'Combo name is required.' }),
        'error'
      );
      return;
    }
    if (cleanedModels.length === 0) {
      showNotification(
        t('ai_providers.combos_models_required', {
          defaultValue: 'At least one target model is required for a combo.',
        }),
        'error'
      );
      return;
    }

    setSaving(true);
    try {
      const nextCombo: ComboConfig = {
        name: trimmedName,
        strategy: form.strategy,
        models: cleanedModels,
        disabled: form.disabled,
      };
      const nextList =
        editingIndex !== null
          ? combos.map((item, idx) => (idx === editingIndex ? nextCombo : item))
          : [...combos.filter((c) => c.name.toLowerCase() !== trimmedName.toLowerCase()), nextCombo];

      const saved = await combosApi.saveCombos(nextList);
      setCombos(saved);
      showNotification(
        editingIndex !== null
          ? t('ai_providers.combos_updated', { defaultValue: 'Combo updated.' })
          : t('ai_providers.combos_added', { defaultValue: 'Combo created.' }),
        'success'
      );
      setModalOpen(false);
      setEditingIndex(null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showNotification(`${t('notification.update_failed')}: ${msg}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleCombo = async (index: number, enabled: boolean) => {
    const current = combos[index];
    if (!current || saving) return;
    const nextList = combos.map((item, idx) =>
      idx === index ? { ...item, disabled: !enabled } : item
    );
    setCombos(nextList);
    try {
      await combosApi.saveCombos(nextList);
      showNotification(
        enabled ? t('notification.config_enabled') : t('notification.config_disabled'),
        'success'
      );
    } catch (err: unknown) {
      setCombos(combos);
      const msg = err instanceof Error ? err.message : String(err);
      showNotification(`${t('notification.update_failed')}: ${msg}`, 'error');
    }
  };

  const handleDeleteCombo = (index: number) => {
    const target = combos[index];
    if (!target) return;
    showConfirmation({
      title: t('ai_providers.combos_delete_title', { defaultValue: 'Delete Combo' }),
      message: t('ai_providers.combos_delete_confirm', {
        name: target.name,
        defaultValue: `Are you sure you want to delete combo "${target.name}"?`,
      }),
      variant: 'danger',
      confirmText: t('common.delete'),
      onConfirm: async () => {
        try {
          const nextList = combos.filter((_, idx) => idx !== index);
          await combosApi.saveCombos(nextList);
          setCombos(nextList);
          showNotification(
            t('ai_providers.combos_deleted', { defaultValue: 'Combo deleted.' }),
            'success'
          );
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          showNotification(`${t('notification.delete_failed')}: ${msg}`, 'error');
        }
      },
    });
  };

  return (
    <Card
      title={t('ai_providers.combos_title', { defaultValue: 'Model Combos (Fallback & Load Balancing)' })}
      extra={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void loadCombos()}
            disabled={disabled || loading || saving}
          >
            {t('common.refresh', { defaultValue: 'Refresh' })}
          </Button>
          <Button size="sm" onClick={openAddModal} disabled={disabled || saving}>
            {t('ai_providers.combos_add_button', { defaultValue: 'Add Combo' })}
          </Button>
        </div>
      }
    >
      <div className="hint" style={{ marginBottom: 12 }}>
        {t('ai_providers.combos_hint', {
          defaultValue:
            'Combos define virtual model names that route across an ordered list of models using Fallback (failover on quota/5xx errors) or Round-Robin load balancing.',
        })}
      </div>

      {loading ? (
        <div className="hint">{t('common.loading')}</div>
      ) : combos.length === 0 ? (
        <EmptyState
          title={t('ai_providers.combos_empty_title', { defaultValue: 'No Model Combos Configured' })}
          description={t('ai_providers.combos_empty_desc', {
            defaultValue:
              'Create a combo to chain multiple models together with automatic failover or round-robin routing.',
          })}
          action={
            <Button size="sm" onClick={openAddModal} disabled={disabled || saving}>
              {t('ai_providers.combos_add_button', { defaultValue: 'Add Combo' })}
            </Button>
          }
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {combos.map((combo, index) => (
            <div
              key={`${combo.name}-${index}`}
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                padding: '10px 14px',
                borderRadius: 8,
                border: '1px solid var(--border-color, rgba(128,128,128,0.22))',
                opacity: combo.disabled ? 0.65 : 1,
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 220, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: 14, fontFamily: 'monospace' }}>{combo.name}</strong>
                  <span
                    className={`status-badge ${
                      combo.strategy === 'round-robin' ? 'success' : 'muted'
                    }`}
                  >
                    {combo.strategy === 'round-robin' ? 'Round-Robin' : 'Fallback'}
                  </span>
                  {combo.disabled && (
                    <span className="status-badge error">
                      {t('common.disabled', { defaultValue: 'Disabled' })}
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                  {combo.models.map((model, mIdx) => (
                    <span key={`${model}-${mIdx}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <code
                        style={{
                          padding: '2px 8px',
                          borderRadius: 4,
                          background: 'var(--bg-secondary, rgba(128,128,128,0.12))',
                          fontSize: 12,
                        }}
                      >
                        {model}
                      </code>
                      {mIdx < combo.models.length - 1 && (
                        <span style={{ opacity: 0.5, fontSize: 12 }}>
                          {combo.strategy === 'round-robin' ? '⇄' : '→'}
                        </span>
                      )}
                    </span>
                  ))}
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <ToggleSwitch
                  checked={!combo.disabled}
                  onChange={(enabled) => void handleToggleCombo(index, enabled)}
                  disabled={disabled || saving}
                  ariaLabel={`Toggle combo ${combo.name}`}
                />
                <Button
                  variant="secondary"
                  size="xs"
                  onClick={() => openEditModal(index)}
                  disabled={disabled || saving}
                >
                  {t('common.edit', { defaultValue: 'Edit' })}
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => handleDeleteCombo(index)}
                  disabled={disabled || saving}
                >
                  {t('common.delete', { defaultValue: 'Delete' })}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        open={modalOpen}
        title={
          editingIndex !== null
            ? t('ai_providers.combos_edit_title', { defaultValue: 'Edit Model Combo' })
            : t('ai_providers.combos_add_title', { defaultValue: 'Create Model Combo' })
        }
        onClose={handleCloseModal}
        width={640}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={handleCloseModal} disabled={saving}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={() => void handleSaveCombo()} loading={saving} disabled={disabled}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Input
            label={t('ai_providers.combos_name_label', { defaultValue: 'Combo Model Name' })}
            placeholder="e.g. coding-best, glm-or-claude"
            value={form.name}
            onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
            disabled={saving}
            hint={t('ai_providers.combos_name_hint', {
              defaultValue: 'Clients request this model name in /v1/chat/completions or /v1/responses.',
            })}
          />

          <div className="form-group">
            <label>{t('ai_providers.combos_strategy_label', { defaultValue: 'Routing Strategy' })}</label>
            <Select
              value={form.strategy}
              options={[
                {
                  value: 'fallback',
                  label: 'fallback (Try models in order; failover on error/quota)',
                },
                {
                  value: 'round-robin',
                  label: 'round-robin (Distribute requests evenly across models)',
                },
              ]}
              onChange={(value) =>
                setForm((prev) => ({
                  ...prev,
                  strategy: value === 'round-robin' ? 'round-robin' : 'fallback',
                }))
              }
              disabled={saving}
              ariaLabel="Combo Strategy"
            />
          </div>

          <div className="form-group">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <label style={{ margin: 0 }}>
                {t('ai_providers.combos_models_label', { defaultValue: 'Target Models (in order)' })}
              </label>
              <Button
                variant="secondary"
                size="xs"
                onClick={() => handleAddModelSlot('')}
                disabled={saving}
              >
                + {t('ai_providers.combos_add_model_slot', { defaultValue: 'Add Model' })}
              </Button>
            </div>

            {allModelNames.length > 0 && (
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <Select
                  value={quickPickModel}
                  options={allModelNames.map((m) => ({ value: m, label: m }))}
                  placeholder={t('ai_providers.combos_quick_pick_placeholder', {
                    defaultValue: 'Quick-add from configured models...',
                  })}
                  onChange={(value) => {
                    if (!value) return;
                    setQuickPickModel('');
                    setForm((prev) => {
                      const emptyIdx = prev.models.findIndex((m) => !m.trim());
                      if (emptyIdx >= 0) {
                        return {
                          ...prev,
                          models: prev.models.map((item, i) => (i === emptyIdx ? value : item)),
                        };
                      }
                      return { ...prev, models: [...prev.models, value] };
                    });
                  }}
                  disabled={saving}
                  ariaLabel="Quick pick model"
                />
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {form.models.map((model, idx) => (
                <div key={idx} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span style={{ width: 22, fontSize: 12, opacity: 0.65, textAlign: 'right' }}>
                    {idx + 1}.
                  </span>
                  <input
                    type="text"
                    className="input"
                    style={{ flex: 1 }}
                    placeholder="model-name (e.g. glm-4.7, mistral-large-latest)"
                    value={model}
                    onChange={(e) => handleModelChange(idx, e.target.value)}
                    disabled={saving}
                  />
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => handleMoveModelSlot(idx, -1)}
                    disabled={saving || idx === 0}
                    title="Move up"
                  >
                    ↑
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => handleMoveModelSlot(idx, 1)}
                    disabled={saving || idx === form.models.length - 1}
                    title="Move down"
                  >
                    ↓
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => handleRemoveModelSlot(idx)}
                    disabled={saving || form.models.length <= 1}
                  >
                    ✕
                  </Button>
                </div>
              ))}
            </div>
          </div>

          <ToggleSwitch
            label={t('ai_providers.combos_enabled_label', { defaultValue: 'Enable this combo' })}
            checked={!form.disabled}
            onChange={(enabled) => setForm((prev) => ({ ...prev, disabled: !enabled }))}
            disabled={saving}
          />
        </div>
      </Modal>
    </Card>
  );
}
