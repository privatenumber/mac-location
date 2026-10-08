import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { constants } from 'node:fs';
import {
	cp, mkdir, open, readFile, rename, rm, stat, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { setTimeout as delay } from 'node:timers/promises';
import { LocationError } from './errors.ts';
import type { ApplicationIdentity } from './types.ts';

/**
 * Prepare and reuse a helper bundle customized for a caller's application identity.
 *
 * Prepared bundles live under a durable per-user directory, addressed by a hash of the
 * inputs that determine the signed bundle. The same inputs always resolve to the same
 * path, so reuse skips preparation. A prepared bundle is only ever published by renaming a
 * fully verified staging directory into place, so a reader never observes a partial bundle.
 *
 * A per-id kernel lock serializes bundle verification, preparation, and publication.
 */

/** Durable per-user storage for prepared helper bundles. */
export const applicationStorageRoot = path.join(os.homedir(), 'Library', 'Application Support', 'mac-location');

const helperExecutableName = 'mac-location';
const helperBundleName = 'mac-location.app';

const usageDescriptionKeys = [
	'NSLocationUsageDescription',
	'NSLocationWhenInUseUsageDescription',
	'NSLocationAlwaysAndWhenInUseUsageDescription',
];

export type CommandResult = {
	exitCode: number | null;
	stdout: string;
	stderr: string;
};

/** Runs an external command. Injectable so tests can drive preparation deterministically. */
export type CommandRunner = (
	command: string,
	arguments_: string[],
	signal?: AbortSignal,
) => Promise<CommandResult>;

/** A preparation command spawned with piped stdout and stderr. */
export type PreparationCommand = ChildProcessByStdio<null, Readable, Readable>;

/**
 * Collect a preparation command's exit code and output. A failed output stream terminates the
 * child so it cannot linger, then rejects; the caller maps that failure to the public error
 * contract. Exported so tests can drive a specific `ChildProcess`, as with
 * `collectHelperResult`.
 */
export const collectCommandResult = async (
	child: PreparationCommand,
	signal?: AbortSignal,
): Promise<CommandResult> => {
	// Watch completion alongside the output streams so a stream failure is observed instead of
	// surfacing as an uncaught exception.
	const closed = once(child, 'close');

	// Stop a preparation subprocess when the caller cancels.
	const onAbort = () => child.kill('SIGKILL');
	signal?.addEventListener('abort', onAbort, { once: true });

	try {
		const [stdout, stderr] = await Promise.all([
			text(child.stdout),
			text(child.stderr),
			closed,
		]);
		const [exitCode] = await closed as [number | null, NodeJS.Signals | null];
		return {
			exitCode,
			stdout: stdout.trim(),
			stderr: stderr.trim(),
		};
	} catch (error) {
		// A failed output stream must not leave the command running.
		if (child.exitCode === null && child.signalCode === null) {
			child.kill('SIGKILL');
		}
		// Reap the terminated child; the failure that caused it is what we report.
		await closed.catch(() => undefined);
		throw error;
	} finally {
		signal?.removeEventListener('abort', onAbort);
	}
};

export const runCommand: CommandRunner = async (command, arguments_, signal) => {
	// Do not create a preparation subprocess for an already-cancelled request.
	if (signal?.aborted) {
		throw signal.reason;
	}

	const child = spawn(command, arguments_, { stdio: ['ignore', 'pipe', 'pipe'] });
	return collectCommandResult(child, signal);
};

const runChecked = async (
	run: CommandRunner,
	command: string,
	arguments_: string[],
	signal?: AbortSignal,
) => {
	const result = await run(command, arguments_, signal);
	if (result.exitCode !== 0) {
		if (signal?.aborted) {
			throw signal.reason;
		}
		throw new LocationError('HELPER_PREPARATION_FAILED', `${command} failed: ${result.stderr || result.stdout}`);
	}
};

const sha256File = async (filePath: string) => {
	const hash = createHash('sha256');
	hash.update(await readFile(filePath));
	return hash.digest('hex');
};

const shortHash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);

