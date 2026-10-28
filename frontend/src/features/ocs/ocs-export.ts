/*
 * Tariff plan export.
 *
 * `GET /api/tariff-plans/{planId}/export` answers with a JSON attachment rather
 * than a JSON document. The export contract is frozen:
 * `Content-Type: application/json` plus
 * `Content-Disposition: attachment; filename="tariff-plan-{id}.json"`.
 *
 * The transport lives in `lib/api/download`; this module only supplies the
 * OCS-specific path and the documented fallback filename, so business feature
 * code never issues a raw request of its own.
 */
import { AttachmentError, downloadAttachment } from '../../lib/api/download';

export { AttachmentError as TariffExportError };

export const TARIFF_EXPORT_FALLBACK = (planId: string) => `tariff-plan-${planId}.json`;

export async function downloadTariffPlanExport(planId: string): Promise<string> {
  return downloadAttachment(
    `/api/tariff-plans/${encodeURIComponent(planId)}/export`,
    TARIFF_EXPORT_FALLBACK(planId),
  );
}
