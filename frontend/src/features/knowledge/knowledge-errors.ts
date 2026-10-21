import { MutationApiError } from '../../lib/api/mutation-client';

type Translate = (key: string, values?: Record<string, string | number>) => string;

const CODE_MESSAGES: Record<string, string> = {
  KNOWLEDGE_REVISION_CONFLICT: 'kb_revision_conflict',
  KNOWLEDGE_ENTRY_NOT_FOUND: 'kb_error_not_found',
  KNOWLEDGE_FILE_NOT_FOUND: 'kb_error_file_not_found',
  KNOWLEDGE_FILE_NOT_AVAILABLE: 'kb_error_file_unavailable',
  KNOWLEDGE_FILE_TOO_LARGE: 'kb_error_file_too_large',
  KNOWLEDGE_FILE_TYPE_REJECTED: 'kb_error_file_type',
  INVALID_MULTIPART: 'kb_error_validation',
  INVALID_REVISION: 'kb_error_validation',
  INVALID_ENTRY_ID: 'kb_error_validation',
  INVALID_FILE_ID: 'kb_error_validation',
  INVALID_JSON: 'kb_error_validation',
  VALIDATION_FAILED: 'kb_error_validation',
};

/** Maps a knowledge mutation failure to a localized, stable message. */
export function knowledgeErrorMessage(
  error: unknown,
  t: Translate,
  fallbackKey = 'kb_save_failed',
): string {
  if (!(error instanceof MutationApiError)) return t(fallbackKey);
  if (error.code && CODE_MESSAGES[error.code]) return t(CODE_MESSAGES[error.code]);
  if (error.status === 403) return t('kb_error_forbidden');
  if (error.status === 404) return t('kb_error_not_found');
  if (error.status === 409) return t('kb_revision_conflict');
  if (error.status === 413) return t('kb_error_file_too_large');
  if (error.status === 429) return t('kb_error_rate_limited');
  if (error.status === 0) return t('kb_error_network');
  if (error.status >= 500) return t('kb_error_internal');
  return t(fallbackKey);
}
