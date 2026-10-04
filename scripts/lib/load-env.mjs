import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Standard minimal environment loader using Node.js built-in process.loadEnvFile.
 * Loads .env.local (if present) followed by .env (if present).
 * Existing process.env variables take precedence.
 *
 * @param {string} [dir=process.cwd()]
 */
export function loadEnv(dir = process.cwd()) {
  const envFiles = ['.env.local', '.env'];
  for (const file of envFiles) {
    const full = resolve(dir, file);
    if (existsSync(full)) {
      try {
        process.loadEnvFile(full);
      } catch {
        // Ignore file read or parse errors if environment is already set
      }
    }
  }
}
