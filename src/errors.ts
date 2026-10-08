export type LocationErrorCode =
	| 'PERMISSION_DENIED'
	| 'PERMISSION_RESTRICTED'
	| 'LOCATION_SERVICES_DISABLED'
	| 'POSITION_UNAVAILABLE'
	| 'TIMEOUT'
	| 'UNSUPPORTED_PLATFORM'
	| 'HELPER_NOT_FOUND'
	| 'HELPER_FAILED'
	| 'HELPER_PREPARATION_FAILED';

/**
 * The codes the native helper can return in its one-line response. Client-side codes such
 * as `HELPER_PREPARATION_FAILED` are not part of the helper protocol.
 */
const helperErrorCodes = new Set<LocationErrorCode>([
	'PERMISSION_DENIED',
	'PERMISSION_RESTRICTED',
	'LOCATION_SERVICES_DISABLED',
	'POSITION_UNAVAILABLE',
	'TIMEOUT',
	'UNSUPPORTED_PLATFORM',
	'HELPER_NOT_FOUND',
	'HELPER_FAILED',
]);

export const isHelperErrorCode = (value: unknown): value is LocationErrorCode => (
	typeof value === 'string' && helperErrorCodes.has(value as LocationErrorCode)
);

export class LocationError extends Error {
	readonly code: LocationErrorCode;

	constructor(code: LocationErrorCode, message: string) {
		super(message);
		this.name = 'LocationError';
		this.code = code;
	}
}
