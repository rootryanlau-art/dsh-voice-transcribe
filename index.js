// Host half of `dsh-voice-transcribe`.
//
// Exposes two loopback routes so the composer panel (client.js) can transcribe a
// local media file without the browser ever touching the filesystem:
//
//   GET  /dsh-voice-transcribe/status      readiness: python, model, engine paths
//   POST /dsh-voice-transcribe/transcribe  { path, lang?, engine? } -> { text, segments }
//
// Transcription itself is `engine/vstt_engine.py` running in the plugin's private
// venv (~/.dsh/voice-transcribe/venv): SenseVoice int8 on CPU, offline, no API key.
// This half only does path/parameter checking and process management.
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { ENGINE_FILE, modelDir, pythonPath, MODEL_FILES, readiness } from "./lib/paths.mjs";

const ROUTE_STATUS = "/dsh-voice-transcribe/status";
const ROUTE_TRANSCRIBE = "/dsh-voice-transcribe/transcribe";
/** Custom header the client must send; a cross-origin caller cannot set it without a preflight. */
const GATE_HEADER = "x-dsh-voice-transcribe";
const GATE_VALUE = "run";
/** Long meetings take a while; the engine runs at roughly 30脳 real time on CPU. */
const TRANSCRIBE_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_BODY_BYTES = 16 * 1024;
const MEDIA_EXTENSIONS = new Set([
	".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma", ".amr",
	".mp4", ".mkv", ".mov", ".avi", ".webm", ".flv", ".ts", ".m4v", ".3gp"
]);

function json(response, status, payload) {
	const body = Buffer.from(JSON.stringify(payload), "utf8");
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": body.length,
		"cache-control": "no-store"
	});
	response.end(body);
}

function text(response, status, message) {
	const body = Buffer.from(message, "utf8");
	response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "content-length": body.length });
	response.end(body);
}

function readBody(request) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		request.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error("request body too large"));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
			} catch {
				reject(new Error("request body is not valid JSON"));
			}
		});
		request.on("error", reject);
	});
}

/**
 * Run the engine on one file.
 * @returns {{text: string, segments: Array, duration: number, rtf: number, engine: string, elapsed: number}}
 */
