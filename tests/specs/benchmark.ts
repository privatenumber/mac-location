import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createFixture } from 'fs-fixture';
import spawn from 'nano-spawn';
import { describe, expect, test } from 'manten';
import { captureEnvironment, measure, run } from '../../bench/utils/benchmark.ts';
import { measurePreparation } from '../../bench/utils/preparation.ts';

describe('benchmark reporting', () => {
	test('Mitata bounds preparation calls and excludes fresh setup from timing', async () => {
		let setups = 0;
		const contexts: number[] = [];
		const startedAt = performance.now();
		const result = await measurePreparation(async () => {
			await delay(50);
			setups += 1;
			return setups;
		}, async (context) => {
			contexts.push(context);
		}, {
			samples: 3,
			warmup: 2,
		});
		const wallMs = performance.now() - startedAt;
		expect(contexts).toStrictEqual([1, 2, 3, 4, 5]);
		expect(result.samples).toHaveLength(3);
		expect(result.warmup).toStrictEqual({
			attempts: 2,
			failures: 0,
		});
		expect(result.samples.reduce((total, sample) => total + sample, 0)).toBeLessThan(wallMs / 2);
	});

	test('Mitata stops preparation on failure instead of reporting a successful latency', async () => {
		const reason = new Error('Preparation failed');
		let attempts = 0;
		await expect(measurePreparation(() => undefined, async () => {
			attempts += 1;
			if (attempts === 2) {
				throw reason;
			}
		}, { samples: 3 })).rejects.toBe(reason);
		expect(attempts).toBe(2);
	});
	test('counts warm-up failures separately from measured failures', async () => {
		let calls = 0;
		const measurement = await measure(async () => {
			calls += 1;
			if (calls === 1 || calls === 3) {
				throw new Error('Failed operation');
			}
		}, {
			samples: 2,
			warmup: 2,
		});

		expect(measurement.failures).toBe(1);
		expect(measurement.samples).toHaveLength(1);
		expect(measurement.warmup).toStrictEqual({
			attempts: 2,
			failures: 1,
		});
	});

	test('accepts probe output only after a successful exit', async () => {
		expect(await run(process.execPath, ['-e', 'console.log("metadata")'])).toBe('metadata');
		expect(await run(process.execPath, ['-e', 'console.log("invalid metadata"); process.exitCode = 1'])).toBeUndefined();
	});

	test('requires a readable helper artifact for its hash', async () => {
		await using fixture = await createFixture({ helper: 'test artifact' });
		const environment = await captureEnvironment(fixture.getPath('helper'));
		expect(environment.helperSha256).toBe(createHash('sha256').update('test artifact').digest('hex'));
		await expect(captureEnvironment(fixture.getPath('missing'))).rejects.toMatchObject({ code: 'ENOENT' });
	});

	for (const failedVariant of ['none', 'generic', 'application']) {
		test(`end-to-end report with ${failedVariant} preflight failure`, async () => {
			// Run the unchanged entry point against a fixture API. Only preflight can fail;
			// subsequent calls succeed, exposing any accidental entry into measured sampling.
			await using fixture = await createFixture({
				'package.json': JSON.stringify({ type: 'module' }),
				node_modules: ({ symlink }) => symlink(fileURLToPath(new URL('../../node_modules', import.meta.url))),
				'bench/end-to-end.ts': await readFile(new URL('../../bench/end-to-end.ts', import.meta.url)),
				'bench/utils/benchmark.ts': await readFile(new URL('../../bench/utils/benchmark.ts', import.meta.url)),
				'dist-native/mac-location.app/Contents/MacOS/mac-location': 'test artifact',
				'src/index.ts': String.raw`
					import { appendFileSync } from 'node:fs';
					const callsPath = new URL('../calls.txt', import.meta.url);
					const seen = new Set();
					export class LocationError extends Error {
						constructor(code) { super(code); this.code = code; }
					}
					const updateMeta = async (metadata, options) => {
						if (!(options.signal instanceof AbortSignal)) throw new Error('Missing update signal');
						appendFileSync(callsPath, 'update\n');
					};
					const request = async (variant, options) => {
						if (!(options.signal instanceof AbortSignal)) throw new Error('Missing request signal');
						appendFileSync(callsPath, variant + '\n');
						const first = !seen.has(variant);
						seen.add(variant);
						if (first && variant === process.env.FAIL_PREFLIGHT) {
							throw new DOMException('Benchmark deadline expired', 'TimeoutError');
						}
						return { accuracy: 42, timestamp: Date.now() };
					};
					export const getCurrentPosition = (options) => request('generic', options);
					export const createApplication = () => ({
						updateMeta,
						getCurrentPosition: (options) => request('application', options),
					});
				`,
			});
			const child = spawn(process.execPath, [fixture.getPath('bench/end-to-end.ts'), '--live', '--samples', '2'], {
				cwd: fixture.path,
				env: { FAIL_PREFLIGHT: failedVariant },
			});
			if (failedVariant === 'none') {
				await child;
			} else {
				await expect(child).rejects.toMatchObject({
					exitCode: 1,
					stderr: expect.stringContaining('TimeoutError'),
				});
			}

			const report = await fixture.readJson<{
				setupUpdateMs: number;
				preflight: Record<string, { ok: boolean;
					code?: string; }>;
				results: Record<string, Record<string, { samples: number;
					successes: number;
					failures: Record<string, number>;
					latency: { count: number }; }>>;
			}>('bench/results/end-to-end.json');
			expect(Number.isFinite(report.setupUpdateMs)).toBe(true);
			expect(report.preflight.generic.ok).toBe(failedVariant !== 'generic');
			expect(report.preflight.application.ok).toBe(failedVariant !== 'application');
			const callLog = await fixture.readFile('calls.txt', 'utf8');
			const calls = callLog.trim().split('\n');
			if (failedVariant === 'none') {
				expect(Object.keys(report.results)).toStrictEqual(['cached-location-allowed', 'fresh-location-required']);
				for (const scenario of Object.values(report.results)) {
					for (const result of Object.values(scenario)) {
						expect(result.samples).toBe(2);
						expect(result.successes).toBe(2);
						expect(result.failures).toStrictEqual({});
						expect(result.latency.count).toBe(2);
					}
				}
				expect(calls).toHaveLength(11);
			} else {
				expect(report.preflight[failedVariant].code).toBe('TimeoutError');
				expect(report.results).toStrictEqual({});
				expect(calls).toStrictEqual(['update', 'generic', 'application']);
			}
		});
	}
});
