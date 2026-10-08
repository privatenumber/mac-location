#!/usr/bin/env node
import path from 'node:path';
import { once, addAbortListener } from 'node:events';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, stat, readFile, open, rm, cp, writeFile, rename } from 'node:fs/promises';
import os from 'node:os';
import { text } from 'node:stream/consumers';
import { setTimeout as setTimeout$1 } from 'node:timers/promises';

const helperErrorCodes = /* @__PURE__ */ new Set([
  "PERMISSION_DENIED",
  "PERMISSION_RESTRICTED",
  "LOCATION_SERVICES_DISABLED",
  "POSITION_UNAVAILABLE",
  "TIMEOUT",
  "UNSUPPORTED_PLATFORM",
  "HELPER_NOT_FOUND",
  "HELPER_FAILED"
]);
const isHelperErrorCode = (value) => typeof value === "string" && helperErrorCodes.has(value);
class LocationError extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "LocationError";
    this.code = code;
  }
}

const applicationStorageRoot = path.join(os.homedir(), "Library", "Application Support", "mac-location");
const helperExecutableName = "mac-location";
const helperBundleName = "mac-location.app";
const usageDescriptionKeys = [
  "NSLocationUsageDescription",
  "NSLocationWhenInUseUsageDescription",
  "NSLocationAlwaysAndWhenInUseUsageDescription"
];
const collectCommandResult = async (child, signal) => {
  const closed = once(child, "close");
  const onAbort = () => child.kill("SIGKILL");
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const [stdout, stderr] = await Promise.all([
      text(child.stdout),
      text(child.stderr),
      closed
    ]);
    const [exitCode] = await closed;
    return {
      exitCode,
      stdout: stdout.trim(),
      stderr: stderr.trim()
    };
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await closed.catch(() => void 0);
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
};
const runCommand = async (command, arguments_, signal) => {
  if (signal?.aborted) {
    throw signal.reason;
  }
  const child = spawn(command, arguments_, { stdio: ["ignore", "pipe", "pipe"] });
  return collectCommandResult(child, signal);
};
const runChecked = async (run, command, arguments_, signal) => {
  const result = await run(command, arguments_, signal);
  if (result.exitCode !== 0) {
    if (signal?.aborted) {
      throw signal.reason;
    }
    throw new LocationError("HELPER_PREPARATION_FAILED", `${command} failed: ${result.stderr || result.stdout}`);
  }
};
const sha256File = async (filePath) => {
  const hash = createHash("sha256");
  hash.update(await readFile(filePath));
  return hash.digest("hex");
};
const shortHash = (value) => createHash("sha256").update(value).digest("hex").slice(0, 32);
const exists = async (filePath) => {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
};
const exclusiveLockFlag = process.platform === "darwin" ? 32 : 0;
const exclusiveLockOpenFlags = constants.O_RDWR | constants.O_CREAT | exclusiveLockFlag | constants.O_NONBLOCK;
const acquirePreparationLock = async (lockPath, signal) => {
  while (true) {
    if (signal?.aborted) {
      throw signal.reason;
    }
    try {
      const handle = await open(lockPath, exclusiveLockOpenFlags, 384);
      return async () => {
        await handle.close();
      };
    } catch (error) {
      const { code } = error;
      if (code !== "EAGAIN" && code !== "EWOULDBLOCK") {
        throw error;
      }
    }
    await setTimeout$1(50);
  }
};
const bundleIsValid = async (run, bundlePath, signal) => {
  if (!await exists(path.join(bundlePath, "Contents", "MacOS", helperExecutableName))) {
    return false;
  }
  const verification = await run("codesign", ["--verify", bundlePath], signal);
  return verification.exitCode === 0;
};
const inputHashOf = (application, executableSha256) => shortHash(JSON.stringify({
  id: application.id,
  name: application.name,
  locationUsageDescription: application.locationUsageDescription,
  iconSha256: application.icon === void 0 || application.icon === null ? void 0 : createHash("sha256").update(application.icon).digest("hex"),
  executableSha256
}));
const ensureBundle = async (application, sourceBundle, appsDirectory, inputHash, run, signal) => {
  const bundleDirectory = path.join(appsDirectory, inputHash);
  const bundlePath = path.join(bundleDirectory, helperBundleName);
  const executablePath = path.join(bundlePath, "Contents", "MacOS", helperExecutableName);
  if (await bundleIsValid(run, bundlePath, signal)) {
    return executablePath;
  }
  const stagingDirectory = path.join(appsDirectory, `${inputHash}.staging-${process.pid}`);
  try {
    await rm(stagingDirectory, {
      recursive: true,
      force: true
    });
    await mkdir(stagingDirectory, { recursive: true });
    const stagingBundlePath = path.join(stagingDirectory, helperBundleName);
    await cp(sourceBundle, stagingBundlePath, { recursive: true });
    const plistPath = path.join(stagingBundlePath, "Contents", "Info.plist");
    const replace = (key, value) => runChecked(run, "plutil", ["-replace", key, "-string", value, plistPath], signal);
    await replace("CFBundleIdentifier", application.id);
    await replace("CFBundleName", application.name);
    await replace("CFBundleDisplayName", application.name);
    for (const key of usageDescriptionKeys) {
      await replace(key, application.locationUsageDescription);
    }
    if (application.icon !== void 0 && application.icon !== null) {
      const resourcesDirectory = path.join(stagingBundlePath, "Contents", "Resources");
      await mkdir(resourcesDirectory, { recursive: true });
      await writeFile(path.join(resourcesDirectory, "application.icns"), application.icon);
      await replace("CFBundleIconFile", "application.icns");
    }
    await runChecked(run, "codesign", ["--force", "--deep", "-s", "-", stagingBundlePath], signal);
    await runChecked(run, "codesign", ["--verify", "--verbose=2", stagingBundlePath], signal);
    if (signal?.aborted) {
      throw signal.reason;
    }
    await rm(bundleDirectory, {
      recursive: true,
      force: true
    });
    await rename(stagingDirectory, bundleDirectory);
  } catch (error) {
    await rm(stagingDirectory, {
      recursive: true,
      force: true
    });
    throw error;
  }
  return executablePath;
};
const ensurePrepared = async (application, sourceBundle, storageRoot, run, signal) => {
  const sourceExecutable = path.join(sourceBundle, "Contents", "MacOS", helperExecutableName);
  if (!await exists(sourceExecutable)) {
    throw new LocationError("HELPER_NOT_FOUND", `The bundled helper was not found at ${sourceExecutable}.`);
  }
  const executableSha256 = await sha256File(sourceExecutable);
  const inputHash = inputHashOf(application, executableSha256);
  const idDirectory = path.join(storageRoot, shortHash(application.id));
  const appsDirectory = path.join(idDirectory, "apps");
  await mkdir(idDirectory, { recursive: true });
  const release = await acquirePreparationLock(path.join(idDirectory, "prepare.lock"), signal);
  try {
    const executablePath = await ensureBundle(
      application,
      sourceBundle,
      appsDirectory,
      inputHash,
      run,
      signal
    );
    if (signal?.aborted) {
      throw signal.reason;
    }
    return executablePath;
  } finally {
    await release();
  }
};
const toPreparationError = (error, signal) => {
  if (signal?.aborted) {
    return signal.reason;
  }
  if (error instanceof LocationError) {
    return error;
  }
  return new LocationError("HELPER_PREPARATION_FAILED", `Preparing the helper failed: ${error.message}`);
};
const resolveApplicationExecutable = (application, options) => ensurePrepared(
  application,
  options.sourceBundle,
  options.storageRoot ?? applicationStorageRoot,
  options.runCommand ?? runCommand,
  options.signal
).catch((error) => {
  throw toPreparationError(error, options.signal);
});

