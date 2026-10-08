import { chmod } from 'node:fs/promises';
import { createFixture } from 'fs-fixture';

/**
 * Create an executable node script that acts as a stand-in for the native
 * helper. The returned fixture has `Symbol.asyncDispose`, so bind it with
 * `await using` for automatic cleanup. The helper lives at `getPath('helper')`.
 */
export const createFakeHelper = async (script: string) => {
	const fixture = await createFixture({
		helper: `#!/usr/bin/env node\n${script}\n`,
	});
	await chmod(fixture.getPath('helper'), 0o755);
	return fixture;
};

/** Generate a one-line script that prints `object` as a JSON line to stdout. */
export const printJsonScript = (object: unknown) => `console.log('${JSON.stringify(object)}');`;
