import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { en } from '../src/lib/locales/en.ts';
import { zh } from '../src/lib/locales/zh.ts';

const rootDir = process.cwd();

test('SSE real-time notification stream endpoint exists and enforces auth', () => {
  const streamRoutePath = path.join(rootDir, 'src', 'app', 'api', 'notifications', 'stream', 'route.ts');
  assert.ok(fs.existsSync(streamRoutePath), 'notifications/stream route must exist');

  const content = fs.readFileSync(streamRoutePath, 'utf8');
  assert.ok(content.includes('requireAuth'), 'SSE route must verify user authentication');
  assert.ok(content.includes('text/event-stream'), 'SSE route must return text/event-stream');
  assert.ok(content.includes('ReadableStream'), 'SSE route must use standard ReadableStream');
  assert.ok(content.includes('sendEvent'), 'SSE route must support named events');
  assert.ok(content.includes('request.signal.addEventListener'), 'SSE route must handle client abort without leaking');
});

test('Web Audio sound synthesizer provides pure audio synthesis', () => {
  const soundPath = path.join(rootDir, 'src', 'lib', 'soundEffects.ts');
  assert.ok(fs.existsSync(soundPath), 'soundEffects.ts must exist');

  const content = fs.readFileSync(soundPath, 'utf8');
  assert.ok(content.includes('playNotificationSound'), 'soundEffects must export playNotificationSound');
  assert.ok(content.includes('AudioContext'), 'soundEffects must use Web Audio AudioContext');
  assert.ok(content.includes('critical') && content.includes('warning') && content.includes('success') && content.includes('info'), 'soundEffects must handle all 4 sound profiles');
});

test('NotificationProvider and Toast components exist and wire into RootLayout', () => {
  const providerPath = path.join(rootDir, 'src', 'components', 'NotificationProvider.tsx');
  const toastContainerPath = path.join(rootDir, 'src', 'components', 'ToastContainer.tsx');
  const notifCenterPath = path.join(rootDir, 'src', 'app', '(dashboard)', 'components', 'NotificationCenter.tsx');
  const rootLayoutPath = path.join(rootDir, 'src', 'app', 'layout.tsx');
  const appHeaderPath = path.join(rootDir, 'src', 'app', '(dashboard)', 'components', 'AppHeader.tsx');

  assert.ok(fs.existsSync(providerPath), 'NotificationProvider must exist');
  assert.ok(fs.existsSync(toastContainerPath), 'ToastContainer must exist');
  assert.ok(fs.existsSync(notifCenterPath), 'NotificationCenter must exist');

  const rootLayoutContent = fs.readFileSync(rootLayoutPath, 'utf8');
  assert.ok(rootLayoutContent.includes('NotificationProvider'), 'RootLayout must mount NotificationProvider');
  assert.ok(rootLayoutContent.includes('ToastContainer'), 'RootLayout must mount ToastContainer');

  const headerContent = fs.readFileSync(appHeaderPath, 'utf8');
  assert.ok(headerContent.includes('NotificationCenter'), 'AppHeader must mount NotificationCenter');
});

test('Notification CSS styles are defined in globals.css and layout.css', () => {
  const globalsCss = fs.readFileSync(path.join(rootDir, 'src', 'app', 'globals.css'), 'utf8');
  const layoutCss = fs.readFileSync(path.join(rootDir, 'src', 'app', '(dashboard)', 'layout.css'), 'utf8');

  assert.ok(globalsCss.includes('.toast-stack-container'), 'globals.css must define .toast-stack-container');
  assert.ok(globalsCss.includes('.toast-card'), 'globals.css must define .toast-card');
  assert.ok(globalsCss.includes('.toast-progress-bar'), 'globals.css must define .toast-progress-bar');

  assert.ok(layoutCss.includes('.notif-center-menu'), 'layout.css must define .notif-center-menu');
  assert.ok(layoutCss.includes('.notif-dropdown-panel'), 'layout.css must define .notif-dropdown-panel');
  assert.ok(layoutCss.includes('.notif-badge'), 'layout.css must define .notif-badge');
});

test('Notification center translation keys are strictly aligned across en and zh', () => {
  const requiredKeys = [
    'notif_center_title',
    'notif_live_stream',
    'notif_stream_live',
    'notif_stream_reconnecting',
    'notif_settings',
    'notif_mark_all_read',
    'notif_sound_alerts',
    'notif_volume',
    'notif_enable_desktop',
    'notif_tab_all',
    'notif_tab_alerts',
    'notif_tab_approvals',
    'notif_tab_system',
    'notif_empty',
    'notif_view_details',
    'notif_clear_all',
  ];

  for (const key of requiredKeys) {
    assert.ok(key in en, `en.ts must contain ${key}`);
    assert.ok(key in zh, `zh.ts must contain ${key}`);
    assert.ok(typeof en[key] === 'string' && en[key].length > 0, `en[${key}] must not be empty`);
    assert.ok(typeof zh[key] === 'string' && zh[key].length > 0, `zh[${key}] must not be empty`);
  }
});
