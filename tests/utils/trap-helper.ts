import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { HelperProcess } from '../../src/helper.ts';

/** Force-kill a process, ignoring errors if it has already exited. */
const kill = (pid: number | null) => {
	if (pid === null) {
		return;
	}
	try {
		process.kill(pid, 'SIGKILL');
	} catch {
		// Already exited.
	}
};

/**
 * Start a helper that ignores SIGTERM and reports readiness over IPC. When
 * `holdOutputMilliseconds` is set, the helper also starts a background `sleep`
 * that inherits stdout/stderr, keeping those pipes open after the helper is
 * killed so cleanup can outlast the signal's deadline.
 *
 * The returned `child` handle allows termination and exit observation without
 * PID files. `release` ends the inherited-pipe hold, and `await using` force-kills
 * both processes.
 */
export const createTrapHelper = (holdOutputMilliseconds = 0) => {
	const holder = holdOutputMilliseconds > 0
		? `spawn('sleep', ['${Math.ceil(holdOutputMilliseconds / 1000)}'], { stdio: 'inherit' })`
		: 'null';
	const script = `
		const { spawn } = require('node:child_process');
		process.on('SIGTERM', () => {});
		const holder = ${holder};
		process.send(holder ? holder.pid : null);
		setInterval(() => {}, 1000);
	`;

	const child = spawn(process.execPath, ['--eval', script], {
		stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
	}) as HelperProcess;

	let holderPid: number | null = null;
	const ready = once(child, 'message').then(([pid]) => {
		holderPid = pid as number | null;
	});

	return {
		child,

		/** Resolves once the helper has installed its SIGTERM handler. */
		ready,

		/** Kill the background process that holds the output pipes open. */
		release: () => kill(holderPid),

		[Symbol.asyncDispose]: async () => {
			kill(holderPid);
			if (child.exitCode === null && child.signalCode === null) {
				child.kill('SIGKILL');
			}
		},
	};
};
