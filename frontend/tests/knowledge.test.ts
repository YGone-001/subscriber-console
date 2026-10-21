import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEntriesPath, isKnowledgeEntryKey, isKnowledgeListKey } from '../src/features/knowledge/knowledge-api';
import { applyTool } from '../src/features/knowledge/components/MarkdownEditor';
import { knowledgeErrorMessage } from '../src/features/knowledge/knowledge-errors';
import { fileKindLabel, formatFileSize, isImage, isKnowledgeImageUrl } from '../src/features/knowledge/knowledge-format';
import { MutationApiError } from '../src/lib/api/mutation-client';

test('the knowledge entries path carries only requested query values', () => {
  assert.equal(buildEntriesPath(), '/api/knowledge/entries');
  assert.equal(buildEntriesPath({ q: 'attach' }), '/api/knowledge/entries?q=attach');
  assert.equal(
    buildEntriesPath({ q: 'sip', protocol: 'SIP', tag: 'VoLTE', limit: 20 }),
    '/api/knowledge/entries?q=sip&protocol=SIP&tag=VoLTE&limit=20',
  );
  assert.equal(buildEntriesPath({ cursor: 'abc' }), '/api/knowledge/entries?cursor=abc');
});

test('file size formatting keeps zero distinct from missing', () => {
  assert.equal(formatFileSize(0), '0 B');
  assert.equal(formatFileSize(512), '512 B');
  assert.equal(formatFileSize(2048), '2.0 KB');
  assert.equal(formatFileSize(3 * 1024 * 1024), '3.0 MB');
  assert.equal(formatFileSize(-1), '—');
});

test('file kinds map to stable labels and image detection', () => {
  assert.equal(fileKindLabel('image'), 'IMG');
  assert.equal(fileKindLabel('pdf'), 'PDF');
  assert.equal(fileKindLabel('pcap'), 'PCAP');
  assert.equal(fileKindLabel('text'), 'TXT');
  assert.equal(isImage('image'), true);
  assert.equal(isImage('pdf'), false);
});

test('the Markdown link tool inserts a complete link and selects the URL', () => {
  const linked = applyTool('hello', 0, 5, { key: 'link' }, 'Link text');
  assert.equal(linked.text, '[hello](https://)');
  assert.equal(linked.text.slice(linked.selectionStart, linked.selectionEnd), 'https://');

  const empty = applyTool('', 0, 0, { key: 'link' }, 'Link text');
  assert.equal(empty.text, '[Link text](https://)');
  assert.equal(empty.text.slice(empty.selectionStart, empty.selectionEnd), 'Link text');
});

test('the Markdown wrap tool keeps the cursor between empty markers', () => {
  const bold = applyTool('abc', 1, 2, { key: 'bold', wrap: '**' });
  assert.equal(bold.text, 'a**b**c');
  assert.equal(bold.selectionStart, 6);

  const empty = applyTool('abc', 1, 1, { key: 'bold', wrap: '**' });
  assert.equal(empty.text, 'a****bc');
  assert.equal(empty.selectionStart, 3);
  assert.equal(empty.selectionEnd, 3);
});

test('the Markdown prefix tool inserts at the current line start', () => {
  const heading = applyTool('abc', 1, 1, { key: 'h1', prefix: '# ' });
  assert.equal(heading.text, '# abc');
  assert.equal(heading.selectionStart, 3);
});

test('only list keys are invalidated after a knowledge mutation', () => {
  assert.equal(isKnowledgeListKey('/api/knowledge/entries'), true);
  assert.equal(isKnowledgeListKey('/api/knowledge/entries?limit=20'), true);
  assert.equal(isKnowledgeListKey('/api/knowledge/entries/00000000-0000-4000-8000-000000000000'), false);
  assert.equal(isKnowledgeListKey('/api/knowledge/files/00000000-0000-4000-8000-000000000000'), false);
  assert.equal(isKnowledgeListKey(null), false);

  assert.equal(isKnowledgeEntryKey('/api/knowledge/entries?limit=20'), true);
  assert.equal(isKnowledgeEntryKey('/api/knowledge/entries/00000000-0000-4000-8000-000000000000'), true);
  assert.equal(isKnowledgeEntryKey('/api/knowledge/files/00000000-0000-4000-8000-000000000000'), false);
});

test('knowledge mutation errors map to localized message keys', () => {
  const t = (key: string) => key;
  assert.equal(
    knowledgeErrorMessage(new MutationApiError(400, 'rejected', undefined, 'KNOWLEDGE_FILE_TYPE_REJECTED'), t),
    'kb_error_file_type',
  );
  assert.equal(
    knowledgeErrorMessage(new MutationApiError(413, 'too large', undefined, 'KNOWLEDGE_FILE_TOO_LARGE'), t),
    'kb_error_file_too_large',
  );
  assert.equal(knowledgeErrorMessage(new MutationApiError(409, 'conflict'), t), 'kb_revision_conflict');
  assert.equal(knowledgeErrorMessage(new MutationApiError(403, 'forbidden'), t), 'kb_error_forbidden');
  assert.equal(knowledgeErrorMessage(new MutationApiError(404, 'missing'), t), 'kb_error_not_found');
  assert.equal(knowledgeErrorMessage(new MutationApiError(500, 'boom'), t), 'kb_error_internal');
  assert.equal(knowledgeErrorMessage(new Error('network'), t), 'kb_save_failed');
  assert.equal(knowledgeErrorMessage(new Error('network'), t, 'kb_upload_failed'), 'kb_upload_failed');
});

test('inline Markdown images are restricted to knowledge attachments', () => {
  assert.equal(isKnowledgeImageUrl('/api/knowledge/files/00000000-0000-4000-8000-000000000000'), true);
  assert.equal(isKnowledgeImageUrl('/api/knowledge/files/not-a-uuid'), false);
  assert.equal(isKnowledgeImageUrl('https://example.com/x.png'), false);
  assert.equal(isKnowledgeImageUrl('/api/other/files/x'), false);
});
