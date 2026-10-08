import path from 'node:path';
import { cli } from 'cleye';
import { createApplication, getCurrentPosition, LocationError } from '../src/index.ts';
import {
	captureEnvironment, printTable, summarize, writeReport, type ReportRow,
} from './utils/benchmark.ts';

/**
 * End-to-end benchmark (opt-in): compares a generic request with an application-specific
 * request through the public API. It launches the helper and triggers permission dialogs, so
 * it only runs with `--live` and after the operator has approved the generic helper and the
 * benchmark application identity.
 *
 * Both identities must return a successful preflight fix before steady-state sampling.
 * Setup/update duration is reported separately; cold preparation uses the isolated
 * preparation benchmark. Coordinates are never recorded: success, accuracy, and
 * location age are enough to interpret the results.
 */

const projectDirectory = path.resolve(import.meta.dirname, '..');
const helperExecutable = path.join(projectDirectory, 'dist-native', 'mac-location.app', 'Contents', 'MacOS', 'mac-location');

const application = {
	id: 'com.privatenumber.mac-location.benchmark',
	name: 'Mac Location Benchmark',
	locationUsageDescription: 'Benchmark application requests.',
};
const app = createApplication(application);

const { flags } = cli({
	name: 'benchmark-end-to-end',
	strictFlags: true,
	help: { description: 'Compare generic and application location requests (opt-in)' },
	flags: {
		live: {
			type: Boolean,
			default: false,
			description: 'Run location requests after approving both identities',
		},
		samples: {
			type: Number,
			default: 10,
			description: 'Measured requests per identity and scenario',
		},
		timeout: {
			type: Number,
			default: 30_000,
			description: 'Request timeout in milliseconds',
		},
		out: {
			type: String,
			default: path.join(import.meta.dirname, 'results', 'end-to-end.json'),
			description: 'JSON report path',
		},
	},
});

if (!flags.live) {
	console.log('The end-to-end benchmark is opt-in because it prompts for location access.');
	console.log('Approve the generic helper and the benchmark application identity, then re-run with --live.');
}

const { timeout } = flags;
const sampleCount = flags.samples;
const scenarios = [
	{
		name: 'cached-location-allowed',
		maximumAge: 60_000,
	},
	{
		name: 'fresh-location-required',
		maximumAge: 0,
	},
];

type Outcome = {
	variant: 'generic' | 'application';
	ok: boolean;
	elapsedMs: number;
	accuracy?: number;
	ageMs?: number;
	code?: string;
};

const request = async (variant: 'generic' | 'application', maximumAge: number): Promise<Outcome> => {
	const options = {
		signal: AbortSignal.timeout(timeout),
		maximumAge,
	};
	const startedAt = performance.now();
	try {
		const position = await (variant === 'generic'
			? getCurrentPosition(options)
			: app.getCurrentPosition(options));
		return {
			variant,
			ok: true,
			elapsedMs: performance.now() - startedAt,
			accuracy: position.accuracy,
			ageMs: Date.now() - position.timestamp,
		};
	} catch (error) {
		return {
			variant,
			ok: false,
			elapsedMs: performance.now() - startedAt,
			code: error instanceof LocationError ? error.code : (error instanceof Error ? error.name : 'UNKNOWN'),
		};
	}
};

const collect = (outcomes: Outcome[]) => {
	const successes = outcomes.filter(outcome => outcome.ok);
	const failuresByCode: Record<string, number> = {};
	for (const outcome of outcomes) {
		if (!outcome.ok) {
			const code = outcome.code ?? 'UNKNOWN';
			failuresByCode[code] = (failuresByCode[code] ?? 0) + 1;
		}
	}
	return {
		samples: outcomes.length,
		successes: successes.length,
		failures: failuresByCode,
		latency: summarize(successes.map(outcome => outcome.elapsedMs)),
		accuracyMeters: successes.length === 0 ? null : successes.map(outcome => outcome.accuracy),
		locationAgeMs: successes.length === 0 ? null : successes.map(outcome => outcome.ageMs),
	};
};

const environment = await captureEnvironment(helperExecutable);
if (flags.live) {
	await (async () => {
		// Updating can reuse a retained bundle, so this is setup, not a cold-start measurement.
		const setupStartedAt = performance.now();
		await app.updateMeta({}, { signal: AbortSignal.timeout(timeout) });
		const setupUpdateMs = Math.round((performance.now() - setupStartedAt) * 10) / 10;

		// Permission dialogs belong to preflight. A failure cannot establish authorization.
		const preflight = {
			generic: await request('generic', 0),
			application: await request('application', 0),
		};

		const results: Record<string, { generic: ReturnType<typeof collect>;
			application: ReturnType<typeof collect>; }> = {};
		const report = {
			benchmark: 'end-to-end',
			environment,
			parameters: {
				samples: sampleCount,
				timeout,
				scenarios,
			},
			setupUpdateMs,
			preflight,
			results,
		};
		const failedPreflight = Object.values(preflight).filter(outcome => !outcome.ok);
		if (failedPreflight.length > 0) {
			const reason = failedPreflight.map(outcome => `${outcome.variant}: ${outcome.code}`).join(', ');
			await writeReport(flags.out, {
				...report,
				skipped: `Preflight failed (${reason}); no steady-state samples collected.`,
			});
			console.error(`Preflight failed (${reason}). Resolve access or location availability before retrying.`);
			console.log(`Report: ${path.relative(projectDirectory, flags.out)}`);
			process.exitCode = 1;
			return;
		}

		const rows: ReportRow[] = [];
		for (const scenario of scenarios) {
			const outcomes: Record<'generic' | 'application', Outcome[]> = {
				generic: [],
				application: [],
			};
			for (let index = 0; index < sampleCount; index += 1) {
				// Alternate order so a warming cache does not favor one variant.
				const order: Array<'generic' | 'application'> = index % 2 === 0
					? ['generic', 'application']
					: ['application', 'generic'];
				for (const variant of order) {
					outcomes[variant].push(await request(variant, scenario.maximumAge));
				}
			}

			const generic = collect(outcomes.generic);
			const applicationResult = collect(outcomes.application);
			results[scenario.name] = {
				generic,
				application: applicationResult,
			};
			for (const [variant, result] of [['generic', generic], ['application', applicationResult]] as const) {
				rows.push({
					operation: `${scenario.name} — ${variant}`,
					note: `${result.successes}/${result.samples} succeeded`,
					interval: result.successes === 0 ? null : result.latency,
					failures: result.samples - result.successes,
				});
			}
		}

		await writeReport(flags.out, report);
		printTable('End-to-end (ms; successful fixes only)', rows);
		console.log(`\nApplication setup/update: ${report.setupUpdateMs} ms (may reuse a prepared bundle; excludes permission dialogs)`);
		console.log('Environment:', JSON.stringify(environment));
		console.log(`Report: ${path.relative(projectDirectory, flags.out)}`);
	})();
} else {
	await writeReport(flags.out, {
		benchmark: 'end-to-end',
		skipped: 'Pass --live to run; it prompts for location access.',
		environment,
	});
	console.log(`Report: ${path.relative(projectDirectory, flags.out)}`);
}
