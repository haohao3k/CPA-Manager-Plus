import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import styles from './ModelsPage.module.scss';

/** Pointer from the Accounts Cursor view to the spend guard settings and live status. */
export function CursorSpendGuardLink() {
  const { t } = useTranslation();
  return (
    <div className={`${styles.infoBox} ${styles.linkBanner}`} data-testid="cursor-spend-guard-link">
      <span>{t('spend_guard.accounts_hint')}</span>
      <Link className="btn btn-secondary btn-xs" to="/models?tab=spend">
        <span>{t('spend_guard.accounts_link')}</span>
      </Link>
    </div>
  );
}
