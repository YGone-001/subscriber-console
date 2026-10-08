#!/usr/bin/env node
/*
 * Generate the UI forward-port manifest.
 *
 * The manifest is the authority for "what happens to each historical file". It is
 * generated rather than hand-written so completeness is provable: every TSX/TS/CSS
 * file under the reference `frontend/src` must match exactly one disposition rule,
 * and the generator FAILS when a file matches none. That is what makes the
 * acceptance criterion "every historical file relevant to an active route has
 * exactly one disposition" mechanically checkable instead of aspirational.
 *
 * Usage:
 *   node scripts/generate-ui-port-manifest.mjs            # write the manifest
 *   node scripts/generate-ui-port-manifest.mjs --check     # fail if it is stale
 *
 * Reference checkout override: UI_PARITY_REFERENCE
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXCLUSION_REASONS } from './lib/ui-parity-scope.mjs';
import { resolveReferenceRoot } from './lib/project-paths.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/*
 * External reference checkout: explicit override first, then a project-relative sibling.
 * No absolute path is embedded, so the manifest can be generated on any machine.
 */
const REFERENCE_ROOT = resolveReferenceRoot({ env: 'UI_PARITY_REFERENCE' });
const REF_SRC = path.join(REFERENCE_ROOT, 'frontend/src');
const OUTPUT = path.join(ROOT, '.design/frontend-ui-forward-port/PORT_MANIFEST.md');

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.next']);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      walk(full, out);
    } else if (stat.isFile() && /\.(tsx|ts|css)$/.test(entry)) {
      out.push(path.relative(REF_SRC, full).replace(/\\/g, '/'));
    }
  }
  return out;
}

/*
 * Dispositions, first match wins.
 *
 *   reuse-current  the current checkout already owns an equivalent file; nothing
 *                  is copied for this entry
 *   forward-port   the historical presentation must be copied and adapted into
 *                  the current checkout during the named task
 *   exclude        intentionally not ported (retired runtime, retired console, or
 *                  a surface with no current authoritative API contract)
 */
