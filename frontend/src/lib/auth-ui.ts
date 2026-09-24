import { isPasswordStrong } from './security';

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
 * Supports both direct errors ({ code: "..." }) and FetchError shapes ({ info: { code: "..." } }).
 * Never exposes raw backend diagnostic messages or internal server error strings.
 */
export function mapUserManagementError(
  err: unknown,
  t: (key: string, params?: Record<string, string | number>) => string
): string {
  if (!err) return t('users_err_update');
  const code =
    (typeof err === 'object' && err !== null && 'code' in err && typeof (err as { code?: unknown }).code === 'string')
      ? (err as { code: string }).code
      : (typeof err === 'object' && err !== null && 'info' in err && typeof (err as { info?: { code?: unknown } }).info?.code === 'string')
        ? (err as { info: { code: string } }).info.code
        : undefined;

  switch (code) {
    case 'LAST_ACTIVE_ADMIN':
      return t('users_err_last_active_admin');
    case 'SELF_OPERATION_FORBIDDEN':
    case 'SELF_DISABLE_FORBIDDEN':
    case 'SELF_DELETE_FORBIDDEN':
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
    case 'INVALID_USERNAME':
      return t('users_err_username');
    case 'INVALID_ROLE':
    case 'ROLE_ASSIGNMENT_FORBIDDEN':
      return t('users_err_role');
    case 'INVALID_STATUS':
      return t('users_err_status');
    case 'INVALID_EMAIL':
      return t('users_err_email');
    case 'INVALID_DISPLAY_NAME':
      return t('users_err_display_name');
    default:
      return t('users_err_update');
  }
}

export interface ExecutePasswordResetParams {
  username: string;
  password: string;
  confirmPassword: string;
  reason?: string;
  onReset: (username: string, password: string, reason?: string) => Promise<void>;
  onSuccess: () => void;
  setError: (msg: string) => void;
  resetFields: () => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

/**
 * Pure orchestration helper coordinating password validation, matching, mutation invocation,
 * field clearance, success callback invocation, and safe error presentation.
 */
export async function executePasswordReset({
  username,
  password,
  confirmPassword,
  reason,
  onReset,
  onSuccess,
  setError,
  resetFields,
  t,
}: ExecutePasswordResetParams): Promise<boolean> {
  if (!isPasswordStrong(password, username)) {
    setError(t('users_err_password'));
    return false;
  }
  if (password !== confirmPassword) {
    setError(t('users_err_password_match'));
    return false;
  }
  setError('');
  try {
    await onReset(username, password, reason);
    resetFields();
    onSuccess();
    return true;
  } catch (err) {
    setError(mapUserManagementError(err, t));
    return false;
  }
}
