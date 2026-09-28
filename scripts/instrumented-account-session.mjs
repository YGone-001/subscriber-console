import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const __filename = fileURLToPath(import.meta.url);
const baseJiti = createJiti(__filename, {
  interopDefault: true,
  alias: {
    '@': path.resolve(path.dirname(__filename), '../frontend/src'),
    'next/server': path.resolve(path.dirname(__filename), '../frontend/node_modules/next/server.js'),
  },
});

const { getUser } = baseJiti('../frontend/src/server/repositories/userRepository.ts');
const { validateAccountSnapshot, AccountSessionError } = baseJiti('../frontend/src/lib/accountSession.ts');

export { AccountSessionError, validateAccountSnapshot };

export let sessionValidationCount = 0;

export function resetSessionCounters() {
  sessionValidationCount = 0;
}

export function getSessionValidationCount() {
  return sessionValidationCount;
}

export async function validateCurrentAccount(claims) {
  sessionValidationCount++;
  if (typeof claims.username !== 'string' || claims.username.length > 100) {
    throw new AccountSessionError('AUTH_INVALID_TOKEN');
  }
  return validateAccountSnapshot(claims, await getUser(claims.username));
}
