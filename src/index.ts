import path from 'node:path';
import { addAbortListener } from 'node:events';
import { fileURLToPath } from 'node:url';
import { resolveApplicationExecutable } from './application.ts';
import { LocationError, type LocationErrorCode } from './errors.ts';
import { runHelper } from './helper.ts';
import type {
	Application, ApplicationIdentity, ApplicationMetadata, GetPositionOptions, Position,
} from './types.ts';

export { LocationError };
export type {
	ApplicationIdentity,
	Application,
	ApplicationMetadata,
	GetPositionOptions,
	LocationErrorCode,
	Position,
};

const HELPER_APP_NAME = 'mac-location.app';
const HELPER_EXECUTABLE_NAME = 'mac-location';

/**
 * The bundled native helper lives at the package root, next to the compiled
 * `dist/` and the source `src/`, so both development and published layouts
 * resolve it from the module's own directory.
 */
const helperBundlePath = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
	'dist-native',
	HELPER_APP_NAME,
);
const helperExecutablePath = path.join(helperBundlePath, 'Contents', 'MacOS', HELPER_EXECUTABLE_NAME);

export const isSupported = process.platform === 'darwin';

const requireSupported = () => {
	if (!isSupported) {
		throw new LocationError('UNSUPPORTED_PLATFORM', `mac-location only supports macOS (current platform: ${process.platform})`);
	}
};

const DEFAULT_TIMEOUT = 30_000;

const validateOptions = (options: GetPositionOptions) => {
	if (
		options.maximumAge !== undefined
		&& (!Number.isFinite(options.maximumAge) || options.maximumAge < 0)
	) {
		throw new TypeError(`Invalid "maximumAge": ${options.maximumAge}. Expected a non-negative number of milliseconds.`);
	}
};

const validateApplication = (application: ApplicationIdentity) => {
	const { id, name, locationUsageDescription } = application;
	if (id === '' || name === '' || locationUsageDescription === '') {
		throw new TypeError('Invalid "application": "id", "name", and "locationUsageDescription" must be non-empty.');
	}
};

const copyIcon = (icon: ApplicationIdentity['icon']) => {
	if (icon === undefined || icon === null) {
		return icon;
	}
	if (!(icon instanceof Uint8Array)) {
		throw new TypeError('Invalid "icon": expected .icns bytes as a Uint8Array or null.');
	}
	return new Uint8Array(icon);
};

const requestPosition = async (
	options: GetPositionOptions,
	application?: ApplicationIdentity,
): Promise<Position> => {
	validateOptions(options);
	requireSupported();

	const { maximumAge } = options;
	const signal = options.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT);
	signal.throwIfAborted();
	const executablePath = application === undefined
		? helperExecutablePath
		: await resolveApplicationExecutable(application, {
			sourceBundle: helperBundlePath,
			signal,
		});

	// A completed preparation can remain reusable, but cancellation must prevent launch.
	signal.throwIfAborted();

	return runHelper(executablePath, {
		maximumAge,
		signal,
	});
};

export const getCurrentPosition = (
	options: GetPositionOptions = {},
): Promise<Position> => requestPosition(options);

/** Stop waiting on cancellation and remove the abort listener when the wait ends. */
const waitForUpdate = async (previous: Promise<void>, signal: AbortSignal) => {
	const canceled = Promise.withResolvers<never>();
	const abortListener = addAbortListener(signal, () => canceled.reject(signal.reason));
	try {
		await Promise.race([previous, canceled.promise]);
		signal.throwIfAborted();
	} finally {
		abortListener[Symbol.dispose]();
	}
};

/** Capture an identity without preparing a helper or requesting location. */
export const createApplication = (application: ApplicationIdentity): Application => {
	validateApplication(application);
	let identity: ApplicationIdentity = {
		...application,
		icon: copyIcon(application.icon),
	};
	let pendingUpdate = Promise.resolve();
	return {
		getCurrentPosition: (options = {}) => requestPosition(options, identity),
		updateMeta: async (metadata, options = {}) => {
			// Capture the patch now, but apply it to the latest successful identity at our turn.
			const { name, locationUsageDescription } = metadata;
			const icon = copyIcon(metadata.icon);
			requireSupported();
			const signal = options.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT);
			signal.throwIfAborted();
			const previous = pendingUpdate;
			const completed = Promise.withResolvers<void>();
			// A canceled waiter must not let its successor bypass an earlier active update.
			pendingUpdate = previous.then(() => completed.promise);
			try {
				await waitForUpdate(previous, signal);
				const next: ApplicationIdentity = {
					id: identity.id,
					name: name ?? identity.name,
					locationUsageDescription: locationUsageDescription ?? identity.locationUsageDescription,
					icon: icon === undefined ? identity.icon : icon,
				};
				validateApplication(next);
				await resolveApplicationExecutable(next, {
					sourceBundle: helperBundlePath,
					signal,
				});
				signal.throwIfAborted();
				// Existing requests retain their identity; only successful updates adopt changes.
				identity = next;
			} finally {
				completed.resolve();
			}
		},
	};
};
