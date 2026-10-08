import { existsSync } from 'node:fs';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
	describe, expect, skip, test,
} from 'manten';

const projectDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const helperExecutable = path.join(
	projectDirectory,
	'dist-native',
	'mac-location.app',
	'Contents',
	'MacOS',
	'mac-location',
);

/** Response codes the helper returns when Core Location itself resolves. */
const coreLocationCodes = new Set([
	'PERMISSION_DENIED',
	'PERMISSION_RESTRICTED',
	'LOCATION_SERVICES_DISABLED',
	'POSITION_UNAVAILABLE',
]);

type HelperResponse = {
	ok: boolean;
	code?: string;
};

type HelperOutcome = {
	code: number | null;
	signal: NodeJS.Signals | null;
	durationMs: number;
};

type HelperRun = {
	child: ChildProcessByStdio<Writable, Readable, Readable>;
	stdout: string;
	exited: Promise<HelperOutcome>;
};

/** Launch the real helper with a stdin pipe so it can observe parent lifetime. */
const launchHelper = (arguments_: string[]): HelperRun => {
	const startedAt = Date.now();
	const child = spawn(helperExecutable, arguments_, {
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	const run: HelperRun = {
		child,
		stdout: '',
		exited: new Promise<HelperOutcome>((resolve) => {
			child.on('close', (code, signal) => {
				resolve({
					code,
					signal,
					durationMs: Date.now() - startedAt,
				});
			});
		}),
	};
	child.stdout.setEncoding('utf8');
	child.stdout.on('data', (chunk) => {
		run.stdout += chunk;
	});
	return run;
};

/**
 * Wait for the helper to exit on its own, but kill it and fail if it outlives
 * the watchdog so a lifetime regression cannot leak a process.
 */
const exitWithin = async (run: HelperRun, watchdogMs: number): Promise<HelperOutcome> => {
	const watchdog = setTimeout(() => run.child.kill('SIGKILL'), watchdogMs);
	try {
		return await run.exited;
	} finally {
		clearTimeout(watchdog);
		run.child.kill('SIGKILL');
	}
};

/** Parse the helper's single-line JSON stdout, or null when it emitted nothing. */
const parseResponse = (run: HelperRun): HelperResponse | null => {
	const line = run.stdout.trim();
	return line === '' ? null : JSON.parse(line) as HelperResponse;
};

/** Whether the helper resolved from Core Location (a position or a location error). */
const isCoreLocationOutcome = (response: HelperResponse | null): response is HelperResponse => (
	response !== null
	&& (response.ok === true || (response.ok === false && coreLocationCodes.has(response.code ?? '')))
);

const describeOutcome = (response: HelperResponse) => (
	response.ok ? 'position' : `code ${response.code ?? '(none)'}`
);

const skipUnlessNative = () => {
	if (process.platform !== 'darwin') {
		skip('Requires macOS');
	}
	if (!process.env.MAC_LOCATION_NATIVE) {
		skip('Set MAC_LOCATION_NATIVE=1 to run native helper tests');
	}
	if (!existsSync(helperExecutable)) {
		skip('Native helper not built (run `pnpm build`)');
	}
};

describe('helper lifetime', () => {
	test('exits with TIMEOUT at its own deadline', async () => {
		skipUnlessNative();

		const run = launchHelper(['--maximum-age', '0', '--timeout', '100']);
		const outcome = await exitWithin(run, 10_000);

		// A killed process means the deadline never fired (lifetime regression).
		expect(outcome.signal).toBeNull();

		const response = parseResponse(run);

		// Core Location resolving first means the deadline was not exercised.
		if (isCoreLocationOutcome(response)) {
			skip(`Core Location resolved before the deadline (${describeOutcome(response)})`);
		}

		// Anything else — including missing or unexpected output — must fail.
		expect(response).toMatchObject({
			ok: false,
			code: 'TIMEOUT',
		});
		expect(outcome.code).toBe(1);
		// The helper must exit around its deadline, not early or open-ended.
		expect(outcome.durationMs).toBeGreaterThanOrEqual(80);
	});

	test('exits when its caller closes stdin', async () => {
		skipUnlessNative();

		// A long deadline ensures any exit is caused by stdin closing, not the timeout.
		const run = launchHelper(['--maximum-age', '0', '--timeout', '60000']);
		await delay(50);

		if (run.child.exitCode !== null || run.child.signalCode !== null) {
			skip('Helper resolved before stdin was closed, so the watch was not exercised');
		}

		const closedAt = Date.now();
		run.child.stdin.end();
		const outcome = await exitWithin(run, 10_000);

		// A killed process means the exit was not caused by the stdin closure.
		expect(outcome.signal).toBeNull();

		// A JSON response means Core Location won the race; the watch was not exercised.
		const response = parseResponse(run);
		if (response !== null) {
			skip(`Core Location resolved before the stdin watch (${describeOutcome(response)})`);
		}

		// The stdin watch exits 0 without emitting any response.
		expect(outcome.code).toBe(0);
		expect(run.stdout).toBe('');
		expect(Date.now() - closedAt).toBeLessThan(5000);
	});
});
