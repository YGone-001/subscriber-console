import { getJson } from '../../lib/api/read-client';
import { deleteJson, postJson, putJson } from '../../lib/api/mutation-client';
import type {
  CreateChannelRequest,
  CreateEscalationRequest,
  Delivery,
  DeliveryStatus,
  DeliveriesResponse,
  Escalation,
  NotificationChannel,
  UpdateChannelRequest,
  UpdateEscalationRequest,
} from './nf-notifications-types';

export async function fetchNotificationChannels(): Promise<NotificationChannel[]> {
  const res = await getJson<{ channels: NotificationChannel[] }>('/api/nf-notifications/channels');
  return res.channels ?? [];
}

export async function createNotificationChannel(payload: CreateChannelRequest): Promise<NotificationChannel> {
  return postJson<NotificationChannel>('/api/nf-notifications/channels', payload);
}

export async function updateNotificationChannel(
  channelId: string,
  payload: UpdateChannelRequest,
): Promise<NotificationChannel> {
  return putJson<NotificationChannel>(`/api/nf-notifications/channels/${encodeURIComponent(channelId)}`, payload);
}

export async function deleteNotificationChannel(channelId: string): Promise<{ status: string }> {
  return deleteJson<{ status: string }>(`/api/nf-notifications/channels/${encodeURIComponent(channelId)}`);
}

/**
 * Queues one channel probe. The worker delivers it through the real outbox, so
 * the test exercises the same signing and transport as alert traffic; the
 * result appears in the delivery ledger.
 */
export async function testNotificationChannel(channelId: string): Promise<Delivery> {
  return postJson<Delivery>(`/api/nf-notifications/channels/${encodeURIComponent(channelId)}/test`, {});
}

export async function fetchNotificationEscalations(): Promise<Escalation[]> {
  const res = await getJson<{ escalations: Escalation[] }>('/api/nf-notifications/escalations');
  return res.escalations ?? [];
}

export async function createNotificationEscalation(payload: CreateEscalationRequest): Promise<Escalation> {
  return postJson<Escalation>('/api/nf-notifications/escalations', payload);
}

export async function updateNotificationEscalation(
  escalationId: string,
  payload: UpdateEscalationRequest,
): Promise<Escalation> {
  return putJson<Escalation>(`/api/nf-notifications/escalations/${encodeURIComponent(escalationId)}`, payload);
}

export async function deleteNotificationEscalation(escalationId: string): Promise<{ status: string }> {
  return deleteJson<{ status: string }>(`/api/nf-notifications/escalations/${encodeURIComponent(escalationId)}`);
}

export type DeliveryQuery = {
  limit?: number;
  status?: DeliveryStatus | '';
  cursor?: string;
  alertId?: string;
  subjectKind?: 'nf_alert' | 'config_drift';
};

/** Builds the ledger path; every value is encoded and empty filters are omitted. */
export function notificationDeliveriesPath(query: DeliveryQuery = {}): string {
  const params = new URLSearchParams();
  params.set('limit', String(query.limit ?? 50));
  if (query.status) params.set('status', query.status);
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.alertId) params.set('alertId', query.alertId);
  params.set('subjectKind', query.subjectKind ?? 'nf_alert');
  return `/api/nf-notifications/deliveries?${params.toString()}`;
}

export async function fetchNotificationDeliveries(query: DeliveryQuery = {}): Promise<DeliveriesResponse> {
  return getJson<DeliveriesResponse>(notificationDeliveriesPath(query));
}

export async function retryNotificationDelivery(deliveryId: string): Promise<Delivery> {
  return postJson<Delivery>(`/api/nf-notifications/deliveries/${encodeURIComponent(deliveryId)}/retry`, {});
}