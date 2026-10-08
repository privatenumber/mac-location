import path from 'node:path';
import { chmod, cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createFixture } from 'fs-fixture';
import spawn from 'nano-spawn';

const projectDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const macLocationCliPath = path.join(projectDirectory, 'src', 'cli.ts');

/** Run the mac-location CLI as a subprocess. */
export const macLocationsCli = (...arguments_: string[]) => spawn(
	process.execPath,
	[macLocationCliPath, ...arguments_],
);

/** Copy the public entry points into an isolated package with a fixture helper and HOME. */
export const createLocationFixture = (helperScript: string) => createFixture(async (fixture) => {
	await cp(path.join(projectDirectory, 'src'), fixture.getPath('src'), { recursive: true });
	const executableDirectory = 'dist-native/mac-location.app/Contents/MacOS';
	await fixture.mkdir(executableDirectory);
	const executablePath = path.join(executableDirectory, 'mac-location');
	await fixture.writeFile(executablePath, `#!/usr/bin/env node\n${helperScript}\n`);
	await chmod(fixture.getPath(executablePath), 0o755);
	return {
		'package.json': JSON.stringify({ type: 'module' }),
		node_modules: ({ symlink }) => symlink(path.join(projectDirectory, 'node_modules')),
		'dist-native/mac-location.app/Contents/Info.plist': `
			<plist version="1.0"><dict>
				<key>CFBundleExecutable</key><string>mac-location</string>
				<key>CFBundleIdentifier</key><string>com.example.fixture</string>
				<key>CFBundleName</key><string>Fixture</string>
				<key>CFBundleDisplayName</key><string>Fixture</string>
				<key>CFBundlePackageType</key><string>APPL</string>
				<key>NSLocationUsageDescription</key><string>Test location.</string>
				<key>NSLocationWhenInUseUsageDescription</key><string>Test location.</string>
				<key>NSLocationAlwaysAndWhenInUseUsageDescription</key><string>Test location.</string>
			</dict></plist>
		`,
	};
});