const exists = async (filePath: string) => {
	try {
		await stat(filePath);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return false;
		}
		throw error;
	}
};

/**
 * Exclusive lock taken at open time. On macOS `O_EXLOCK` (`<sys/fcntl.h>`) takes an `flock`
 * for the open file description, and the kernel releases it when the description is closed
 * or the process dies. Node does not expose the constant, so the BSD value is used on
 * macOS. This is the whole locking mechanism: there is no stale-lock reclamation, so a
 * reclaimer can never move a live owner's lock.
 */
const exclusiveLockFlag = process.platform === 'darwin' ? 0x20 : 0;

/* eslint-disable no-bitwise -- the open flags are combined with bitwise OR. */
const exclusiveLockOpenFlags = constants.O_RDWR
	| constants.O_CREAT
	| exclusiveLockFlag
	| constants.O_NONBLOCK;
/* eslint-enable no-bitwise */

/**
 * Acquire the per-id preparation lock. Ownership is held by the kernel for the returned
 * file description, so a crashed or killed owner releases it automatically and a waiting
 * caller can then acquire it. The caller's signal controls how long it waits.
 *
 * The lock file must stay at its path: it is never unlinked or replaced during normal
 * operation, so every process contends on the same inode. Removing or replacing it would
 * let two processes lock different files at the same pathname and both believe they hold it.
 * Release only closes the description.
 *
 * Exported for tests; preparation owns the only production caller.
 */
export const acquirePreparationLock = async (lockPath: string, signal?: AbortSignal) => {
	while (true) {
		if (signal?.aborted) {
			throw signal.reason;
		}

		try {
			const handle = await open(lockPath, exclusiveLockOpenFlags, 0o600);
			return async () => {
				await handle.close();
			};
		} catch (error) {
			const { code } = error as NodeJS.ErrnoException;
			if (code !== 'EAGAIN' && code !== 'EWOULDBLOCK') {
				throw error;
			}
		}

		await delay(50);
	}
};

const bundleIsValid = async (run: CommandRunner, bundlePath: string, signal?: AbortSignal) => {
	if (!await exists(path.join(bundlePath, 'Contents', 'MacOS', helperExecutableName))) {
		return false;
	}
	const verification = await run('codesign', ['--verify', bundlePath], signal);
	return verification.exitCode === 0;
};

const inputHashOf = (
	application: ApplicationIdentity,
	executableSha256: string,
) => shortHash(JSON.stringify({
	id: application.id,
	name: application.name,
	locationUsageDescription: application.locationUsageDescription,
	iconSha256: application.icon === undefined || application.icon === null ? undefined : createHash('sha256').update(application.icon).digest('hex'),
	executableSha256,
}));

/**
 * Copy, customize, sign, and atomically publish the bundle for `application`, unless a valid
 * bundle is already in place, and return its executable path. Staging is published only by
 * renaming a verified directory into place, so a reader never observes a partial bundle.
 */
