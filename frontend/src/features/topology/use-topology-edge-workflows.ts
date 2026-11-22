/*
 * Governed relationship workflow owner.
 *
 * Owns the three mutation workflows as state machines - which target is being
 * changed, what the operator has typed, whether a request is in flight, and what
 * the server said - and nothing else. The transport is injected by the page, so
 * this module never imports the request boundary and the page stays the one
 * place that names the three governed operations.
 *
 * Target safety is the reason this is a single owner. Every workflow captures the
 * edge it was opened with (including its revision) at the moment the operator
 * opened it, so a later query or view change cannot substitute a different
 * relationship underneath a pending action:
 *
 *   - the edit target carries `expectedRevision` from the row that was clicked;
 *   - the retire target carries its own revision and an explicit reason;
 *   - a revision conflict is surfaced and never retried automatically;
 *   - a failed mutation never reports success, and closing a dialog never
 *     submits anything.
 */
import { useCallback, useMemo, useState } from 'react';
import { MutationApiError } from '../../lib/api/mutation-client';
import { useI18n } from '../../providers/I18nProvider';
import { buildCreateEdgeRequest, buildRetireEdgeRequest } from './topology-builders';
import type {
  CreateEdgeRequest,
  RegisterRelationshipDraft,
  RetireEdgeRequest,
  TopologyEdge,
  UpdateEdgeRequest,
} from './topology-types';

/** The governed request boundary, injected so the page owns the wiring. */
export type TopologyEdgeExecutors = {
  create: (req: CreateEdgeRequest) => Promise<TopologyEdge>;
  update: (edgeId: string, req: UpdateEdgeRequest) => Promise<TopologyEdge>;
  retire: (edgeId: string, payload: RetireEdgeRequest) => Promise<TopologyEdge>;
};

export type TopologyEdgeWorkflows = {
  createOpen: boolean;
  editTarget: TopologyEdge | null;
  retireTarget: TopologyEdge | null;
  retireReason: string;
  submitting: boolean;
  formError: string | null;
  conflictNotice: string | null;
  beginCreate: () => void;
  beginEdit: (edge: TopologyEdge) => void;
  beginRetire: (edge: TopologyEdge) => void;
  setRetireReason: (value: string) => void;
  closeCreate: () => void;
  closeEdit: () => void;
  closeRetire: () => void;
  submitCreate: (req: CreateEdgeRequest) => Promise<void>;
  submitUpdate: (req: UpdateEdgeRequest) => Promise<void>;
  submitRetire: () => Promise<void>;
  /** Registers one configured link as a declaration; returns an error or null. */
  registerFromEvidence: (draft: RegisterRelationshipDraft) => Promise<string | null>;
  /** Clears the conflict banner and re-reads the authoritative ledger. */
  acknowledgeConflict: () => void;
};

