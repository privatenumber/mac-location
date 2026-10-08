import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Timing and reporting helpers for the benchmark entry points. Measurements use
 * `performance.now()`, and setup and cleanup happen outside the measured interval.
 */

export type Interval = {
	count: number;
	median: number;
	p95: number;
	min: number;
	max: number;
};

/** Round to a tenth of a millisecond so output stays readable. */
export const round = (value: number) => Math.round(value * 10) / 10;

const percentile = (sorted: number[], quantile: number) => (
	sorted[Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1)]
);

export const summarize = (samples: number[]): Interval | null => {
	if (samples.length === 0) {
		return null;
	}
	const sorted = [...samples].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	const median = sorted.length % 2 === 0
		? (sorted[middle - 1] + sorted[middle]) / 2
		: sorted[middle];
	return {
		count: sorted.length,
		median: round(median),
		p95: round(percentile(sorted, 0.95)),
		min: round(sorted[0]),
		max: round(sorted.at(-1) as number),
	};
};

export type Measurement = {
	samples: number[];
	failures: number;
	warmup: {
		attempts: number;
		failures: number;
	};
};

/**
 * Run `operation` for `samples` iterations after an optional discarded warm-up, recording
 * `performance.now()` deltas. Only the operation is timed; `setup` and cleanup are not.
 */
export const measure = async (
	operation: () => Promise<void>,
	options: {
		samples: number;
		warmup?: number;
		setup?: () => Promise<void>;
	},
): Promise<Measurement> => {
	const warmup = {
		attempts: options.warmup ?? 0,
		failures: 0,
	};
	for (let index = 0; index < (options.warmup ?? 0); index += 1) {
		await options.setup?.();
		try {
			await operation();
		} catch {
			warmup.failures += 1;
		}
	}

	const samples: number[] = [];
	let failures = 0;
	for (let index = 0; index < options.samples; index += 1) {
		await options.setup?.();
		const startedAt = performance.now();
		try {
			await operation();
			samples.push(performance.now() - startedAt);
		} catch {
			failures += 1;
		}
	}

	return {
		samples,
		failures,
		warmup,
	};
};

/** Run a command and return its trimmed stdout, or `undefined` if it fails. */
export const run = async (command: string, arguments_: string[]): Promise<string | undefined> => {
	try {
		const child = spawn(command, arguments_, { stdio: ['ignore', 'pipe', 'ignore'] });
		let stdout = '';
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			stdout += chunk;
		});
		const [exitCode] = await once(child, 'close') as [number | null];
		return exitCode === 0 ? stdout.trim() : undefined;
	} catch {
		return undefined;
	}
};

export type Environment = {
	commit: string;
	macosVersion: string;
	macosBuild: string;
	architecture: string;
	nodeVersion: string;
	helperSha256: string;
};

export const captureEnvironment = async (helperExecutablePath: string): Promise<Environment> => {
	const [commit, macosVersion, macosBuild, helperContents] = await Promise.all([
		run('git', ['rev-parse', 'HEAD']),
		run('sw_vers', ['-productVersion']),
		run('sw_vers', ['-buildVersion']),
		readFile(helperExecutablePath),
	]);
	return {
		commit: commit ?? 'unknown',
		macosVersion: macosVersion ?? 'unknown',
		macosBuild: macosBuild ?? 'unknown',
		architecture: process.arch,
		nodeVersion: process.version,
		helperSha256: createHash('sha256').update(helperContents).digest('hex'),
	};
};

export type ReportRow = {
	operation: string;
	note?: string;
	interval: Interval | null;
	failures: number;
};

const formatInterval = (interval: Interval | null, failures: number) => (
	interval === null
		? `unavailable (failures ${failures})`
		: `median ${interval.median} ms  p95 ${interval.p95} ms  n=${interval.count}  failures ${failures}`
);

export const printTable = (title: string, rows: ReportRow[]) => {
	console.log(`\n${title}`);
	for (const row of rows) {
		const suffix = row.note === undefined ? '' : `  [${row.note}]`;
		console.log(`  ${row.operation}${suffix}: ${formatInterval(row.interval, row.failures)}`);
	}
};

export const writeReport = async (filePath: string, report: unknown) => {
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, `${JSON.stringify(report, null, '\t')}\n`);
};
