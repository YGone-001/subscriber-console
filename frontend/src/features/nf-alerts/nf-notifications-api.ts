import { getJson } from '../../lib/api/read-client';
import { deleteJson, postJson, putJson } from '../../lib/api/mutation-client';
import type {
  CreateChannelRequest,
  CreateEscalationRequest,
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

export async function fetchNotificationDeliveries(limit = 20): Promise<DeliveriesResponse> {
  return getJson<DeliveriesResponse>(
    `/api/nf-notifications/deliveries?limit=${encodeURIComponent(String(limit))}`,
  );
}
