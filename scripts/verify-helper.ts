import { access, constants } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import spawn from 'nano-spawn';

const projectDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const appBundleDirectory = path.join(projectDirectory, 'dist-native', 'mac-location.app');
const executablePath = path.join(appBundleDirectory, 'Contents', 'MacOS', 'mac-location');

// The bundled helper is required for the package to work. Packing without it
// produces a package that fails with HELPER_NOT_FOUND on macOS.
await (async () => {
	try {
		await access(executablePath, constants.X_OK);
	} catch {
		throw new Error(`Packaging check failed: bundled helper is missing or not executable at ${executablePath}. Build it with \`pnpm build:helper\`.`);
	}

	if (process.platform === 'darwin') {
		const { stdout: archInfo } = await spawn('lipo', ['-info', executablePath]);
		if (!archInfo.includes('x86_64') || !archInfo.includes('arm64')) {
			throw new Error(`Packaging check failed: helper is not a universal binary: ${archInfo}`);
		}

		await spawn('codesign', ['--verify', appBundleDirectory]);
	}
})();
