type LocationErrorCode = 'PERMISSION_DENIED' | 'PERMISSION_RESTRICTED' | 'LOCATION_SERVICES_DISABLED' | 'POSITION_UNAVAILABLE' | 'TIMEOUT' | 'UNSUPPORTED_PLATFORM' | 'HELPER_NOT_FOUND' | 'HELPER_FAILED' | 'HELPER_PREPARATION_FAILED';
declare class LocationError extends Error {
    readonly code: LocationErrorCode;
    constructor(code: LocationErrorCode, message: string);
}

type Position = {
    /** Latitude in degrees (WGS84). */
    latitude: number;
    /** Longitude in degrees (WGS84). */
    longitude: number;
    /** Horizontal accuracy in meters. */
    accuracy: number;
    /** Unix time in milliseconds. */
    timestamp: number;
};
/**
 * A stable application identity for the customized helper. These fields describe the
 * application: macOS shows the name and purpose in the permission prompt, and can show the
 * name and custom icon in System Settings. They are
 * captured by createApplication(), and macOS may ask the user to authorize again when they change.
 */
type ApplicationIdentity = {
    /** The bundle identifier, for example `com.example.weather-cli`. Stable per application. */
    id: string;
    /** The display name. macOS shows it in the permission prompt and System Settings. */
    name: string;
    /** The explanation macOS shows in the permission prompt. */
    locationUsageDescription: string;
    /** Custom .icns bytes. Copied when captured; null means no custom icon. */
    icon?: Uint8Array | null;
};
type GetPositionOptions = {
    /** Accept a cached location no older than this many milliseconds. Default: 0 (fresh only). */
    maximumAge?: number;
    /** Cancel with this signal's reason. When omitted, a 30-second timeout signal is used. */
    signal?: AbortSignal;
};
type ApplicationMetadata = Partial<Pick<ApplicationIdentity, 'name' | 'locationUsageDescription' | 'icon'>>;
type Application = {
    getCurrentPosition: (options?: GetPositionOptions) => Promise<Position>;
    /** Prepare metadata without requesting location. The ID stays fixed. */
    updateMeta: (metadata: ApplicationMetadata, options?: {
        signal?: AbortSignal;
    }) => Promise<void>;
};

declare const isSupported: boolean;
declare const getCurrentPosition: (options?: GetPositionOptions) => Promise<Position>;
/** Capture an identity without preparing a helper or requesting location. */
declare const createApplication: (application: ApplicationIdentity) => Application;

export { LocationError, createApplication, getCurrentPosition, isSupported };
export type { Application, ApplicationIdentity, ApplicationMetadata, GetPositionOptions, LocationErrorCode, Position };
