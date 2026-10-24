// Shared path resolution for `dsh-voice-transcribe`.
//
// Every path is derived from this file's own location or from the environment,
// so the package works from a checkout, from `node_modules`, and from a linked
// junction alike. Nothing is hard-coded to one machine.
//
//   VSTT_HOME          data root            default ~/.dsh/voice-transcribe
//   VSTT_VENV          private venv         default <VSTT_HOME>/venv
//   VSTT_PYTHON        python to run        default <venv python>, else python3/python
//   VSTT_MODEL_DIR     SenseVoice directory default <pkg>/models/sense-voice if present,
//                                           else <VSTT_HOME>/models/sense-voice
//   VSTT_FFMPEG        ffmpeg executable    default ffmpeg on PATH
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Package root (the directory holding package.json). */
export const PKG_DIR = resolve(HERE, "..");

/** Engine script that actually transcribes. */
export const ENGINE_FILE = join(PKG_DIR, "engine", "vstt_engine.py");

/** Requirements file for the private venv. */
export const REQUIREMENTS = join(PKG_DIR, "engine", "requirements.txt");

/** Data root: venv, model cache, logs. */
export const DATA_DIR = resolve(process.env.VSTT_HOME || join(homedir(), ".dsh", "voice-transcribe"));

/** Private virtual environment. */
export const VENV_DIR = resolve(process.env.VSTT_VENV || join(DATA_DIR, "venv"));

/** Log directory (one line per dictation, so levels can be audited later). */
export const LOG_DIR = join(DATA_DIR, "logs");

/** Where the SenseVoice ONNX model lives. */
export function modelDir() {
	if (process.env.VSTT_MODEL_DIR) return resolve(process.env.VSTT_MODEL_DIR);
	const bundled = join(PKG_DIR, "models", "sense-voice");
	if (existsSync(join(bundled, "model.int8.onnx"))) return bundled;
	return join(DATA_DIR, "models", "sense-voice");
}

/** Model files that must both exist for the engine to start. */
export const MODEL_FILES = ["model.int8.onnx", "tokens.txt"];

/** Interpreter inside the private venv, or null when `setup` has not run yet. */
export function venvPython() {
	const candidates =
		process.platform === "win32"
			? [join(VENV_DIR, "Scripts", "python.exe"), join(VENV_DIR, "bin", "python3"), join(VENV_DIR, "bin", "python")]
			: [join(VENV_DIR, "bin", "python3"), join(VENV_DIR, "bin", "python"), join(VENV_DIR, "Scripts", "python.exe")];
	for (const candidate of candidates) if (existsSync(candidate)) return candidate;
	return null;
}

/**
 * Pick the interpreter to run the engine with.
 * VSTT_PYTHON wins; then the private venv; then whatever `python3`/`python` resolves to.
 * The last case usually has no sherpa-onnx, which `doctor` reports instead of crashing.
 */
export function pythonPath() {
	if (process.env.VSTT_PYTHON) return process.env.VSTT_PYTHON;
	return venvPython() || (process.platform === "win32" ? "python" : "python3");
}

/** Engine version, read from package.json so the CLI and the plugin agree. */
export function pkgVersion() {
	try {
		return JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8")).version || "0.0.0";
	} catch {
		return "0.0.0";
	}
}

/** A short, human-readable readiness report used by `doctor`, the CLI and the host route. */
export function readiness() {
	const python = pythonPath();
	const fromVenv = python === venvPython();
	const dir = modelDir();
	const missing = MODEL_FILES.filter((name) => !existsSync(join(dir, name)));
	return {
		version: pkgVersion(),
		python,
		pythonFromVenv: fromVenv,
		modelDir: dir,
		ready: missing.length === 0 && fromVenv,
		modelReady: missing.length === 0,
		modelMissing: missing,
		dataDir: DATA_DIR,
		engine: ENGINE_FILE,
		ffmpeg: process.env.VSTT_FFMPEG || "ffmpeg (PATH)"
	};
}
