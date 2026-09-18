"use client";

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import useSWR from 'swr';
import { AlertTriangle, CheckCircle2, Clock3, Eye, GitPullRequest, Play, RefreshCw, Search, ShieldAlert, X } from 'lucide-react';
import { useI18n } from '@/components/I18nProvider';
import { ApprovalStatusBadge, RiskBadge } from '@/components/governance/GovernanceBadges';
import { ChangeDiff } from '@/components/governance/ChangeDiff';
import { EventTimeline } from '@/components/governance/EventTimeline';
import { EmptyState } from '@/components/OperationFeedback';
import { DataTablePagination } from '@/components/ui/DataTablePagination';
import { Dialog } from '@/components/ui/Dialog';
import MetricStrip from '@/components/ui/MetricStrip';
import PageHeader from '@/components/ui/PageHeader';
import { fetcher } from '@/lib/fetcher';
import type { ApprovalDocument } from '@/server/repositories/approvalRepository';
import type { AuditLogRecord } from '@/types/audit';
import styles from './ApprovalConsole.module.css';

type Eligibility = {
  canApprove: boolean; approveReason?: string;
  canReject: boolean; rejectReason?: string;
  canCancel: boolean; cancelReason?: string;
  canExecute: boolean; executeReason?: string;
};
type ApprovalItem = ApprovalDocument & { actions: Eligibility };
type ListResponse = {
  approvals: ApprovalItem[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  summary: { canReview: number; awaiting: number; todayApproved: number; highRiskPending: number };
};
type DetailResponse = { approval: ApprovalItem };
type AuditResponse = { logs: AuditLogRecord[] };
type PendingAction = { type: 'approve' | 'reject' | 'cancel' | 'execute'; approval: ApprovalItem };

const QUERY_KEYS = ['page', 'pageSize', 'q', 'status', 'risk', 'action', 'resourceType', 'resourceId', 'requester', 'reviewer', 'from', 'to'] as const;
const STATUSES = ['pending', 'approved', 'executing', 'completed', 'rejected', 'cancelled', 'expired', 'failed'] as const;
const ACTIONS = ['ACCESS_REQUEST', 'POLICY_CHANGE', 'TRAFFIC_ADJUSTMENT', 'RATING_CREATE', 'RATING_UPDATE', 'RATING_DELETE', 'TARIFF_PLAN_MIGRATE', 'PROFILE_RESTORE', 'SYSTEM_HEAL', 'SUBSCRIBER_BATCH_CREATE', 'SUBSCRIBER_BATCH_UPDATE', 'SUBSCRIBER_IMPORT', 'SUBSCRIBER_BULK_DELETE'] as const;

function actionLabel(action: string, zh: boolean) {
  const labels: Record<string, [string, string]> = {
    ACCESS_REQUEST: ['权限申请', 'Access request'], POLICY_CHANGE: ['策略变更', 'Policy change'], TRAFFIC_ADJUSTMENT: ['余额调整', 'Balance adjustment'],
    RATING_CREATE: ['新建计费规则', 'Create rating rule'], RATING_UPDATE: ['修改计费规则', 'Update rating rule'], RATING_DELETE: ['删除计费规则', 'Delete rating rule'],
    TARIFF_PLAN_MIGRATE: ['资费计划迁移', 'Tariff migration'], PROFILE_RESTORE: ['配置恢复', 'Profile restore'], SYSTEM_HEAL: ['系统修复', 'System heal'],
    SUBSCRIBER_BATCH_CREATE: ['批量开户', 'Batch provision'], SUBSCRIBER_IMPORT: ['用户导入', 'Subscriber import'], SUBSCRIBER_BULK_DELETE: ['批量删除用户', 'Bulk subscriber delete'],
  };
  if (action === 'SUBSCRIBER_BATCH_UPDATE') return zh ? '批量修改订阅用户' : 'Subscriber batch update';
  return labels[action]?.[zh ? 0 : 1] || action;
}

export function ApprovalConsole() {
  const { isZh, formatDateTime } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const selectedId = params.get('approvalId');
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const navigate = (changes: Record<string, string | number | null>, replace = false) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === '' || value === 'all') next.delete(key); else next.set(key, String(value));
    }
    router[replace ? 'replace' : 'push'](next.size ? `/approvals?${next}` : '/approvals', { scroll: false });
  };
  const api = new URLSearchParams();
  for (const key of QUERY_KEYS) { const value = params.get(key); if (value) api.set(key, value); }
  if (!api.has('page')) api.set('page', '1');
  if (!api.has('pageSize')) api.set('pageSize', '20');
  const { data, error, isLoading, mutate } = useSWR<ListResponse>(`/api/approvals?${api}`, fetcher);
  const { data: detail, mutate: mutateDetail } = useSWR<DetailResponse>(selectedId ? `/api/approvals/${selectedId}` : null, fetcher);
  const { data: audit, mutate: mutateAudit } = useSWR<AuditResponse>(selectedId ? `/api/approvals/${selectedId}/audit` : null, fetcher);
  const page = Number(params.get('page') || 1);
  useEffect(() => { if (data && data.pagination.page !== page) navigate({ page: data.pagination.page }, true); }, [data?.pagination.page, page]); // eslint-disable-line react-hooks/exhaustive-deps

  const setFilter = (key: string, value: string, replace = false) => navigate({ [key]: value, page: 1, approvalId: null }, replace);
  const reset = () => {
    const changes: Record<string, null> = { approvalId: null };
    for (const key of QUERY_KEYS) changes[key] = null;
    navigate(changes);
  };
  const openAction = (type: PendingAction['type'], approval: ApprovalItem) => { setComment(''); setNotice(null); setPendingAction({ type, approval }); };
  const submitAction = async () => {
    if (!pendingAction) return;
    if (pendingAction.type === 'reject' && comment.trim().length < 3) { setNotice({ tone: 'error', text: isZh ? '驳回原因至少需要 3 个字符。' : 'Rejection reason must contain at least 3 characters.' }); return; }
    setSubmitting(true); setNotice(null);
    try {
      const body = pendingAction.type === 'approve' ? { comment: comment.trim() } : pendingAction.type === 'execute' ? {} : { reason: comment.trim() };
      const response = await fetch(`/api/approvals/${pendingAction.approval.id}/${pendingAction.type}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.code || payload.error || 'APPROVAL_OPERATION_FAILED');
      setPendingAction(null); setComment(''); setNotice({ tone: 'success', text: isZh ? '变更单状态已更新。' : 'Change request updated.' });
      await Promise.all([mutate(), mutateDetail(), mutateAudit()]);
    } catch (actionError) { setNotice({ tone: 'error', text: actionError instanceof Error ? actionError.message : 'APPROVAL_OPERATION_FAILED' }); }
    finally { setSubmitting(false); }
  };

  const summary = data?.summary || { canReview: 0, awaiting: 0, todayApproved: 0, highRiskPending: 0 };
  const approvals = data?.approvals || [];
  const selected = detail?.approval;
  return <div className={`container animate-fade-in ${styles.console}`}>
    <PageHeader eyebrow="CHANGE / GOVERNANCE" icon={<GitPullRequest size={23} />} title={isZh ? '变更审批' : 'Change approvals'}
      description={isZh ? '审批结论与执行状态独立流转，所有动作保留并发安全的状态证据。' : 'Approval decisions and execution progress move independently with concurrency-safe evidence.'}
      status={<><ShieldAlert size={15} />{isZh ? '原子状态机' : 'Atomic state machine'}</>}
      actions={<button type="button" className="btn btn-outline" onClick={() => void mutate()}><RefreshCw size={15} />{isZh ? '刷新' : 'Refresh'}</button>} />
    <MetricStrip ariaLabel={isZh ? '审批统计' : 'Approval metrics'} items={[
      { key: 'review', label: isZh ? '可由我审批' : 'I can review', value: summary.canReview, icon: <CheckCircle2 size={17} />, tone: 'primary', onClick: () => navigate({ status: 'pending', page: 1 }) },
      { key: 'pending', label: isZh ? '等待审批' : 'Awaiting review', value: summary.awaiting, icon: <Clock3 size={17} />, tone: 'warning', onClick: () => navigate({ status: 'pending', page: 1 }) },
      { key: 'approved', label: isZh ? '今日已通过' : 'Approved today', value: summary.todayApproved, icon: <CheckCircle2 size={17} />, tone: 'success', onClick: () => navigate({ status: 'approved', page: 1 }) },
      { key: 'risk', label: isZh ? '高风险待审' : 'High risk pending', value: summary.highRiskPending, icon: <ShieldAlert size={17} />, tone: 'danger', onClick: () => navigate({ status: 'pending', risk: 'high', page: 1 }) },
    ]} />
    {notice ? <div className={styles.notice} data-tone={notice.tone} role="status">{notice.text}</div> : null}
    <section className={`glass-card ${styles.filters}`} aria-label={isZh ? '审批筛选' : 'Approval filters'}>
      <label className={styles.search}><Search size={17} /><span className="sr-only">{isZh ? '搜索' : 'Search'}</span><input value={params.get('q') || ''} onChange={(e) => setFilter('q', e.target.value, true)} placeholder={isZh ? '搜索 CHG 编号、目标、申请人或动作' : 'Search CHG ID, target, requester or action'} /></label>
      <select aria-label={isZh ? '状态' : 'Status'} value={params.get('status') || ''} onChange={(e) => setFilter('status', e.target.value)}><option value="">{isZh ? '全部状态' : 'All statuses'}</option>{STATUSES.map((value) => <option key={value} value={value}>{value}</option>)}</select>
      <select aria-label={isZh ? '风险' : 'Risk'} value={params.get('risk') || ''} onChange={(e) => setFilter('risk', e.target.value)}><option value="">{isZh ? '全部风险' : 'All risks'}</option>{['low', 'medium', 'high', 'critical'].map((value) => <option key={value} value={value}>{value.toUpperCase()}</option>)}</select>
      <select aria-label={isZh ? '动作' : 'Action'} value={params.get('action') || ''} onChange={(e) => setFilter('action', e.target.value)}><option value="">{isZh ? '全部动作' : 'All actions'}</option>{ACTIONS.map((value) => <option key={value} value={value}>{actionLabel(value, isZh)}</option>)}</select>
      <button type="button" className="btn btn-ghost" onClick={reset}>{isZh ? '重置' : 'Reset'}</button>
      <details className={styles.more}><summary>{isZh ? '更多筛选' : 'More filters'}</summary><div>
        <label>{isZh ? '申请人' : 'Requester'}<input value={params.get('requester') || ''} onChange={(e) => setFilter('requester', e.target.value, true)} /></label>
        <label>{isZh ? '审批人' : 'Reviewer'}<input value={params.get('reviewer') || ''} onChange={(e) => setFilter('reviewer', e.target.value, true)} /></label>
        <label>{isZh ? '资源类型' : 'Resource type'}<input value={params.get('resourceType') || ''} onChange={(e) => setFilter('resourceType', e.target.value, true)} /></label>
        <label>{isZh ? '资源 ID' : 'Resource ID'}<input value={params.get('resourceId') || ''} onChange={(e) => setFilter('resourceId', e.target.value, true)} /></label>
        <label>{isZh ? '开始时间' : 'From'}<input type="date" value={params.get('from') || ''} onChange={(e) => setFilter('from', e.target.value)} /></label>
        <label>{isZh ? '结束时间' : 'To'}<input type="date" value={params.get('to') || ''} onChange={(e) => setFilter('to', e.target.value)} /></label>
      </div></details>
    </section>
    <section className={`glass-card ${styles.tableCard}`} aria-label={isZh ? '变更单列表' : 'Change request list'}>
      <div className={styles.tableScroll}><table className={styles.table}><caption className="sr-only">{isZh ? '变更审批列表' : 'Change approval list'}</caption><thead><tr><th>CHG ID</th><th>{isZh ? '变更' : 'Change'}</th><th>{isZh ? '目标' : 'Target'}</th><th>{isZh ? '风险' : 'Risk'}</th><th>{isZh ? '申请人与时间' : 'Requester / time'}</th><th>{isZh ? '状态 / 审批人' : 'Status / reviewer'}</th><th>{isZh ? '操作' : 'Actions'}</th></tr></thead><tbody>
        {isLoading ? <tr><td colSpan={7}><div className={styles.loading} aria-busy="true">{isZh ? '正在加载审批数据…' : 'Loading approval data…'}</div></td></tr> : null}
        {!isLoading && error ? <tr><td colSpan={7}><EmptyState icon={<AlertTriangle />} title={isZh ? '审批列表加载失败' : 'Failed to load approvals'} description={isZh ? '请刷新或检查访问权限。' : 'Refresh or check access permissions.'} /></td></tr> : null}
        {!isLoading && !error && approvals.length === 0 ? <tr><td colSpan={7}><EmptyState icon={<GitPullRequest />} title={isZh ? '暂无变更单' : 'No change requests'} description={isZh ? '当前筛选条件没有匹配记录。' : 'No records match the current filters.'} /></td></tr> : null}
        {approvals.map((approval) => <tr key={approval.id} tabIndex={0} onClick={() => navigate({ approvalId: approval.id })} onKeyDown={(e) => { if (e.key === 'Enter') navigate({ approvalId: approval.id }); }}>
          <td data-label="CHG ID"><code>{approval.changeId || approval.id}</code>{approval.legacyStatus ? <small>{isZh ? '历史状态记录' : 'Legacy status record'}</small> : null}</td>
          <td data-label={isZh ? '变更' : 'Change'}><strong>{approval.title || approval.summary}</strong><small>{actionLabel(approval.action, isZh)}</small></td>
          <td data-label={isZh ? '目标' : 'Target'}><code>{approval.operation?.resourceId || approval.targetId}</code><small>{approval.operation?.resourceType}</small></td>
          <td data-label={isZh ? '风险' : 'Risk'}><RiskBadge risk={approval.riskLevel} /></td>
          <td data-label={isZh ? '申请人与时间' : 'Requester / time'}><strong>{approval.requester}</strong><small>{formatDateTime(approval.createdAt)}</small></td>
          <td data-label={isZh ? '状态 / 审批人' : 'Status / reviewer'}><ApprovalStatusBadge status={approval.status} /><small>{approval.reviewer || '—'}</small></td>
          <td data-label={isZh ? '操作' : 'Actions'}><div className={styles.rowActions} onClick={(e) => e.stopPropagation()}>
            <button type="button" className="btn btn-ghost" onClick={() => navigate({ approvalId: approval.id })}><Eye size={15} />{isZh ? '详情' : 'Details'}</button>
            {approval.actions.canApprove ? <button type="button" className="btn btn-primary" onClick={() => openAction('approve', approval)}>{isZh ? '通过' : 'Approve'}</button> : null}
            {approval.actions.canExecute ? <button type="button" className="btn btn-primary" onClick={() => openAction('execute', approval)}><Play size={15} />{isZh ? '执行' : 'Execute'}</button> : null}
          </div></td>
        </tr>)}
      </tbody></table></div>
      {data ? <DataTablePagination page={data.pagination.page} pageSize={data.pagination.pageSize} total={data.pagination.total} visibleCount={approvals.length} totalPages={data.pagination.totalPages}
        labels={{ showing: isZh ? '显示' : 'Showing', to: isZh ? '至' : 'to', of: isZh ? '共' : 'of', entries: isZh ? '条记录' : 'entries', previous: isZh ? '上一页' : 'Previous', next: isZh ? '下一页' : 'Next', perPage: isZh ? '每页' : 'per page' }}
        onPageChange={(next) => navigate({ page: next })} onPageSizeChange={(next) => navigate({ pageSize: next, page: 1 })} /> : null}
    </section>
    <ApprovalDrawer approval={selected} audit={audit?.logs || []} zh={isZh} formatDateTime={formatDateTime} onClose={() => navigate({ approvalId: null })} onAction={openAction} />
    <ActionDialog pending={pendingAction} comment={comment} setComment={setComment} submitting={submitting} notice={notice} zh={isZh} onClose={() => { if (!submitting) setPendingAction(null); }} onSubmit={() => void submitAction()} />
  </div>;
}

function ApprovalDrawer({ approval, audit, zh, formatDateTime, onClose, onAction }: { approval?: ApprovalItem; audit: AuditLogRecord[]; zh: boolean; formatDateTime: (value: Date | string | number, options?: Intl.DateTimeFormatOptions) => string; onClose: () => void; onAction: (type: PendingAction['type'], approval: ApprovalItem) => void }) {
  const titleId = useId(); const closeRef = useRef<HTMLButtonElement>(null);
  return <Dialog open={Boolean(approval)} onClose={onClose} overlayClassName={styles.drawerLayer} className={styles.drawer} labelledBy={titleId} initialFocusRef={closeRef}>
    {approval ? <><header className={styles.drawerHeader}><div><span>CHANGE REQUEST</span><h2 id={titleId}>{approval.changeId || approval.id}</h2></div><button ref={closeRef} type="button" onClick={onClose} aria-label={zh ? '关闭' : 'Close'}><X /></button></header>
      <div className={styles.drawerBody}>
        <section className={styles.detailSection}><div className={styles.lead}><div><ApprovalStatusBadge status={approval.status} /><RiskBadge risk={approval.riskLevel} /></div><h3>{approval.title}</h3><p>{approval.description || approval.summary}</p></div><dl className={styles.detailGrid}><div><dt>{zh ? '动作' : 'Action'}</dt><dd>{actionLabel(approval.action, zh)}</dd></div><div><dt>{zh ? '申请人' : 'Requester'}</dt><dd>{approval.requester}</dd></div><div><dt>{zh ? '审批人' : 'Reviewer'}</dt><dd>{approval.reviewer || '—'}</dd></div><div><dt>{zh ? '创建时间' : 'Created'}</dt><dd>{formatDateTime(approval.createdAt)}</dd></div></dl></section>
        <section className={styles.detailSection}><h3>{zh ? '原因、工单与维护窗口' : 'Reason, ticket and maintenance window'}</h3><p>{approval.reason || '—'}</p><dl className={styles.detailGrid}><div><dt>{zh ? '工单' : 'Ticket'}</dt><dd>{approval.ticketId || '—'}</dd></div><div><dt>{zh ? '维护窗口' : 'Maintenance window'}</dt><dd>{approval.maintenanceWindow ? `${formatDateTime(approval.maintenanceWindow.start)} — ${formatDateTime(approval.maintenanceWindow.end)}` : '—'}</dd></div></dl></section>
        <section className={styles.detailSection}><h3>{zh ? '变更目标' : 'Target'}</h3><code>{approval.operation?.resourceType}:{approval.operation?.resourceId}</code></section>
        <section className={styles.detailSection}><h3>{zh ? '冻结变更快照' : 'Frozen change snapshot'}</h3><ChangeDiff before={approval.before} after={approval.after} compact /></section>
        <section className={styles.detailSection}><h3>{zh ? '风险评估依据' : 'Risk rationale'}</h3><ul>{approval.riskAssessment.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul><small>{approval.riskAssessment.policyId}</small></section>
        <section className={styles.detailSection}><h3>{zh ? '真实事件时间线' : 'Recorded event timeline'}</h3><EventTimeline events={approval.events} /></section>
        <section className={styles.detailSection}><div className={styles.sectionHeading}><h3>{zh ? '关联审计' : 'Related audit'}</h3><Link href={`/audit-logs?approvalId=${encodeURIComponent(approval.id)}`}>{zh ? '在审计控制台查看' : 'Open audit console'}</Link></div><p>{zh ? `${audit.length} 条关联证据` : `${audit.length} related records`}</p></section>
        <section className={styles.detailSection}><h3>{zh ? '执行证据' : 'Execution evidence'}</h3><dl className={styles.detailGrid}><div><dt>Execution ID</dt><dd><code>{approval.execution?.id || '—'}</code></dd></div><div><dt>{zh ? '结果' : 'Result'}</dt><dd>{approval.execution?.success === undefined ? '—' : approval.execution.success ? 'SUCCESS' : 'FAILED'}</dd></div><div><dt>{zh ? '开始' : 'Started'}</dt><dd>{approval.execution?.startedAt ? formatDateTime(approval.execution.startedAt) : '—'}</dd></div><div><dt>{zh ? '完成' : 'Completed'}</dt><dd>{approval.execution?.completedAt ? formatDateTime(approval.execution.completedAt) : '—'}</dd></div></dl></section>
        <section className={`${styles.detailSection} ${styles.drawerActions}`}><h3>{zh ? '可用操作' : 'Available actions'}</h3><div>{approval.actions.canApprove ? <button className="btn btn-primary" onClick={() => onAction('approve', approval)}>{zh ? '通过' : 'Approve'}</button> : null}{approval.actions.canReject ? <button className="btn btn-outline" onClick={() => onAction('reject', approval)}>{zh ? '驳回' : 'Reject'}</button> : null}{approval.actions.canCancel ? <button className="btn btn-outline" onClick={() => onAction('cancel', approval)}>{zh ? '取消申请' : 'Cancel'}</button> : null}{approval.actions.canExecute ? <button className="btn btn-primary" onClick={() => onAction('execute', approval)}><Play size={15} />{zh ? '执行变更' : 'Execute change'}</button> : null}{!approval.actions.canApprove && !approval.actions.canReject && !approval.actions.canCancel && !approval.actions.canExecute ? <div className={styles.reasonList}><p>{zh ? '当前没有可用操作：' : 'No actions are currently available:'}</p><ul>{approval.actions.approveReason ? <li>{zh ? '通过：' : 'Approve: '}{approval.actions.approveReason}</li> : null}{approval.actions.rejectReason ? <li>{zh ? '驳回：' : 'Reject: '}{approval.actions.rejectReason}</li> : null}{approval.actions.cancelReason ? <li>{zh ? '取消：' : 'Cancel: '}{approval.actions.cancelReason}</li> : null}{approval.actions.executeReason ? <li>{zh ? '执行：' : 'Execute: '}{approval.actions.executeReason}</li> : null}</ul></div> : null}</div></section>
      </div></> : null}
  </Dialog>;
}

function ActionDialog({ pending, comment, setComment, submitting, notice, zh, onClose, onSubmit }: { pending: PendingAction | null; comment: string; setComment: (value: string) => void; submitting: boolean; notice: { tone: 'success' | 'error'; text: string } | null; zh: boolean; onClose: () => void; onSubmit: () => void }) {
  const titleId = useId(); const confirmRef = useRef<HTMLButtonElement>(null); const type = pending?.type;
  const title = type === 'approve' ? (zh ? '确认通过变更' : 'Approve change') : type === 'reject' ? (zh ? '确认驳回变更' : 'Reject change') : type === 'cancel' ? (zh ? '取消变更申请' : 'Cancel request') : (zh ? '确认执行变更' : 'Execute change');
  return <Dialog open={Boolean(pending)} onClose={onClose} overlayClassName={styles.modalLayer} className={styles.modal} labelledBy={titleId} initialFocusRef={confirmRef} role="alertdialog">
    {pending ? <><div className={styles.modalHeader}><div><span>{pending.approval.changeId || pending.approval.id}</span><h2 id={titleId}>{title}</h2></div><button type="button" onClick={onClose} disabled={submitting} aria-label={zh ? '关闭' : 'Close'}><X /></button></div><div className={styles.modalBody}>
      {pending.approval.riskLevel === 'critical' && type === 'approve' ? <div className={styles.critical}><AlertTriangle />{zh ? '这是关键风险变更。通过只记录审批结论，仍需单独执行。' : 'This is a critical-risk change. Approval records the decision only; execution remains separate.'}</div> : null}
      {type === 'execute' ? <div className={styles.critical}><Play />{zh ? '执行会先原子占用执行权，再检查维护窗口与目标状态。' : 'Execution atomically claims the request before checking its window and live target state.'}</div> : null}
      {type !== 'execute' ? <label>{type === 'reject' ? (zh ? '驳回原因（必填）' : 'Rejection reason (required)') : (zh ? '备注' : 'Comment')}<textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} rows={4} /></label> : null}
      {notice?.tone === 'error' ? <p className={styles.error}>{notice.text}</p> : null}
    </div><div className={styles.modalFooter}><button type="button" className="btn btn-outline" onClick={onClose} disabled={submitting}>{zh ? '返回' : 'Back'}</button><button ref={confirmRef} type="button" className="btn btn-primary" onClick={onSubmit} disabled={submitting}>{submitting ? (zh ? '处理中…' : 'Working…') : title}</button></div></> : null}
  </Dialog>;
}
