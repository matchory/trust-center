import { describe, expect, it } from 'vitest';
import { projectName } from '../../src/lib/meta';

describe('project metadata', () => {
	it('exposes the project name', () => {
		expect(projectName).toBe('trust-center');
	});
});
