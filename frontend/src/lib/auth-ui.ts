export type LoginErrorCategory =
  | 'invalid_credentials'
  | 'rate_limited'
  | 'service_unavailable'
  | 'server_error'
  | 'network_error';

export interface LoginUiState {
  category: LoginErrorCategory;
  i18nKey: string;
  retryAfterSeconds: number;
}

/**
 * Safely parses the Retry-After header into a non-negative integer.
 * Returns 0 if missing, non-numeric, zero, or negative. Never returns NaN.
 */
export function parseRetryAfter(header?: string | null): number {
  if (!header) return 0;
  const trimmed = header.trim();
  const val = Number(trimmed);
  if (!Number.isFinite(val) || isNaN(val) || val <= 0) {
    return 0;
  }
  return Math.max(0, Math.floor(val));
}

/**
 * Pure response-to-UI mapping helper for login failures.
 * Ensures credential failure privacy: all 401 statuses map to a single generic message.
 */
export function mapLoginResponse(
  status: number | undefined,
  body?: { code?: string; error?: string } | null,
  retryAfterHeader?: string | null
): LoginUiState {
  if (status === undefined) {
    return {
      category: 'network_error',
      i18nKey: 'login_network_error',
      retryAfterSeconds: 0,
    };
  }

  if (status === 401) {
    return {
      category: 'invalid_credentials',
      i18nKey: 'login_invalid_credentials',
      retryAfterSeconds: 0,
    };
  }

  if (status === 429) {
    const retryAfterSeconds = parseRetryAfter(retryAfterHeader);
    return {
      category: 'rate_limited',
      i18nKey: retryAfterSeconds > 0 ? 'login_retry_after' : 'login_rate_limited',
      retryAfterSeconds,
    };
  }

  if (status === 502 || status === 503) {
    return {
      category: 'service_unavailable',
      i18nKey: 'login_service_unavailable',
      retryAfterSeconds: 0,
    };
  }

  return {
    category: 'server_error',
    i18nKey: 'login_server_error',
    retryAfterSeconds: 0,
  };
}

/**
 * Maps User Management API and policy error codes to safe localized user messages.
 */
export function mapUserManagementError(
  err: unknown,
  t: (key: string, params?: Record<string, string | number>) => string
): string {
  if (!err) return t('users_err_update');
  const code = (err as { code?: string })?.code;

  switch (code) {
    case 'LAST_ACTIVE_ADMIN':
      return t('users_err_last_active_admin');
    case 'SELF_OPERATION_FORBIDDEN':
    case 'SELF_DISABLE_FORBIDDEN':
      return t('users_err_self_operation');
    case 'SELF_ROLE_CHANGE_FORBIDDEN':
      return t('users_err_self_role_change');
    case 'USER_NOT_FOUND':
      return t('users_err_not_found');
    case 'USERNAME_ALREADY_EXISTS':
      return t('users_username_taken');
    case 'INVALID_PASSWORD':
      return t('users_err_password');
    case 'PERMISSION_DENIED':
      return t('users_err_permission_denied');
    default:
      if (err instanceof Error && err.message) {
        return err.message;
      }
      return t('users_err_update');
  }
}
