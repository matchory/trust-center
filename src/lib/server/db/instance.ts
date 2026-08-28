import { config } from '../config';
import { createDb } from './index';

export const { db } = createDb(config.databaseUrl);
