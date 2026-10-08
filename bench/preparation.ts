import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cli } from 'cleye';
import { resolveApplicationExecutable } from '../src/application.ts';
import {
	captureEnvironment,
	printTable,
	summarize,
	writeReport,
	type ReportRow,
} from './utils/benchmark.ts';
import { measurePreparation } from './utils/preparation.ts';

/**
 * Preparation benchmark: the incremental cost of the `application` option, measured through
 * the production preparation functions with an isolated storage root. It never launches the
 * location helper, so it does not prompt, read location, or create Location Services entries.
 *
 * Run `pnpm build` first so the precompiled helper exists. Cold samples use an unprepared
 * storage root, not an emptied OS filesystem cache; system caches are never flushed.
 */

const projectDirectory = path.resolve(import.meta.dirname, '..');
const sourceBundle = path.join(projectDirectory, 'dist-native', 'mac-location.app');
const helperExecutable = path.join(sourceBundle, 'Contents', 'MacOS', 'mac-location');
const applicationModuleUrl = new URL('../src/application.ts', import.meta.url).href;

const applicationA = {
	id: 'com.privatenumber.mac-location.benchmark',
	name: 'Mac Location Benchmark',
	locationUsageDescription: 'Benchmark application preparation.',
};
const applicationB = {
	...applicationA,
	locationUsageDescription: 'Benchmark application update.',
};

const { flags } = cli({
	name: 'benchmark-preparation',
	strictFlags: true,
	help: { description: 'Measure helper preparation and reuse without requesting location' },
	flags: {
		cold: {
			type: Number,
			default: 20,
			description: 'Number of cold preparation and update samples',
		},
		warm: {
			type: Number,
			default: 100,
			description: 'Number of warm reuse samples',
		},
		iterations: {
			type: Number,
			default: 10,
			description: 'Requests per concurrent worker',
		},
		out: {
			type: String,
			default: path.join(import.meta.dirname, 'results', 'preparation.json'),
			description: 'JSON report path',
		},
	},
});
const coldSamples = flags.cold;
const warmSamples = flags.warm;
const concurrentIterations = flags.iterations;

try {
	await stat(helperExecutable);
} catch {
	throw new Error(`The helper is not built: ${helperExecutable}. Run \`pnpm build\` first.`);
}

const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'mac-location-benchmark-'));
const optionsFor = (storage: string) => ({
	sourceBundle,
	storageRoot: storage,
});
const rows: ReportRow[] = [];

