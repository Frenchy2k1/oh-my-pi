import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getDaemonRuntimeDir, hasFsCode, isEacces, isEisdir, isEnoent, logger } from "@oh-my-pi/pi-utils";

/** Resolve the private runtime directory shared by omp processes in one project directory. */
export { getDaemonRuntimeDir as daemonRuntimeDir };

/** File in a broker runtime dir recording which project (or global service dir) owns the scope. */
const SCOPE_FILE = "scope.json";
/**
 * Small mutable lifecycle state (snapshot, completion bookkeeping) in
 * `<runtimeDir>/daemons/<name>/`. Rewritten on transitions, and only when its
 * serialized form changes.
 */
export const DAEMON_META_FILE = "meta.json";
/**
 * The launch spec, including its environment (often the whole parent env,
 * tens of KB). Written when the record is created or its mode changes, never
 * on lifecycle transitions. Older brokers embedded it in `meta.json`; readers
 * still accept that layout and broker recovery migrates it.
 */
export const DAEMON_SPEC_FILE = "spec.json";

/**
 * Suffix of a runtime-dir symlink recording that `<name>` lives outside the
 * scope (a Snap-confined Chromium cannot write the runtime dir, so its profile
 * is mirrored under `$SNAP_USER_COMMON/omp/<original path>`). Pruning the scope
 * removes the link target too; see {@link removeRelocatedRuntimeData}.
 */
const RELOCATED_SUFFIX = ".relocated";

/**
 * Record that runtime-dir path `original` is stored at `relocated`, so pruning
 * the scope reclaims it. Best-effort: a failed link only costs the reclaim.
 */
export async function linkRelocatedRuntimeData(original: string, relocated: string): Promise<void> {
	const link = `${original}${RELOCATED_SUFFIX}`;
	try {
		if ((await fs.readlink(link).catch(() => undefined)) === relocated) return;
		await fs.rm(link, { force: true });
		await fs.symlink(relocated, link);
	} catch (error) {
		if (hasFsCode(error, "EEXIST")) return; // A concurrent client recorded it first.
		logger.warn("Failed to record relocated daemon runtime data", {
			link,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/**
 * Remove the out-of-scope data recorded by {@link linkRelocatedRuntimeData} in
 * `runtimeDir`. Only a target mirroring its original path under an `omp` dir
 * is deleted, so a stray or hand-made link never reaches unrelated data.
 */
export async function removeRelocatedRuntimeData(runtimeDir: string): Promise<void> {
	for (const name of await fs.readdir(runtimeDir)) {
		if (!name.endsWith(RELOCATED_SUFFIX)) continue;
		const original = path.join(runtimeDir, name.slice(0, -RELOCATED_SUFFIX.length));
		let target: string;
		try {
			target = await fs.readlink(path.join(runtimeDir, name));
		} catch {
			continue; // Not a symlink.
		}
		if (!path.isAbsolute(target) || !target.endsWith(path.join(`${path.sep}omp`, original))) continue;
		await fs.rm(target, { recursive: true, force: true });
	}
}

/**
 * Canonicalize a project directory the same way every broker client does, so
 * hash-keyed runtime dirs and Windows pipe names agree across processes.
 * Missing paths and permission-denied lookups (EPERM/EACCES on protected
 * parent directories) resolve without realpath instead of failing.
 */
export async function canonicalProjectDir(projectDir: string): Promise<string> {
	const resolved = path.resolve(projectDir);
	try {
		return await fs.realpath(resolved);
	} catch (error) {
		if (isEnoent(error) || isEisdir(error) || isEacces(error) || hasFsCode(error, "EPERM")) return resolved;
		throw error;
	}
}

/**
 * Record the scope's canonical project directory inside its runtime dir.
 * Written by the broker at startup so out-of-process inspectors (`omp ps`)
 * can map a hash-keyed runtime dir back to its project.
 */
export async function writeDaemonScopeMeta(runtimeDir: string, projectDir: string): Promise<void> {
	await Bun.write(path.join(runtimeDir, SCOPE_FILE), JSON.stringify({ projectDir }));
}

/** Read the project directory recorded for a runtime dir; undefined when absent or malformed. */
export async function readDaemonScopeMeta(runtimeDir: string): Promise<string | undefined> {
	try {
		const raw: unknown = await Bun.file(path.join(runtimeDir, SCOPE_FILE)).json();
		if (typeof raw === "object" && raw !== null && "projectDir" in raw && typeof raw.projectDir === "string") {
			return raw.projectDir;
		}
	} catch {
		// Missing or malformed scope metadata reads as unknown.
	}
	return undefined;
}

/** One daemon record dir as stored on disk, before parsing. */
export interface StoredDaemonRecord {
	/** Decoded `meta.json`. */
	meta: object & { daemon: unknown };
	/** Decoded launch spec, from `meta.json` (legacy layout) or `spec.json`. */
	spec: unknown;
	/** The spec was embedded in `meta.json` by an older broker. */
	legacyLayout: boolean;
}

/**
 * Read a daemon record dir in either layout. Undefined when `meta.json` has no
 * daemon snapshot; throws when a file is missing or malformed.
 */
export async function readStoredDaemonRecord(dir: string): Promise<StoredDaemonRecord | undefined> {
	const meta: unknown = await Bun.file(path.join(dir, DAEMON_META_FILE)).json();
	if (typeof meta !== "object" || meta === null || !("daemon" in meta)) return undefined;
	if ("spec" in meta) return { meta, spec: meta.spec, legacyLayout: true };
	const spec: unknown = await Bun.file(path.join(dir, DAEMON_SPEC_FILE)).json();
	return { meta, spec, legacyLayout: false };
}

/** Resolve the Unix socket or Windows named pipe used by one daemon broker scope. */
export function daemonBrokerEndpoint(projectDir: string, runtimeDir: string): string {
	if (process.platform === "win32") {
		const key = Bun.hash.wyhash(path.resolve(projectDir)).toString(16).padStart(16, "0");
		return `\\\\.\\pipe\\omp-daemon-${key}`;
	}
	return path.join(runtimeDir, "broker.sock");
}
