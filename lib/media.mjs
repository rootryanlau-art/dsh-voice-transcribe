// Shared path handling for the host route and the CLI.
//
// Both entry points accept the same thing a person actually has in hand:
//
//   * a media file        -> transcribe that one file
//   * a folder            -> transcribe every media file in it (batch)
//
// Windows-friendly details that matter in practice: a path pasted from Explorer's
// "copy as path" arrives wrapped in double quotes, and people type forward slashes.
// Both are accepted here so the panel or the CLI never fails on pure formatting.
import { readdirSync, statSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";

/** Extensions the engine can be handed (ffmpeg decodes the container). */
export const MEDIA_EXTENSIONS = new Set([
	".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma", ".amr",
	".mp4", ".mkv", ".mov", ".avi", ".webm", ".flv", ".ts", ".m4v", ".3gp"
]);

/** A folder is transcribed newest-first, capped so one click cannot start all night. */
export const MAX_BATCH_FILES = 20;

function unsupportedExtensions() {
	return [...MEDIA_EXTENSIONS].join(" ");
}

/** Strip surrounding quotes/whitespace that paste operations leave behind. */
function cleanPath(raw) {
	if (typeof raw !== "string" || raw.trim() === "") throw new Error("path is required");
	let value = raw.trim();
	const quoted = /^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value);
	if (quoted) value = quoted[1].trim();
	if (value === "") throw new Error("path is required");
	return value;
}

/**
 * Validate what the user handed us.
 * @param {string} raw - file or folder, absolute (quotes and forward slashes tolerated)
 * @returns {{kind: "file", path: string, size: number}
 *          | {kind: "dir", path: string, files: Array<{path: string, name: string, size: number, mtime: number}>, total: number}}
 */
export function resolveTarget(raw) {
	const cleaned = cleanPath(raw);
	const target = resolve(cleaned);
	if (!isAbsolute(target)) throw new Error(`path must be absolute: ${cleaned}`);
	let stat;
	try {
		stat = statSync(target);
	} catch {
		throw new Error(`path not found: ${target}`);
	}

	if (stat.isFile()) {
		if (stat.size === 0) throw new Error(`file is empty: ${target}`);
		const extension = extname(target).toLowerCase();
		if (!MEDIA_EXTENSIONS.has(extension)) {
			throw new Error(`unsupported extension ${extension || "(none)"} -- supported: ${unsupportedExtensions()}`);
		}
		return { kind: "file", path: target, size: stat.size };
	}

	if (!stat.isDirectory()) throw new Error(`not a file or folder: ${target}`);

	const files = [];
	for (const name of readdirSync(target)) {
		if (name.startsWith(".")) continue;
		const full = join(target, name);
		if (!MEDIA_EXTENSIONS.has(extname(name).toLowerCase())) continue;
		let info;
		try {
			info = statSync(full);
		} catch {
			continue;
		}
		if (!info.isFile() || info.size === 0) continue;
		files.push({ path: full, name, size: info.size, mtime: info.mtimeMs });
	}
	if (files.length === 0) {
		throw new Error(
			`folder has no supported media files: ${target} -- supported: ${unsupportedExtensions()}. ` +
				"Put a recording in the folder, or pass the file itself."
		);
	}
	files.sort((a, b) => b.mtime - a.mtime);
	return { kind: "dir", path: target, files: files.slice(0, MAX_BATCH_FILES), total: files.length };
}
