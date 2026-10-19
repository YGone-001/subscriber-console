/*
 * Candidate detail drawer.
 *
 * The overlay detail surface for one observed candidate. It replaces the
 * row-level action cluster so the candidate queue stays compact, and it is the
 * one place where the follow-up actions for a candidate live:
 *
 *   link / unlink   -> discovery metadata only; Inventory stays authoritative
 *   monitoring       -> the authoritative association projection (read-only)
 *   onboarding       -> governed runtime bootstrap preview (server-decided)
 *
 * Onboarding eligibility rules: matching by NF type is a search hint
 * only. A component the server marks monitoring-not-supported is never
 * selectable; several components sharing one NF type require an explicit
 * operator selection (no silent batch); the preview service remains the final
 * eligibility authority for running / verified state.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Link2, Link2Off, ShieldCheck, X } from 'lucide-react';
import { Field } from '../../components/ui/Field';
import { useDialogFocus } from '../../components/ui/useDialogFocus';
import { useI18n } from '../../providers/I18nProvider';
import type { RuntimeComponent } from '../runtime/runtime-types';
import type { NfObservation } from './discovery-types';
import { formatTimestamp, observationLabel } from './discovery-view-model';
import styles from '../../styles/modules/discovery.module.css';

type Props = {
  candidate: NfObservation;
  runtimeComponents: RuntimeComponent[];
  runtimeUnavailable: boolean;
  canConfigure: boolean;
  busy: boolean;
  linkError: string | null;
  onClose: () => void;
  onLink: (resourceId: string) => void;
  onUnlink: () => void;
  onBootstrap: (componentIds: string[]) => void;
};

export function CandidateDetailDrawer({
  candidate,
  runtimeComponents,
  runtimeUnavailable,
  canConfigure,
  busy,
  linkError,
  onClose,
  onLink,
  onUnlink,
  onBootstrap,
}: Props) {
  const { t } = useI18n();
  const dialogRef = useDialogFocus({ open: true, onClose });
  const [linkResourceId, setLinkResourceId] = useState('');

  // Server-recognized components carrying the same canonical NF type. The match
  // is a search hint; identity conclusions belong to the preview service.
  const matched = useMemo(
    () =>
      runtimeComponents.filter(
        (component) => Boolean(component.nfType) && component.nfType === candidate.nfType,
      ),
    [runtimeComponents, candidate.nfType],
  );
  const selectable = useMemo(
    () => matched.filter((component) => component.monitoring.state === 'supported'),
    [matched],
  );
  // One unambiguous match is preselected; several matches require an explicit
  // choice so no nfType batch is ever applied silently.
  const [selected, setSelected] = useState<string[]>(() =>
    matched.length === 1 && selectable.length === 1 ? [selectable[0].componentId] : [],
  );

  // Runtime observations can arrive after the drawer opens. Reconcile the
  // selection when the eligible component set changes without silently
  // selecting one component out of an ambiguous NF-type match.
  useEffect(() => {
    setSelected((current) => {
      const eligible = new Set(selectable.map((component) => component.componentId));
      const retained = current.filter((componentId) => eligible.has(componentId));
      if (retained.length > 0) {
        return retained.length === current.length ? current : retained;
      }
      return matched.length === 1 && selectable.length === 1
        ? [selectable[0].componentId]
        : [];
    });
  }, [matched.length, selectable]);

  const association = candidate.monitoringAssociation;
  const toggleComponent = (componentId: string) => {
    setSelected((current) =>
      current.includes(componentId)
        ? current.filter((id) => id !== componentId)
        : [...current, componentId],
    );
  };

  return (
    <div className={styles.drawerLayer}>
      <div
        className={styles.drawer}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="candidate-detail-title"
        tabIndex={-1}
      >
        <header className={styles.drawerHead}>
          <div>
            <h3 id="candidate-detail-title" className={styles.detailTitle}>{candidate.nfType}</h3>
            <p className={styles.detailSub}>
              {observationLabel(candidate.observationState, t)} &middot;{' '}
              <code>{candidate.nfStatus}</code>
            </p>
          </div>
          <button type="button" className={styles.detailClose} onClick={onClose} aria-label={t('close')}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div className={styles.drawerBody}>
          <section className={styles.drawerSection} aria-label={t('discovery_detail_identity')}>
            <h4 className={styles.drawerSectionTitle}>{t('discovery_detail_identity')}</h4>
            <dl className={styles.detailList}>
              <div>
                <dt>{t('discovery_col_instance')}</dt>
                <dd><code className={styles.uuid}>{candidate.externalNfInstanceId}</code></dd>
              </div>
              <div>
                <dt>{t('discovery_col_source')}</dt>
                <dd><code className={styles.uuid}>{candidate.sourceId}</code></dd>
              </div>
              {candidate.fqdn ? (
                <div>
                  <dt>{t('discovery_col_fqdn')}</dt>
                  <dd>{candidate.fqdn}</dd>
                </div>
              ) : null}
              {candidate.ipv4Addresses?.length ? (
                <div>
                  <dt>IPv4</dt>
                  <dd>{candidate.ipv4Addresses.join(', ')}</dd>
                </div>
              ) : null}
              {candidate.plmnList?.length ? (
                <div>
                  <dt>{t('discovery_col_plmn')}</dt>
                  <dd>
                    {candidate.plmnList
                      .map((plmn) => `${plmn.mcc}-${plmn.mnc}`)
                      .join(', ')}
                  </dd>
                </div>
              ) : null}
              {candidate.sNssaiList?.length ? (
                <div>
                  <dt>{t('discovery_col_snssai')}</dt>
                  <dd>
                    {candidate.sNssaiList
                      .map((snssai) => (snssai.sd ? `${snssai.sst}-${snssai.sd}` : String(snssai.sst)))
                      .join(', ')}
                  </dd>
                </div>
              ) : null}
              {candidate.heartBeatTimer ? (
                <div>
                  <dt>{t('discovery_col_heartbeat')}</dt>
                  <dd>{candidate.heartBeatTimer}</dd>
                </div>
              ) : null}
              <div>
                <dt>{t('discovery_col_first_seen')}</dt>
                <dd>{formatTimestamp(candidate.firstSeenAt)}</dd>
              </div>
              <div>
                <dt>{t('discovery_col_last_seen')}</dt>
                <dd>{formatTimestamp(candidate.lastSeenAt)}</dd>
              </div>
              <div>
                <dt>{t('discovery_col_revision')}</dt>
                <dd>r{candidate.revision}</dd>
              </div>
            </dl>
            <p className={styles.viewNote}>{t('discovery_observation_not_health')}</p>
          </section>

          <section className={styles.drawerSection} aria-label={t('discovery_detail_endpoints_section')}>
            <h4 className={styles.drawerSectionTitle}>{t('discovery_detail_endpoints_section')}</h4>
            {candidate.observedEndpoints.length === 0 ? (
              <p className={styles.viewNote}>{t('discovery_detail_no_endpoints')}</p>
            ) : (
              <ul className={styles.miniList}>
                {candidate.observedEndpoints.map((endpoint, index) => (
                  <li key={`${endpoint.serviceName ?? 'endpoint'}-${index}`}>
                    <code>
                      {[
                        endpoint.serviceName,
                        endpoint.scheme,
                        endpoint.address,
                        endpoint.port ? String(endpoint.port) : undefined,
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    </code>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className={styles.drawerSection} aria-label={t('discovery_detail_services_section')}>
            <h4 className={styles.drawerSectionTitle}>{t('discovery_detail_services_section')}</h4>
            {candidate.observedServices.length === 0 ? (
              <p className={styles.viewNote}>{t('discovery_detail_no_services')}</p>
            ) : (
              <ul className={styles.miniList}>
                {candidate.observedServices.map((service) => (
                  <li key={service.serviceName}>
                    <code>{service.serviceName}</code>
                    {service.status ? ` - ${service.status}` : ''}
                    {service.apiVersions?.length ? ` (${service.apiVersions.join(', ')})` : ''}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className={styles.drawerSection} aria-label={t('discovery_detail_monitoring_section')}>
            <h4 className={styles.drawerSectionTitle}>{t('discovery_detail_monitoring_section')}</h4>
            {!candidate.linkedResourceId ? (
              <p className={styles.viewNote}>{t('discovery_monitoring_requires_link')}</p>
            ) : association?.state === 'monitored' ? (
              <p className={styles.viewNote}>
                {t('discovery_monitored')}
                {association.targetId ? (
                  <>
                    {' '}
                    <Link to={`/nf-health/${encodeURIComponent(association.targetId)}`}>
                      {t('discovery_detail_monitoring_target')}
                    </Link>
                  </>
                ) : null}
              </p>
            ) : association?.state === 'unmonitored' ? (
              <p className={styles.viewNote}>{t('discovery_unmonitored')}</p>
            ) : (
              <p className={styles.viewNote}>{t('discovery_monitoring_unresolved_note')}</p>
            )}
          </section>

          <section className={styles.drawerSection} aria-label={t('discovery_link_section')}>
            <h4 className={styles.drawerSectionTitle}>{t('discovery_link_section')}</h4>
            {candidate.linkedResourceId ? (
              <>
                <p className={styles.viewNote}>
                  <code className={styles.uuid}>{candidate.linkedResourceId}</code>
                </p>
                <div className={styles.entryList}>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={onUnlink}
                    disabled={!canConfigure || busy}
                  >
                    <Link2Off size={14} aria-hidden="true" />
                    {t('discovery_unlink_action')}
                  </button>
                </div>
              </>
            ) : (
              <>
                <Field
                  htmlFor="candidate-link-resource"
                  label={t('discovery_link_resource')}
                  description={t('discovery_link_resource_hint')}
                  error={linkError ?? undefined}
                >
                  <input
                    id="candidate-link-resource"
                    className="form-input"
                    value={linkResourceId}
                    onChange={(event) => setLinkResourceId(event.target.value)}
                    disabled={busy}
                    placeholder="00000000-0000-4000-8000-000000000000"
                  />
                </Field>
                <div className={styles.entryList}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => onLink(linkResourceId.trim())}
                    disabled={!canConfigure || busy || linkResourceId.trim().length === 0}
                  >
                    <Link2 size={14} aria-hidden="true" />
                    {t('discovery_link_confirm')}
                  </button>
                </div>
                <p className={styles.viewNote}>{t('discovery_link_intro')}</p>
              </>
            )}
          </section>

          <section className={styles.drawerSection} aria-label={t('discovery_runtime_onboarding_title')}>
            <h4 className={styles.drawerSectionTitle}>{t('discovery_runtime_onboarding_title')}</h4>
            <p className={styles.viewNote}>{t('discovery_runtime_onboarding_note')}</p>

            {runtimeUnavailable ? (
              <p className={styles.viewNote}>{t('discovery_runtime_onboarding_unavailable')}</p>
            ) : matched.length === 0 ? (
              <p className={styles.viewNote}>{t('discovery_runtime_onboarding_empty')}</p>
            ) : (
              <>
                {selectable.length > 1 ? (
                  <p className={styles.viewNote}>
                    {t('discovery_runtime_onboarding_ambiguous', { count: selectable.length })}
                  </p>
                ) : null}
                <ul className={styles.componentPick}>
                  {matched.map((component) => {
                    const supported = component.monitoring.state === 'supported';
                    return (
                      <li key={component.componentId}>
                        <label className={supported ? undefined : styles.pickDisabled}>
                          <input
                            type="checkbox"
                            checked={selected.includes(component.componentId)}
                            onChange={() => toggleComponent(component.componentId)}
                            disabled={!supported || !canConfigure || busy}
                          />
                          <span className={styles.pickName}>{component.displayName}</span>
                          <code className={styles.pickProcess}>{component.processName}</code>
                          <span className={styles.pickStatus}>
                            {t(`runtime_status_${component.runtimeStatus}`)}
                          </span>
                        </label>
                        {!supported ? (
                          <p className={styles.viewNote}>
                            {t('discovery_runtime_onboarding_not_supported')}
                            {component.monitoring.reason ? ` (${component.monitoring.reason})` : ''}
                          </p>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
                <div className={styles.entryList}>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => onBootstrap(selected)}
                    disabled={!canConfigure || busy || selected.length === 0}
                    title={t('discovery_runtime_onboarding_title')}
                  >
                    <ShieldCheck size={14} aria-hidden="true" />
                    {t('discovery_runtime_onboarding_preview')}
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

export default CandidateDetailDrawer;
