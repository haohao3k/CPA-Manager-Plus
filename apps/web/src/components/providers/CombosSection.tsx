import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AutocompleteInput } from '@/components/ui/AutocompleteInput';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { getTypeLabel, normalizeProviderKey } from '@/features/authFiles/constants';
import { authFilesApi, combosApi, type ComboConfig, type ComboStrategy } from '@/services/api';
import { useNotificationStore } from '@/stores';
import type { AuthFileItem } from '@/types';

interface CombosSectionProps {
  disabled?: boolean;
  allModelNames?: string[];
  files?: AuthFileItem[];
}

interface DiscoveredComboModel {
  id: string;
  provider: string;
  providerLabel: string;
  displayName?: string;
}

interface ComboFormState {
  name: string;
  strategy: ComboStrategy;
  models: string[];
  disabled: boolean;
}

const EMPTY_MODEL_NAMES: string[] = [];

const buildEmptyComboForm = (): ComboFormState => ({
  name: '',
  strategy: 'fallback',
  models: [''],
  disabled: false,
});

export function CombosSection({
  disabled = false,
  allModelNames = EMPTY_MODEL_NAMES,
  files: propFiles,
}: CombosSectionProps) {
  const { t } = useTranslation();
  const { showNotification, showConfirmation } = useNotificationStore();

  const [combos, setCombos] = useState<ComboConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [form, setForm] = useState<ComboFormState>(buildEmptyComboForm);
  const [quickPickModel, setQuickPickModel] = useState('');
  const [discoveredModels, setDiscoveredModels] = useState<DiscoveredComboModel[]>([]);
  const [providerFilter, setProviderFilter] = useState<string>('all');

  const propFilesRef = useRef(propFiles);
  propFilesRef.current = propFiles;
  const allModelNamesRef = useRef(allModelNames);
  allModelNamesRef.current = allModelNames;
  const tRef = useRef(t);
  tRef.current = t;

  const filesFingerprint = useMemo(
    () =>
      (propFiles ?? [])
        .map((f) => `${f.name}:${f.disabled ? 1 : 0}:${f.type ?? ''}:${f.provider ?? ''}`)
        .join('|'),
    [propFiles]
  );
  const modelNamesFingerprint = useMemo(() => allModelNames.join('|'), [allModelNames]);

  const loadDiscoveredModels = useCallback(async () => {
    try {
      let authFiles = propFilesRef.current;
      if (!authFiles || authFiles.length === 0) {
        const res = await authFilesApi.list();
        authFiles = res.files || [];
      }

      const activeFiles = authFiles.filter((f) => !f.disabled);
      const activeProviders = new Set<string>();
      activeFiles.forEach((f) => {
        const raw = String(f.type || f.provider || '').trim();
        const key = normalizeProviderKey(raw);
        if (key && key !== 'unknown' && key !== 'empty') {
          activeProviders.add(key);
        }
      });

      const collected: DiscoveredComboModel[] = [];
      const seen = new Set<string>();

      const addModel = (id: string, provider: string, displayName?: string) => {
        const trimmed = id.trim();
        if (!trimmed) return;
        const dedupKey = `${provider}:${trimmed}`;
        if (seen.has(dedupKey)) return;
        seen.add(dedupKey);
        collected.push({
          id: trimmed,
          provider,
          providerLabel:
            provider === 'api-provider'
              ? 'API Provider'
              : provider === 'alias'
                ? 'OAuth Alias'
                : getTypeLabel(tRef.current, provider),
          displayName,
        });
      };

      // 1. Load models per active auth file + static definitions per active OAuth provider
      await Promise.allSettled([
        ...activeFiles.map(async (file) => {
          const provider = normalizeProviderKey(String(file.type || file.provider || ''));
          if (!provider) return;
          try {
            const fileModels = await authFilesApi.getModelsForAuthFile(file.name);
            fileModels.forEach((m) => addModel(m.id, provider, m.display_name));
          } catch {
            // Fallback to provider model definitions below
          }
        }),
        ...Array.from(activeProviders).map(async (provider) => {
          const channel = provider === 'gemini-cli' ? 'gemini' : provider;
          try {
            const defs = await authFilesApi.getModelDefinitions(channel);
            defs.forEach((m) => addModel(m.id, provider, m.display_name));
          } catch {
            // Ignore unsupported static definition channels
          }
        }),
        (async () => {
          try {
            const aliasMap = await authFilesApi.getOauthModelAlias();
            Object.entries(aliasMap || {}).forEach(([prov, entries]) => {
              const normProv = normalizeProviderKey(prov) || 'alias';
              (entries || []).forEach((entry) => {
                if (entry.alias) {
                  addModel(entry.alias, normProv, `${entry.alias} -> ${entry.name}`);
                }
              });
            });
          } catch {
            // Ignore if alias endpoint is unavailable
          }
        })(),
      ]);

      // 2. Include API-key provider models passed via props
      allModelNamesRef.current.forEach((name) => addModel(name, 'api-provider'));

      setDiscoveredModels(collected);
    } catch {
      // Ignore discovery errors
    }
  }, [filesFingerprint, modelNamesFingerprint]);

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

  useEffect(() => {
    void loadDiscoveredModels();
  }, [loadDiscoveredModels]);

  const providerCounts = useMemo(() => {
    const counts = new Map<string, { label: string; count: number }>();
    discoveredModels.forEach((m) => {
      const cur = counts.get(m.provider);
      if (cur) {
        cur.count += 1;
      } else {
        counts.set(m.provider, { label: m.providerLabel, count: 1 });
      }
    });
    return Array.from(counts.entries()).map(([provider, info]) => ({
      provider,
      label: info.label,
      count: info.count,
    }));
  }, [discoveredModels]);

  const filteredCatalogModels = useMemo(() => {
    if (providerFilter === 'all') return discoveredModels;
    return discoveredModels.filter((m) => m.provider === providerFilter);
  }, [discoveredModels, providerFilter]);

  const autocompleteOptions = useMemo(() => {
    const uniqueById = new Map<string, { value: string; label?: string }>();
    discoveredModels.forEach((m) => {
      const existing = uniqueById.get(m.id);
      const tag = m.displayName && m.displayName !== m.id ? `${m.providerLabel} · ${m.displayName}` : m.providerLabel;
      if (!existing) {
        uniqueById.set(m.id, { value: m.id, label: tag });
      } else if (existing.label && !existing.label.includes(m.providerLabel)) {
        existing.label = `${existing.label} / ${m.providerLabel}`;
      }
    });
    return Array.from(uniqueById.values());
  }, [discoveredModels]);

  const quickPickModelToForm = useCallback((modelId: string) => {
    if (!modelId) return;
    setForm((prev) => {
      const emptyIdx = prev.models.findIndex((m) => !m.trim());
      if (emptyIdx >= 0) {
        return {
          ...prev,
          models: prev.models.map((item, i) => (i === emptyIdx ? modelId : item)),
        };
      }
      return { ...prev, models: [...prev.models, modelId] };
    });
  }, []);

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
            onClick={() => {
              void loadCombos();
              void loadDiscoveredModels();
            }}
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
            'Combos define virtual model names that route across an ordered list of models from your OAuth accounts (Cursor, Mistral, Z.AI GLM, OpenCode Go, Codex, Claude...) or API keys using Fallback (automatic failover on quota/429/5xx errors) or Round-Robin load balancing.',
        })}
      </div>

      {providerCounts.length > 0 && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
            alignItems: 'center',
            marginBottom: 14,
            padding: '8px 12px',
            borderRadius: 8,
            background: 'var(--bg-secondary, rgba(128,128,128,0.08))',
            fontSize: 12,
          }}
        >
          <span style={{ opacity: 0.75, fontWeight: 500 }}>
            {t('ai_providers.combos_detected_sources', {
              defaultValue: 'Detected OAuth & Provider Models:',
            })}
          </span>
          {providerCounts.map((item) => (
            <span
              key={item.provider}
              className="status-badge muted"
              style={{ fontSize: 11, padding: '2px 8px' }}
            >
              {item.label}: {item.count}
            </span>
          ))}
        </div>
      )}

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
                + {t('ai_providers.combos_add_model_slot', { defaultValue: 'Add Model Slot' })}
              </Button>
            </div>

            {discoveredModels.length > 0 && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  marginBottom: 12,
                  padding: 10,
                  borderRadius: 8,
                  border: '1px solid var(--border-color, rgba(128,128,128,0.2))',
                  background: 'var(--bg-secondary, rgba(128,128,128,0.06))',
                }}
              >
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                  <span style={{ fontSize: 12, opacity: 0.75, marginRight: 4 }}>
                    {t('ai_providers.combos_filter_provider', {
                      defaultValue: 'Pick from OAuth / Providers:',
                    })}
                  </span>
                  <button
                    type="button"
                    onClick={() => setProviderFilter('all')}
                    style={{
                      padding: '2px 8px',
                      borderRadius: 999,
                      fontSize: 11,
                      cursor: 'pointer',
                      border: '1px solid var(--border-color, rgba(128,128,128,0.3))',
                      background:
                        providerFilter === 'all'
                          ? 'var(--primary-color, #2563eb)'
                          : 'transparent',
                      color: providerFilter === 'all' ? '#fff' : 'inherit',
                    }}
                  >
                    All ({discoveredModels.length})
                  </button>
                  {providerCounts.map((item) => (
                    <button
                      key={item.provider}
                      type="button"
                      onClick={() => setProviderFilter(item.provider)}
                      style={{
                        padding: '2px 8px',
                        borderRadius: 999,
                        fontSize: 11,
                        cursor: 'pointer',
                        border: '1px solid var(--border-color, rgba(128,128,128,0.3))',
                        background:
                          providerFilter === item.provider
                            ? 'var(--primary-color, #2563eb)'
                            : 'transparent',
                        color: providerFilter === item.provider ? '#fff' : 'inherit',
                      }}
                    >
                      {item.label} ({item.count})
                    </button>
                  ))}
                </div>

                <div style={{ display: 'flex', gap: 8 }}>
                  <Select
                    value={quickPickModel}
                    options={filteredCatalogModels.map((m) => ({
                      value: m.id,
                      label: `[${m.providerLabel}] ${m.id}${
                        m.displayName && m.displayName !== m.id ? ` (${m.displayName})` : ''
                      }`,
                    }))}
                    placeholder={t('ai_providers.combos_quick_pick_placeholder', {
                      defaultValue: 'Quick-add model from connected OAuth / Providers...',
                    })}
                    onChange={(value) => {
                      if (!value) return;
                      setQuickPickModel('');
                      quickPickModelToForm(value);
                    }}
                    disabled={saving}
                    ariaLabel="Quick pick model"
                  />
                </div>

                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 6,
                    maxHeight: 132,
                    overflowY: 'auto',
                    paddingTop: 2,
                  }}
                >
                  {filteredCatalogModels.map((m) => {
                    const alreadyInCombo = form.models.some(
                      (item) => item.trim().toLowerCase() === m.id.toLowerCase()
                    );
                    return (
                      <button
                        key={`${m.provider}:${m.id}`}
                        type="button"
                        onClick={() => quickPickModelToForm(m.id)}
                        disabled={saving}
                        title={`Add ${m.id} (${m.providerLabel})`}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                          padding: '3px 8px',
                          borderRadius: 6,
                          fontSize: 11,
                          fontFamily: 'monospace',
                          cursor: 'pointer',
                          border: alreadyInCombo
                            ? '1px solid var(--primary-color, #2563eb)'
                            : '1px solid var(--border-color, rgba(128,128,128,0.25))',
                          background: alreadyInCombo
                            ? 'rgba(37, 99, 235, 0.14)'
                            : 'var(--bg-primary, rgba(255,255,255,0.04))',
                          color: 'inherit',
                        }}
                      >
                        <span style={{ opacity: 0.6, fontFamily: 'sans-serif' }}>
                          [{m.providerLabel}]
                        </span>
                        <span>{m.id}</span>
                        <span style={{ opacity: 0.7 }}>+</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {form.models.map((model, idx) => (
                <div key={idx} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span style={{ width: 22, fontSize: 12, opacity: 0.65, textAlign: 'right' }}>
                    {idx + 1}.
                  </span>
                  <AutocompleteInput
                    wrapperStyle={{ flex: 1, marginBottom: 0 }}
                    placeholder="model-name (e.g. cursor-claude-sonnet-4-5, mistral-large-latest, glm-5.3)"
                    value={model}
                    onChange={(value) => handleModelChange(idx, value)}
                    disabled={saving}
                    options={autocompleteOptions}
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
