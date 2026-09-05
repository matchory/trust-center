import { getConfig } from '../config';
import { createS3Adapter } from './s3';
import { createSyslogAdapter } from './syslog';
import { SINK_NAMES } from '../db/schema';
import type { AuditSinkAdapter } from './port';
import type { SinkName } from '../db/schema';

/**
 * The one place that maps a sink name to an adapter.
 *
 * The job needs the list and the admin panel needs it per name, and before this
 * existed each held its own `if s3 … if syslog` ladder — so a third sink meant
 * finding both. `SINK_NAMES` is already the list the CHECK constraint and the
 * panel iterate; this makes the adapters agree with it by construction.
 */
export function adapterFor(sink: SinkName): AuditSinkAdapter | null {
	const { auditSink } = getConfig();

	if (sink === 's3') return auditSink.s3 ? createS3Adapter(auditSink.s3) : null;

	return auditSink.syslog ? createSyslogAdapter(auditSink.syslog) : null;
}

/** Every configured sink, in `SINK_NAMES` order so a batch reaches them in the
 * same order on every tick and in every deployment. */
export function activeAdapters(): AuditSinkAdapter[] {
	return SINK_NAMES.map(adapterFor).filter((adapter) => adapter !== null);
}
