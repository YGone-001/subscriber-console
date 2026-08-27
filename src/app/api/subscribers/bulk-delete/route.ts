import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { requireCapability } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { isSuperAdmin } from '@/lib/permissions';
import { validateImsiList } from '@/lib/subscriberValidation';
import { createApprovalRequest } from '@/server/repositories/approvalRepository';
import { deleteSubscriber } from '@/server/repositories/subscriberRepository';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const auth = requireCapability(request, 'subscriber_write');
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`subscribers:bulk-delete:${auth.auth.user}`, 10, 60);
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const body = await request.json();
    const validation = validateImsiList(body?.imsiList);
    if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: 400 });
    if (validation.value.length === 0) return NextResponse.json({ error: 'imsiList cannot be empty' }, { status: 400 });

    if (!isSuperAdmin(auth.auth.role)) {
      const approval = await createApprovalRequest({
        action: 'SUBSCRIBER_BULK_DELETE',
        requester: auth.auth.user,
        targetId: 'subscriber:bulk-delete',
        summary: `Delete ${validation.value.length} subscriber(s)`,
        payload: { imsiList: validation.value },
      });

      logAudit('UPDATE', `approval:${approval.id}`, null, approval, request);
      return NextResponse.json(
        { message: 'Approval required before bulk subscriber deletion', approval },
        { status: 202 }
      );
    }

    const results = await Promise.all(validation.value.map(async (imsi) => ({ imsi, deleted: await deleteSubscriber(imsi) })));
    const deletedImsis = results.filter((item) => item.deleted).map((item) => item.imsi);

    logAudit(
      'BATCH_DELETE',
      deletedImsis.length > 0 ? `${deletedImsis[0]} ~ ${deletedImsis[deletedImsis.length - 1]}` : 'subscriber:bulk-delete',
      { requested: validation.value },
      { deleted: deletedImsis.length, deletedImsis },
      request
    );

    return NextResponse.json({
      message: `Deleted ${deletedImsis.length} subscribers`,
      requested: validation.value.length,
      deleted: deletedImsis.length,
      deletedImsis,
    });
  } catch (error) {
    console.error('Error bulk deleting subscribers:', error);
    return NextResponse.json({ error: 'Bulk subscriber delete failed' }, { status: 500 });
  }
}
