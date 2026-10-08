import { describe, expect, test } from 'manten';
import { decodeHelperResponse } from '../../src/helper-response.ts';

const validPosition = {
	ok: true,
	latitude: 35.6586,
	longitude: 139.7454,
	accuracy: 35,
	timestamp: 1_750_000_000_000,
};

const validOutput = JSON.stringify(validPosition);

/** Capture the error thrown by decoding, or throw if decoding unexpectedly succeeds. */
const decodeError = (stdout: string, stderr = '', exitCode: number | null = 0) => {
	try {
		decodeHelperResponse(stdout, stderr, exitCode, null);
	} catch (error) {
		return error;
	}
	throw new Error('Expected decoding to throw');
};

describe('decodeHelperResponse', () => {
	test('decodes a valid position', () => {
		expect(decodeHelperResponse(validOutput, '', 0, null)).toStrictEqual({
			latitude: 35.6586,
			longitude: 139.7454,
			accuracy: 35,
			timestamp: 1_750_000_000_000,
		});
	});

	test('preserves the helper error code', () => {
		const output = JSON.stringify({
			ok: false,
			code: 'PERMISSION_DENIED',
			message: 'denied',
		});
		expect(decodeError(output, '', 1)).toMatchObject({ code: 'PERMISSION_DENIED' });
	});

	test('rejects an unknown error code', () => {
		const output = JSON.stringify({
			ok: false,
			code: 'NOT_A_REAL_CODE',
			message: 'nope',
		});
		expect(decodeError(output, '', 1)).toMatchObject({ code: 'HELPER_FAILED' });
	});

	test('rejects success reported with a non-zero exit', () => {
		expect(decodeError(validOutput, '', 1)).toMatchObject({ code: 'HELPER_FAILED' });
	});

	test('rejects an out-of-range position', () => {
		const output = JSON.stringify({
			ok: true,
			latitude: 100,
			longitude: 0,
			accuracy: 10,
			timestamp: 1,
		});
		expect(decodeError(output)).toMatchObject({ code: 'HELPER_FAILED' });
	});

	test('rejects invalid output', () => {
		expect(decodeError('not json')).toMatchObject({ code: 'HELPER_FAILED' });
	});

	test('rejects empty output', () => {
		expect(decodeError('', '', 1)).toMatchObject({ code: 'HELPER_FAILED' });
	});

	test('rejects an unexpected success shape', () => {
		expect(decodeError(JSON.stringify({
			ok: true,
			latitude: 'nope',
		}))).toMatchObject({ code: 'HELPER_FAILED' });
	});
});
