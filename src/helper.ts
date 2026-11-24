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

/** Milliseconds to wait for a fix after location access is granted. */
export const DEFAULT_TIMEOUT = 30_000;

/** Milliseconds to wait after SIGTERM before escalating to SIGKILL. */
const FORCE_KILL_DELAY = 1000;

/** A helper child process spawned with piped stdin, stdout, and stderr. */
export type HelperProcess = ChildProcessByStdio<Writable, Readable, Readable>;

/** Progress lines the helper prints before its final response. */
const permissionRequestEvent = '{"event":"permission-request"}';

/** Callbacks for helper progress. */
export type HelperEvents = {
	onPermissionRequest?: () => void;
};

/** A listener failure, kept apart from subprocess failures so it reaches the caller unchanged. */
class ListenerError {
	readonly cause: unknown;

	constructor(cause: unknown) {
		this.cause = cause;
	}
}

/**
 * Read stdout line by line, dispatch progress events as they arrive, and return the
 * remaining output: the helper's final response.
 */
const readResponse = async (stdout: Readable, events: HelperEvents): Promise<string> => {
	let response = '';
	let pending = '';
	stdout.setEncoding('utf8');
	for await (const chunk of stdout as AsyncIterable<string>) {
		pending += chunk;
		let newline = pending.indexOf('\n');
		while (newline !== -1) {
			const line = pending.slice(0, newline);
			pending = pending.slice(newline + 1);
			if (line === permissionRequestEvent) {
				try {
					events.onPermissionRequest?.();
				} catch (error) {
					throw new ListenerError(error);
				}
			} else {
				response += `${line}\n`;
			}
			newline = pending.indexOf('\n');
		}
	}
	return response + pending;
};

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
	signal?: AbortSignal,
	events: HelperEvents = {},
): Promise<HelperOutput> => {
	const onAbort = () => terminate(child);
	signal?.addEventListener('abort', onAbort, { once: true });

	// Watch the close promise alongside the output streams so a child-process
	// error is handled immediately and never becomes an unhandled rejection.
	const closed = once(child, 'close');
	if (signal?.aborted) {
		terminate(child);
	}

	let stdout = '';
	let stderr = '';

	try {
		[stdout, stderr] = await Promise.all([
			readResponse(child.stdout, events),
			text(child.stderr),
			closed,
		]);
	} catch (error) {
		// Terminate on subprocess or stream failure; cancellation keeps its original reason.
		terminate(child);
		if (signal?.aborted) {
			throw signal.reason;
		}
		if (error instanceof ListenerError) {
			throw error.cause;
		}
		throw toSubprocessError(error);
	} finally {
		signal?.removeEventListener('abort', onAbort);
	}

	signal?.throwIfAborted();

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
	options: HelperEvents & {
		maximumAge?: number;
		timeout?: number;
		signal?: AbortSignal;
	},
): Promise<Position> => {
	const {
		maximumAge = DEFAULT_MAXIMUM_AGE,
		timeout = DEFAULT_TIMEOUT,
		signal,
		onPermissionRequest,
	} = options;

	signal?.throwIfAborted();

	// The helper owns the fix deadline because only it knows when permission is granted.
	// Node owns cancellation, which covers the whole request.
	const child = spawn(executablePath, ['--maximum-age', String(maximumAge), '--timeout', String(timeout)], {
		stdio: ['pipe', 'pipe', 'pipe'],
	});

	const { stdout, stderr } = await collectHelperResult(child, signal, { onPermissionRequest });

	return decodeHelperResponse(stdout, stderr, child.exitCode, child.signalCode);
};
