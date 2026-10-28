import assert from 'node:assert/strict';
import test from 'node:test';
import { copyText } from '../src/lib/clipboard';

interface FakeTextarea {
  tagName: string;
  value: string;
  style: Record<string, string>;
  attributes: Record<string, string>;
  selected: boolean;
  setAttribute(name: string, value: string): void;
  select(): void;
}

type ClipboardMode = 'missing' | 'resolves' | 'rejects';
type ExecCommandMode = 'succeeds' | 'fails' | 'throws';

function installEnvironment(clipboardMode: ClipboardMode, execCommandMode: ExecCommandMode = 'succeeds') {
  const writeTextCalls: string[] = [];
  const execCalls: string[] = [];
  const attached: FakeTextarea[] = [];
  const textareas: FakeTextarea[] = [];

  const clipboard = clipboardMode === 'missing'
    ? undefined
    : {
        writeText: async (text: string) => {
          writeTextCalls.push(text);
          if (clipboardMode === 'rejects') throw new Error('clipboard unavailable');
        },
      };

  Object.defineProperty(globalThis, 'navigator', { value: { clipboard }, configurable: true });
  Object.defineProperty(globalThis, 'document', {
    value: {
      body: {
        appendChild(node: FakeTextarea) {
          attached.push(node);
          return node;
        },
        removeChild(node: FakeTextarea) {
          const index = attached.indexOf(node);
          if (index >= 0) attached.splice(index, 1);
          return node;
        },
      },
      createElement(tag: string): FakeTextarea {
        const textarea: FakeTextarea = {
          tagName: tag.toUpperCase(),
          value: '',
          style: {},
          attributes: {},
          selected: false,
          setAttribute(name: string, value: string) {
            textarea.attributes[name] = value;
          },
          select() {
            textarea.selected = true;
          },
        };
        textareas.push(textarea);
        return textarea;
      },
      execCommand(command: string) {
        execCalls.push(command);
        if (execCommandMode === 'throws') throw new Error('execCommand unsupported');
        return execCommandMode === 'succeeds';
      },
    },
    configurable: true,
  });

  return { writeTextCalls, execCalls, attached, textareas };
}

function restoreEnvironment() {
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { navigator?: unknown }).navigator;
}

test('a secure origin copies through the Clipboard API without touching execCommand', async (t) => {
  const env = installEnvironment('resolves');
  t.after(restoreEnvironment);

  assert.equal(await copyText('460001234567890'), true);
  assert.deepEqual(env.writeTextCalls, ['460001234567890']);
  assert.deepEqual(env.execCalls, []);
  assert.deepEqual(env.textareas, []);
});

test('a plain-HTTP origin without the Clipboard API still copies through a selection', async (t) => {
  const env = installEnvironment('missing');
  t.after(restoreEnvironment);

  assert.equal(await copyText('460001234567890'), true);
  assert.deepEqual(env.execCalls, ['copy']);
  assert.equal(env.textareas.length, 1);
  assert.equal(env.textareas[0].value, '460001234567890');
  assert.equal(env.textareas[0].attributes.readonly, '');
  assert.equal(env.textareas[0].selected, true);
  assert.deepEqual(env.attached, []);
});

test('a rejected Clipboard API write falls back instead of reporting success early', async (t) => {
  const env = installEnvironment('rejects');
  t.after(restoreEnvironment);

  assert.equal(await copyText('Volte'), true);
  assert.deepEqual(env.writeTextCalls, ['Volte']);
  assert.deepEqual(env.execCalls, ['copy']);
  assert.deepEqual(env.attached, []);
});

test('copying reports failure when both clipboard paths fail', async (t) => {
  const rejected = installEnvironment('rejects', 'fails');
  t.after(restoreEnvironment);

  assert.equal(await copyText('blocked'), false);
  assert.deepEqual(rejected.attached, []);
});

test('copying reports failure when execCommand throws', async (t) => {
  const env = installEnvironment('missing', 'throws');
  t.after(restoreEnvironment);

  assert.equal(await copyText('blocked'), false);
  assert.deepEqual(env.execCalls, ['copy']);
  assert.deepEqual(env.attached, []);
});
