import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFixture } from 'fs-fixture';
import {
	describe, expect, skip, test,
} from 'manten';
import spawnProcess from 'nano-spawn';
import { createApplication, getCurrentPosition, isSupported } from '../../src/index.ts';
import { createLocationFixture } from '../utils/mac-location.ts';

const projectDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const helperExecutable = path.join(
	projectDirectory,
	'dist-native',
	'mac-location.app',
	'Contents',
	'MacOS',
	'mac-location',
);

describe('Node API', () => {
	test('isSupported describes the platform', () => {
		expect(isSupported).toBe(process.platform === 'darwin');
	});

	test('validates application identity synchronously', () => {
		for (const field of ['id', 'name', 'locationUsageDescription']) {
			expect(() => createApplication({
				id: 'com.example.test',
				name: 'Test',
				locationUsageDescription: 'Test location.',
				[field]: '',
			})).toThrow(TypeError);
		}
	});

	test('rejects with TypeError on an invalid maximumAge', async () => {
		await expect(getCurrentPosition({ maximumAge: -1 })).rejects.toThrow(TypeError);
		await expect(getCurrentPosition({ maximumAge: Number.NaN })).rejects.toThrow(TypeError);
	});

	test('rejects with AbortError on a pre-aborted signal', async () => {
		if (process.platform !== 'darwin') {
			skip('Requires macOS');
		}
		const controller = new AbortController();
		controller.abort();
		await expect(getCurrentPosition({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
	});

	for (const suppliedSignal of [false, true]) {
		test(`${suppliedSignal ? 'caller signal replaces' : 'omitted signal uses'} the default location deadline`, async () => {
			if (process.platform !== 'darwin') {
				skip('Requires macOS');
			}
			await using fixture = await createLocationFixture(`
				setTimeout(() => console.log(JSON.stringify({
					ok: true, latitude: 1, longitude: 2, accuracy: 3, timestamp: 4,
				})), 150);
			`);
			// Accelerate only the default deadline in this isolated process. A supplied signal
			// must let the delayed fixture succeed; a hidden competing deadline would cancel it.
			const { stdout } = await spawnProcess(process.execPath, ['--input-type=module', '-e', `
				const timeout = AbortSignal.timeout;
				let defaultSignal;
				AbortSignal.timeout = (milliseconds) => {
					if (milliseconds !== 30000) throw new Error('Unexpected default deadline');
					defaultSignal = timeout(20);
					return defaultSignal;
				};
				const { getCurrentPosition } = await import(${JSON.stringify(pathToFileURL(fixture.getPath('src/index.ts')).href)});
				const controller = new AbortController();
				try {
					const position = await getCurrentPosition(${suppliedSignal ? '{ signal: controller.signal }' : ''});
					console.log(JSON.stringify({ position }));
				} catch (error) {
					console.log(JSON.stringify({ name: error.name, sameReason: error === defaultSignal?.reason }));
				}
			`], { env: { HOME: fixture.getPath('home') } });
			expect(JSON.parse(stdout)).toStrictEqual(suppliedSignal
				? {
					position: {
						latitude: 1,
						longitude: 2,
						accuracy: 3,
						timestamp: 4,
					},
				}
				: {
					name: 'TimeoutError',
					sameReason: true,
				});
		});
	}

	for (const operation of ['getCurrentPosition', 'updateMeta']) {
		for (const suppliedSignal of [false, true]) {
			test(`${operation} preserves the ${suppliedSignal ? 'caller' : 'default timeout'} reason during preparation without launching`, async () => {
				if (process.platform !== 'darwin') {
					skip('Requires macOS kernel locks');
				}
				await using fixture = await createLocationFixture(`
					import { writeFileSync } from 'node:fs';
					writeFileSync(process.env.LAUNCH_MARKER, 'launched');
				`);
				const { stdout } = await spawnProcess(process.execPath, ['--input-type=module', '-e', `
					import { createHash } from 'node:crypto';
					import { mkdir } from 'node:fs/promises';
					import path from 'node:path';
					const timeout = AbortSignal.timeout;
					let defaultSignal;
					AbortSignal.timeout = (milliseconds) => {
						if (milliseconds !== 30000) throw new Error('Unexpected default deadline');
						defaultSignal = timeout(20);
						return defaultSignal;
					};
					const { createApplication } = await import(${JSON.stringify(pathToFileURL(fixture.getPath('src/index.ts')).href)});
					const { acquirePreparationLock, applicationStorageRoot } = await import(${JSON.stringify(pathToFileURL(fixture.getPath('src/application.ts')).href)});
					const application = { id: 'com.example.cancellation', name: 'Test', locationUsageDescription: 'Test preparation.' };
					const app = createApplication(application);
					const idHash = createHash('sha256').update(application.id).digest('hex').slice(0, 32);
					const directory = path.join(applicationStorageRoot, idHash);
					await mkdir(directory, { recursive: true });
					const release = await acquirePreparationLock(path.join(directory, 'prepare.lock'));
					const controller = new AbortController();
					const timer = setTimeout(() => controller.abort({ source: 'caller' }), 100);
					try {
						await app.${operation}(${operation === 'updateMeta' ? '{}, ' : ''}${suppliedSignal ? '{ signal: controller.signal }' : '{}'});
						throw new Error('Unexpected success');
					} catch (error) {
						const signal = ${suppliedSignal ? 'controller.signal' : 'defaultSignal'};
						console.log(JSON.stringify({ sameReason: error === signal.reason, reason: error.name ?? error.source }));
					} finally {
						clearTimeout(timer);
						await release();
					}
				`], {
					env: {
						HOME: fixture.getPath('home'),
						LAUNCH_MARKER: fixture.getPath('launched'),
					},
				});
				expect(JSON.parse(stdout)).toStrictEqual({
					sameReason: true,
					reason: suppliedSignal ? 'caller' : 'TimeoutError',
				});
				expect(await fixture.exists('launched')).toBe(false);
			});
		}
	}

	test('uses the caller signal after preparing an application and reaps its helper', async () => {
		if (process.platform !== 'darwin') {
			skip('Requires macOS preparation');
		}
		await using fixture = await createLocationFixture(`
			import { writeFileSync } from 'node:fs';
			writeFileSync(process.env.LAUNCH_MARKER, String(process.pid));
			process.stdin.resume();
			process.stdin.on('end', () => process.exit());
			setInterval(() => {}, 1000);
		`);
		const { stdout } = await spawnProcess(process.execPath, ['--input-type=module', '-e', `
			import { readFile } from 'node:fs/promises';
			import { setTimeout as delay } from 'node:timers/promises';
			const { createApplication } = await import(${JSON.stringify(pathToFileURL(fixture.getPath('src/index.ts')).href)});
			const controller = new AbortController();
			const reason = { source: 'caller after preparation' };
			const app = createApplication({ id: 'com.example.cancellation', name: 'Test', locationUsageDescription: 'Test cancellation.' });
			const request = app.getCurrentPosition({
				signal: controller.signal,
			}).then(() => null, error => error);
			let pid;
			try {
				for (let attempt = 0; attempt < 200; attempt += 1) {
					const contents = await readFile(process.env.LAUNCH_MARKER, 'utf8').catch(() => null);
					if (contents !== null) { pid = Number(contents); break; }
					await delay(20);
				}
				if (pid === undefined) throw new Error('Helper did not launch');
			} finally {
				controller.abort(reason);
			}
			const error = await request;
			let helperExited = false;
			try { process.kill(pid, 0); } catch { helperExited = true; }
			console.log(JSON.stringify({ sameReason: error === reason, helperExited }));
		`], {
			env: {
				HOME: fixture.getPath('home'),
				LAUNCH_MARKER: fixture.getPath('launched'),
			},
		});
		expect(JSON.parse(stdout)).toStrictEqual({
			sameReason: true,
			helperExited: true,
		});
	});

	test('copies icons and prepares replacements and removal without launching location', async () => {
		if (process.platform !== 'darwin') {
			skip('Requires macOS preparation');
		}
		await using fixture = await createLocationFixture(String.raw`
			import { appendFileSync, existsSync, readFileSync } from 'node:fs';
			import { execFileSync } from 'node:child_process';
			import path from 'node:path';
			const contents = path.join(import.meta.dirname, '..');
			const icon = path.join(contents, 'Resources', 'application.icns');
			const field = !existsSync(icon) ? '' : execFileSync('plutil', ['-extract', 'CFBundleIconFile', 'raw', path.join(contents, 'Info.plist')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
			appendFileSync(process.env.LAUNCH_MARKER, JSON.stringify({ executable: import.meta.filename, icon: existsSync(icon) ? readFileSync(icon).toString('hex') : null, field: field.trim() }) + '\n');
			console.log(JSON.stringify({ ok: true, latitude: 1, longitude: 2, accuracy: 3, timestamp: 4 }));
		`);
		await spawnProcess(process.execPath, ['--input-type=module', '-e', String.raw`
			import assert from 'node:assert/strict';
			import { readFile } from 'node:fs/promises';
			const { createApplication } = await import(${JSON.stringify(pathToFileURL(fixture.getPath('src/index.ts')).href)});
			const icon = Buffer.from('icns0001');
			const app = createApplication({ id: 'com.example.icons', name: 'Icons', locationUsageDescription: 'Test icons.', icon });
			icon.fill(0);
			const launches = async () => (await readFile(process.env.LAUNCH_MARKER, 'utf8')).trim().split('\n').map(JSON.parse);
			await app.getCurrentPosition();
			await app.updateMeta({});
			await app.getCurrentPosition();
			let records = await launches();
			assert.equal(records[0].icon, Buffer.from('icns0001').toString('hex'));
			assert.equal(records[0].field, 'application.icns');
			assert.deepEqual(records[0], records[1]);
			const replacement = new Uint8Array(Buffer.from('icns0002'));
			const update = app.updateMeta({ icon: replacement });
			replacement.fill(0);
			await update;
			assert.equal((await launches()).length, 2);
			await assert.rejects(app.updateMeta({ name: '', icon: Buffer.from('bad') }), TypeError);
			const reason = { source: 'icon cancellation' };
			await assert.rejects(app.updateMeta({ icon: Buffer.from('canceled') }, { signal: AbortSignal.abort(reason) }), error => error === reason);
			await app.getCurrentPosition();
			records = await launches();
			assert.equal(records[2].icon, Buffer.from('icns0002').toString('hex'));
			assert.notEqual(records[0].executable, records[2].executable);
			await app.updateMeta({ icon: null });
			assert.equal((await launches()).length, 3);
			await app.getCurrentPosition();
			records = await launches();
			assert.equal(records[3].icon, null);
			assert.equal(records[3].field, '');
		`], {
			env: {
				HOME: fixture.getPath('home'),
				LAUNCH_MARKER: fixture.getPath('launched'),
			},
		});
	});

	test('captures identity lazily and updates metadata without launching location', async () => {
		if (process.platform !== 'darwin') {
			skip('Requires macOS preparation');
		}
		await using fixture = await createLocationFixture(String.raw`
			import { execFileSync } from 'node:child_process';
			import { appendFileSync } from 'node:fs';
			import path from 'node:path';
			const plist = path.join(import.meta.dirname, '..', 'Info.plist');
			const name = execFileSync('plutil', ['-extract', 'CFBundleName', 'raw', plist], { encoding: 'utf8' }).trim();
			appendFileSync(process.env.LAUNCH_MARKER, name + '\n');
			console.log(JSON.stringify({ ok: true, latitude: 1, longitude: 2, accuracy: 3, timestamp: 4 }));
		`);
		const { stdout } = await spawnProcess(process.execPath, ['--input-type=module', '-e', String.raw`
			import assert from 'node:assert/strict';
			import { existsSync } from 'node:fs';
			import { readFile, readdir } from 'node:fs/promises';
			import path from 'node:path';
			import { execFileSync } from 'node:child_process';
			const { createApplication } = await import(${JSON.stringify(pathToFileURL(fixture.getPath('src/index.ts')).href)});
			const { applicationStorageRoot, acquirePreparationLock } = await import(${JSON.stringify(pathToFileURL(fixture.getPath('src/application.ts')).href)});
			const input = { id: 'com.example.factory', name: 'Original', locationUsageDescription: 'Original purpose.' };
			const app = createApplication(input);
			input.id = 'com.example.mutated';
			input.name = 'Mutated';
			assert.equal(existsSync(applicationStorageRoot), false);
			await app.getCurrentPosition();
			const before = await readFile(process.env.LAUNCH_MARKER, 'utf8');
			const reason = { source: 'canceled update' };
			await assert.rejects(app.updateMeta({ name: 'Failed' }, { signal: AbortSignal.abort(reason) }), error => error === reason);
			await assert.rejects(app.updateMeta({ name: '' }), TypeError);
			const [directory] = await readdir(applicationStorageRoot);
			const release = await acquirePreparationLock(path.join(applicationStorageRoot, directory, 'prepare.lock'));
			try {
				const signal = AbortSignal.timeout(40);
				await assert.rejects(app.updateMeta({ name: 'Canceled while waiting' }, { signal }), error => error === signal.reason);
			} finally {
				await release();
			}
			await app.getCurrentPosition();
			assert.equal(await readFile(process.env.LAUNCH_MARKER, 'utf8'), before + 'Original\n');
			// Start a request before an update. Its metadata is captured even if preparation
			// and signing overlap with the update.
			const launchesBeforeUpdate = await readFile(process.env.LAUNCH_MARKER, 'utf8');
			const pending = app.getCurrentPosition();
			await app.updateMeta({ id: 'com.example.rejected-id', name: 'Updated' });
			await pending;
			assert.equal(await readFile(process.env.LAUNCH_MARKER, 'utf8'), launchesBeforeUpdate + 'Original\n');
			const apps = path.join(applicationStorageRoot, directory, 'apps');
			const bundles = await readdir(apps);
			const metadata = bundles.map(bundle => {
				const plist = path.join(apps, bundle, 'mac-location.app', 'Contents', 'Info.plist');
				const field = key => execFileSync('plutil', ['-extract', key, 'raw', plist], { encoding: 'utf8' }).trim();
				return { id: field('CFBundleIdentifier'), name: field('CFBundleName'), purpose: field('NSLocationUsageDescription') };
			});
			assert.deepEqual(metadata.sort((a, b) => a.name < b.name ? -1 : 1), [
				{ id: 'com.example.factory', name: 'Original', purpose: 'Original purpose.' },
				{ id: 'com.example.factory', name: 'Updated', purpose: 'Original purpose.' },
			]);
			await app.updateMeta({ locationUsageDescription: 'Updated purpose.' });
			assert.equal(await readFile(process.env.LAUNCH_MARKER, 'utf8'), launchesBeforeUpdate + 'Original\n');
			await app.getCurrentPosition();
			const other = createApplication({ id: 'com.example.factory', name: 'Original', locationUsageDescription: 'Original purpose.' });
			await other.getCurrentPosition();
			await app.getCurrentPosition();
			console.log(JSON.stringify((await readFile(process.env.LAUNCH_MARKER, 'utf8')).trim().split('\n')));
		`], {
			env: {
				HOME: fixture.getPath('home'),
				LAUNCH_MARKER: fixture.getPath('launched'),
			},
		});
		expect(JSON.parse(stdout)).toStrictEqual(['Original', 'Original', 'Original', 'Updated', 'Original', 'Updated']);
	});

	test('serializes partial metadata updates and skips canceled or failed patches', async () => {
		if (process.platform !== 'darwin') {
			skip('Requires macOS preparation');
		}
		await using fixture = await createLocationFixture(String.raw`
			import { execFileSync } from 'node:child_process';
			import path from 'node:path';
			const plist = path.join(import.meta.dirname, '..', 'Info.plist');
			const field = key => execFileSync('plutil', ['-extract', key, 'raw', plist], { encoding: 'utf8' }).trim();
			console.log(JSON.stringify({ ok: true,
				latitude: field('CFBundleName').length,
				longitude: field('NSLocationUsageDescription').length,
				accuracy: 3, timestamp: 4,
			}));
		`);
		const { stdout } = await spawnProcess(process.execPath, ['--input-type=module', '-e', `
			import assert from 'node:assert/strict';
			import { readdir } from 'node:fs/promises';
			import path from 'node:path';
			import { setTimeout as delay } from 'node:timers/promises';
			const { createApplication } = await import(${JSON.stringify(pathToFileURL(fixture.getPath('src/index.ts')).href)});
			const { applicationStorageRoot, acquirePreparationLock } = await import(${JSON.stringify(pathToFileURL(fixture.getPath('src/application.ts')).href)});
			const app = createApplication({ id: 'com.example.concurrent', name: 'Weather', locationUsageDescription: 'Show the local forecast.' });
			await Promise.all([
				app.updateMeta({ name: 'Weather Station' }),
				app.updateMeta({ locationUsageDescription: 'Show nearby stations.' }),
			]);
			const partial = await app.getCurrentPosition();
			const [directory] = await readdir(applicationStorageRoot);
			const release = await acquirePreparationLock(path.join(applicationStorageRoot, directory, 'prepare.lock'));
			const first = app.updateMeta({ name: 'New' });
			const controller = new AbortController();
			const reason = { source: 'cancel queued update' };
			const canceled = app.updateMeta({ name: 'Skipped' }, { signal: controller.signal }).then(() => null, error => error);
			const last = app.updateMeta({ locationUsageDescription: 'Final purpose.' });
			try {
				controller.abort(reason);
				// The earlier update is still blocked: cancellation must reject without waiting
				// for it, and the later update must retain its place after that earlier update.
				assert.equal(await Promise.race([canceled, delay(500).then(() => 'still waiting')]), reason);
			} finally {
				await release();
				await Promise.all([first, last]);
			}
			const afterCancel = await app.getCurrentPosition();
			const failed = app.updateMeta({ name: '' }).then(() => null, error => error);
			const succeeding = app.updateMeta({ name: 'Recovered' });
			assert.ok(await failed instanceof TypeError);
			await succeeding;
			const afterFailure = await app.getCurrentPosition();
			console.log(JSON.stringify({ partial, afterCancel, afterFailure }));
		`], { env: { HOME: fixture.getPath('home') } });
		expect(JSON.parse(stdout)).toStrictEqual({
			partial: {
				latitude: 'Weather Station'.length,
				longitude: 'Show nearby stations.'.length,
				accuracy: 3,
				timestamp: 4,
			},
			afterCancel: {
				latitude: 'New'.length,
				longitude: 'Final purpose.'.length,
				accuracy: 3,
				timestamp: 4,
			},
			afterFailure: {
				latitude: 'Recovered'.length,
				longitude: 'Final purpose.'.length,
				accuracy: 3,
				timestamp: 4,
			},
		});
	});

	test('resolves a valid position against the real helper', async () => {
		if (process.platform !== 'darwin') {
			skip('Requires macOS');
		}
		if (!process.env.MAC_LOCATION_LIVE) {
			skip('Set MAC_LOCATION_LIVE=1 to run the live location test');
		}
		if (!existsSync(helperExecutable)) {
			skip('Native helper not built (run `pnpm build`)');
		}

		const position = await getCurrentPosition({ signal: AbortSignal.timeout(15_000) });

		expect(position.latitude).toBeGreaterThanOrEqual(-90);
		expect(position.latitude).toBeLessThanOrEqual(90);
		expect(position.longitude).toBeGreaterThanOrEqual(-180);
		expect(position.longitude).toBeLessThanOrEqual(180);
		expect(position.accuracy).toBeGreaterThanOrEqual(0);
		expect(Number.isFinite(position.timestamp)).toBe(true);
	});

	test('rejects unsupported platforms before preparation', async () => {
		const moduleUrl = new URL('../../src/index.ts', import.meta.url).href;
		// Run in a child so faking process.platform cannot affect concurrent tests. HOME points
		// at a temp directory so a regression cannot touch the real storage root.
		const script = `
			Object.defineProperty(process, 'platform', { value: 'linux' });
			const { createApplication, getCurrentPosition, LocationError, isSupported } = await import(${JSON.stringify(moduleUrl)});
			const application = { id: 'com.example.app', name: 'App', locationUsageDescription: 'Why.' };
			const app = createApplication(application);
			if (isSupported !== false) throw new Error('Unexpected supported platform');
			const capture = async (call) => {
				try {
					await call();
					return 'resolved';
				} catch (error) {
					return error instanceof LocationError ? error.code : 'raw';
				}
			};
			process.stdout.write([
				await capture(() => getCurrentPosition()),
				await capture(() => app.getCurrentPosition()),
				await capture(() => app.updateMeta({ name: 'Updated' })),
			].join(','));
		`;
		await using home = await createFixture({});
		const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
			env: {
				...process.env,
				HOME: home.path,
			},
			stdio: ['ignore', 'pipe', 'inherit'],
		});
		let stdout = '';
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			stdout += chunk;
		});
		const [exitCode] = await once(child, 'close') as [number | null];

		expect(exitCode).toBe(0);
		expect(stdout).toBe('UNSUPPORTED_PLATFORM,UNSUPPORTED_PLATFORM,UNSUPPORTED_PLATFORM');
	});
});