const isHelperResponse = (value) => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const response = value;
  if (response.ok === true) {
    return typeof response.latitude === "number" && typeof response.longitude === "number" && typeof response.accuracy === "number" && typeof response.timestamp === "number";
  }
  return response.ok === false && typeof response.code === "string" && typeof response.message === "string";
};
const isValidPosition = (response) => Number.isFinite(response.latitude) && response.latitude >= -90 && response.latitude <= 90 && Number.isFinite(response.longitude) && response.longitude >= -180 && response.longitude <= 180 && Number.isFinite(response.accuracy) && response.accuracy >= 0 && Number.isFinite(response.timestamp);
const parseResponse = (stdout, stderr) => {
  const line = stdout.trim();
  if (line === "") {
    const detail = stderr.trim();
    throw new LocationError("HELPER_FAILED", detail === "" ? "Helper produced no output" : `Helper failed: ${detail}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new LocationError("HELPER_FAILED", `Helper produced invalid output: ${line}`);
  }
  if (!isHelperResponse(parsed)) {
    throw new LocationError("HELPER_FAILED", `Helper produced unexpected output: ${line}`);
  }
  return parsed;
};
const toPosition = (response, exitCode, signalCode) => {
  if (!response.ok) {
    const { code } = response;
    if (!isHelperErrorCode(code)) {
      throw new LocationError("HELPER_FAILED", `Helper returned an unknown error code: ${code}`);
    }
    throw new LocationError(code, response.message);
  }
  if (exitCode !== 0 || signalCode !== null) {
    throw new LocationError("HELPER_FAILED", "Helper reported success but exited abnormally");
  }
  if (!isValidPosition(response)) {
    throw new LocationError("HELPER_FAILED", "Helper returned an invalid position");
  }
  return {
    latitude: response.latitude,
    longitude: response.longitude,
    accuracy: response.accuracy,
    timestamp: response.timestamp
  };
};
const decodeHelperResponse = (stdout, stderr, exitCode, signalCode) => toPosition(parseResponse(stdout, stderr), exitCode, signalCode);

const DEFAULT_MAXIMUM_AGE = 0;
const FORCE_KILL_DELAY = 1e3;
const terminate = (child) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  const forceKillId = setTimeout(() => child.kill("SIGKILL"), FORCE_KILL_DELAY);
  child.once("close", () => clearTimeout(forceKillId));
};
const toSubprocessError = (error) => {
  const errno = error;
  const code = errno.code === "ENOENT" ? "HELPER_NOT_FOUND" : "HELPER_FAILED";
  return new LocationError(code, error.message);
};
const collectHelperResult = async (child, signal) => {
  const onAbort = () => terminate(child);
  signal.addEventListener("abort", onAbort, { once: true });
  const closed = once(child, "close");
  if (signal.aborted) {
    terminate(child);
  }
  let stdout = "";
  let stderr = "";
  try {
    [stdout, stderr] = await Promise.all([
      text(child.stdout),
      text(child.stderr),
      closed
    ]);
  } catch (error) {
    terminate(child);
    if (signal.aborted) {
      throw signal.reason;
    }
    throw toSubprocessError(error);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  signal.throwIfAborted();
  return {
    stdout,
    stderr
  };
};
const runHelper = async (executablePath, options) => {
  const {
    maximumAge = DEFAULT_MAXIMUM_AGE,
    signal
  } = options;
  signal.throwIfAborted();
  const child = spawn(executablePath, ["--maximum-age", String(maximumAge)], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  const { stdout, stderr } = await collectHelperResult(child, signal);
  return decodeHelperResponse(stdout, stderr, child.exitCode, child.signalCode);
};

const HELPER_APP_NAME = "mac-location.app";
const HELPER_EXECUTABLE_NAME = "mac-location";
const helperBundlePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist-native",
  HELPER_APP_NAME
);
const helperExecutablePath = path.join(helperBundlePath, "Contents", "MacOS", HELPER_EXECUTABLE_NAME);
const isSupported = process.platform === "darwin";
const requireSupported = () => {
  if (!isSupported) {
    throw new LocationError("UNSUPPORTED_PLATFORM", `mac-location only supports macOS (current platform: ${process.platform})`);
  }
};
const DEFAULT_TIMEOUT = 3e4;
const validateOptions = (options) => {
  if (options.maximumAge !== void 0 && (!Number.isFinite(options.maximumAge) || options.maximumAge < 0)) {
    throw new TypeError(`Invalid "maximumAge": ${options.maximumAge}. Expected a non-negative number of milliseconds.`);
  }
};
const validateApplication = (application) => {
  const { id, name, locationUsageDescription } = application;
  if (id === "" || name === "" || locationUsageDescription === "") {
    throw new TypeError('Invalid "application": "id", "name", and "locationUsageDescription" must be non-empty.');
  }
};
const copyIcon = (icon) => {
  if (icon === void 0 || icon === null) {
    return icon;
  }
  if (!(icon instanceof Uint8Array)) {
    throw new TypeError('Invalid "icon": expected .icns bytes as a Uint8Array or null.');
  }
  return new Uint8Array(icon);
};
const requestPosition = async (options, application) => {
  validateOptions(options);
  requireSupported();
  const { maximumAge } = options;
  const signal = options.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT);
  signal.throwIfAborted();
  const executablePath = application === void 0 ? helperExecutablePath : await resolveApplicationExecutable(application, {
    sourceBundle: helperBundlePath,
    signal
  });
  signal.throwIfAborted();
  return runHelper(executablePath, {
    maximumAge,
    signal
  });
};
const getCurrentPosition = (options = {}) => requestPosition(options);
const waitForUpdate = async (previous, signal) => {
  const canceled = Promise.withResolvers();
  const abortListener = addAbortListener(signal, () => canceled.reject(signal.reason));
  try {
    await Promise.race([previous, canceled.promise]);
    signal.throwIfAborted();
  } finally {
    abortListener[Symbol.dispose]();
  }
};
const createApplication = (application) => {
  validateApplication(application);
  let identity = {
    ...application,
    icon: copyIcon(application.icon)
  };
  let pendingUpdate = Promise.resolve();
  return {
    getCurrentPosition: (options = {}) => requestPosition(options, identity),
    updateMeta: async (metadata, options = {}) => {
      const { name, locationUsageDescription } = metadata;
      const icon = copyIcon(metadata.icon);
      requireSupported();
      const signal = options.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT);
      signal.throwIfAborted();
      const previous = pendingUpdate;
      const completed = Promise.withResolvers();
      pendingUpdate = previous.then(() => completed.promise);
      try {
        await waitForUpdate(previous, signal);
        const next = {
          id: identity.id,
          name: name ?? identity.name,
          locationUsageDescription: locationUsageDescription ?? identity.locationUsageDescription,
          icon: icon === void 0 ? identity.icon : icon
        };
        validateApplication(next);
        await resolveApplicationExecutable(next, {
          sourceBundle: helperBundlePath,
          signal
        });
        signal.throwIfAborted();
        identity = next;
      } finally {
        completed.resolve();
      }
    }
  };
};

export { LocationError, createApplication, getCurrentPosition, isSupported };
