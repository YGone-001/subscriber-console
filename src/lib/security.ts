const COMMON_SECRET_VALUES = new Set([
  'secret',
  'jwt_secret',
  'change-me',
  'changeme',
  'development',
  'password',
]);

export function getJwtSecretKey(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('FATAL: JWT_SECRET environment variable is missing');
  }

  const normalized = secret.trim();
  if (COMMON_SECRET_VALUES.has(normalized.toLowerCase())) {
    throw new Error('FATAL: JWT_SECRET uses an unsafe placeholder value');
  }

  if (new TextEncoder().encode(normalized).byteLength < 32) {
    throw new Error('FATAL: JWT_SECRET must be at least 32 bytes');
  }

  return new TextEncoder().encode(normalized);
}

export function isPasswordStrong(password: string): boolean {
  return password.length >= 8;
}

export const PASSWORD_POLICY_MESSAGE =
  'Password must be at least 8 characters';
