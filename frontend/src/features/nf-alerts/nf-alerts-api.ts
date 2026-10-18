import { getJson } from '../../lib/api/read-client';
import { deleteJson, postJson, putJson } from '../../lib/api/mutation-client';
import type {
  Alert,
  AlertListQueryParams,
  AlertRule,
  CreateRuleRequest,
  DeleteRuleResponse,
  ListAlertsResponse,
  ListRulesResponse,
  NfAlertsMeta,
  RuleListQueryParams,
  UpdateRuleRequest,
} from './nf-alerts-types';

function withQuery(path: string, params: Record<string, string | number | undefined>): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    searchParams.set(key, String(value));
  }
  const query = searchParams.toString();
  return query ? `${path}?${query}` : path;
}

export async function fetchNfAlertsMeta(): Promise<NfAlertsMeta> {
  return getJson<NfAlertsMeta>('/api/nf-alerts/meta');
}

export async function fetchNfAlertRules(
  params: RuleListQueryParams = {},
): Promise<ListRulesResponse> {
  return getJson<ListRulesResponse>(
    withQuery('/api/nf-alerts/rules', {
      q: params.q,
      enabled: params.enabled,
      cursor: params.cursor,
      limit: params.limit,
    }),
  );
}

export async function fetchNfAlertRule(ruleId: string): Promise<AlertRule> {
  return getJson<AlertRule>(`/api/nf-alerts/rules/${encodeURIComponent(ruleId)}`);
}

export async function createNfAlertRule(payload: CreateRuleRequest): Promise<AlertRule> {
  return postJson<AlertRule>('/api/nf-alerts/rules', payload);
}

export async function updateNfAlertRule(
  ruleId: string,
  payload: UpdateRuleRequest,
): Promise<AlertRule> {
  return putJson<AlertRule>(`/api/nf-alerts/rules/${encodeURIComponent(ruleId)}`, payload);
}

export async function deleteNfAlertRule(ruleId: string): Promise<DeleteRuleResponse> {
  return deleteJson<DeleteRuleResponse>(`/api/nf-alerts/rules/${encodeURIComponent(ruleId)}`);
}

export async function fetchNfAlerts(
  params: AlertListQueryParams = {},
): Promise<ListAlertsResponse> {
  return getJson<ListAlertsResponse>(
    withQuery('/api/nf-alerts', {
      state: params.state,
      severity: params.severity,
      q: params.q,
      cursor: params.cursor,
      limit: params.limit,
    }),
  );
}

export async function acknowledgeNfAlert(alertId: string): Promise<Alert> {
  return postJson<Alert>(`/api/nf-alerts/${encodeURIComponent(alertId)}/acknowledge`, {});
}

export async function resolveNfAlert(alertId: string): Promise<Alert> {
  return postJson<Alert>(`/api/nf-alerts/${encodeURIComponent(alertId)}/resolve`, {});
}
