import { spawn, type ChildProcess, type ChildProcessByStdio } from 'node:child_process';
import { once } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { text } from 'node:stream/consumers';
import {
	LocationError,
	type LocationErrorCode,
} from './errors.ts';
import { decodeHelperResponse } from './helper-response.ts';
import type { Position } from './types.ts';

export const DEFAULT_MAXIMUM_AGE = 0;

/** Milliseconds to wait after SIGTERM before escalating to SIGKILL. */
const FORCE_KILL_DELAY = 1000;

/** A helper child process spawned with piped stdin, stdout, and stderr. */
export type HelperProcess = ChildProcessByStdio<Writable, Readable, Readable>;

/** The helper's collected output, ready to decode into a position. */
type HelperOutput = {
	stdout: string;
	stderr: string;
};

/** Terminate the helper, escalating to SIGKILL if it does not exit promptly. */
const terminate = (child: ChildProcess): void => {
	if (child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	child.kill('SIGTERM');
	const forceKillId = setTimeout(() => child.kill('SIGKILL'), FORCE_KILL_DELAY);
	child.once('close', () => clearTimeout(forceKillId));
};

/** Map a child-process or stream failure to a LocationError. */
const toSubprocessError = (error: unknown): LocationError => {
	const errno = error as NodeJS.ErrnoException;
	const code: LocationErrorCode = errno.code === 'ENOENT' ? 'HELPER_NOT_FOUND' : 'HELPER_FAILED';
	return new LocationError(code, (error as Error).message);
};

/**
 * Collect the helper's output, terminating it on failure or cancellation.
 *
 * Exported so tests can drive a specific `ChildProcess` — for example, to inject
 * a post-spawn 'error' event or to fail an output stream read.
 */
export const collectHelperResult = async (
	child: HelperProcess,
	signal: AbortSignal,
): Promise<HelperOutput> => {
	const onAbort = () => terminate(child);
	signal.addEventListener('abort', onAbort, { once: true });

	// Watch the close promise alongside the output streams so a child-process
	// error is handled immediately and never becomes an unhandled rejection.
	const closed = once(child, 'close');
	if (signal.aborted) {
		terminate(child);
	}

	let stdout = '';
	let stderr = '';

	try {
		[stdout, stderr] = await Promise.all([
			text(child.stdout),
			text(child.stderr),
			closed,
		]);
	} catch (error) {
		// Terminate on subprocess or stream failure; cancellation keeps its original reason.
		terminate(child);
		if (signal.aborted) {
			throw signal.reason;
		}
		throw toSubprocessError(error);
	} finally {
		signal.removeEventListener('abort', onAbort);
	}

	signal.throwIfAborted();

	return {
		stdout,
		stderr,
	};
};

/**
 * Run the native helper and resolve to a position.
 *
 * @param executablePath Absolute path to the helper executable.
 */
export const runHelper = async (
	executablePath: string,
	options: { maximumAge?: number;
		signal: AbortSignal; },
): Promise<Position> => {
	const {
		maximumAge = DEFAULT_MAXIMUM_AGE,
		signal,
	} = options;

	signal.throwIfAborted();

	// Node owns cancellation; the native helper's optional deadline is for direct invocation.
	const child = spawn(executablePath, ['--maximum-age', String(maximumAge)], {
		stdio: ['pipe', 'pipe', 'pipe'],
	});

	const { stdout, stderr } = await collectHelperResult(child, signal);

	return decodeHelperResponse(stdout, stderr, child.exitCode, child.signalCode);
};
