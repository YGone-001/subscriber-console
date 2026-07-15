"use client";

import { useState } from "react";
import { Plus, Trash2, Save, X, Pencil, DollarSign, Hash, Tag } from "lucide-react";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import { useI18n } from "@/components/I18nProvider";
import { useAuth } from "@/hooks/useAuth";

// 支持的币种列表
const CURRENCIES = ["USD", "EUR", "GBP", "CNY", "HKD", "JPY", "KRW", "SGD", "AUD", "CAD"];

/**
 * Rating Policy 管理页面
 * -------------------------------------------------------
 * 管理 OCS:RATES:RATES_[RATING_ID] 费率模板表
 * 数据结构: { currency, rates, rates_type, rating_group_id }
 * -------------------------------------------------------
 */
export default function RatingPage() {
  const { t } = useI18n();
  const { data, isLoading, mutate } = useSWR("/api/ratings", fetcher);
  const ratings: any[] = data?.ratings || [];
  const { canEditTemplates } = useAuth();

  const RATE_TYPES = [
    { label: t("rating_type_time"), val: 1 },
    { label: t("rating_type_vol"), val: 2 },
    { label: t("rating_type_event"), val: 3 },
    { label: t("rating_type_flat"), val: 4 }
  ];

  const formatCurrency = (c: string) => {
    const translated = t(`currency_${c}`);
    return translated && translated !== `currency_${c}` ? `${c} (${translated})` : c;
  };

  // 行内编辑状态
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<any>({});

  // 新增表单
  const [isAdding, setIsAdding] = useState(false);
  const defaultForm = {
    rating_group_id: "",
    currency: "USD",
    rates: "0",
    rates_type: 2,
    apn: "internet",
    service_identifier: "1",
    quota_per_grant: "10485760",
    validity_time: "300",
    volume_threshold: "8388608",
  };
  const [newForm, setNewForm] = useState(defaultForm);

  /**
   * Create a rating template through the MongoDB-backed API.
   */
  const handleCreate = async () => {
    if (!newForm.rating_group_id) return;
    try {
      const res = await fetch("/api/ratings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newForm)
      });
      if (res.ok) {
        setIsAdding(false);
        setNewForm(defaultForm);
        mutate();
      } else {
        const err = await res.json();
        alert(err.error || t("rating_err_create"));
      }
    } catch (e) {
      console.error("Create failed", e);
    }
  };

  /**
   * 更新已有费率模板
   */
  const handleUpdate = async (id: number) => {
    try {
      const res = await fetch(`/api/ratings/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editForm)
      });
      if (res.ok) {
        setEditingId(null);
        mutate();
      }
    } catch (e) {
      console.error("Update failed", e);
    }
  };

  /**
   * 删除费率模板
   */
  const handleDelete = async (id: number) => {
    if (!confirm(t("rating_del_confirm").replace("{id}", id.toString()))) return;
    try {
      const res = await fetch(`/api/ratings/${id}`, { method: "DELETE" });
      if (res.ok) mutate();
    } catch (e) {
      console.error("Delete failed", e);
    }
  };

  // 进入行内编辑模式, 预填充现有数据
  const startEdit = (rating: any) => {
    setEditingId(rating.rating_group_id);
    setEditForm({
      currency: rating.currency,
      rates: rating.rates,
      rates_type: rating.rates_type,
      apn: rating.apn || "internet",
      service_identifier: String(rating.service_identifier ?? 1),
      quota_per_grant: String(rating.quota_per_grant ?? 10485760),
      validity_time: String(rating.validity_time ?? 300),
      volume_threshold: String(rating.volume_threshold ?? 8388608),
    });
  };

  return (
    <div className="container animate-fade-in" style={{ padding: "3rem", paddingBottom: "100px" }}>

      {/* Page Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "2rem" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: "1.75rem", fontWeight: 600, color: "var(--text-main)" }}>{t("rating_title")}</h1>
          <p style={{ margin: "0.5rem 0 0 0", color: "var(--text-muted)", fontSize: "0.95rem" }}>{t("rating_subtitle")}</p>
        </div>
        {canEditTemplates && (
          <button
            className="btn btn-primary"
            onClick={() => setIsAdding(true)}
            style={{ padding: "0.6rem 1.25rem", display: "flex", alignItems: "center", gap: "0.5rem", borderRadius: "24px" }}
          >
            <Plus size={18} /> {t("rating_new_rate")}
          </button>
        )}
      </div>

      {/* Rate Table */}
      <div className="dash-card" style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.95rem" }}>
          <thead>
            <tr style={{ background: "var(--surface-hover)", borderBottom: "2px solid var(--surface-border)" }}>
              <th className="table-header-cap" style={{ padding: "1.25rem 1.5rem", textAlign: "left", width: "160px" }}>
                <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}><Hash size={16} /> {t("rating_col_id")}</span>
              </th>
              <th className="table-header-cap" style={{ padding: "1.25rem 1.5rem", textAlign: "left" }}>
                <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}><DollarSign size={16} /> {t("rating_col_currency")}</span>
              </th>
              <th className="table-header-cap" style={{ padding: "1.25rem 1.5rem", textAlign: "left" }}>
                <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>{t("rating_col_rates")}</span>
              </th>
              <th className="table-header-cap" style={{ padding: "1.25rem 1.5rem", textAlign: "left" }}>
                <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}><Tag size={16} /> {t("rating_col_type")}</span>
              </th>
              <th className="table-header-cap" style={{ padding: "1.25rem 1.5rem", textAlign: "left" }}>APN</th>
              <th className="table-header-cap" style={{ padding: "1.25rem 1.5rem", textAlign: "left" }}>SI</th>
              <th className="table-header-cap" style={{ padding: "1.25rem 1.5rem", textAlign: "left" }}>Grant</th>
              <th className="table-header-cap" style={{ padding: "1.25rem 1.5rem", textAlign: "left" }}>Validity</th>
              <th className="table-header-cap" style={{ padding: "1.25rem 1.5rem", textAlign: "left" }}>Threshold</th>
              {canEditTemplates && <th className="table-header-cap" style={{ padding: "1.25rem 1.5rem", textAlign: "right", width: "120px" }}>{t("rating_col_actions")}</th>}
            </tr>
          </thead>
          <tbody>
            {/* New Row Form */}
            {isAdding && (
              <tr style={{ background: "rgba(59, 130, 246, 0.08)", borderBottom: "1px solid var(--surface-border)" }}>
                <td style={{ padding: "1rem 1.5rem" }}>
                  <input type="number" className="form-input" style={{ width: "110px" }} placeholder={t("rating_ph_id")} value={newForm.rating_group_id} onChange={e => setNewForm({...newForm, rating_group_id: e.target.value})} autoFocus />
                </td>
                <td style={{ padding: "1rem 1.5rem" }}>
                  <select className="form-input" value={newForm.currency} onChange={e => setNewForm({...newForm, currency: e.target.value})}>
                    {CURRENCIES.map(c => <option key={c} value={c}>{formatCurrency(c)}</option>)}
                  </select>
                </td>
                <td style={{ padding: "1rem 1.5rem" }}>
                  <input type="text" className="form-input" style={{ width: "120px" }} value={newForm.rates} onChange={e => setNewForm({...newForm, rates: e.target.value})} placeholder={t("rating_ph_rates")} />
                </td>
                <td style={{ padding: "1rem 1.5rem" }}>
                  <select className="form-input" value={newForm.rates_type} onChange={e => setNewForm({...newForm, rates_type: Number(e.target.value)})}>
                    {RATE_TYPES.map(t => <option key={t.val} value={t.val}>{t.label}</option>)}
                  </select>
                </td>
                <td style={{ padding: "1rem 1.5rem" }}>
                  <input type="text" className="form-input" style={{ width: "110px" }} value={newForm.apn} onChange={e => setNewForm({...newForm, apn: e.target.value})} />
                </td>
                <td style={{ padding: "1rem 1.5rem" }}>
                  <input type="number" className="form-input" style={{ width: "80px" }} value={newForm.service_identifier} onChange={e => setNewForm({...newForm, service_identifier: e.target.value})} />
                </td>
                <td style={{ padding: "1rem 1.5rem" }}>
                  <input type="number" className="form-input" style={{ width: "130px" }} value={newForm.quota_per_grant} onChange={e => setNewForm({...newForm, quota_per_grant: e.target.value})} />
                </td>
                <td style={{ padding: "1rem 1.5rem" }}>
                  <input type="number" className="form-input" style={{ width: "90px" }} value={newForm.validity_time} onChange={e => setNewForm({...newForm, validity_time: e.target.value})} />
                </td>
                <td style={{ padding: "1rem 1.5rem" }}>
                  <input type="number" className="form-input" style={{ width: "130px" }} value={newForm.volume_threshold} onChange={e => setNewForm({...newForm, volume_threshold: e.target.value})} />
                </td>
                <td style={{ padding: "1rem 1.5rem", textAlign: "right" }}>
                  <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
                    <button className="btn-icon" onClick={handleCreate} title={t("save")}><Save size={18} color="var(--success)" /></button>
                    <button className="btn-icon" onClick={() => setIsAdding(false)} title={t("cancel")}><X size={18} color="var(--text-muted)" /></button>
                  </div>
                </td>
              </tr>
            )}

            {/* Data Rows */}
            {isLoading ? (
              <tr><td colSpan={10} style={{ padding: "3rem", textAlign: "center", color: "var(--text-muted)" }}>{t("rating_loading")}</td></tr>
            ) : ratings.length === 0 ? (
              <tr><td colSpan={10} style={{ padding: "3rem", textAlign: "center", color: "var(--text-muted)" }}>{t("rating_no_data")}</td></tr>
            ) : ratings.map(r => (
              <tr key={r.rating_group_id} style={{ borderBottom: "1px solid var(--surface-border)", transition: "background 0.15s" }} onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-hover)')} onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                {editingId === r.rating_group_id ? (
                  <>
                    <td style={{ padding: "1rem 1.5rem" }}>
                      <span style={{ fontFamily: "monospace", fontWeight: 600, color: "var(--primary)", fontSize: "1.1rem" }}>#{r.rating_group_id}</span>
                    </td>
                    <td style={{ padding: "1rem 1.5rem" }}>
                      <select className="form-input" value={editForm.currency} onChange={e => setEditForm({...editForm, currency: e.target.value})}>
                        {CURRENCIES.map(c => <option key={c} value={c}>{formatCurrency(c)}</option>)}
                      </select>
                    </td>
                    <td style={{ padding: "1rem 1.5rem" }}>
                      <input type="text" className="form-input" style={{ width: "120px" }} value={editForm.rates} onChange={e => setEditForm({...editForm, rates: e.target.value})} />
                    </td>
                    <td style={{ padding: "1rem 1.5rem" }}>
                      <select className="form-input" value={editForm.rates_type} onChange={e => setEditForm({...editForm, rates_type: Number(e.target.value)})}>
                        {RATE_TYPES.map(t => <option key={t.val} value={t.val}>{t.label}</option>)}
                      </select>
                    </td>
                    <td style={{ padding: "1rem 1.5rem" }}>
                      <input type="text" className="form-input" style={{ width: "110px" }} value={editForm.apn} onChange={e => setEditForm({...editForm, apn: e.target.value})} />
                    </td>
                    <td style={{ padding: "1rem 1.5rem" }}>
                      <input type="number" className="form-input" style={{ width: "80px" }} value={editForm.service_identifier} onChange={e => setEditForm({...editForm, service_identifier: e.target.value})} />
                    </td>
                    <td style={{ padding: "1rem 1.5rem" }}>
                      <input type="number" className="form-input" style={{ width: "130px" }} value={editForm.quota_per_grant} onChange={e => setEditForm({...editForm, quota_per_grant: e.target.value})} />
                    </td>
                    <td style={{ padding: "1rem 1.5rem" }}>
                      <input type="number" className="form-input" style={{ width: "90px" }} value={editForm.validity_time} onChange={e => setEditForm({...editForm, validity_time: e.target.value})} />
                    </td>
                    <td style={{ padding: "1rem 1.5rem" }}>
                      <input type="number" className="form-input" style={{ width: "130px" }} value={editForm.volume_threshold} onChange={e => setEditForm({...editForm, volume_threshold: e.target.value})} />
                    </td>
                    <td style={{ padding: "1rem 1.5rem", textAlign: "right" }}>
                      <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
                        <button className="btn-icon" onClick={() => handleUpdate(r.rating_group_id)} title={t("save")}><Save size={18} color="var(--success)" /></button>
                        <button className="btn-icon" onClick={() => setEditingId(null)} title={t("cancel")}><X size={18} color="var(--text-muted)" /></button>
                      </div>
                    </td>
                  </>
                ) : (
                  <>
                    <td style={{ padding: "1.25rem 1.5rem" }}>
                      <span style={{ fontFamily: "monospace", fontWeight: 600, color: "var(--primary)", fontSize: "1.1rem" }}>#{r.rating_group_id}</span>
                    </td>
                    <td style={{ padding: "1.25rem 1.5rem" }}>
                      <span style={{ background: "rgba(59, 130, 246, 0.12)", color: "var(--primary)", padding: "3px 10px", borderRadius: "12px", fontSize: "0.85rem", fontWeight: 600 }}>{formatCurrency(r.currency)}</span>
                    </td>
                    <td style={{ padding: "1.25rem 1.5rem", fontFamily: "monospace", fontWeight: 500, color: "var(--text-main)", fontSize: "1.05rem" }}>{r.rates}</td>
                    <td style={{ padding: "1.25rem 1.5rem" }}>
                      <span style={{ background: "rgba(16, 185, 129, 0.12)", color: "var(--success)", padding: "3px 10px", borderRadius: "12px", fontSize: "0.85rem", fontWeight: 600 }}>
                        {RATE_TYPES.find(t => t.val === r.rates_type)?.label || r.rates_type}
                      </span>
                    </td>
                    <td style={{ padding: "1.25rem 1.5rem", fontFamily: "monospace", color: "var(--text-main)" }}>{r.apn || "internet"}</td>
                    <td style={{ padding: "1.25rem 1.5rem", fontFamily: "monospace", color: "var(--text-main)" }}>{r.service_identifier ?? 1}</td>
                    <td style={{ padding: "1.25rem 1.5rem", fontFamily: "monospace", color: "var(--text-main)" }}>{r.quota_per_grant ?? 10485760}</td>
                    <td style={{ padding: "1.25rem 1.5rem", fontFamily: "monospace", color: "var(--text-main)" }}>{r.validity_time ?? 300}s</td>
                    <td style={{ padding: "1.25rem 1.5rem", fontFamily: "monospace", color: "var(--text-main)" }}>{r.volume_threshold ?? 8388608}</td>
                    {canEditTemplates && (
                      <td style={{ padding: "1.25rem 1.5rem", textAlign: "right" }}>
                        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
                          <button className="btn-icon" onClick={() => startEdit(r)} title={t("edit")}><Pencil size={16} color="var(--primary)" /></button>
                          <button className="btn-icon" onClick={() => handleDelete(r.rating_group_id)} title={t("delete")}><Trash2 size={16} color="var(--danger)" /></button>
                        </div>
                      </td>
                    )}
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
