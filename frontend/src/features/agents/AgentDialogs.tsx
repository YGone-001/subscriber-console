import { useState, type FormEvent } from 'react';
import { Check, Copy, KeyRound, X } from 'lucide-react';
import { Dialog } from '../../components/ui/Dialog';
import { Field } from '../../components/ui/Field';
import { copyText } from '../../lib/clipboard';
import { useI18n } from '../../providers/I18nProvider';
import { createAgent, updateAgent, type Agent, type AgentCredential } from './agents-api';
import { metadataFromForm } from './agents-model';
import styles from '../../styles/modules/agents.module.css';

type EditorProps = {
  agent?: Agent;
  onClose: () => void;
  onChanged: () => void;
  onCredential: (value: AgentCredential) => void;
};
export function AgentEditor({ agent, onClose, onChanged, onCredential }: EditorProps) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const metadata = metadataFromForm(form);
    setBusy(true); setError('');
    try {
      if (agent) {
        await updateAgent(agent.agentId, { ...metadata, expectedRevision: agent.revision, enabled: agent.enabled });
      } else {
        const credential = await createAgent(metadata);
        onCredential(credential);
      }
      onChanged(); onClose();
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
      setError(t(code === 'AGENT_REVISION_CONFLICT' ? 'agents_err_conflict' : 'agents_err_save'));
    } finally { setBusy(false); }
  }
  const fields = [
    ['name', 'agents_name', agent?.name ?? '', true, 128],
    ['networkKey', 'agents_network_key', agent?.scope.networkKey ?? '', true, 64],
    ['operatorName', 'agents_operator', agent?.scope.operatorName ?? '', false, 128],
    ['plmns', 'agents_plmns', agent?.scope.plmns.join(', ') ?? '', false, 128],
    ['siteResourceId', 'agents_site', agent?.scope.siteResourceId ?? '', false, 36],
    ['hostResourceId', 'agents_host_resource', agent?.scope.hostResourceId ?? '', false, 36],
  ] as const;
  return <Dialog open onClose={onClose} ariaLabel={t(agent ? 'agents_edit' : 'agents_create')} overlayClassName="modal-overlay" className="modal-content">
    <form className={styles.dialog} onSubmit={(event) => { void submit(event); }}>
      <header className={styles.dialogHead}>
        <h2>{t(agent ? 'agents_edit' : 'agents_create')}</h2>
        <button className="btn btn-ghost" type="button" onClick={onClose} aria-label={t('close')} disabled={busy}><X size={18} /></button>
      </header>
      <p className={styles.hint}>{t('agents_scope_hint')}</p>
      <div className={styles.formGrid}>{fields.map(([key, label, initial, required, maxLength]) =>
        <Field key={key} label={t(label)} description={t(`agents_field_${key}`)}>
          <input className="input" name={key} defaultValue={initial} required={required} maxLength={maxLength}
            pattern={key === 'networkKey' ? '[a-z0-9][a-z0-9._-]{0,63}' : undefined} autoComplete="off" disabled={busy} />
        </Field>,
      )}</div>
      {error ? <p role="alert" className={styles.error}>{error}</p> : null}
      <footer className={styles.dialogActions}>
        <button className="btn btn-secondary" type="button" onClick={onClose} disabled={busy}>{t('cancel')}</button>
        <button className="btn btn-primary" type="submit" disabled={busy}>{t(busy ? 'loading' : 'save')}</button>
      </footer>
    </form>
  </Dialog>;
}

export function CredentialDialog({ credential, onClose }: { credential: AgentCredential; onClose: () => void }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  async function copy() {
    const ok = await copyText(credential.token);
    setCopied(ok); setCopyFailed(!ok);
  }
  return <Dialog open onClose={onClose} ariaLabel={t('agents_credential_title')} overlayClassName="modal-overlay" className="modal-content" closeOnOverlay={false}>
    <div className={styles.dialog}>
      <header className={styles.dialogHead}><h2><KeyRound size={18} /> {t('agents_credential_title')}</h2>
        <button className="btn btn-ghost" onClick={onClose} aria-label={t('close')}><X size={18} /></button>
      </header>
      <p>{t('agents_credential_once')}</p>
      <Field label={t('agents_id')}><code className={styles.secret}>{credential.agent.agentId}</code></Field>
      <Field label={t('agents_credential')}><code className={styles.secret}>{credential.token}</code></Field>
      <button className="btn btn-secondary" onClick={() => { void copy(); }}>{copied ? <Check size={16} /> : <Copy size={16} />}{t(copied ? 'agents_copied' : 'agents_copy_key')}</button>
      {copyFailed ? <p role="alert">{t('agents_copy_failed')}</p> : null}
      <p className={styles.hint}>{t('agents_install_hint')}</p>
      <pre className={styles.config}>{JSON.stringify({
        serverUrl: 'https://controller.example',
        agentId: credential.agent.agentId,
        tokenFile: '/etc/xcloud-agent/token',
      }, null, 2)}</pre>
      <p className={styles.hint}>{t('agents_launch_hint')}</p>
      <code className={styles.config}>xcloud-agent -config /etc/xcloud-agent/config.json</code>
      <footer className={styles.dialogActions}><button className="btn btn-primary" onClick={onClose}>{t('close')}</button></footer>
    </div>
  </Dialog>;
}