export function useTopologyEdgeWorkflows({
  executors,
  reload,
  cursor,
  onCreated,
}: {
  executors: TopologyEdgeExecutors;
  /** Re-reads the authoritative ledger after a successful mutation. */
  reload: (cursor?: string) => Promise<void>;
  cursor: string | undefined;
  /** Navigation after a create; the page owns navigation. */
  onCreated: (edge: TopologyEdge) => void;
}): TopologyEdgeWorkflows {
  const { t } = useI18n();

  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<TopologyEdge | null>(null);
  const [retireTarget, setRetireTarget] = useState<TopologyEdge | null>(null);
  const [retireReason, setRetireReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [conflictNotice, setConflictNotice] = useState<string | null>(null);

  const describe = useCallback(
    (err: unknown) => describeMutationError(err, t),
    [t],
  );

  const beginCreate = useCallback(() => {
    setFormError(null);
    setCreateOpen(true);
  }, []);

  const beginEdit = useCallback((edge: TopologyEdge) => {
    setFormError(null);
    setEditTarget(edge);
  }, []);

  const beginRetire = useCallback((edge: TopologyEdge) => {
    setFormError(null);
    setRetireReason('');
    setRetireTarget(edge);
  }, []);

  const closeCreate = useCallback(() => setCreateOpen(false), []);
  const closeEdit = useCallback(() => setEditTarget(null), []);
  const closeRetire = useCallback(() => setRetireTarget(null), []);

  const submitCreate = useCallback(
    async (req: CreateEdgeRequest) => {
      setSubmitting(true);
      setFormError(null);
      setConflictNotice(null);
      try {
        const created = await executors.create(req);
        setCreateOpen(false);
        await reload(cursor);
        onCreated(created);
      } catch (err) {
        setFormError(describe(err));
      } finally {
        setSubmitting(false);
      }
    },
    [executors, reload, cursor, onCreated, describe],
  );

  const submitUpdate = useCallback(
    async (req: UpdateEdgeRequest) => {
      /* The target was captured when the dialog opened. If it is gone the
       * workflow refuses instead of guessing a replacement. */
      if (!editTarget) return;
      setSubmitting(true);
      setFormError(null);
      try {
        await executors.update(editTarget.edgeId, req);
        setEditTarget(null);
        await reload(cursor);
      } catch (err) {
        if (isRevisionConflict(err)) {
          setFormError(t('topology_stale_revision_body'));
          setConflictNotice(t('topology_stale_revision_body'));
        } else {
          setFormError(describe(err));
        }
      } finally {
        setSubmitting(false);
      }
    },
    [editTarget, executors, reload, cursor, describe, t],
  );

  const submitRetire = useCallback(async () => {
    if (!retireTarget) return;
    setSubmitting(true);
    setFormError(null);
    try {
      /* The builder bounds the reason and binds the revision the operator saw. */
      const payload = buildRetireEdgeRequest(retireTarget.revision, retireReason);
      await executors.retire(retireTarget.edgeId, payload);
      setRetireTarget(null);
      setRetireReason('');
      await reload(cursor);
    } catch (err) {
      if (isRevisionConflict(err)) {
        setFormError(t('topology_stale_revision_body'));
      } else if (err instanceof MutationApiError) {
        setFormError(describe(err));
      } else {
        setFormError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSubmitting(false);
    }
  }, [retireTarget, retireReason, executors, reload, cursor, describe, t]);

  /* Registers one configured link in the declared ledger. The operator already
   * confirmed the specific link in the inspector, so this path opens no dialog;
   * a duplicate or a retired endpoint comes back as an inline error. */
  const registerFromEvidence = useCallback(
    async (draft: RegisterRelationshipDraft): Promise<string | null> => {
      try {
        await executors.create(buildCreateEdgeRequest(draft));
        await reload(cursor);
        return null;
      } catch (err) {
        return describe(err);
      }
    },
    [executors, reload, cursor, describe],
  );

  const acknowledgeConflict = useCallback(() => {
    setConflictNotice(null);
    void reload(cursor);
  }, [reload, cursor]);

  return useMemo(
    () => ({
      createOpen,
      editTarget,
      retireTarget,
      retireReason,
      submitting,
      formError,
      conflictNotice,
      beginCreate,
      beginEdit,
      beginRetire,
      setRetireReason,
      closeCreate,
      closeEdit,
      closeRetire,
      submitCreate,
      submitUpdate,
      submitRetire,
      registerFromEvidence,
      acknowledgeConflict,
    }),
    [
      createOpen,
      editTarget,
      retireTarget,
      retireReason,
      submitting,
      formError,
      conflictNotice,
      beginCreate,
      beginEdit,
      beginRetire,
      closeCreate,
      closeEdit,
      closeRetire,
      submitCreate,
      submitUpdate,
      submitRetire,
      registerFromEvidence,
      acknowledgeConflict,
    ],
  );
}

/**
 * True when a mutation failed because the caller held a stale revision.
 *
 * A revision conflict is a state the operator must resolve by re-reading, never a
 * transport hiccup to retry: the client cannot know whether the newer revision
 * still represents the relationship it meant to change.
 */
export function isRevisionConflict(err: unknown): boolean {
  return err instanceof MutationApiError && err.status === 409;
}

export function describeMutationError(
  err: unknown,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (err instanceof MutationApiError) {
    switch (err.code) {
      case 'TOPOLOGY_DUPLICATE_ACTIVE_EDGE':
        return t('topology_duplicate_edge');
      case 'TOPOLOGY_SELF_EDGE':
        return t('topology_self_edge');
      case 'TOPOLOGY_ENDPOINT_RETIRED':
        return t('topology_endpoint_retired');
      case 'TOPOLOGY_ENDPOINT_NOT_FOUND':
        return t('topology_endpoint_not_found');
      case 'TOPOLOGY_REVISION_CONFLICT':
        return t('topology_stale_revision_body');
      case 'TOPOLOGY_EDGE_RETIRED':
        return t('topology_edge_retired');
      default:
        break;
    }
    if (err.status === 403) return t('topology_permission_denied');
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
