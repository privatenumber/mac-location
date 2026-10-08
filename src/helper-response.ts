import {
	isHelperErrorCode,
	LocationError,
} from './errors.ts';
import type { Position } from './types.ts';

/** The one-line JSON response the native helper prints to stdout. */
type HelperResponse =
	| {
		ok: true;
		latitude: number;
		longitude: number;
		accuracy: number;
		timestamp: number;
	}
	| {
		ok: false;
		code: string;
		message: string;
	};

const isHelperResponse = (value: unknown): value is HelperResponse => {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const response = value as Record<string, unknown>;
	if (response.ok === true) {
		return (
			typeof response.latitude === 'number'
			&& typeof response.longitude === 'number'
			&& typeof response.accuracy === 'number'
			&& typeof response.timestamp === 'number'
		);
	}
	return response.ok === false
		&& typeof response.code === 'string'
		&& typeof response.message === 'string';
};

const isValidPosition = (
	response: Extract<HelperResponse, { ok: true }>,
): boolean => (
	Number.isFinite(response.latitude)
	&& response.latitude >= -90
	&& response.latitude <= 90
	&& Number.isFinite(response.longitude)
	&& response.longitude >= -180
	&& response.longitude <= 180
	&& Number.isFinite(response.accuracy)
	&& response.accuracy >= 0
	&& Number.isFinite(response.timestamp)
);

/** Parse the helper's stdout, falling back to its stderr for the failure message. */
const parseResponse = (stdout: string, stderr: string): HelperResponse => {
	const line = stdout.trim();
	if (line === '') {
		const detail = stderr.trim();
		throw new LocationError('HELPER_FAILED', detail === '' ? 'Helper produced no output' : `Helper failed: ${detail}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		throw new LocationError('HELPER_FAILED', `Helper produced invalid output: ${line}`);
	}
	if (!isHelperResponse(parsed)) {
		throw new LocationError('HELPER_FAILED', `Helper produced unexpected output: ${line}`);
	}
	return parsed;
};

/** Interpret a decoded response and exit status as a position, or throw. */
const toPosition = (
	response: HelperResponse,
	exitCode: number | null,
	signalCode: NodeJS.Signals | null,
): Position => {
	if (!response.ok) {
		const { code } = response;
		if (!isHelperErrorCode(code)) {
			throw new LocationError('HELPER_FAILED', `Helper returned an unknown error code: ${code}`);
		}
		throw new LocationError(code, response.message);
	}
	if (exitCode !== 0 || signalCode !== null) {
		throw new LocationError('HELPER_FAILED', 'Helper reported success but exited abnormally');
	}
	if (!isValidPosition(response)) {
		throw new LocationError('HELPER_FAILED', 'Helper returned an invalid position');
	}
	return {
		latitude: response.latitude,
		longitude: response.longitude,
		accuracy: response.accuracy,
		timestamp: response.timestamp,
	};
};

/**
 * Decode the helper's output and exit status into a position.
 *
 * @param stdout The helper's stdout: one JSON line on success or failure.
 * @param stderr Diagnostic output, used when stdout is empty.
 * @param exitCode The helper's exit code, or null if it was signalled.
 * @param signalCode The signal that terminated the helper, or null.
 */
export const decodeHelperResponse = (
	stdout: string,
	stderr: string,
	exitCode: number | null,
	signalCode: NodeJS.Signals | null,
): Position => toPosition(parseResponse(stdout, stderr), exitCode, signalCode);