const RULES = [
  /* ---- retired runtime entry points ------------------------------------- */
  { re: /^proxy\.ts$/, d: 'exclude', group: 'excluded', reason: 'current-runtime-replaced', note: 'Historical Node API proxy. The Go service owns the production API surface.' },
  { re: /^app\/(?:\(dashboard\)\/)?layout\.tsx$/, d: 'exclude', group: 'excluded', reason: 'current-runtime-replaced', note: 'Historical layout entry point.' },
  { re: /^app\/.*page\.tsx$/, d: 'exclude', group: 'excluded', reason: 'current-runtime-replaced', note: 'Historical route entry. The current React Router table owns routing; any page-level composition it contained is adapted into the matching file under frontend/src/features/.' },

  /* ---- already-ported global style layers -------------------------------- */
  { re: /^app\/globals\.css$/, d: 'reuse-current', target: 'frontend/src/styles/globals.css', group: 'foundation' },
  { re: /^app\/\(dashboard\)\/layout\.css$/, d: 'reuse-current', target: 'frontend/src/styles/shell.css', group: 'foundation' },
  { re: /^app\/\(dashboard\)\/ocs\/ocs\.css$/, d: 'reuse-current', target: 'frontend/src/styles/ocs.css', group: 'foundation' },
  { re: /^app\/\(dashboard\)\/subscribers\/subscribers\.css$/, d: 'reuse-current', target: 'frontend/src/styles/subscribers.css', group: 'foundation' },
  { re: /^app\/\(dashboard\)\/profile\/profile\.css$/, d: 'reuse-current', target: 'frontend/src/styles/profile.css', group: 'foundation' },
  { re: /^app\/\(dashboard\)\/system-health\/system-health\.css$/, d: 'reuse-current', target: 'frontend/src/styles/system-health.css', group: 'foundation' },
  { re: /^app\/login\/LoginForm\.css$/, d: 'reuse-current', target: 'frontend/src/styles/login.css', group: 'foundation' },
  { re: /^components\/analytics\.css$/, d: 'reuse-current', target: 'frontend/src/styles/analytics.css', group: 'foundation' },
  { re: /^components\/modals\.css$/, d: 'reuse-current', target: 'frontend/src/styles/modals.css', group: 'foundation' },
  { re: /^components\/SubscriberModal\.css$/, d: 'reuse-current', target: 'frontend/src/styles/modals.css', group: 'foundation' },
  { re: /^components\/subscriber\/subscriber\.css$/, d: 'reuse-current', target: 'frontend/src/styles/subscribers.css', group: 'foundation' },
  { re: /^components\/subscriber\/rating-rule-link-panel\.css$/, d: 'reuse-current', target: 'frontend/src/styles/subscribers.css', group: 'foundation' },
  { re: /^components\/profile\/profile\.css$/, d: 'reuse-current', target: 'frontend/src/styles/profile.css', group: 'foundation' },
  { re: /^components\/CommandPalette\.css$/, d: 'reuse-current', target: 'frontend/src/styles/command-palette.css', group: 'foundation' },
  { re: /^components\/OperationFeedback\.css$/, d: 'reuse-current', target: 'frontend/src/styles/feedback.css', group: 'foundation' },
  { re: /^components\/NocSentinel\.css$/, d: 'reuse-current', target: 'frontend/src/styles/noc-sentinel.css', group: 'foundation' },

  /* ---- already-ported CSS modules ---------------------------------------- */
  { re: /^components\/ui\/[^/]+\.module\.css$/, d: 'reuse-current', target: 'frontend/src/styles/modules/<basename>', group: 'foundation' },
  { re: /^components\/iam\/iam\.module\.css$/, d: 'reuse-current', target: 'frontend/src/styles/modules/iam.module.css', group: 'foundation' },
  { re: /^app\/\(dashboard\)\/users\/[^/]+\.module\.css$/, d: 'reuse-current', target: 'frontend/src/styles/modules/<basename>', group: 'foundation' },
  { re: /^app\/\(dashboard\)\/users\/components\/[^/]+\.module\.css$/, d: 'reuse-current', target: 'frontend/src/styles/modules/<basename>', group: 'foundation' },

  /* ---- already-ported shared primitives ---------------------------------- */
  { re: /^components\/ui\//, d: 'reuse-current', target: 'frontend/src/components/ui/<basename>', group: 'foundation' },
  { re: /^components\/ocs\/OcsPageShell\.tsx$/, d: 'reuse-current', target: 'frontend/src/components/ocs/OcsPageShell.tsx', group: 'foundation' },
  { re: /^components\/health\/SubsystemCard\.tsx$/, d: 'reuse-current', target: 'frontend/src/components/health/SubsystemCard.tsx', group: 'foundation' },
  { re: /^components\/analytics\//, d: 'reuse-current', target: 'frontend/src/components/analytics/<basename>', group: 'foundation' },
  { re: /^components\/AnalyticsCockpit\.tsx$/, d: 'reuse-current', target: 'frontend/src/components/AnalyticsCockpit.tsx', group: 'foundation' },
  { re: /^components\/OperationFeedback\.tsx$/, d: 'reuse-current', target: 'frontend/src/components/ui/OperationFeedback.tsx', group: 'foundation' },
  { re: /^components\/NocSentinel\.tsx$/, d: 'reuse-current', target: 'frontend/src/app/components/NocSentinel.tsx', group: 'foundation' },
  { re: /^components\/(?:NavigationBreadcrumbs|NavigationTabBar|LanguageSwitcher|ThemeSwitcher)\.tsx$/, d: 'reuse-current', target: 'frontend/src/app/components/<basename>', group: 'foundation' },
  { re: /^app\/\(dashboard\)\/components\/(?:AppHeader|AppSidebar|NotificationCenter|UserMenu)\.tsx$/, d: 'reuse-current', target: 'frontend/src/app/components/<basename>', group: 'foundation' },

  /* ---- already-ported libraries and types -------------------------------- */
  { re: /^lib\/locales(?:\.ts|\/)/, d: 'reuse-current', target: 'frontend/src/lib/locales/<basename>', group: 'foundation' },
  { re: /^lib\/(?:fetcher|auth-ui|permissions|security|userManagementPolicy|unitParser)\.ts$/, d: 'reuse-current', target: 'frontend/src/lib/<basename>', group: 'foundation' },
  { re: /^types\/(?:governance|iam)\.ts$/, d: 'reuse-current', target: 'frontend/src/types/<basename>', group: 'foundation' },

  /* ---- command palette --------------------------------------------------- */
  { re: /^components\/CommandPalette\.tsx$/, d: 'forward-port', target: 'frontend/src/app/components/CommandPalette.tsx', group: 'shell', task: 'T18', note: 'Restore reference result grouping and geometry; keep the current router and /api/search.' },

  /* ---- login and system health ------------------------------------------- */
  { re: /^app\/login\/LoginForm\.tsx$/, d: 'forward-port', target: 'frontend/src/auth/LoginPage.tsx', group: 'login-health', task: 'T19', note: 'Reference geometry for icons, fields and card; current auth flow is retained.' },
  { re: /^app\/\(dashboard\)\/system-health\/page\.tsx$/, d: 'forward-port', target: 'frontend/src/features/system-health/SystemHealthPage.tsx', group: 'login-health', task: 'T19', note: 'Reference status pill and action ordering over live health data.' },

  /* ---- OCS domain -------------------------------------------------------- */
  { re: /^components\/ocs\/OcsDetailDrawer\.tsx$/, d: 'forward-port', target: 'frontend/src/components/ocs/OcsDetailDrawer.tsx', group: 'ocs', task: 'T06' },
  { re: /^components\/ocs\/common\//, d: 'forward-port', target: 'frontend/src/components/ocs/common/<basename>', group: 'ocs', task: 'T06' },
  { re: /^components\/ocs\/OcsTariffsPanel\.tsx$/, d: 'exclude', group: 'excluded', reason: 'current-runtime-replaced', note: 'Superseded: the /ocs/tariffs route renders OcsTariffGovernancePanel.' },
  { re: /^components\/ocs\/tariffs\//, d: 'forward-port', target: 'frontend/src/components/ocs/tariffs/<basename>', group: 'ocs', task: 'T07' },
  { re: /^components\/ocs\/contracts\//, d: 'forward-port', target: 'frontend/src/components/ocs/contracts/<basename>', group: 'ocs', task: 'T08' },
  { re: /^components\/ocs\/OcsSubscribersPanel\.tsx$/, d: 'exclude', group: 'excluded', reason: 'current-runtime-replaced', note: 'Superseded by the contract panel the /ocs/contracts route renders.' },
  { re: /^components\/ocs\/OcsBalancesPanel\.tsx$/, d: 'exclude', group: 'excluded', reason: 'current-runtime-replaced', note: 'Superseded: the /ocs/balances route renders OcsBalancePlaceholder.' },
  { re: /^components\/ocs\/balances\//, d: 'forward-port', target: 'frontend/src/components/ocs/balances/<basename>', group: 'ocs', task: 'T09' },

  /* ---- Users domain ------------------------------------------------------ */
  { re: /^app\/\(dashboard\)\/users\/components\/[^/]+\.(?:tsx|ts)$/, d: 'forward-port', target: 'frontend/src/features/users/components/<basename>', group: 'users', task: 'T11' },
  { re: /^app\/\(dashboard\)\/users\/(?:types\.ts|utils\.ts)$/, d: 'forward-port', target: 'frontend/src/features/users/<basename>', group: 'users', task: 'T11' },
  { re: /^app\/\(dashboard\)\/users\/hooks\//, d: 'forward-port', target: 'frontend/src/features/users/hooks/<basename>', group: 'users', task: 'T11', note: 'Port only the presentational state hooks; the current read and mutation clients stay authoritative.' },
  { re: /^components\/iam\/(?:PasswordField|RoleBadge|StatusBadge)\.tsx$/, d: 'forward-port', target: 'frontend/src/components/iam/<basename>', group: 'users', task: 'T11' },

  /* ---- Subscribers domain ------------------------------------------------ */
  { re: /^app\/\(dashboard\)\/subscribers\/components\//, d: 'forward-port', target: 'frontend/src/features/subscribers/components/<basename>', group: 'subscribers', task: 'T15' },
  { re: /^app\/\(dashboard\)\/subscribers\/types\.ts$/, d: 'forward-port', target: 'frontend/src/features/subscribers/types.ts', group: 'subscribers', task: 'T15' },
  { re: /^components\/subscriber\//, d: 'forward-port', target: 'frontend/src/features/subscribers/components/subscriber/<basename>', group: 'subscribers', task: 'T16' },
  { re: /^components\/(?:SubscriberModal|BatchCreateModal|TrafficAdjustmentModal)\.tsx$/, d: 'forward-port', target: 'frontend/src/components/<basename>', group: 'subscribers', task: 'T15' },
  { re: /^components\/BulkPolicyModal\.tsx$/, d: 'exclude', group: 'excluded', reason: 'unsupported-contract', note: 'Its mutation is on the project absolute denylist, so the surface must not be ported.' },
  { re: /^hooks\/useSubscriberForm\.ts$/, d: 'forward-port', target: 'frontend/src/features/subscribers/useSubscriberForm.ts', group: 'subscribers', task: 'T16' },
  { re: /^lib\/(?:csv)\.ts$/, d: 'forward-port', target: 'frontend/src/lib/<basename>', group: 'subscribers', task: 'T15' },
  { re: /^lib\/(?:subscriberDefaults|tariffPlanOperations|typeGuards|xcloudSubscriber)\.ts$/, d: 'forward-port', target: 'frontend/src/features/subscribers/lib/<basename>', group: 'subscribers', task: 'T15', note: 'Port only the helpers the ported presentational components call.' },
  { re: /^lib\/subscriberValidation\.ts$/, d: 'exclude', group: 'excluded', reason: 'current-runtime-replaced', note: 'Subscriber validation is owned by the current Inventory validation and the Go API.' },

  /* ---- Profiles domain --------------------------------------------------- */
  { re: /^components\/profile\//, d: 'forward-port', target: 'frontend/src/features/profiles/components/<basename>', group: 'profiles', task: 'T17' },
  { re: /^components\/ProfileModal\.tsx$/, d: 'forward-port', target: 'frontend/src/components/ProfileModal.tsx', group: 'profiles', task: 'T17' },
  { re: /^lib\/userAccessManagement\.ts$/, d: 'forward-port', target: 'frontend/src/lib/userAccessManagement.ts', group: 'users', task: 'T11' },
  { re: /^lib\/userQuery\.ts$/, d: 'exclude', group: 'excluded', reason: 'current-runtime-replaced', note: 'The current users surface keeps query state in the URL through the router.' },

  /* ---- domain types ------------------------------------------------------ */
  { re: /^types\/(?:platformHealth|subscriber|xcloud)\.ts$/, d: 'forward-port', target: 'frontend/src/types/<basename>', group: 'foundation', task: 'T05', note: 'Port only the shapes the ported components actually consume.' },
  { re: /^types\/ocs\.ts$/, d: 'exclude', group: 'excluded', reason: 'current-runtime-replaced', note: 'The ported OCS features declare the shapes they consume.' },
  { re: /^types\/plmn\.ts$/, d: 'exclude', group: 'excluded', reason: 'current-runtime-replaced', note: 'The PLMN record shape is declared by the ported subscribers feature.' },

  /* ---- excluded: retired runtime, providers, retired consoles ------------ */
  { re: /^components\/(?:I18nProvider|ThemeProvider|SWRProvider|NotificationProvider|GlobalErrorBoundary|ToastContainer)\.tsx$/, d: 'exclude', group: 'excluded', reason: 'current-runtime-replaced', note: 'The current providers own runtime state, data fetching, theming and errors.' },
  { re: /^hooks\/(?:useAuth|usePermissions)\.ts$/, d: 'exclude', group: 'excluded', reason: 'current-runtime-replaced', note: 'The current authentication and session providers own identity and capability state.' },
  { re: /^lib\/api\//, d: 'exclude', group: 'excluded', reason: 'current-runtime-replaced', note: 'The current read client and mutation client own the Go contract.' },
  { re: /^lib\/governance\//, d: 'exclude', group: 'excluded', reason: 'retired', note: 'Retired governance/approval surface.' },
  { re: /^components\/governance\//, d: 'exclude', group: 'excluded', reason: 'retired', note: 'Retired governance/approval surface.' },
  { re: /^types\/audit\.ts$/, d: 'exclude', group: 'excluded', reason: 'retired', note: 'Retired user-facing audit console type.' },
  { re: /^components\/(?:DataHub)\.tsx$|^components\/datahub\.css$/, d: 'exclude', group: 'excluded', reason: 'retired', note: 'Retired data hub surface.' },
  { re: /^components\/(?:VisualDiffViewer)\.tsx$|^components\/diff-viewer\.css$|^lib\/diffEngine\.ts$/, d: 'exclude', group: 'excluded', reason: 'retired', note: 'Retired visual diff surface.' },
  { re: /^components\/(?:SubscriberTraceModal)\.tsx$|^components\/subscriber-trace-modal\.css$/, d: 'exclude', group: 'excluded', reason: 'retired', note: 'Signalling trace capture has no current authoritative API contract.' },
  { re: /^components\/SubscriberBatchUpdateModal\.tsx$/, d: 'forward-port', target: 'frontend/src/components/SubscriberBatchUpdateModal.tsx', group: 'subscribers', task: 'T15', note: 'Owns POST /api/subscribers/batch-update, which the Go router registers.' },
  { re: /^components\/RatingManagementPage\.tsx$|^components\/rating\//, d: 'exclude', group: 'excluded', reason: 'charging-plane', note: 'Charging-plane rating console is outside the current OCS boundary.' },
  { re: /^components\/ocs\/(?:OcsSessionsPanel|OcsUsagePanel)\.tsx$/, d: 'exclude', group: 'excluded', reason: 'current-runtime-replaced', note: 'No current route or API contract for sessions/usage panels.' },
  { re: /^lib\/soundEffects\.ts$/, d: 'exclude', group: 'excluded', reason: 'retired', note: 'Non-essential audio surface.' },
  { re: /^lib\/navigation(?:Routes|Prefetch)\.ts$/, d: 'exclude', group: 'excluded', reason: 'current-runtime-replaced', note: 'Historical navigation table; frontend/src/lib/navigation.ts is authoritative.' },
];

const GROUPS = [
  ['foundation', 'Foundation: shared UI, style layers and shared types'],
  ['shell', 'Shell: command palette'],
  ['login-health', 'Login and system health'],
  ['ocs', 'OCS domain (tariffs, contracts, balances)'],
  ['users', 'User management domain'],
  ['subscribers', 'Subscriber domain'],
  ['profiles', 'Profile domain'],
  ['excluded', 'Excluded: retired runtime, providers and retired consoles'],
];

function classify(relativePath) {
  for (const rule of RULES) {
    if (rule.re.test(relativePath)) {
      return {
        disposition: rule.d,
        group: rule.group,
        task: rule.task ?? '',
        target: (rule.target ?? '').replace('<basename>', path.basename(relativePath)),
        reason: rule.reason ?? '',
        note: rule.note ?? '',
      };
    }
  }
  return null;
}

function build() {
  if (!fs.existsSync(REF_SRC)) {
    console.log('ui_port_manifest_result=SKIP');
    console.log(`reason=reference source not found at ${REF_SRC}`);
    process.exit(0);
  }

  const files = walk(REF_SRC).sort();
  const classified = new Map();
  const unclassified = [];
  for (const file of files) {
    const entry = classify(file);
    if (!entry) { unclassified.push(file); continue; }
    classified.set(file, entry);
  }

  if (unclassified.length) {
    console.error(`ui_port_manifest_result=FAIL`);
    console.error(`reason=reference files without a disposition: ${unclassified.length}`);
    for (const file of unclassified) console.error(`  ${file}`);
    process.exit(1);
  }

  const counts = { 'reuse-current': 0, 'forward-port': 0, exclude: 0 };
  for (const entry of classified.values()) counts[entry.disposition]++;

  /*
   * Post-classification checks. A disposition is a promise about the filesystem, so
   * the generator verifies it instead of trusting the rules:
   *
   *   1. every `forward-port` target must exist (a rule that points at a file nobody
   *      created is a silent gap, not a plan);
   *   2. every `exclude` rule must carry a reason from the scope vocabulary, so the
   *      manifest and `scripts/lib/ui-parity-scope.mjs` speak the same language.
   */
  const scopeReasons = new Set(Object.values(EXCLUSION_REASONS));
  const missingTargets = [];
  const unlabelledExclusions = [];

  for (const [file, entry] of classified) {
    if (entry.disposition === 'forward-port') {
      const target = entry.target.replace('<basename>', path.basename(file));
      if (!fs.existsSync(path.join(ROOT, target))) {
        missingTargets.push(`${path.relative(REF_SRC, file).replace(/\\/g, '/')} -> ${target}`);
      }
    }
    if (entry.disposition === 'exclude' && !scopeReasons.has(entry.reason)) {
      unlabelledExclusions.push(`${path.relative(REF_SRC, file).replace(/\\/g, '/')} reason=${entry.reason ?? '(none)'}`);
    }
  }

  if (unlabelledExclusions.length) {
    console.error('ui_port_manifest_result=FAIL');
    console.error(`reason=exclusions without a scope reason: ${unlabelledExclusions.length}`);
    for (const item of unlabelledExclusions.slice(0, 20)) console.error(`  ${item}`);
    process.exit(1);
  }

  if (missingTargets.length) {
    console.error('ui_port_manifest_result=FAIL');
    console.error(`reason=forward-port targets that do not exist: ${missingTargets.length}`);
    for (const item of missingTargets.slice(0, 30)) console.error(`  ${item}`);
    process.exit(1);
  }

  const lines = [];
  lines.push('# UI Forward-Port Manifest');
  lines.push('');
  lines.push('Generated from the reference checkout by `npm run ui:port-manifest`. Do not edit by hand:');
  lines.push('edit the disposition rules in `scripts/generate-ui-port-manifest.mjs` and regenerate.');
  lines.push('');
  lines.push(`- Reference: \`${REF_SRC.replace(/\\/g, '/')}\` (commit 2c40903, last pure-Next.js state)`);
  lines.push(`- Target: \`frontend/src\``);
  lines.push(`- Reference source files covered: **${files.length}**`);
  lines.push('');
  lines.push('## Dispositions');
  lines.push('');
  lines.push('| Disposition | Meaning |');
  lines.push('| --- | --- |');
  lines.push(`| \`reuse-current\` | ${counts['reuse-current']} files. The current checkout already owns an equivalent; nothing is copied. |`);
  lines.push(`| \`forward-port\` | ${counts['forward-port']} files. Historical presentation is copied and adapted during the named task. |`);
  lines.push(`| \`exclude\` | ${counts.exclude} files. Intentionally not ported. Every exclusion carries one of the four reasons below. |`);
  lines.push('');
  lines.push('### Exclusion reasons');
  lines.push('');
  lines.push('The reason vocabulary is defined once, in `scripts/lib/ui-parity-scope.mjs`, and is shared with the parity gate:');
  lines.push('');
  lines.push('| Reason | Meaning |');
  lines.push('| --- | --- |');
  lines.push('| `retired` | The historical surface was deliberately retired by the brief. |');
  lines.push('| `charging-plane` | Charging-plane rating console; outside the operator console boundary. |');
  lines.push('| `current-runtime-replaced` | The current checkout already owns this runtime concern, or the surface is superseded by the one its route renders. |');
  lines.push('| `unsupported-contract` | The referenced operation has no authoritative contract here and is on the absolute denylist. |');
  lines.push('');
  lines.push('## Hard boundaries');
  lines.push('');
  lines.push('The port preserves the current authority of `frontend/package.json`, `frontend/vite.config.ts`,');
  lines.push('`frontend/index.html`, `frontend/src/main.tsx`, `frontend/src/app/App.tsx`, the React Router route');
  lines.push('table, the authentication and session providers, the read and mutation clients, the Go API contracts,');
  lines.push('the three-role RBAC model, and the Inventory feature. `npm run check:ui-forward-port-boundaries`');
  lines.push('enforces this mechanically.');
  lines.push('');

  for (const [key, title] of GROUPS) {
    const rows = [...classified.entries()].filter(([, entry]) => entry.group === key);
    lines.push(`## ${title}`);
    lines.push('');
    lines.push(`Files: ${rows.length}`);
    lines.push('');
    lines.push('| Reference path | Disposition | Reason | Target | Task | Note |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const [file, entry] of rows) {
      /* The reason is mandatory for exclusions and is validated above, so it is always
       * one of the four categories the parity scope defines. */
      lines.push(`| \`${file}\` | \`${entry.disposition}\` | ${entry.reason ? `\`${entry.reason}\`` : '-'} | ${entry.target ? `\`${entry.target}\`` : '-'} | ${entry.task || '-'} | ${entry.note || '-'} |`);
    }
    lines.push('');
  }

  lines.push('## Verification');
  lines.push('');
  lines.push('```bash');
  lines.push('npm run ui:port-manifest          # regenerate; fails if any reference file is unclassified');
  lines.push('npm run check:ui-forward-port-boundaries');
  lines.push('```');
  lines.push('');

  return { text: `${lines.join('\n')}`, counts, total: files.length };
}

const result = build();
const stale = !fs.existsSync(OUTPUT) || fs.readFileSync(OUTPUT, 'utf8') !== result.text;

if (process.argv.slice(2).includes('--check')) {
  console.log(`ui_port_manifest_files=${result.total}`);
  console.log(`ui_port_manifest_stale=${stale ? 1 : 0}`);
  console.log(`ui_port_manifest_result=${stale ? 'FAIL' : 'PASS'}`);
  process.exit(stale ? 1 : 0);
}

fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, result.text);
console.log(`ui_port_manifest_files=${result.total}`);
console.log(`reuse_current=${result.counts['reuse-current']} forward_port=${result.counts['forward-port']} exclude=${result.counts.exclude}`);
console.log(`ui_port_manifest=${path.relative(ROOT, OUTPUT).replace(/\\/g, '/')}`);
console.log('ui_port_manifest_result=PASS');
