import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { SegmentedTabs } from '@/components/ui/SegmentedTabs';
import { usePanelFeatureAvailability } from '@/hooks/usePanelFeatureAvailability';
import { apiKeysApi } from '@/services/api/apiKeys';
import {
  modelExposureApi,
  type ApiKeyPolicy,
  type CursorModelAlias,
  type ModelCatalog,
  type ModelExposureConfig,
} from '@/services/api/modelExposure';
import { usageServiceApi } from '@/services/api/usageService';
import { useAuthStore } from '@/stores';
import { getErrorMessage } from '@/utils/helpers';
import { ExposureTab } from './ExposureTab';
import { CursorAliasesTab } from './CursorAliasesTab';
import { KeyAccessTab } from './KeyAccessTab';
import { SpendGuardTab } from './SpendGuardTab';
import styles from './ModelsPage.module.scss';

export type ModelsTab = 'exposure' | 'aliases' | 'access' | 'spend';

const isModelsTab = (value: string | null): value is ModelsTab =>
  value === 'exposure' || value === 'aliases' || value === 'access' || value === 'spend';

export interface ModelsData {
  catalog: ModelCatalog;
  exposure: ModelExposureConfig;
  aliases: CursorModelAlias[];
  policies: ApiKeyPolicy[];
  apiKeys: string[];
  /** sha256(api key) -> CPAM alias label, when the manager service provides them. */
  keyLabels: Record<string, string>;
}

function useKeyLabels(): Record<string, string> {
  const availability = usePanelFeatureAvailability();
  const managementKey = useAuthStore((state) => state.managementKey);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const serviceBase =
    !availability.checking &&
    availability.panelHostConfirmed &&
    availability.panelHostMode === 'manager_embedded' &&
    availability.managerServiceAvailable
      ? availability.managerServiceBase
      : '';

  useEffect(() => {
    if (!serviceBase) return;
    let cancelled = false;
    usageServiceApi
      .getApiKeyAliases(serviceBase, managementKey)
      .then((response) => {
        if (cancelled) return;
        const next: Record<string, string> = {};
        (response.items ?? []).forEach((item) => {
          const hash = String(item.apiKeyHash || '')
            .trim()
            .toLowerCase();
          const alias = String(item.alias || '').trim();
          if (hash && alias) next[hash] = alias;
        });
        setLabels(next);
      })
      .catch(() => {
        if (!cancelled) setLabels({});
      });
    return () => {
      cancelled = true;
    };
  }, [managementKey, serviceBase]);

  return serviceBase ? labels : {};
}

export function ModelsPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const activeTab: ModelsTab = isModelsTab(tabParam) ? tabParam : 'exposure';
  const keyLabels = useKeyLabels();
  const [data, setData] = useState<Omit<ModelsData, 'keyLabels'> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [catalog, exposure, aliases, policies, apiKeys] = await Promise.all([
        modelExposureApi.getCatalog(),
        modelExposureApi.getExposure(),
        modelExposureApi.getCursorAliases(),
        modelExposureApi.getKeyPolicies(),
        apiKeysApi.list(),
      ]);
      setData({ catalog, exposure, aliases, policies, apiKeys });
      setRevision((value) => value + 1);
    } catch (err) {
      setError(getErrorMessage(err, t('model_exposure.load_failed')));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const changeTab = (tab: ModelsTab) => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', tab);
    if (tab !== 'access') next.delete('key');
    setSearchParams(next, { replace: true });
  };

  const tabs = [
    { id: 'exposure' as const, label: t('model_exposure.tab_exposure') },
    { id: 'aliases' as const, label: t('model_exposure.tab_aliases') },
    { id: 'access' as const, label: t('model_exposure.tab_access') },
    { id: 'spend' as const, label: t('spend_guard.tab') },
  ];

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <SegmentedTabs
          items={tabs}
          activeTab={activeTab}
          onChange={changeTab}
          ariaLabel={t('model_exposure.title')}
          idBase="models-tabs"
          className={styles.tabs}
          equalWidth
        />
        {activeTab !== 'spend' ? (
          <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading}>
            {t('model_exposure.reload')}
          </Button>
        ) : null}
      </div>

      {activeTab !== 'spend' && error ? <div className={styles.errorBox}>{error}</div> : null}

      {activeTab === 'spend' ? (
        <SpendGuardTab />
      ) : !data ? (
        loading ? (
          <LoadingSpinner />
        ) : null
      ) : activeTab === 'exposure' ? (
        <ExposureTab key={revision} data={{ ...data, keyLabels }} onSaved={load} />
      ) : activeTab === 'aliases' ? (
        <CursorAliasesTab key={revision} data={{ ...data, keyLabels }} onSaved={load} />
      ) : (
        <KeyAccessTab
          key={revision}
          data={{ ...data, keyLabels }}
          onSaved={load}
          focusKeyHash={searchParams.get('key') ?? ''}
        />
      )}
    </div>
  );
}
