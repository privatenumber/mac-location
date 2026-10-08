import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	describe, expect, test,
} from 'manten';

const projectDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const readJson = async (filePath: string) => JSON.parse(await readFile(filePath, 'utf8')) as {
	engines?: { node?: string };
	dependencies?: Record<string, string>;
};

/** Turn a `>=x.y.z` range into its numeric version parts. */
const minimumVersion = (range: string) => range.replace(/^\D*/, '').split('.').map(Number);

const compareVersions = (a: number[], b: number[]) => {
	for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
		const difference = (a[index] ?? 0) - (b[index] ?? 0);
		if (difference !== 0) {
			return difference;
		}
	}
	return 0;
};

describe('package metadata', () => {
	test('advertises a Node range that covers every runtime dependency', async () => {
		const manifest = await readJson(path.join(projectDirectory, 'package.json'));
		const declaredMinimum = minimumVersion(manifest.engines!.node!);

		for (const dependency of Object.keys(manifest.dependencies ?? {})) {
			const dependencyManifest = await readJson(
				path.join(projectDirectory, 'node_modules', dependency, 'package.json'),
			);
			const requiredNode = dependencyManifest.engines?.node;
			if (requiredNode === undefined) {
				continue;
			}

			expect(
				compareVersions(declaredMinimum, minimumVersion(requiredNode)),
			).toBeGreaterThanOrEqual(0);
		}
	});
});
