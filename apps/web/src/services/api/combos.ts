import { parseDocument } from 'yaml';
import { apiClient } from './client';
import { configFileApi } from './configFile';

export type ComboStrategy = 'fallback' | 'round-robin';

export interface ComboConfig {
  name: string;
  strategy: ComboStrategy;
  models: string[];
  disabled?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const normalizeComboConfig = (raw: unknown): ComboConfig | null => {
  if (!isRecord(raw)) return null;
  const name = String(raw.name ?? '').trim();
  if (!name) return null;
  const rawStrategy = String(raw.strategy ?? 'fallback')
    .trim()
    .toLowerCase();
  const strategy: ComboStrategy = rawStrategy === 'round-robin' ? 'round-robin' : 'fallback';
  const rawModels = Array.isArray(raw.models) ? raw.models : [];
  const models = rawModels.map((item) => String(item ?? '').trim()).filter(Boolean);
  const disabled = raw.disabled === true || String(raw.disabled).toLowerCase() === 'true';
  return {
    name,
    strategy,
    models,
    disabled,
  };
};

const extractCombosList = (data: unknown): ComboConfig[] => {
  const list = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.combos)
      ? data.combos
      : isRecord(data) && Array.isArray(data.items)
        ? data.items
        : [];
  return list.map(normalizeComboConfig).filter(Boolean) as ComboConfig[];
};

const serializeCombo = (combo: ComboConfig): Record<string, unknown> => ({
  name: combo.name.trim(),
  strategy: combo.strategy === 'round-robin' ? 'round-robin' : 'fallback',
  models: combo.models.map((m) => m.trim()).filter(Boolean),
  ...(combo.disabled ? { disabled: true } : {}),
});

export const combosApi = {
  async getCombos(): Promise<ComboConfig[]> {
    try {
      const data = await apiClient.get('/combos');
      return extractCombosList(data);
    } catch {
      try {
        const rawConfig = await apiClient.get('/config');
        if (isRecord(rawConfig) && Array.isArray(rawConfig.combos)) {
          return extractCombosList(rawConfig.combos);
        }
      } catch {
        // Fallback to YAML
      }
      try {
        const yamlText = await configFileApi.fetchConfigYaml();
        if (!yamlText.trim()) return [];
        const doc = parseDocument(yamlText);
        const parsed = doc.toJS() as unknown;
        if (isRecord(parsed) && Array.isArray(parsed.combos)) {
          return extractCombosList(parsed.combos);
        }
      } catch {
        // Ignore fallback failure
      }
      return [];
    }
  },

  async saveCombos(combos: ComboConfig[]): Promise<ComboConfig[]> {
    const serialized = combos.map(serializeCombo);
    try {
      const response = await apiClient.put('/combos', { combos: serialized });
      return extractCombosList(response).length ? extractCombosList(response) : combos;
    } catch {
      const yamlText = await configFileApi.fetchConfigYaml();
      const doc = parseDocument(yamlText || '{}\n');
      if (serialized.length > 0) {
        doc.set('combos', serialized);
      } else {
        doc.delete('combos');
      }
      await configFileApi.saveConfigYaml(doc.toString());
      return combos;
    }
  },

  async upsertCombo(combo: ComboConfig, existingCombos?: ComboConfig[]): Promise<ComboConfig[]> {
    try {
      await apiClient.post('/combos', serializeCombo(combo));
      return await combosApi.getCombos();
    } catch {
      const current = existingCombos ?? (await combosApi.getCombos());
      const next = [...current];
      const index = next.findIndex((item) => item.name.toLowerCase() === combo.name.toLowerCase());
      if (index >= 0) {
        next[index] = combo;
      } else {
        next.push(combo);
      }
      return await combosApi.saveCombos(next);
    }
  },

  async deleteCombo(name: string, existingCombos?: ComboConfig[]): Promise<ComboConfig[]> {
    try {
      await apiClient.delete(`/combos?name=${encodeURIComponent(name.trim())}`);
      return await combosApi.getCombos();
    } catch {
      const current = existingCombos ?? (await combosApi.getCombos());
      const next = current.filter((item) => item.name.toLowerCase() !== name.trim().toLowerCase());
      return await combosApi.saveCombos(next);
    }
  },
};
