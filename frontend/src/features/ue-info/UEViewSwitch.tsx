import { useLocation, useNavigate } from 'react-router-dom';
import { ViewSwitch } from '../../components/ui/ViewSwitch';
import { useI18n } from '../../providers/I18nProvider';

export function UEViewSwitch() {
  const { t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  return <ViewSwitch ariaLabel={t('ims_view_label')} value={location.pathname === '/ims-registrations' ? 'ims' : 'ue'} options={[{ value: 'ue', label: t('ims_view_epc') }, { value: 'ims', label: t('ims_title') }]} onChange={(value) => navigate(value === 'ims' ? '/ims-registrations' : '/ue-info')} />;
}
