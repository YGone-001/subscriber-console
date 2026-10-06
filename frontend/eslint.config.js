import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    /* Node-side test infrastructure: the runner and the loader hooks are plain
     * Node modules, not browser code, so they need the Node globals. */
    files: ['tests/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
  },
  {
    /*
     * Forward-ported historical surfaces.
     *
     * The historical checkout disables `no-explicit-any` for exactly this reason:
     * "Existing API payloads and legacy UI state still use broad shapes. Keep lint
     * focused on actionable issues while those boundaries gain schemas."
     *
     * The port carries that code over verbatim, so the same decision applies — but
     * it is scoped to the ported files only. The current project's own modules keep
     * the strict rule.
     */
    files: [
      'src/features/subscribers/**/*.{ts,tsx}',
      'src/features/profiles/**/*.{ts,tsx}',
      'src/features/system-health/**/*.{ts,tsx}',
      'src/components/BatchCreateModal.tsx',
      'src/components/BulkPolicyModal.tsx',
      'src/components/TrafficAdjustmentModal.tsx',
      'src/components/SubscriberModal.tsx',
      'src/components/SubscriberBatchUpdateModal.tsx',
      'src/components/ProfileModal.tsx',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
