import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Edit2, PowerOff, RefreshCw } from 'lucide-react';
import { Modal } from '../../components/Modal';
import { hasPermission } from '../../lib/permissions';
import { useAuth } from '../../providers/AuthProvider';
import { useI18n } from '../../providers/I18nProvider';
import {
  fetchInventoryMeta,
  fetchInventoryResource,
  retireInventoryResource,
  updateInventoryResource,
} from './inventory-api';
import {
  buildRetireResourceRequest,
  buildUpdateResourceRequest,
} from './inventory-builders';
import type {
  ManagementEndpoint,
  MetaResponse,
  MutableResource,
  Resource,
  SoftwareMetadata,
} from './inventory-types';
import {
  validateAttributes,
  validateMachineName,
  validateManagementEndpoints,
} from './inventory-validation';

export function InventoryDetailPage() {
  const { resourceId } = useParams<{ resourceId: string }>();
  const { t } = useI18n();
  const { user } = useAuth();

  const [resource, setResource] = useState<Resource | null>(null);
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: 'success' | 'error' | 'warning'; message: string } | null>(null);

  // Edit modal states
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDisplayName, setEditDisplayName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editKind, setEditKind] = useState('');
  const [editDomain, setEditDomain] = useState('');
  const [editRole, setEditRole] = useState('');
  const [editLifecycle, setEditLifecycle] = useState('');
  const [editVendor, setEditVendor] = useState('');
  const [editModel, setEditModel] = useState('');
  const [editSoftware, setEditSoftware] = useState<SoftwareMetadata>({});
  const [editEndpoints, setEditEndpoints] = useState<ManagementEndpoint[]>([]);
  const [editCapabilities, setEditCapabilities] = useState('');
  const [editLabels, setEditLabels] = useState<Array<{ key: string; value: string }>>([]);
  const [editAttributesJson, setEditAttributesJson] = useState('{}');
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [isStaleConflict, setIsStaleConflict] = useState(false);

  // Retire modal states
  const [isRetireOpen, setIsRetireOpen] = useState(false);
  const [retireReason, setRetireReason] = useState('');
  const [retireSubmitting, setRetireSubmitting] = useState(false);
  const [retireError, setRetireError] = useState<string | null>(null);

  const canConfigure = hasPermission(user, 'core.configure');

  const loadData = async () => {
    if (!resourceId) return;
    setLoading(true);
    setError(null);
    setIsStaleConflict(false);
    try {
      const data = await fetchInventoryResource(resourceId);
      setResource(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load inventory resource.');
      setResource(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    fetchInventoryMeta().then(setMeta).catch(() => {});
  }, [resourceId]);

  const openEditModal = () => {
    if (!resource) return;
    setEditName(resource.name);
    setEditDisplayName(resource.displayName || '');
    setEditDescription(resource.description || '');
    setEditKind(resource.kind);
    setEditDomain(resource.domain);
    setEditRole(resource.role || '');
    setEditLifecycle(resource.lifecycleState);
    setEditVendor(resource.vendor || '');
    setEditModel(resource.model || '');
    setEditSoftware(resource.software || {});
    setEditEndpoints(resource.managementEndpoints ? [...resource.managementEndpoints] : []);
    setEditCapabilities((resource.capabilities || []).join(', '));
    setEditLabels(
      resource.labels
        ? Object.entries(resource.labels).map(([key, value]) => ({ key, value }))
        : [],
    );
    setEditAttributesJson(
      resource.attributes ? JSON.stringify(resource.attributes, null, 2) : '{}',
    );
    setEditError(null);
    setIsStaleConflict(false);
    setIsEditOpen(true);
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resource || !resourceId) return;

    setEditError(null);
    const nameErr = validateMachineName(editName);
    if (nameErr) {
      setEditError(nameErr);
      return;
    }

    let parsedAttributes: Record<string, unknown> | undefined = undefined;
    if (editAttributesJson.trim()) {
      try {
        parsedAttributes = JSON.parse(editAttributesJson);
      } catch {
        setEditError('Attributes must be valid JSON.');
        return;
      }
      const attrErr = validateAttributes(parsedAttributes);
      if (attrErr) {
        setEditError(attrErr);
        return;
      }
    }

    const epErr = validateManagementEndpoints(editEndpoints);
    if (epErr) {
      setEditError(epErr);
      return;
    }

    const labelsObj: Record<string, string> = {};
    for (const item of editLabels) {
      if (item.key.trim()) {
        labelsObj[item.key.trim()] = item.value.trim();
      }
    }

    const caps = editCapabilities
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const mutable: MutableResource = {
      kind: editKind,
      name: editName.trim(),
      displayName: editDisplayName.trim() || undefined,
      description: editDescription.trim() || undefined,
      domain: editDomain,
      role: editRole.trim() || undefined,
      lifecycleState: editLifecycle,
      vendor: editVendor.trim() || undefined,
      model: editModel.trim() || undefined,
      software: Object.keys(editSoftware).length > 0 ? editSoftware : undefined,
      managementEndpoints: editEndpoints.length > 0 ? editEndpoints : undefined,
      capabilities: caps.length > 0 ? caps : undefined,
      labels: Object.keys(labelsObj).length > 0 ? labelsObj : undefined,
      attributes: parsedAttributes,
    };

    setEditSubmitting(true);
    try {
      const payload = buildUpdateResourceRequest(resource.revision, mutable);
      const updated = await updateInventoryResource(resourceId, payload);
      setResource(updated);
      setIsEditOpen(false);
      setNotice({ type: 'success', message: 'Resource updated successfully.' });
    } catch (err: unknown) {
      const isConflict =
        (typeof err === 'object' && err !== null && 'status' in err && (err as { status: unknown }).status === 409) ||
        (err instanceof Error && (err.message.includes('conflict') || err.message.includes('revision')));
      if (isConflict) {
        setIsStaleConflict(true);
        setEditError(
          'Conflict detected: this resource was modified by another operator. Reload required before saving changes.',
        );
      } else {
        setEditError(err instanceof Error ? err.message : 'Update failed.');
      }
    } finally {
      setEditSubmitting(false);
    }
  };

  const handleRetireSubmit = async () => {
    if (!resource || !resourceId) return;
    if (!retireReason.trim()) {
      setRetireError('Retirement reason is required.');
      return;
    }

    setRetireSubmitting(true);
    setRetireError(null);
    try {
      const payload = buildRetireResourceRequest(resource.revision, retireReason);
      const updated = await retireInventoryResource(resourceId, payload);
      setResource(updated);
      setIsRetireOpen(false);
      setNotice({ type: 'success', message: 'Resource retired successfully.' });
    } catch (err: unknown) {
      const isConflict =
        (typeof err === 'object' && err !== null && 'status' in err && (err as { status: unknown }).status === 409) ||
        (err instanceof Error && (err.message.includes('conflict') || err.message.includes('revision')));
      if (isConflict) {
        setRetireError(
          'Conflict detected: this resource was modified by another operator. Please reload.',
        );
      } else {
        setRetireError(err instanceof Error ? err.message : 'Retirement failed.');
      }
    } finally {
      setRetireSubmitting(false);
    }
  };

  if (loading && !resource) {
    return (
      <div className="page-container p-8 text-center text-muted-foreground">
        {t('loading', { defaultValue: 'Loading resource details...' })}
      </div>
    );
  }

  if (error || !resource) {
    return (
      <div className="page-container">
        <Link to="/inventory" className="btn-secondary btn-sm mb-4 inline-flex items-center gap-1.5">
          <ArrowLeft size={16} />
          <span>Back to Inventory</span>
        </Link>
        <div className="notice-banner notice-error" role="alert">
          {error || 'Resource not found.'}
        </div>
      </div>
    );
  }

  const isRetired = resource.lifecycleState === 'retired';

  return (
    <div className="page-container">
      <div className="flex justify-between items-center mb-6">
        <Link to="/inventory" className="btn-ghost btn-sm inline-flex items-center gap-1.5">
          <ArrowLeft size={16} />
          <span>{t('inventory_back_to_list', { defaultValue: 'Back to Inventory' })}</span>
        </Link>
        <div className="flex gap-2">
          <button
            type="button"
            className="btn-secondary btn-sm flex items-center gap-1.5"
            onClick={loadData}
            disabled={loading}
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            <span>{t('refresh', { defaultValue: 'Refresh' })}</span>
          </button>
          {canConfigure && !isRetired ? (
            <>
              <button
                type="button"
                className="btn-secondary btn-sm flex items-center gap-1.5"
                onClick={openEditModal}
              >
                <Edit2 size={14} />
                <span>{t('edit', { defaultValue: 'Edit Resource' })}</span>
              </button>
              <button
                type="button"
                className="btn-danger btn-sm flex items-center gap-1.5"
                onClick={() => {
                  setRetireReason('');
                  setRetireError(null);
                  setIsRetireOpen(true);
                }}
              >
                <PowerOff size={14} />
                <span>{t('retire', { defaultValue: 'Retire Resource' })}</span>
              </button>
            </>
          ) : null}
        </div>
      </div>

      {notice ? (
        <div
          className={`notice-banner ${
            notice.type === 'success'
              ? 'notice-success'
              : notice.type === 'warning'
              ? 'notice-warning'
              : 'notice-error'
          } mb-4`}
          role="status"
        >
          {notice.message}
        </div>
      ) : null}

      {/* Header card */}
      <div className="card p-6 mb-6">
        <div className="flex flex-wrap justify-between items-start gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold tracking-tight text-foreground">{resource.name}</h1>
              <span className="badge badge-outline">{resource.kind}</span>
              <span
                className={`badge ${
                  resource.lifecycleState === 'active'
                    ? 'badge-success'
                    : resource.lifecycleState === 'maintenance'
                    ? 'badge-warning'
                    : resource.lifecycleState === 'retired'
                    ? 'badge-danger'
                    : 'badge-secondary'
                }`}
              >
                {resource.lifecycleState}
              </span>
            </div>
            {resource.displayName ? (
              <p className="text-base text-muted-foreground mt-1">{resource.displayName}</p>
            ) : null}
            {resource.description ? (
              <p className="text-sm text-muted-foreground mt-2">{resource.description}</p>
            ) : null}
          </div>
          <div className="text-right text-xs text-muted-foreground">
            <div>Revision: <span className="font-mono font-medium text-foreground">{resource.revision}</span></div>
            <div>Schema: <span className="font-mono font-medium text-foreground">v{resource.schemaVersion}</span></div>
            <div className="mt-1">ID: <span className="font-mono text-muted-foreground">{resource.resourceId}</span></div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
        {/* Resource Facts */}
        <div className="card p-6">
          <h2 className="text-base font-semibold mb-4 text-foreground border-b pb-2">Classification & Identity</h2>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <dt className="text-muted-foreground">Domain</dt>
            <dd className="font-medium text-foreground">{resource.domain}</dd>
            <dt className="text-muted-foreground">Role</dt>
            <dd className="font-medium text-foreground">{resource.role || '-'}</dd>
            <dt className="text-muted-foreground">Vendor</dt>
            <dd className="font-medium text-foreground">{resource.vendor || '-'}</dd>
            <dt className="text-muted-foreground">Model</dt>
            <dd className="font-medium text-foreground">{resource.model || '-'}</dd>
          </dl>

          <h3 className="text-sm font-semibold mt-6 mb-3 text-foreground border-b pb-2">Software Metadata</h3>
          {resource.software ? (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Product</dt>
              <dd className="font-medium text-foreground">{resource.software.product || '-'}</dd>
              <dt className="text-muted-foreground">Version</dt>
              <dd className="font-medium text-foreground">{resource.software.version || '-'}</dd>
              <dt className="text-muted-foreground">Build</dt>
              <dd className="font-medium text-foreground">{resource.software.build || '-'}</dd>
            </dl>
          ) : (
            <p className="text-xs text-muted-foreground">No software metadata recorded.</p>
          )}
        </div>

        {/* Provenance & Audit Facts */}
        <div className="card p-6">
          <h2 className="text-base font-semibold mb-4 text-foreground border-b pb-2">Source & Provenance</h2>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <dt className="text-muted-foreground">Source Kind</dt>
            <dd className="font-medium text-foreground">{resource.source?.kind || '-'}</dd>
            <dt className="text-muted-foreground">Origin System</dt>
            <dd className="font-medium text-foreground">{resource.source?.system || '-'}</dd>
            <dt className="text-muted-foreground">Authority</dt>
            <dd className="font-medium text-foreground">{resource.source?.authority || '-'}</dd>
            <dt className="text-muted-foreground">External ID</dt>
            <dd className="font-medium text-foreground font-mono">{resource.source?.externalId || '-'}</dd>
          </dl>

          <h3 className="text-sm font-semibold mt-6 mb-3 text-foreground border-b pb-2">Audit History</h3>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Created By</dt>
            <dd className="font-medium text-foreground">{resource.createdBy}</dd>
            <dt className="text-muted-foreground">Created At</dt>
            <dd className="font-medium text-foreground text-xs">
              {new Date(resource.createdAt).toLocaleString()}
            </dd>
            <dt className="text-muted-foreground">Updated By</dt>
            <dd className="font-medium text-foreground">{resource.updatedBy}</dd>
            <dt className="text-muted-foreground">Updated At</dt>
            <dd className="font-medium text-foreground text-xs">
              {new Date(resource.updatedAt).toLocaleString()}
            </dd>
          </dl>
        </div>
      </div>

      {/* Management Endpoints */}
      <div className="card p-6 mb-6">
        <h2 className="text-base font-semibold mb-4 text-foreground border-b pb-2">Management Endpoints</h2>
        {resource.managementEndpoints && resource.managementEndpoints.length > 0 ? (
          <div className="table-wrapper">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th>Endpoint Name</th>
                  <th>Protocol</th>
                  <th>Address Type</th>
                  <th>Address</th>
                  <th>Port</th>
                  <th>Path</th>
                </tr>
              </thead>
              <tbody>
                {resource.managementEndpoints.map((ep, idx) => (
                  <tr key={idx}>
                    <td className="font-medium text-foreground">{ep.name}</td>
                    <td><span className="badge badge-secondary">{ep.protocol}</span></td>
                    <td>{ep.addressType}</td>
                    <td className="font-mono text-xs">{ep.address}</td>
                    <td className="font-mono text-xs">{ep.port}</td>
                    <td className="font-mono text-xs">{ep.path || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No management endpoints registered.</p>
        )}
      </div>

      {/* Capabilities & Labels */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
        <div className="card p-6">
          <h2 className="text-base font-semibold mb-4 text-foreground border-b pb-2">Capabilities</h2>
          {resource.capabilities && resource.capabilities.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {resource.capabilities.map((cap) => (
                <span key={cap} className="badge badge-secondary font-mono text-xs">
                  {cap}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No capabilities specified.</p>
          )}
        </div>

        <div className="card p-6">
          <h2 className="text-base font-semibold mb-4 text-foreground border-b pb-2">Labels</h2>
          {resource.labels && Object.keys(resource.labels).length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {Object.entries(resource.labels).map(([k, v]) => (
                <span key={k} className="badge badge-outline text-xs">
                  <span className="font-semibold">{k}:</span> {v}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No labels attached.</p>
          )}
        </div>
      </div>

      {/* Attributes (JSON) */}
      <div className="card p-6 mb-6">
        <h2 className="text-base font-semibold mb-4 text-foreground border-b pb-2">Attributes</h2>
        {resource.attributes && Object.keys(resource.attributes).length > 0 ? (
          <pre className="bg-muted p-4 rounded text-xs font-mono overflow-auto max-h-96">
            {JSON.stringify(resource.attributes, null, 2)}
          </pre>
        ) : (
          <p className="text-xs text-muted-foreground">No custom attributes defined.</p>
        )}
      </div>

      {/* Edit Modal */}
      <Modal
        isOpen={isEditOpen}
        onClose={() => !editSubmitting && setIsEditOpen(false)}
        title={`Edit Resource: ${resource.name}`}
        maxWidth="40rem"
        footer={
          <div className="flex justify-between w-full">
            <div>
              {isStaleConflict ? (
                <button
                  type="button"
                  className="btn-warning btn-sm"
                  onClick={async () => {
                    await loadData();
                    setIsEditOpen(false);
                  }}
                >
                  Reload Latest
                </button>
              ) : null}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setIsEditOpen(false)}
                disabled={editSubmitting}
              >
                {t('cancel', { defaultValue: 'Cancel' })}
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={handleEditSubmit}
                disabled={editSubmitting || isStaleConflict}
              >
                {editSubmitting ? t('saving', { defaultValue: 'Saving...' }) : t('save', { defaultValue: 'Save Changes' })}
              </button>
            </div>
          </div>
        }
      >
        <form onSubmit={handleEditSubmit} className="space-y-4">
          {editError ? (
            <div className="notice-banner notice-error text-xs" role="alert">
              {editError}
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium mb-1">Name *</label>
              <input
                type="text"
                className="input w-full"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Display Name</label>
              <input
                type="text"
                className="input w-full"
                value={editDisplayName}
                onChange={(e) => setEditDisplayName(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium mb-1">Kind</label>
              <input
                type="text"
                className="input w-full bg-muted cursor-not-allowed"
                value={editKind}
                readOnly
                disabled
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Domain *</label>
              <select
                className="input select w-full"
                value={editDomain}
                onChange={(e) => setEditDomain(e.target.value)}
              >
                {meta?.domains?.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Lifecycle *</label>
              <select
                className="input select w-full"
                value={editLifecycle}
                onChange={(e) => setEditLifecycle(e.target.value)}
              >
                {meta?.lifecycleStates
                  ?.filter((s) => s !== 'retired')
                  .map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium mb-1">Role</label>
              <input
                type="text"
                className="input w-full"
                value={editRole}
                onChange={(e) => setEditRole(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Vendor</label>
              <input
                type="text"
                className="input w-full"
                value={editVendor}
                onChange={(e) => setEditVendor(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Model</label>
              <input
                type="text"
                className="input w-full"
                value={editModel}
                onChange={(e) => setEditModel(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Capabilities (comma separated)</label>
            <input
              type="text"
              className="input w-full"
              value={editCapabilities}
              onChange={(e) => setEditCapabilities(e.target.value)}
            />
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Attributes (JSON)</label>
            <textarea
              className="input font-mono text-xs w-full h-32"
              value={editAttributesJson}
              onChange={(e) => setEditAttributesJson(e.target.value)}
            />
          </div>
        </form>
      </Modal>

      {/* Retire Modal */}
      <Modal
        isOpen={isRetireOpen}
        onClose={() => !retireSubmitting && setIsRetireOpen(false)}
        title={t('inventory_retirement_confirm_title', { name: resource.name, defaultValue: `Retire Resource: ${resource.name}` })}
        maxWidth="32rem"
        footer={
          <div className="flex justify-end gap-2 w-full">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setIsRetireOpen(false)}
              disabled={retireSubmitting}
            >
              {t('cancel', { defaultValue: 'Cancel' })}
            </button>
            <button
              type="button"
              className="btn-danger"
              onClick={handleRetireSubmit}
              disabled={retireSubmitting}
            >
              {retireSubmitting ? 'Retiring...' : 'Confirm Retirement'}
            </button>
          </div>
        }
      >
        <div className="space-y-3">
          <div className="p-3 bg-muted rounded text-xs text-muted-foreground font-medium border">
            {t('inventory_retirement_warning', { defaultValue: 'Retirement changes inventory lifecycle only. It does not stop, restart, delete, or reconfigure the network element.' })}
          </div>
          {retireError ? (
            <div className="notice-banner notice-error text-xs" role="alert">
              {retireError}
            </div>
          ) : null}
          <div>
            <label className="block text-xs font-medium mb-1 text-foreground">
              {t('inventory_retirement_reason_label', { defaultValue: 'Reason for retirement' })} *
            </label>
            <input
              type="text"
              className="input w-full"
              placeholder={t('inventory_retirement_reason_placeholder', { defaultValue: 'e.g. Decommissioned node replaced by unit-02' })}
              value={retireReason}
              onChange={(e) => setRetireReason(e.target.value)}
              required
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}
