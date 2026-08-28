import { parseConfig } from './parse';

export const config = parseConfig(process.env);
export type { AppConfig } from './parse';
