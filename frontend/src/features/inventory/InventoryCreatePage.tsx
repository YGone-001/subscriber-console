import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { useI18n } from '../../providers/I18nProvider';
import { createInventoryResource, fetchInventoryMeta } from './inventory-api';
import { buildCreateResourceRequest } from './inventory-builders';
import type {
  CreateResourceRequest,
  ManagementEndpoint,
  MetaResponse,
  SoftwareMetadata,
} from './inventory-types';
import {
  validateAttributes,
  validateMachineName,
  validateManagementEndpoints,
} from './inventory-validation';

export function InventoryCreatePage() {
  const navigate = useNavigate();
  const { t } = useI18n();

  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form fields
  const [kind, setKind] = useState('host');
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [domain, setDomain] = useState('5gc');
  const [role, setRole] = useState('');
  const [lifecycleState, setLifecycleState] = useState('planned');
  const [vendor, setVendor] = useState('');
  const [model, setModel] = useState('');

  // Software
  const [softwareProduct, setSoftwareProduct] = useState('');
  const [softwareVersion, setSoftwareVersion] = useState('');
  const [softwareBuild, setSoftwareBuild] = useState('');

  // Management endpoints
  const [endpoints, setEndpoints] = useState<ManagementEndpoint[]>([]);

  // Capabilities & labels
  const [capabilitiesInput, setCapabilitiesInput] = useState('');
  const [labels, setLabels] = useState<Array<{ key: string; value: string }>>([]);

  // Attributes
  const [attributesJson, setAttributesJson] = useState('{}');

  useEffect(() => {
    fetchInventoryMeta()
      .then((data) => {
        setMeta(data);
        if (data.kinds && data.kinds.length > 0 && !data.kinds.includes(kind)) {
          setKind(data.kinds[0]);
        }
        if (data.domains && data.domains.length > 0 && !data.domains.includes(domain)) {
          setDomain(data.domains[0]);
        }
      })
      .catch(() => {});
  }, []);

  const handleAddEndpoint = () => {
    setEndpoints((prev) => [
      ...prev,
      {
        name: `endpoint-${prev.length + 1}`,
        protocol: 'https',
        addressType: 'ipv4',
        address: '127.0.0.1',
        port: 443,
      },
    ]);
  };

  const handleRemoveEndpoint = (index: number) => {
    setEndpoints((prev) => prev.filter((_, i) => i !== index));
  };

  const handleUpdateEndpoint = (
    index: number,
    field: keyof ManagementEndpoint,
    val: string | number,
  ) => {
    setEndpoints((prev) =>
      prev.map((ep, i) => (i === index ? { ...ep, [field]: val } : ep)),
    );
  };

  const handleAddLabel = () => {
    setLabels((prev) => [...prev, { key: '', value: '' }]);
  };

  const handleRemoveLabel = (index: number) => {
    setLabels((prev) => prev.filter((_, i) => i !== index));
  };

  const handleUpdateLabel = (index: number, field: 'key' | 'value', val: string) => {
    setLabels((prev) =>
      prev.map((l, i) => (i === index ? { ...l, [field]: val } : l)),
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const nameErr = validateMachineName(name);
    if (nameErr) {
      setError(nameErr);
      return;
    }

    let parsedAttributes: Record<string, unknown> | undefined = undefined;
    if (attributesJson.trim() && attributesJson.trim() !== '{}') {
      try {
        parsedAttributes = JSON.parse(attributesJson);
      } catch {
        setError('Attributes must be valid JSON.');
        return;
      }
      const attrErr = validateAttributes(parsedAttributes);
      if (attrErr) {
        setError(attrErr);
        return;
      }
    }

    const epErr = validateManagementEndpoints(endpoints);
    if (epErr) {
      setError(epErr);
      return;
    }

    const labelsObj: Record<string, string> = {};
    for (const item of labels) {
      if (item.key.trim()) {
        labelsObj[item.key.trim()] = item.value.trim();
      }
    }

    const caps = capabilitiesInput
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    let sw: SoftwareMetadata | undefined = undefined;
    if (softwareProduct.trim() || softwareVersion.trim() || softwareBuild.trim()) {
      sw = {
        product: softwareProduct.trim() || undefined,
        version: softwareVersion.trim() || undefined,
        build: softwareBuild.trim() || undefined,
      };
    }

    const rawReq: Partial<CreateResourceRequest> = {
      kind,
      name: name.trim(),
      displayName: displayName.trim() || undefined,
      description: description.trim() || undefined,
      domain,
      role: role.trim() || undefined,
      lifecycleState: lifecycleState || undefined,
      vendor: vendor.trim() || undefined,
      model: model.trim() || undefined,
      software: sw,
      managementEndpoints: endpoints.length > 0 ? endpoints : undefined,
      capabilities: caps.length > 0 ? caps : undefined,
      labels: Object.keys(labelsObj).length > 0 ? labelsObj : undefined,
      attributes: parsedAttributes,
    };

    setSubmitting(true);
    try {
      const payload = buildCreateResourceRequest(rawReq);
      const created = await createInventoryResource(payload);
      navigate(`/inventory/${encodeURIComponent(created.resourceId)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="page-container max-w-4xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link to="/inventory" className="btn-ghost btn-sm inline-flex items-center gap-1.5">
          <ArrowLeft size={16} />
          <span>{t('inventory_back_to_list', { defaultValue: 'Back to Inventory' })}</span>
        </Link>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          {t('inventory_create_resource', { defaultValue: 'Register Inventory Resource' })}
        </h1>
      </div>

      {error ? (
        <div className="notice-banner notice-error mb-6" role="alert">
          {error}
        </div>
      ) : null}

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Basic Identity & Classification */}
        <div className="card p-6">
          <h2 className="text-base font-semibold mb-4 text-foreground border-b pb-2">
            Identity & Classification
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium mb-1">
                Resource Kind *
              </label>
              <select
                className="input select w-full"
                value={kind}
                onChange={(e) => setKind(e.target.value)}
                required
              >
                {meta?.kinds?.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium mb-1">
                Telecom Domain *
              </label>
              <select
                className="input select w-full"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                required
              >
                {meta?.domains?.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium mb-1">
                Machine Name *
              </label>
              <input
                type="text"
                className="input w-full"
                placeholder="e.g. amf-core-01.site-a"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
              <p className="text-[10px] text-muted-foreground mt-1">
                Letters, digits, dots, hyphens, colons, underscores (max 128 chars).
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium mb-1">{t('inventory_display_name')}</label>
              <input
                type="text"
                className="input w-full"
                placeholder="e.g. Primary AMF Cluster Node"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>

            <div>
              <label className="block text-xs font-medium mb-1">{t('inventory_role')}</label>
              <input
                type="text"
                className="input w-full"
                placeholder="e.g. control-plane, ingress, gateway"
                value={role}
                onChange={(e) => setRole(e.target.value)}
              />
            </div>

            <div>
              <label className="block text-xs font-medium mb-1">
                Initial Lifecycle State *
              </label>
              <select
                className="input select w-full"
                value={lifecycleState}
                onChange={(e) => setLifecycleState(e.target.value)}
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

          <div className="mt-4">
            <label className="block text-xs font-medium mb-1">
              Description
            </label>
            <textarea
              className="input w-full h-20"
              placeholder="Optional notes or operational description..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        </div>

        {/* Hardware & Software Details */}
        <div className="card p-6">
          <h2 className="text-base font-semibold mb-4 text-foreground border-b pb-2">
            Hardware & Software Metadata
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium mb-1">{t('inventory_vendor')}</label>
              <input
                type="text"
                className="input w-full"
                placeholder="e.g. Dell, Cisco, Nokia, Huawei"
                value={vendor}
                onChange={(e) => setVendor(e.target.value)}
              />
            </div>

            <div>
              <label className="block text-xs font-medium mb-1">{t('inventory_model')}</label>
              <input
                type="text"
                className="input w-full"
                placeholder="e.g. PowerEdge R750, NF-VNF-200"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
            </div>

            <div>
              <label className="block text-xs font-medium mb-1">{t('inventory_software_product')}</label>
              <input
                type="text"
                className="input w-full"
                placeholder="e.g. core-amf-01"
                value={softwareProduct}
                onChange={(e) => setSoftwareProduct(e.target.value)}
              />
            </div>

            <div>
              <label className="block text-xs font-medium mb-1">{t('inventory_software_version')}</label>
              <input
                type="text"
                className="input w-full"
                placeholder="e.g. 2.7.2"
                value={softwareVersion}
                onChange={(e) => setSoftwareVersion(e.target.value)}
              />
            </div>

            <div>
              <label className="block text-xs font-medium mb-1">{t('inventory_software_build')}</label>
              <input
                type="text"
                className="input w-full"
                placeholder="e.g. b14092"
                value={softwareBuild}
                onChange={(e) => setSoftwareBuild(e.target.value)}
              />
            </div>
          </div>
        </div>

        {/* Management Endpoints */}
        <div className="card p-6">
          <div className="flex justify-between items-center mb-4 border-b pb-2">
            <h2 className="text-base font-semibold text-foreground">{t('inventory_management_endpoints')}</h2>
            <button
              type="button"
              className="btn-secondary btn-sm flex items-center gap-1"
              onClick={handleAddEndpoint}
            >
              <Plus size={14} />
              <span>{t('inventory_endpoint_add')}</span>
            </button>
          </div>

          {endpoints.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('inventory_endpoints_empty_draft')}</p>
          ) : (
            <div className="space-y-3">
              {endpoints.map((ep, idx) => (
                <div key={idx} className="flex flex-wrap items-center gap-2 p-3 bg-muted/40 rounded border">
                  <div className="flex-1 min-w-[120px]">
                    <input
                      type="text"
                      className="input input-sm w-full"
                      placeholder="Name"
                      value={ep.name}
                      onChange={(e) => handleUpdateEndpoint(idx, 'name', e.target.value)}
                    />
                  </div>
                  <div className="w-28">
                    <select
                      className="input select input-sm w-full"
                      value={ep.protocol}
                      onChange={(e) => handleUpdateEndpoint(idx, 'protocol', e.target.value)}
                    >
                      {meta?.managementProtocols?.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="w-24">
                    <select
                      className="input select input-sm w-full"
                      value={ep.addressType}
                      onChange={(e) => handleUpdateEndpoint(idx, 'addressType', e.target.value)}
                    >
                      {meta?.addressTypes?.map((a) => (
                        <option key={a} value={a}>
                          {a}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex-1 min-w-[140px]">
                    <input
                      type="text"
                      className="input input-sm w-full font-mono text-xs"
                      placeholder="Address (IP or FQDN)"
                      value={ep.address}
                      onChange={(e) => handleUpdateEndpoint(idx, 'address', e.target.value)}
                    />
                  </div>
                  <div className="w-20">
                    <input
                      type="number"
                      className="input input-sm w-full font-mono text-xs"
                      placeholder="Port"
                      value={ep.port}
                      onChange={(e) => handleUpdateEndpoint(idx, 'port', parseInt(e.target.value, 10) || 0)}
                    />
                  </div>
                  <button
                    type="button"
                    className="btn-danger btn-sm p-1.5"
                    onClick={() => handleRemoveEndpoint(idx)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Capabilities & Labels */}
        <div className="card p-6">
          <h2 className="text-base font-semibold mb-4 text-foreground border-b pb-2">
            Capabilities & Labels
          </h2>
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium mb-1">{t('inventory_capabilities_hint')}</label>
              <input
                type="text"
                className="input w-full font-mono text-xs"
                placeholder="e.g. sbi.namf_comm, n2.ngap, ipv4_routing"
                value={capabilitiesInput}
                onChange={(e) => setCapabilitiesInput(e.target.value)}
              />
            </div>

            <div>
              <div className="flex justify-between items-center mb-2">
                <label className="text-xs font-medium">{t('inventory_labels_hint')}</label>
                <button
                  type="button"
                  className="btn-secondary btn-sm text-xs py-1"
                  onClick={handleAddLabel}
                >
                  <Plus size={12} className="inline mr-1" />
                  Add Label
                </button>
              </div>
              {labels.map((lbl, idx) => (
                <div key={idx} className="flex gap-2 items-center mb-2">
                  <input
                    type="text"
                    className="input input-sm w-1/3"
                    placeholder="Key"
                    value={lbl.key}
                    onChange={(e) => handleUpdateLabel(idx, 'key', e.target.value)}
                  />
                  <input
                    type="text"
                    className="input input-sm flex-1"
                    placeholder="Value"
                    value={lbl.value}
                    onChange={(e) => handleUpdateLabel(idx, 'value', e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn-danger btn-sm p-1"
                    onClick={() => handleRemoveLabel(idx)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Extension Attributes */}
        <div className="card p-6">
          <h2 className="text-base font-semibold mb-2 text-foreground border-b pb-2">
            Extension Attributes (JSON)
          </h2>
          <p className="text-xs text-muted-foreground mb-3">
            Custom configuration attributes. Note: sensitive keys (passwords, tokens, secrets) are strictly rejected.
          </p>
          <textarea
            className="input font-mono text-xs w-full h-32"
            value={attributesJson}
            onChange={(e) => setAttributesJson(e.target.value)}
          />
        </div>

        <div className="flex justify-end gap-3 pt-4 border-t">
          <Link to="/inventory" className="btn-secondary">
            {t('cancel', { defaultValue: 'Cancel' })}
          </Link>
          <button
            type="submit"
            className="btn-primary"
            disabled={submitting}
          >
            {submitting ? 'Registering...' : 'Register Resource'}
          </button>
        </div>
      </form>
    </div>
  );
}
