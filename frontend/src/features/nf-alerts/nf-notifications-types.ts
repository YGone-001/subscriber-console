/*
 * Notification configuration and delivery-ledger types.
 *
 * The channel secret is write-only: the server never returns it, so the type
 * does not carry one on read. The delivery status vocabulary mirrors the
 * outbox states the worker advances.
 */

export type NotificationChannel = {
  id: string;
  name: string;
  kind: 'webhook';
  enabled: boolean;
  url: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type CreateChannelRequest = {
  name: string;
  kind: 'webhook';
  url: string;
  secret?: string;
  enabled?: boolean;
};

export type UpdateChannelRequest = {
  expectedRevision: number;
  channel: {
    name: string;
    url: string;
    secret?: string;
    enabled: boolean;
  };
};

export type EscalationSeverity = 'critical' | 'warning' | 'info';

export type Escalation = {
  id: string;
  name: string;
  enabled: boolean;
  severities: EscalationSeverity[];
  ruleIds?: string[];
  channelIds: string[];
  escalateAfterSeconds: number;
  escalateChannelIds?: string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type CreateEscalationRequest = {
  name: string;
  enabled?: boolean;
  severities: EscalationSeverity[];
  ruleIds?: string[];
  channelIds: string[];
  escalateAfterSeconds: number;
  escalateChannelIds?: string[];
};

export type UpdateEscalationRequest = {
  expectedRevision: number;
  escalation: {
    name: string;
    enabled: boolean;
    severities: EscalationSeverity[];
    ruleIds: string[];
    channelIds: string[];
    escalateAfterSeconds: number;
    escalateChannelIds: string[];
  };
};

export type DeliveryStatus =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'skipped'
  | 'failed'
  | 'dead';

export type Delivery = {
  id: string;
  deliveryKey: string;
  event: string;
  alertId: string;
  ruleId: string;
  ruleName: string;
  targetId: string;
  targetName: string;
  severity: string;
  triggerCount: number;
  occurredAt: string;
  channelId: string;
  status: DeliveryStatus;
  attempts: number;
  lastError?: string;
  createdAt: string;
  completedAt?: string;
};

export type DeliveriesResponse = {
  deliveries: Delivery[];
  page: {
    limit: number;
    nextCursor?: string | null;
    hasMore: boolean;
  };
};
