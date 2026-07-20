import { NextResponse } from 'next/server';
import { requireAnyRole } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { updateAlertWorkflow, type AlertWorkflowStatus } from '@/server/repositories/alertRepository';

export const dynamic = 'force-dynamic';

const WORKFLOW_STATUSES = new Set<AlertWorkflowStatus>(['acknowledged', 'assigned', 'recovering', 'resolved']);
const MAX_TEXT_LENGTH = 80;

function cleanText(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, MAX_TEXT_LENGTH);
}

export async function POST(request: Request) {
  const auth = requireAnyRole(request, ['root', 'operator']);
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`alerts:workflow:${auth.auth.user}`, 120, 60);
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const body = (await request.json()) as { id?: unknown; status?: unknown; assignedTo?: unknown; note?: unknown };
    const id = cleanText(body.id);
    const status = typeof body.status === 'string' ? body.status : '';

    if (!id) {
      return NextResponse.json({ error: 'Alert ID required' }, { status: 400 });
    }

    if (!WORKFLOW_STATUSES.has(status as AlertWorkflowStatus)) {
      return NextResponse.json({ error: 'Invalid alert workflow status' }, { status: 400 });
    }

    const result = await updateAlertWorkflow(id, {
      status: status as AlertWorkflowStatus,
      assignedTo: cleanText(body.assignedTo),
      note: cleanText(body.note),
    });

    if (result.matched === 0) {
      return NextResponse.json({ error: 'Alert not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    console.error('Alert workflow update error:', error);
    return NextResponse.json({ error: 'Failed to update alert workflow' }, { status: 500 });
  }
}
