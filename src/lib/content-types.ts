export const DOCUMENT_TIERS = ['public', 'request', 'nda'] as const;
export const DOCUMENT_STATUSES = ['draft', 'published', 'archived'] as const;
export type DocumentTier = (typeof DOCUMENT_TIERS)[number];
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];
export const CONTROL_STATUSES = [
	'implemented',
	'in_progress',
	'planned',
	'not_applicable'
] as const;
export type ControlStatus = (typeof CONTROL_STATUSES)[number];
