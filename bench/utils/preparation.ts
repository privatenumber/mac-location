import { measure } from 'mitata';

/** Bound expensive OS operations and keep per-call setup outside Mitata's timed interval. */
export const measurePreparation = async <Context>(
	setup: () => Context | Promise<Context>,
	operation: (context: Context) => Promise<unknown>,
	options: { samples: number;
		warmup?: number; },
) => {
	const warmup = options.warmup ?? 1;
	if (
		!Number.isSafeInteger(options.samples) || options.samples < 1
		|| !Number.isSafeInteger(warmup) || warmup < 1
	) {
		throw new TypeError('Preparation sample and warm-up counts must be positive integers.');
	}
	const stats = await measure(function* () {
		yield {
			0: setup,
			bench: operation,
		};
	}, {
		min_samples: options.samples,
		max_samples: options.samples,
		min_cpu_time: 0,
		// Mitata performs one probe before these additional warm-up calls.
		warmup_samples: warmup - 1,
		warmup_threshold: Infinity,
		batch_threshold: 0,
		samples_threshold: Infinity,
		gc: false,
	});
	return {
		// Mitata reports nanoseconds; the existing OS-service reports use milliseconds.
		samples: stats.samples.map(sample => sample / 1e6),
		failures: 0,
		warmup: {
			attempts: warmup,
			failures: 0,
		},
	};
};
