import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, test } from 'manten';
import { collectHelperResult, runHelper } from '../../src/helper.ts';
import { createFakeHelper, printJsonScript } from '../utils/fake-helper.ts';
import { createTrapHelper } from '../utils/trap-helper.ts';

const successPosition = {
	ok: true,
	latitude: 35.6586,
	longitude: 139.7454,
	accuracy: 35,
	timestamp: 1_750_000_000_000,
};

describe('runHelper', () => {
	// Invocation: spawning, argument forwarding, and decoding stay connected.
	test('resolves a position from valid output', async () => {
		await using fixture = await createFakeHelper(printJsonScript(successPosition));
		await expect(runHelper(fixture.getPath('helper'), { signal: AbortSignal.timeout(10_000) })).resolves.toStrictEqual({
			latitude: 35.6586,
			longitude: 139.7454,
			accuracy: 35,
			timestamp: 1_750_000_000_000,
		});
	});

	test('forwards maximumAge to the helper as --maximum-age', async () => {
		await using fixture = await createFakeHelper(`
			const index = process.argv.indexOf('--maximum-age');
			const maximumAge = index === -1 ? null : Number(process.argv[index + 1]);
			console.log(JSON.stringify({ ok: true, latitude: 1, longitude: 2, accuracy: 3, timestamp: maximumAge }));
		`);
		await expect(runHelper(fixture.getPath('helper'), {
			maximumAge: 12_345,
			signal: AbortSignal.timeout(10_000),
		})).resolves.toMatchObject({
			timestamp: 12_345,
		});
	});

	test('lets the signal own cancellation without a native deadline', async () => {
		await using fixture = await createFakeHelper(`
			if (process.argv.includes('--timeout')) {
				console.log(JSON.stringify({ ok: false, code: 'TIMEOUT', message: 'Unexpected native deadline' }));
			} else {
				${printJsonScript(successPosition)}
			}
		`);
		await expect(runHelper(fixture.getPath('helper'), {
			signal: AbortSignal.timeout(10_000),
		})).resolves.toMatchObject({
			timestamp: successPosition.timestamp,
		});
	});

	test('rejects with HELPER_NOT_FOUND when the executable is missing', async () => {
		await expect(runHelper('/nonexistent/path/helper', { signal: AbortSignal.timeout(10_000) })).rejects.toMatchObject({ code: 'HELPER_NOT_FOUND' });
	});

	// Subprocess faults: drive `collectHelperResult` with a real child so cleanup
	// and error handling are exercised without spawning the native helper.
	test('reports HELPER_FAILED and no unhandled rejection on a post-spawn child error', async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown) => {
			unhandled.push(error);
		};
		process.on('unhandledRejection', onUnhandled);

		const child = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000);'], {
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		try {
			const request = collectHelperResult(child, AbortSignal.timeout(30_000));

			// The child spawned successfully; emit an error while its streams remain open.
			child.emit('error', new Error('injected child error'));

			await expect(request).rejects.toMatchObject({ code: 'HELPER_FAILED' });

			// Let the event loop settle so a floating rejection would surface.
			await delay(100);
			expect(unhandled).toHaveLength(0);
		} finally {
			process.off('unhandledRejection', onUnhandled);
			if (child.exitCode === null && child.signalCode === null) {
				child.kill('SIGKILL');
			}
		}
	});

	test('terminates the helper and reports HELPER_FAILED on an output stream failure', async () => {
		const child = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000);'], {
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		const exited = once(child, 'exit');
		try {
			const request = collectHelperResult(child, AbortSignal.timeout(30_000));

			// Fail the stdout read while the child is still running.
			child.stdout.destroy(new Error('injected read failure'));

			await expect(request).rejects.toMatchObject({ code: 'HELPER_FAILED' });

			// A failed read must not leave the helper running.
			await exited;
		} finally {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill('SIGKILL');
			}
		}
	});

	// Lifecycle: cancellation and termination. Sequenced to avoid contending for
	// process resources; readiness is awaited before any timeout starts.
	describe('lifecycle', async () => {
		await test(
			'preserves TimeoutError and terminates a helper that ignores SIGTERM',
			async () => {
				await using helper = createTrapHelper();
				await helper.ready;
				const exited = once(helper.child, 'exit');

				const signal = AbortSignal.timeout(1000);
				const request = collectHelperResult(helper.child, signal)
					.then(() => null, (error: unknown) => error);

				const reason = await request;
				expect(reason).toBe(signal.reason);
				expect(reason).toMatchObject({ name: 'TimeoutError' });
				await exited;
			},
			{ timeout: 15_000 },
		);

		await test(
			'force-kills a helper that ignores SIGTERM when aborted',
			async () => {
				await using helper = createTrapHelper();
				await helper.ready;
				const controller = new AbortController();
				const exited = once(helper.child, 'exit');

				const request = collectHelperResult(helper.child, controller.signal)
					.then(() => null, (error: unknown) => error);

				controller.abort();

				// SIGKILL escalates 1s after the SIGTERM that was ignored.
				await expect(request).resolves.toMatchObject({ name: 'AbortError' });
				await exited;
			},
			{ timeout: 15_000 },
		);

		await test(
			'preserves the first abort reason through delayed child cleanup',
			async () => {
				await using helper = createTrapHelper(30_000);
				await helper.ready;
				const controller = new AbortController();
				const request = collectHelperResult(helper.child, controller.signal)
					.then(() => null, (error: unknown) => error);

				// The background sleep keeps output pipes open after force-kill escalation.
				const reason = new Error('caller-abort');
				controller.abort(reason);
				await delay(1300);
				controller.abort(new Error('later-abort'));
				helper.release();

				await expect(request).resolves.toBe(reason);
			},
			{ timeout: 15_000 },
		);
	});
});
