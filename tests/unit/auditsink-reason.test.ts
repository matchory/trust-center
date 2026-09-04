import { describe, expect, it } from 'vitest';
import { SinkError, classifyError } from '../../src/lib/server/auditsink/ship';

describe('classifyError', () => {
	it('passes a SinkError through unchanged', () => {
		expect(classifyError(new SinkError('auth'))).toEqual({ reason: 'auth', statusCode: undefined });
	});

	it('resolves a 403 to exactly one reason', () => {
		// Spec §5.4: S3 answers 403 for both a bad signature and a denied action.
		// A menu of overlapping labels is not a lookup key, so the rule is
		// first-match and the two cases are distinguished by the error code.
		expect(classifyError(new SinkError('auth', 403)).reason).toBe('auth');
		expect(classifyError(new SinkError('permission', 403)).reason).toBe('permission');
	});

	it('classifies a TLS failure from the cause chain, not the message', () => {
		const cause = Object.assign(new Error('fetch failed'), {
			cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }
		});
		expect(classifyError(cause).reason).toBe('tls');
	});

	it('classifies an abort as a timeout', () => {
		expect(classifyError(new DOMException('aborted', 'AbortError')).reason).toBe('timeout');
	});

	it('falls back to network for an unrecognised failure', () => {
		expect(classifyError(new Error('socket hang up')).reason).toBe('network');
	});
});