try {
	// Cold preparation: a fresh, unprepared storage root per sample.
	let coldIndex = 0;
	const cold = await measurePreparation(
		() => {
			coldIndex += 1;
			return path.join(storageRoot, `cold-${coldIndex}`);
		},
		storage => resolveApplicationExecutable(applicationA, optionsFor(storage)),
		{ samples: coldSamples },
	);

	// Warm reuse: a matching bundle already exists.
	const warmStorage = path.join(storageRoot, 'warm');
	await resolveApplicationExecutable(applicationA, optionsFor(warmStorage));
	const warm = await measurePreparation(
		() => warmStorage,
		storage => resolveApplicationExecutable(applicationA, optionsFor(storage)),
		{
			samples: warmSamples,
			warmup: 5,
		},
	);

	// Changed metadata: an existing application with a bundle that is not prepared yet.
	let updateIndex = 0;
	const explicitUpdate = await measurePreparation(
		async () => {
			updateIndex += 1;
			const storage = path.join(storageRoot, `update-${updateIndex}`);
			await resolveApplicationExecutable(applicationA, optionsFor(storage));
			return storage;
		},
		storage => resolveApplicationExecutable(applicationB, optionsFor(storage)),
		{ samples: coldSamples },
	);

	// Return to a retained version: A -> B -> A, verifying and reusing each matching bundle.
	const retainedStorage = path.join(storageRoot, 'retained');
	await resolveApplicationExecutable(applicationA, optionsFor(retainedStorage));
	await resolveApplicationExecutable(applicationB, optionsFor(retainedStorage));
	let retainedNext = applicationA;
	const retained = await measurePreparation(
		() => {
			retainedNext = retainedNext === applicationA ? applicationB : applicationA;
			return retainedNext;
		},
		identity => resolveApplicationExecutable(identity, optionsFor(retainedStorage)),
		{
			samples: warmSamples,
			warmup: 5,
		},
	);

	// Concurrent warm reuse: independent Node processes sharing one prepared identity.
	const workerScript = `
		const { resolveApplicationExecutable } = await import(${JSON.stringify(applicationModuleUrl)});
		const application = ${JSON.stringify(applicationA)};
		const options = { sourceBundle: ${JSON.stringify(sourceBundle)}, storageRoot: ${JSON.stringify(warmStorage)} };
		const latencies = [];
		const startedAt = performance.now();
		for (let index = 0; index < ${concurrentIterations}; index += 1) {
			const start = performance.now();
			await resolveApplicationExecutable(application, options);
			latencies.push(performance.now() - start);
		}
		process.stdout.write(JSON.stringify({ wallMs: performance.now() - startedAt, latencies }));
	`;
	const runWorker = async () => {
		const child = spawn(process.execPath, ['--input-type=module', '-e', workerScript], {
			stdio: ['ignore', 'pipe', 'inherit'],
		});
		let stdout = '';
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			stdout += chunk;
		});
		const [exitCode] = await once(child, 'close') as [number | null];
		if (exitCode !== 0) {
			throw new Error(`A concurrent worker exited with code ${exitCode}`);
		}
		return JSON.parse(stdout) as { wallMs: number;
			latencies: number[]; };
	};

	const concurrent: Record<string, { perRequest: ReturnType<typeof summarize>;
		totalCompletionMs: number; }> = {};
	for (const processes of [2, 8]) {
		const startedAt = performance.now();
		const workers = await Promise.all(Array.from({ length: processes }, runWorker));
		concurrent[processes] = {
			perRequest: summarize(workers.flatMap(worker => worker.latencies)),
			totalCompletionMs: Math.round((performance.now() - startedAt) * 10) / 10,
		};
	}

	rows.push(
		{
			operation: 'Cold preparation',
			note: `discarded warm-up calls ${cold.warmup.attempts}`,
			interval: summarize(cold.samples),
			failures: cold.failures,
		},
		{
			operation: 'Warm reuse',
			note: `warm-up failures ${warm.warmup.failures}/${warm.warmup.attempts}`,
			interval: summarize(warm.samples),
			failures: warm.failures,
		},
		{
			operation: 'Explicit update (new bundle)',
			note: `discarded warm-up calls ${explicitUpdate.warmup.attempts}`,
			interval: summarize(explicitUpdate.samples),
			failures: explicitUpdate.failures,
		},
		{
			operation: 'Return to retained version',
			note: `warm-up failures ${retained.warmup.failures}/${retained.warmup.attempts}`,
			interval: summarize(retained.samples),
			failures: retained.failures,
		},
	);
	for (const processes of [2, 8]) {
		rows.push({
			operation: `Concurrent warm reuse, ${processes} processes`,
			note: `per-request latency; total ${concurrent[processes].totalCompletionMs} ms for ${processes * concurrentIterations} requests`,
			interval: concurrent[processes].perRequest,
			failures: 0,
		});
	}

	const environment = await captureEnvironment(helperExecutable);
	const report = {
		benchmark: 'application-preparation',
		timing: {
			engine: 'mitata',
			version: '1.0.34',
			batching: false,
			failurePolicy: 'stop',
		},
		environment,
		parameters: {
			coldSamples,
			warmSamples,
			concurrentIterations,
		},
		scenarios: {
			cold: {
				warmup: cold.warmup,
				interval: summarize(cold.samples),
				failures: cold.failures,
			},
			warm: {
				interval: summarize(warm.samples),
				failures: warm.failures,
				warmup: warm.warmup,
			},
			explicitUpdate: {
				warmup: explicitUpdate.warmup,
				interval: summarize(explicitUpdate.samples),
				failures: explicitUpdate.failures,
			},
			returnToRetained: {
				interval: summarize(retained.samples),
				failures: retained.failures,
				warmup: retained.warmup,
			},
			concurrent,
		},
	};

	await writeReport(flags.out, report);
	printTable('Application preparation (ms; setup and cleanup excluded)', rows);
	console.log('\nEnvironment:', JSON.stringify(environment));
	console.log(`Report: ${path.relative(projectDirectory, flags.out)}`);
} finally {
	await rm(storageRoot, {
		recursive: true,
		force: true,
	});
}