const ensureBundle = async (
	application: ApplicationIdentity,
	sourceBundle: string,
	appsDirectory: string,
	inputHash: string,
	run: CommandRunner,
	signal?: AbortSignal,
): Promise<string> => {
	const bundleDirectory = path.join(appsDirectory, inputHash);
	const bundlePath = path.join(bundleDirectory, helperBundleName);
	const executablePath = path.join(bundlePath, 'Contents', 'MacOS', helperExecutableName);
	if (await bundleIsValid(run, bundlePath, signal)) {
		return executablePath;
	}

	const stagingDirectory = path.join(appsDirectory, `${inputHash}.staging-${process.pid}`);
	try {
		await rm(stagingDirectory, {
			recursive: true,
			force: true,
		});
		await mkdir(stagingDirectory, { recursive: true });

		const stagingBundlePath = path.join(stagingDirectory, helperBundleName);
		await cp(sourceBundle, stagingBundlePath, { recursive: true });

		const plistPath = path.join(stagingBundlePath, 'Contents', 'Info.plist');
		const replace = (key: string, value: string) => runChecked(run, 'plutil', ['-replace', key, '-string', value, plistPath], signal);
		await replace('CFBundleIdentifier', application.id);
		await replace('CFBundleName', application.name);
		await replace('CFBundleDisplayName', application.name);
		for (const key of usageDescriptionKeys) {
			await replace(key, application.locationUsageDescription);
		}
		if (application.icon !== undefined && application.icon !== null) {
			const resourcesDirectory = path.join(stagingBundlePath, 'Contents', 'Resources');
			await mkdir(resourcesDirectory, { recursive: true });
			await writeFile(path.join(resourcesDirectory, 'application.icns'), application.icon);
			await replace('CFBundleIconFile', 'application.icns');
		}

		await runChecked(run, 'codesign', ['--force', '--deep', '-s', '-', stagingBundlePath], signal);
		await runChecked(run, 'codesign', ['--verify', '--verbose=2', stagingBundlePath], signal);

		// Do not begin publication for a request that was cancelled while signing.
		if (signal?.aborted) {
			throw signal.reason;
		}

		await rm(bundleDirectory, {
			recursive: true,
			force: true,
		});
		await rename(stagingDirectory, bundleDirectory);
	} catch (error) {
		// On any failure or cancellation, remove the incomplete staging directory.
		await rm(stagingDirectory, {
			recursive: true,
			force: true,
		});
		throw error;
	}

	return executablePath;
};

/** Resolve the matching bundle under one per-ID lock, without selecting shared state. */
const ensurePrepared = async (
	application: ApplicationIdentity,
	sourceBundle: string,
	storageRoot: string,
	run: CommandRunner,
	signal?: AbortSignal,
): Promise<string> => {
	const sourceExecutable = path.join(sourceBundle, 'Contents', 'MacOS', helperExecutableName);
	if (!await exists(sourceExecutable)) {
		throw new LocationError('HELPER_NOT_FOUND', `The bundled helper was not found at ${sourceExecutable}.`);
	}
	const executableSha256 = await sha256File(sourceExecutable);
	const inputHash = inputHashOf(application, executableSha256);

	const idDirectory = path.join(storageRoot, shortHash(application.id));
	const appsDirectory = path.join(idDirectory, 'apps');

	await mkdir(idDirectory, { recursive: true });
	const release = await acquirePreparationLock(path.join(idDirectory, 'prepare.lock'), signal);
	try {
		const executablePath = await ensureBundle(
			application,
			sourceBundle,
			appsDirectory,
			inputHash,
			run,
			signal,
		);

		// Publication may have completed, but a canceled request must not report success.
		if (signal?.aborted) {
			throw signal.reason;
		}

		return executablePath;
	} finally {
		await release();
	}
};

export type PrepareApplicationOptions = {
	sourceBundle: string;
	signal?: AbortSignal;
	storageRoot?: string;

	/** Overrides the runner used for `plutil` and `codesign`. Used by tests. */
	runCommand?: CommandRunner;
};

/**
 * Map a preparation failure to the public error contract. Cancellation wins so a cancelled
 * request reports its own reason; an existing `LocationError` is preserved; anything else is a
 * preparation failure rather than a raw system error.
 */
const toPreparationError = (error: unknown, signal?: AbortSignal): unknown => {
	if (signal?.aborted) {
		return signal.reason;
	}
	if (error instanceof LocationError) {
		return error;
	}
	return new LocationError('HELPER_PREPARATION_FAILED', `Preparing the helper failed: ${(error as Error).message}`);
};

export const resolveApplicationExecutable = (
	application: ApplicationIdentity,
	options: PrepareApplicationOptions,
): Promise<string> => ensurePrepared(
	application,
	options.sourceBundle,
	options.storageRoot ?? applicationStorageRoot,
	options.runCommand ?? runCommand,
	options.signal,
).catch((error: unknown) => {
	throw toPreparationError(error, options.signal);
});
