import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
	chmod, readFile, readdir, rm, stat, writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createFixture } from 'fs-fixture';
import {
	describe, expect, skip, test,
} from 'manten';
import {
	acquirePreparationLock,
	collectCommandResult,
	resolveApplicationExecutable,
	type CommandRunner,
	runCommand,
} from '../../src/application.ts';

/**
 * Controlled fixtures exercise the preparation lifecycle. The source bundle is a minimal
 * `.app` with a script executable, so these tests do not depend on the built native helper.
 * They do require macOS, because preparation shells out to `plutil` and `codesign`.
 */

const helperScript = '#!/bin/sh\nexit 0\n';

const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>mac-location</string>
	<key>CFBundleIdentifier</key>
	<string>com.example.before</string>
	<key>CFBundleName</key>
	<string>Before</string>
	<key>CFBundleDisplayName</key>
	<string>Before</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>NSLocationUsageDescription</key>
	<string>Before purpose.</string>
	<key>NSLocationWhenInUseUsageDescription</key>
	<string>Before purpose.</string>
	<key>NSLocationAlwaysAndWhenInUseUsageDescription</key>
	<string>Before purpose.</string>
</dict>
</plist>
`;

const application = {
	id: 'com.example.weather',
	name: 'Weather',
	locationUsageDescription: 'Show the weather forecast.',
};

const skipUnlessMac = () => {
	if (process.platform !== 'darwin') {
		skip('Requires macOS (plutil, codesign)');
	}
};

/** A minimal source app bundle the preparation can copy, edit, and sign. */
const createSourceBundle = async (script = helperScript) => {
	const fixture = await createFixture({
		'Helper.app/Contents/Info.plist': infoPlist,
		'Helper.app/Contents/MacOS/mac-location': script,
	});
	await chmod(fixture.getPath('Helper.app/Contents/MacOS/mac-location'), 0o755);
	return fixture;
};

/** The single per-identity directory the preparation creates under the storage root. */
const identifierDirectory = async (storageRoot: string) => {
	const [entry] = await readdir(storageRoot);
	return path.join(storageRoot, entry);
};

/** Poll until a file appears. */
const waitForFile = async (file: string) => {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const contents = await readFile(file, 'utf8').catch(() => null);
		if (contents !== null) {
			return contents;
		}
		await delay(50);
	}
	throw new Error(`File never appeared: ${file}`);
};

/** Poll until the process is gone, tolerating the zombie window. */
const waitForProcessExit = async (pid: number) => {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			process.kill(pid, 0);
		} catch {
			return;
		}
		await delay(50);
	}
	throw new Error(`Process ${pid} did not exit`);
};

describe('application preparation', () => {
	test('reuses a prepared bundle for identical inputs', async () => {
		skipUnlessMac();
		await using source = await createSourceBundle();
		await using storage = await createFixture({});
		const options = {
			sourceBundle: source.getPath('Helper.app'),
			storageRoot: storage.path,
		};

		const first = await resolveApplicationExecutable(application, options);
		const firstStat = await stat(first);
		const second = await resolveApplicationExecutable(application, options);

		expect(second).toBe(first);
		// An unchanged bundle is not re-signed, so its modification time is unchanged.
		const secondStat = await stat(second);
		expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs);
	});

	test('prepares independent bundles when metadata changes', async () => {
		skipUnlessMac();
		await using source = await createSourceBundle();
		await using storage = await createFixture({});
		const options = {
			sourceBundle: source.getPath('Helper.app'),
			storageRoot: storage.path,
		};

		const first = await resolveApplicationExecutable(application, options);
		const renamed = await resolveApplicationExecutable({
			...application,
			name: 'Renamed',
		}, options);
		const changedPurpose = await resolveApplicationExecutable({
			...application,
			locationUsageDescription: 'Changed.',
		}, options);
		expect(new Set([first, renamed, changedPurpose]).size).toBe(3);
		await expect(resolveApplicationExecutable(application, options)).resolves.toBe(first);
	});

	test('prepares the matching bundle when helper contents change', async () => {
		skipUnlessMac();
		await using source = await createSourceBundle();
		await using storage = await createFixture({});
		const options = {
			sourceBundle: source.getPath('Helper.app'),
			storageRoot: storage.path,
		};

		const first = await resolveApplicationExecutable(application, options);
		await writeFile(source.getPath('Helper.app/Contents/MacOS/mac-location'), `${helperScript}# changed\n`);

		const second = await resolveApplicationExecutable(application, options);
		expect(second).not.toBe(first);
		expect(await readFile(second, 'utf8')).toBe(`${helperScript}# changed\n`);
	});

	test('reuses retained bundles without selecting a shared configuration', async () => {
		skipUnlessMac();
		await using source = await createSourceBundle();
		await using storage = await createFixture({});
		const options = {
			sourceBundle: source.getPath('Helper.app'),
			storageRoot: storage.path,
		};
		const renamed = {
			...application,
			name: 'Renamed',
		};

		const first = await resolveApplicationExecutable(application, options);
		const second = await resolveApplicationExecutable(renamed, options);
		await expect(resolveApplicationExecutable(application, options)).resolves.toBe(first);
		await expect(resolveApplicationExecutable(renamed, options)).resolves.toBe(second);
	});

	test('concurrent preparation yields one complete, consistent bundle', async () => {
		skipUnlessMac();
		await using source = await createSourceBundle();
		await using storage = await createFixture({});
		const options = {
			sourceBundle: source.getPath('Helper.app'),
			storageRoot: storage.path,
		};

		const [first, second] = await Promise.all([
			resolveApplicationExecutable(application, options),
			resolveApplicationExecutable(application, options),
		]);

		expect(second).toBe(first);
		// No incomplete staging directories remain.
		const apps = await readdir(path.join(await identifierDirectory(storage.path), 'apps'));
		expect(apps.filter(name => name.includes('.staging-'))).toStrictEqual([]);
	});

	test('concurrent first use with different metadata prepares both bundles', async () => {
		skipUnlessMac();
		await using source = await createSourceBundle();
		await using storage = await createFixture({});
		const options = {
			sourceBundle: source.getPath('Helper.app'),
			storageRoot: storage.path,
		};
		const conflicting = {
			...application,
			locationUsageDescription: 'A different purpose.',
		};

		const [first, second] = await Promise.all([
			resolveApplicationExecutable(application, options),
			resolveApplicationExecutable(conflicting, options),
		]);

		expect(first).not.toBe(second);
		await expect(resolveApplicationExecutable(application, options)).resolves.toBe(first);
		await expect(resolveApplicationExecutable(conflicting, options)).resolves.toBe(second);
	});

	test('serializes acquirers and releases the lock on close', async () => {
		skipUnlessMac();
		await using storage = await createFixture({});
		const lockPath = path.join(storage.path, 'prepare.lock');

		const release = await acquirePreparationLock(lockPath);
		const { ino: firstInode } = await stat(lockPath);
		let acquired = false;
		const pending = acquirePreparationLock(lockPath).then((releaseNext) => {
			acquired = true;
			return releaseNext;
		});

		// The second acquirer waits while the first holds the kernel lock.
		await delay(150);
		expect(acquired).toBe(false);

		await release();
		const releaseSecond = await pending;
		expect(acquired).toBe(true);
		await releaseSecond();

		// The lock file stays at its path and is never replaced, so both acquirers contend
		// on the same inode.
		const secondStat = await stat(lockPath);
		expect(secondStat.ino).toBe(firstInode);
	});

	test('does not spawn a preparation command after cancellation', async () => {
		skipUnlessMac();
		await using control = await createFixture({});
		const marker = control.getPath('spawned.txt');
		const reason = new Error('cancelled');

		await expect(runCommand('/usr/bin/touch', [marker], AbortSignal.abort(reason))).rejects.toBe(reason);
		await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	test('a successor acquires after the lock owner is killed', async () => {
		skipUnlessMac();
		await using storage = await createFixture({});
		const lockPath = path.join(storage.path, 'prepare.lock');
		const moduleUrl = new URL('../../src/application.ts', import.meta.url).href;

		// A child process holds the lock with the kernel and stays alive.
		const holder = spawn(process.execPath, ['--input-type=module', '-e', String.raw`
			const { acquirePreparationLock } = await import(${JSON.stringify(moduleUrl)});
			await acquirePreparationLock(${JSON.stringify(lockPath)});
			process.stdout.write('held\n');
			setInterval(() => {}, 1000);
		`], { stdio: ['ignore', 'pipe', 'inherit'] });
		await once(holder.stdout, 'data');

		// A second acquirer waits while the owner is alive.
		const controller = new AbortController();
		const reason = new Error('busy');
		const pending = acquirePreparationLock(lockPath, controller.signal);
		const abortTimer = setTimeout(() => controller.abort(reason), 150);
		try {
			await expect(pending).rejects.toBe(reason);
		} finally {
			clearTimeout(abortTimer);
		}

		// Killing the owner releases the kernel lock, so a successor acquires.
		holder.kill('SIGKILL');
		await once(holder, 'close');
		const release = await acquirePreparationLock(lockPath);
		await release();
	});

	test('cancellation while waiting for a held lock preserves the reason', async () => {
		skipUnlessMac();
		await using storage = await createFixture({});
		const lockPath = path.join(storage.path, 'prepare.lock');
		const release = await acquirePreparationLock(lockPath);

		const controller = new AbortController();
		const reason = new Error('stop waiting');
		const pending = acquirePreparationLock(lockPath, controller.signal);
		const abortTimer = setTimeout(() => controller.abort(reason), 100);
		try {
			await expect(pending).rejects.toBe(reason);
		} finally {
			clearTimeout(abortTimer);
		}
		await release();
	});

	test('cancellation stops preparation and publishes nothing', async () => {
		skipUnlessMac();
		await using source = await createSourceBundle();
		await using storage = await createFixture({});
		const options = {
			sourceBundle: source.getPath('Helper.app'),
			storageRoot: storage.path,
		};

		const reason = new Error('cancelled');
		await expect(resolveApplicationExecutable(application, {
			...options,
			signal: AbortSignal.abort(reason),
		})).rejects.toBe(reason);

		await expect(readdir(path.join(await identifierDirectory(storage.path), 'apps')))
			.rejects.toMatchObject({ code: 'ENOENT' });
	});

	test('re-prepares after the prepared bundle is corrupted', async () => {
		skipUnlessMac();
		await using source = await createSourceBundle();
		await using storage = await createFixture({});
		const options = {
			sourceBundle: source.getPath('Helper.app'),
			storageRoot: storage.path,
		};

		const executable = await resolveApplicationExecutable(application, options);
		await rm(executable);

		await expect(resolveApplicationExecutable(application, options)).resolves.toBe(executable);
		await expect(stat(executable)).resolves.toBeTruthy();
	});

	test('an update leaves an in-use prepared bundle usable', async () => {
		skipUnlessMac();
		await using source = await createSourceBundle('#!/bin/sh\nsleep 30\n');
		await using storage = await createFixture({});
		const options = {
			sourceBundle: source.getPath('Helper.app'),
			storageRoot: storage.path,
		};

		const first = await resolveApplicationExecutable(application, options);
		const running = spawn(first);
		try {
			await resolveApplicationExecutable({
				...application,
				name: 'Renamed',
			}, options);

			// The already-running helper's bundle is untouched.
			await expect(stat(first)).resolves.toBeTruthy();

			// A subsequent request selects the updated version.
			const next = await resolveApplicationExecutable({
				...application,
				name: 'Renamed',
			}, options);
			expect(next).not.toBe(first);
		} finally {
			running.kill('SIGKILL');
		}
	});

	test('two helper versions for one identity coexist', async () => {
		skipUnlessMac();
		await using sourceV1 = await createSourceBundle();
		await using sourceV2 = await createSourceBundle('#!/bin/sh\nexit 0\n# v2\n');
		await using storage = await createFixture({});
		const storageRoot = storage.path;

		const first = await resolveApplicationExecutable(application, {
			sourceBundle: sourceV1.getPath('Helper.app'),
			storageRoot,
		});

		const second = await resolveApplicationExecutable(application, {
			sourceBundle: sourceV2.getPath('Helper.app'),
			storageRoot,
		});
		expect(second).not.toBe(first);
		await expect(resolveApplicationExecutable(application, {
			sourceBundle: sourceV1.getPath('Helper.app'),
			storageRoot,
		})).resolves.toBe(first);
	});

	test('cancellation during active preparation reaps the subprocess and cleans up', async () => {
		skipUnlessMac();
		await using source = await createSourceBundle();
		await using storage = await createFixture({});
		await using control = await createFixture({});
		const readyFile = control.getPath('ready.txt');
		// `exec` keeps a single process holding the pipes, so killing it closes them at once.
		await writeFile(control.getPath('slow.sh'), `#!/bin/sh\necho ready > ${JSON.stringify(readyFile)}\nexec sleep 30\n`);
		await chmod(control.getPath('slow.sh'), 0o755);

		const options = {
			sourceBundle: source.getPath('Helper.app'),
			storageRoot: storage.path,
		};

		// The first `plutil` runs a controlled executable that signals readiness and waits,
		// so interruption is deterministic and lands with the lock held and staging present.
		let slowPid: number | undefined;
		let substituted = false;
		const run: CommandRunner = async (command, arguments_, signal) => {
			if (command === 'plutil' && !substituted) {
				substituted = true;
				const child = spawn(control.getPath('slow.sh'));
				slowPid = child.pid;
				const onAbort = () => child.kill('SIGKILL');
				signal?.addEventListener('abort', onAbort, { once: true });
				try {
					const [exitCode] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
					if (signal?.aborted) {
						throw signal.reason;
					}
					return {
						exitCode,
						stdout: '',
						stderr: '',
					};
				} finally {
					signal?.removeEventListener('abort', onAbort);
				}
			}
			return runCommand(command, arguments_, signal);
		};

		const controller = new AbortController();
		const reason = new Error('stop preparing');
		const pending = resolveApplicationExecutable(application, {
			...options,
			signal: controller.signal,
			runCommand: run,
		}).then(() => null, (error: unknown) => error);

		await waitForFile(readyFile);
		controller.abort(reason);

		await expect(pending).resolves.toBe(reason);
		if (slowPid !== undefined) {
			await waitForProcessExit(slowPid);
		}

		// Staging is cleaned and the lock is released.
		const idDirectory = await identifierDirectory(storage.path);
		const apps = await readdir(path.join(idDirectory, 'apps')).catch(() => []);
		expect(apps).toStrictEqual([]);
		// The owned lock was released, so a successor can acquire it (the lock file persists).
		const release = await acquirePreparationLock(path.join(idDirectory, 'prepare.lock'));
		await release();
	});

	test('does not publish when cancelled before publication', async () => {
		skipUnlessMac();
		await using source = await createSourceBundle();
		await using storage = await createFixture({});
		const options = {
			sourceBundle: source.getPath('Helper.app'),
			storageRoot: storage.path,
		};

		const reason = new Error('cancelled while signing');
		const controller = new AbortController();
		// The command still reports success, so only the explicit pre-publication cancellation
		// check can stop the publish.
		const run: CommandRunner = () => {
			controller.abort(reason);
			return Promise.resolve({
				exitCode: 0,
				stdout: '',
				stderr: '',
			});
		};

		await expect(resolveApplicationExecutable(application, {
			...options,
			runCommand: run,
			signal: controller.signal,
		})).rejects.toBe(reason);

		// Nothing was published.
		const idDirectory = await identifierDirectory(storage.path);
		const apps = await readdir(path.join(idDirectory, 'apps')).catch(() => []);
		expect(apps).toStrictEqual([]);
	});

	test('preserves the abort reason when verifying a retained bundle', async () => {
		skipUnlessMac();
		await using source = await createSourceBundle();
		await using storage = await createFixture({});
		const options = {
			sourceBundle: source.getPath('Helper.app'),
			storageRoot: storage.path,
		};
		const renamed = {
			...application,
			name: 'Renamed',
		};

		await resolveApplicationExecutable(application, options);
		await resolveApplicationExecutable(renamed, options);

		// A command can report success after cancellation; reuse must still reject.
		const reason = new Error('cancelled during verification');
		const controller = new AbortController();
		const run: CommandRunner = () => {
			controller.abort(reason);
			return Promise.resolve({
				exitCode: 0,
				stdout: '',
				stderr: '',
			});
		};
		await expect(resolveApplicationExecutable(renamed, {
			...options,
			runCommand: run,
			signal: controller.signal,
		})).rejects.toBe(reason);

		await expect(resolveApplicationExecutable(application, options)).resolves.toBeTruthy();
	});

	test('kills an in-flight preparation command on cancellation', async () => {
		skipUnlessMac();
		await using control = await createFixture({});
		const readyFile = control.getPath('ready.txt');
		await writeFile(control.getPath('slow.sh'), `#!/bin/sh\necho ready > ${JSON.stringify(readyFile)}\nexec sleep 30\n`);
		await chmod(control.getPath('slow.sh'), 0o755);

		const controller = new AbortController();
		const pending = runCommand(control.getPath('slow.sh'), [], controller.signal);
		await waitForFile(readyFile);
		controller.abort(new Error('cancelled'));

		// A kill signal, not a normal exit, ends the command.
		const { exitCode } = await pending;
		expect(exitCode).toBeNull();
	});

	test('terminates a preparation command and rejects on an output stream failure', async () => {
		const child = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000);'], {
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		const exited = once(child, 'exit');
		try {
			const request = collectCommandResult(child);

			// Fail the stdout read while the command is still running.
			child.stdout.destroy(new Error('injected read failure'));

			await expect(request).rejects.toThrow('injected read failure');
			// A failed read must not leave the command running.
			await exited;
		} finally {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill('SIGKILL');
			}
		}
	});

	test('reports HELPER_NOT_FOUND when the source helper is missing', async () => {
		skipUnlessMac();
		await using storage = await createFixture({});
		const options = {
			sourceBundle: storage.getPath('missing.app'),
			storageRoot: storage.path,
		};

		await expect(resolveApplicationExecutable(application, options))
			.rejects.toMatchObject({ code: 'HELPER_NOT_FOUND' });
	});

	test('wraps an unexpected preparation failure as HELPER_PREPARATION_FAILED', async () => {
		skipUnlessMac();
		await using source = await createSourceBundle();
		await using storage = await createFixture({});
		const options = {
			sourceBundle: source.getPath('Helper.app'),
			storageRoot: storage.path,
		};
		const failing: CommandRunner = () => Promise.reject(new Error('command runner exploded'));

		await expect(resolveApplicationExecutable(application, {
			...options,
			runCommand: failing,
		})).rejects.toMatchObject({
			code: 'HELPER_PREPARATION_FAILED',
			message: 'Preparing the helper failed: command runner exploded',
		});
	});
});
