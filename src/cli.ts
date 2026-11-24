import { cli } from 'cleye';
import { getCurrentPosition } from './index.ts';

const argv = cli({
	name: 'mac-location',
	strictFlags: true,
	help: {
		description: 'Get the current location of the Mac',
		examples: [
			'mac-location',
			'mac-location --json',
		],
	},
	flags: {
		timeout: {
			type: Number,
			description: 'Milliseconds to wait for a location after permission is granted (default 30000)',
		},
		maximumAge: {
			type: Number,
			description: 'Accept a cached location no older than this many milliseconds (default 0)',
		},
		json: {
			type: Boolean,
			description: 'Output JSON',
		},
	},
});

try {
	const { timeout } = argv.flags;
	if (
		timeout !== undefined
		&& (!Number.isInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647)
	) {
		throw new TypeError(`Invalid "--timeout": ${timeout}. Expected a positive integer number of milliseconds (up to 2147483647).`);
	}
	const position = await getCurrentPosition({
		timeout,
		maximumAge: argv.flags.maximumAge,
		onPermissionRequest: () => {
			console.error('Waiting for location permission. Choose Allow in the macOS prompt, or press Ctrl-C to cancel.');
		},
	});

	if (argv.flags.json) {
		console.log(JSON.stringify(position, null, 2));
	} else {
		console.log(`${position.latitude},${position.longitude}`);
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
