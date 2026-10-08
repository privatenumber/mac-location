import {
	chmod, mkdir, rm, writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import spawn from 'nano-spawn';

const projectDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const swiftSource = path.join(projectDirectory, 'src-native', 'LocHelper.swift');
const appBundleDirectory = path.join(projectDirectory, 'dist-native', 'mac-location.app');
const contentsDirectory = path.join(appBundleDirectory, 'Contents');
const macosDirectory = path.join(contentsDirectory, 'MacOS');
const executablePath = path.join(macosDirectory, 'mac-location');

const MINIMUM_MACOS_VERSION = '11.0';
const APP_NAME = 'mac-location';
const BUNDLE_IDENTIFIER = 'com.privatenumber.mac-location';

const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>${APP_NAME}</string>
	<key>CFBundleIdentifier</key>
	<string>${BUNDLE_IDENTIFIER}</string>
	<key>CFBundleName</key>
	<string>${APP_NAME}</string>
	<key>CFBundleDisplayName</key>
	<string>${APP_NAME}</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>CFBundleShortVersionString</key>
	<string>1.0.0</string>
	<key>LSMinimumSystemVersion</key>
	<string>${MINIMUM_MACOS_VERSION}</string>
	<key>NSLocationUsageDescription</key>
	<string>Your location is used to provide the current coordinates.</string>
	<key>NSLocationWhenInUseUsageDescription</key>
	<string>Your location is used to provide the current coordinates.</string>
	<key>NSLocationAlwaysAndWhenInUseUsageDescription</key>
	<string>Your location is used to provide the current coordinates.</string>
</dict>
</plist>
`;

const compileForArchitecture = (architecture: string, outputPath: string) => spawn('swiftc', [
	swiftSource,
	'-Osize',
	'-whole-module-optimization',
	'-target',
	`${architecture}-apple-macosx${MINIMUM_MACOS_VERSION}`,
	'-framework',
	'CoreLocation',
	'-o',
	outputPath,
]);

// Build the universal helper bundle. Only meaningful on macOS.
await (async () => {
	if (process.platform !== 'darwin') {
		console.log('Skipping native helper build: not running on macOS.');
		return;
	}

	const arm64BinaryPath = path.join(macosDirectory, 'LocHelper-arm64');
	const intelBinaryPath = path.join(macosDirectory, 'LocHelper-x86_64');

	await rm(appBundleDirectory, {
		recursive: true,
		force: true,
	});
	await mkdir(macosDirectory, { recursive: true });
	await writeFile(path.join(contentsDirectory, 'Info.plist'), infoPlist);

	await Promise.all([
		compileForArchitecture('arm64', arm64BinaryPath),
		compileForArchitecture('x86_64', intelBinaryPath),
	]);
	await spawn('lipo', ['-create', arm64BinaryPath, intelBinaryPath, '-output', executablePath]);

	// Drop debugging and local symbols. This must run before signing: modifying
	// the executable afterward would invalidate the signature.
	await spawn('strip', ['-S', '-x', executablePath]);

	await Promise.all([
		rm(arm64BinaryPath, { force: true }),
		rm(intelBinaryPath, { force: true }),
	]);

	const { stdout: archInfo } = await spawn('lipo', ['-info', executablePath]);
	if (!archInfo.includes('x86_64') || !archInfo.includes('arm64')) {
		throw new Error(`Helper is not a universal binary: ${archInfo}`);
	}

	await chmod(executablePath, 0o755);
	await spawn('codesign', ['--force', '--deep', '-s', '-', appBundleDirectory]);
	await spawn('codesign', ['--verify', appBundleDirectory]);

	console.log(`Built native helper: ${appBundleDirectory}`);
})();
