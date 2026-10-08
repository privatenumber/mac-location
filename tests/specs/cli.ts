import spawn, { SubprocessError } from 'nano-spawn';
import {
	describe, expect, skip, test,
} from 'manten';
import { createLocationFixture, macLocationsCli } from '../utils/mac-location.ts';

/** Run the CLI expecting a non-zero exit and return its error. */
const runExpectingFailure = async (...arguments_: string[]) => {
	try {
		await macLocationsCli(...arguments_);
	} catch (error) {
		if (error instanceof SubprocessError) {
			return error;
		}
		throw error;
	}
	throw new Error('Expected the CLI to exit with a non-zero code');
};

describe('cli', () => {
	test('--help prints usage and exits 0', async () => {
		const { stdout } = await macLocationsCli('--help');
		expect(stdout).toContain('mac-location');
	});

	test('rejects an invalid flag value with a clean error and non-zero exit', async () => {
		const error = await runExpectingFailure('--timeout', 'not-a-number');
		expect(error.exitCode).toBe(1);
		expect(error.stderr).toContain('timeout');
		expect(error.stderr).not.toContain('at validateOptions');
	});

	test('rejects an unknown flag', async () => {
		const error = await runExpectingFailure('--nope');
		expect(error.exitCode).toBe(1);
		expect(error.stderr).not.toBe('');
	});

	test('--timeout cancels through the Node signal and exits with its message', async () => {
		if (process.platform !== 'darwin') {
			skip('Requires macOS');
		}
		await using fixture = await createLocationFixture('setInterval(() => {}, 1000);');
		await expect(spawn(process.execPath, [fixture.getPath('src/cli.ts'), '--timeout', '100'], {
			env: { HOME: fixture.getPath('home') },
		})).rejects.toMatchObject({
			exitCode: 1,
			stderr: 'The operation was aborted due to timeout',
		});
	});

	for (const timeout of ['0', '-1', '1.5', '2147483648']) {
		test(`rejects invalid --timeout ${timeout} without launching`, async () => {
			const error = await runExpectingFailure('--timeout', timeout);
			expect(error.exitCode).toBe(1);
			expect(error.stderr).toContain('Invalid "--timeout"');
		});
	}
});
