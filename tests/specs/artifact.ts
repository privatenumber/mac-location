import { existsSync } from 'node:fs';
import { access, constants } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import spawn from 'nano-spawn';
import {
	describe, expect, skip, test,
} from 'manten';

const projectDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const appBundleDirectory = path.join(projectDirectory, 'dist-native', 'mac-location.app');
const helperExecutable = path.join(appBundleDirectory, 'Contents', 'MacOS', 'mac-location');

describe('helper artifact', () => {
	test('is executable, universal, and signed', async () => {
		if (process.platform !== 'darwin') {
			skip('Requires macOS');
		}
		if (!existsSync(helperExecutable)) {
			skip('Native helper not built (run `pnpm build`)');
		}

		// Executable bit must survive packaging so the helper can be spawned.
		await access(helperExecutable, constants.X_OK);

		// Universal binary: both Apple Silicon and Intel.
		const { stdout: lipoOutput } = await spawn('lipo', ['-info', helperExecutable]);
		expect(lipoOutput).toContain('x86_64');
		expect(lipoOutput).toContain('arm64');

		// A valid signature is required for CoreLocation authorization. This rejects on failure.
		await spawn('codesign', ['--verify', appBundleDirectory]);
	});

	test('declares the location usage descriptions macOS requires', async () => {
		if (process.platform !== 'darwin') {
			skip('Requires macOS');
		}
		if (!existsSync(helperExecutable)) {
			skip('Native helper not built (run `pnpm build`)');
		}

		const plistPath = path.join(appBundleDirectory, 'Contents', 'Info.plist');
		const { stdout } = await spawn('plutil', ['-convert', 'json', '-o', '-', plistPath]);
		const infoPlist = JSON.parse(stdout) as Record<string, unknown>;

		// macOS requires NSLocationUsageDescription for location access.
		expect(infoPlist.NSLocationUsageDescription).toEqual(expect.any(String));
		expect(infoPlist.NSLocationWhenInUseUsageDescription).toEqual(expect.any(String));
	});
});
