export const DOCUMENT_TIERS = ['public', 'request', 'nda'] as const;
export const DOCUMENT_STATUSES = ['draft', 'published', 'archived'] as const;
export type DocumentTier = (typeof DOCUMENT_TIERS)[number];
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];
