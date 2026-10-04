export function isPasswordStrong(password: unknown, username?: string): password is string {
  return (
    typeof password === 'string' &&
    [...password.trim()].length >= 8 &&
    new TextEncoder().encode(password).length <= 72 &&
    (!username || !password.toLowerCase().includes(username.toLowerCase()))
  );
}

export const PASSWORD_POLICY_MESSAGE =
  'Password must have at least 8 Unicode characters after trimming surrounding whitespace, at most 72 UTF-8 bytes, and must not contain the target username';
