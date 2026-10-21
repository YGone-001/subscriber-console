import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEntriesPath } from '../src/features/knowledge/knowledge-api';
import { fileKindLabel, formatFileSize, isImage, isKnowledgeImageUrl } from '../src/features/knowledge/knowledge-format';

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

test('inline Markdown images are restricted to knowledge attachments', () => {
  assert.equal(isKnowledgeImageUrl('/api/knowledge/files/00000000-0000-4000-8000-000000000000'), true);
  assert.equal(isKnowledgeImageUrl('/api/knowledge/files/not-a-uuid'), false);
  assert.equal(isKnowledgeImageUrl('https://example.com/x.png'), false);
  assert.equal(isKnowledgeImageUrl('/api/other/files/x'), false);
});