function runEngine(file, lang, engineName) {
	return new Promise((resolve, reject) => {
		const args = [ENGINE_FILE, "file", file, "--json"];
		if (lang) args.push("--lang", lang);
		if (engineName) args.push("--engine", engineName);
		const child = spawn(pythonPath(), args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		const started = Date.now();
		const stdout = [];
		let stderr = "";
		let settled = false;
		const finish = (fn, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn(value);
		};
		const timer = setTimeout(() => {
			child.kill();
			finish(reject, new Error(`transcription timed out after ${TRANSCRIBE_TIMEOUT_MS / 60000} minutes`));
		}, TRANSCRIBE_TIMEOUT_MS);
		child.stdout.on("data", (chunk) => stdout.push(chunk));
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", (error) => finish(reject, error));
		child.on("close", (code) => {
			const elapsed = (Date.now() - started) / 1000;
			const line = Buffer.concat(stdout).toString("utf8").trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
			if (code !== 0) {
				const tail = stderr.trim().split(/\r?\n/).slice(-4).join(" ");
				finish(reject, new Error(`engine exited ${code}: ${tail || "no output"}`));
				return;
			}
			try {
				const parsed = JSON.parse(line);
				finish(resolve, {
					text: String(parsed.text ?? ""),
					segments: Array.isArray(parsed.segments) ? parsed.segments : [],
					duration: Number(parsed.duration) || 0,
					rtf: Number(parsed.rtf) || 0,
					engine: String(parsed.engine ?? engineName ?? "sensevoice"),
					elapsed
				});
			} catch (error) {
				finish(reject, new Error(`unreadable engine output: ${error instanceof Error ? error.message : error}`));
			}
		});
	});
}

/** Validate a user-supplied path before spending a minute of CPU on it. */
function checkMediaPath(raw) {
	if (typeof raw !== "string" || raw.trim() === "") throw new Error("path is required");
	const file = resolve(raw.trim().replace(/^"(.*)"$/, "$1"));
	if (!isAbsolute(file)) throw new Error("path must be absolute");
	let stat;
	try {
		stat = statSync(file);
	} catch {
		throw new Error(`file not found: ${file}`);
	}
	if (!stat.isFile()) throw new Error(`not a file: ${file}`);
	if (stat.size === 0) throw new Error(`file is empty: ${file}`);
	const dot = file.lastIndexOf(".");
	const extension = dot >= 0 ? file.slice(dot).toLowerCase() : "";
	if (MEDIA_EXTENSIONS.has(extension) === false) {
		throw new Error(`unsupported extension ${extension || "(none)"} --supported: ${[...MEDIA_EXTENSIONS].join(" ")}`);
	}
	return { file, size: stat.size };
}

async function handleStatus(request, response) {
	if (request.method !== "GET" && request.method !== "HEAD") {
		response.writeHead(405, { allow: "GET, HEAD" });
		response.end();
		return;
	}
	if (request.headers[GATE_HEADER] !== GATE_VALUE) {
		text(response, 403, "forbidden");
		return;
	}
	const state = readiness();
	json(response, 200, {
		...state,
		modelFiles: MODEL_FILES,
		ready: state.modelReady && state.pythonFromVenv
	});
}

async function handleTranscribe(request, response) {
	if (request.method !== "POST") {
		response.writeHead(405, { allow: "POST" });
		response.end();
		return;
	}
	if (request.headers[GATE_HEADER] !== GATE_VALUE) {
		text(response, 403, "forbidden");
		return;
	}
	let body;
	try {
		body = await readBody(request);
	} catch (error) {
		json(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
		return;
	}
	try {
		if (!readiness().modelReady) {
			throw new Error(`SenseVoice model is missing under ${modelDir()} --run: node bin/vstt.mjs setup`);
		}
		const { file, size } = checkMediaPath(body.path);
		const language = typeof body.lang === "string" && body.lang.trim() ? body.lang.trim() : "zh";
		const engineName = body.engine === "whisper" ? "whisper" : "sensevoice";
		ctxLogger(`transcribing ${file} (${(size / 1048576).toFixed(1)} MB, lang=${language}, engine=${engineName})`);
		const result = await runEngine(file, language, engineName);
		ctxLogger(`done in ${result.elapsed.toFixed(1)}s: ${result.text.length} chars, rtf=${result.rtf}`);
		json(response, 200, { ok: true, path: file, size, lang: language, ...result });
	} catch (error) {
		json(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
	}
}

/** Set by apply(); keeps the handlers free of a captured context in module scope. */
let log = (...args) => console.log("[dsh-voice-transcribe]", ...args);

function ctxLogger(...args) {
	try {
		log(...args);
	} catch {
		/* logging must never break a transcription */
	}
}

/** A web server is enough; the routes are plain Node http handlers. */
export const name = "dsh-voice-transcribe";
export const inject = ["webServer"];

/**
 * Register the two routes.
 * @param ctx - host root context; `webServer` is injected before apply runs.
 */
export function apply(ctx) {
	if (typeof ctx?.webServer?.register !== "function") {
		ctx?.logger?.warn?.("dsh-voice-transcribe: no webServer service, routes not registered");
		return;
	}
	log = (...args) => {
		if (typeof ctx.logger?.info === "function") ctx.logger.info(args.join(" "));
		else console.log("[dsh-voice-transcribe]", ...args);
	};
	ctx.effect(
		() => ctx.webServer.register({ kind: "exact", path: ROUTE_STATUS, handler: handleStatus }),
		"dsh-voice-transcribe: status route"
	);
	ctx.effect(
		() => ctx.webServer.register({ kind: "exact", path: ROUTE_TRANSCRIBE, handler: handleTranscribe }),
		"dsh-voice-transcribe: transcribe route"
	);
	ctx.logger?.info?.(`dsh-voice-transcribe: routes ready at ${ROUTE_TRANSCRIBE}`);
}
