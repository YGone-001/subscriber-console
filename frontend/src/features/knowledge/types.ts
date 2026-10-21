export type FileKind = 'image' | 'pdf' | 'text' | 'pcap';

export type Attachment = {
  fileId: string;
  originalName: string;
  contentType: string;
  kind: FileKind;
  size: number;
  sha256: string;
};

export type KnowledgeEntry = {
  id: string;
  schemaVersion: number;
  title: string;
  protocol: string;
  phenomenon: string;
  rootCause: string;
  solution: string;
  tags: string[];
  attachments: Attachment[];
  revision: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
};

export type KnowledgeSummary = {
  id: string;
  title: string;
  protocol: string;
  phenomenon: string;
  tags: string[];
  attachments: Attachment[];
  revision: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
};

export type TagCount = { tag: string; count: number };
export type ProtocolCount = { protocol: string; count: number };

export type KnowledgeMeta = {
  schemaVersion: number;
  protocols: string[];
  topTags: TagCount[];
  protocolCounts: ProtocolCount[];
  total: number;
  maxFileBytes: number;
  maxAttachments: number;
  maxInlineImages: number;
};

export type KnowledgePageInfo = {
  limit: number;
  nextCursor: string | null;
  hasMore: boolean;
};

export type KnowledgeListResponse = {
  entries: KnowledgeSummary[];
  total: number;
  page: KnowledgePageInfo;
};

export type KnowledgeUploadResponse = {
  fileId: string;
  originalName: string;
  contentType: string;
  kind: FileKind;
  size: number;
  sha256: string;
};

export type KnowledgeEntryInput = {
  title: string;
  protocol?: string;
  phenomenon?: string;
  rootCause?: string;
  solution?: string;
  tags?: string[];
  attachmentFileIds?: string[];
};

export type KnowledgeEntryUpdate = KnowledgeEntryInput & { expectedRevision: number };
