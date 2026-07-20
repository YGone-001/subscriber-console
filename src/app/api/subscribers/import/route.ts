import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { requireCapability } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import {
  importSubscribersFromRecords,
  precheckSubscriberImsis,
} from '@/server/repositories/subscriberRepository';
import { validateImportRecords, validateImsiList } from '@/lib/subscriberValidation';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const auth = requireCapability(request, 'subscriber_write');
    if (!auth.ok) return auth.response;

    const rateLimit = await enforceRateLimit(`subscribers:import:${auth.auth.user}`, 12, 60);
    if (!rateLimit.ok) return rateLimit.response;

    const { searchParams } = new URL(request.url);
    const mode = searchParams.get('mode') || 'precheck';
    const body = await request.json();

    if (mode === 'precheck') {
      const { imsiList } = body;
      const validation = validateImsiList(imsiList);
      if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: 400 });

      const conflicts = await precheckSubscriberImsis(validation.value);

      return NextResponse.json({
        total: conflicts.length,
        existing: conflicts.filter((item) => item.exists).length,
        newCount: conflicts.filter((item) => !item.exists).length,
        conflicts,
      });
    }

    if (mode === 'import') {
      const { records, overwrite } = body;
      const validation = validateImportRecords(records);
      if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: 400 });

      const result = await importSubscribersFromRecords(validation.value, !!overwrite);

      if (result.importedImsis.length > 0) {
        logAudit(
          'CSV_IMPORT',
          result.importedImsis.join(','),
          null,
          {
            count: result.imported,
            overwrite: !!overwrite,
          },
          request
        );
      }

      return NextResponse.json({
        message: `Import completed: ${result.imported} imported, ${result.skipped} skipped${result.failed > 0 ? `, ${result.failed} failed` : ''}`,
        imported: result.imported,
        skipped: result.skipped,
        failed: result.failed,
        failedImsis: result.failedImsis,
      }, { status: result.failed > 0 ? 207 : 200 });
    }

    return NextResponse.json({ error: 'Invalid mode parameter' }, { status: 400 });
  } catch (error) {
    console.error('Import Error:', error);
    return NextResponse.json({ error: 'Internal server error during import' }, { status: 500 });
  }
}
