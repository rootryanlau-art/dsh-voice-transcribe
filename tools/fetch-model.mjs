#!/usr/bin/env node
// Download the SenseVoice int8 ONNX model into the data directory.
//
//   node tools/fetch-model.mjs                 # Hugging Face, then hf-mirror on failure
//   node tools/fetch-model.mjs --mirror hf     # only huggingface.co
//   node tools/fetch-model.mjs --mirror cn     # only hf-mirror.com (mainland-friendly)
//   node tools/fetch-model.mjs --force         # re-download even when present
//
// The files are ~239 MB + ~1 MB. The model is not part of the npm tarball; it is
// fetched here, at the user's request, exactly once.
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";

import { modelDir, MODEL_FILES } from "../lib/paths.mjs";

const REPO = "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17";
const MIRRORS = {
	hf: `https://huggingface.co/${REPO}/resolve/main`,
	cn: `https://hf-mirror.com/${REPO}/resolve/main`
};
/** Minimum plausible size per file, to catch an HTML error page saved as the model. */
const MIN_BYTES = { "model.int8.onnx": 100 * 1024 * 1024, "tokens.txt": 10 * 1024 };

function parseArgs(argv) {
	const args = { mirror: "auto", force: false };
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i];
		if (token === "--force") args.force = true;
		else if (token === "--mirror") args.mirror = argv[++i] ?? "auto";
		else if (token === "--help" || token === "-h") args.help = true;
		else throw new Error(`unknown argument: ${token}`);
	}
	if (!["auto", "hf", "cn"].includes(args.mirror)) throw new Error("--mirror must be auto, hf or cn");
	return args;
}

/** Human-readable byte count. */
function mb(bytes) {
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function downloadOne(base, name, destination) {
	const url = `${base}/${name}`;
	const response = await fetch(url, { redirect: "follow" });
	if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} for ${url}`);
	const total = Number(response.headers.get("content-length") || 0);
	const partial = `${destination}.part`;
	let written = 0;
	let lastReport = 0;
	const source = Readable.fromWeb(response.body);
	source.on("data", (chunk) => {
		written += chunk.length;
		if (written - lastReport < 16 * 1024 * 1024) return;
		lastReport = written;
		const pct = total ? ` (${((written / total) * 100).toFixed(0)}%)` : "";
		process.stderr.write(`  ${name}: ${mb(written)}${total ? ` / ${mb(total)}` : ""}${pct}\n`);
	});
	await pipeline(source, createWriteStream(partial));
	const size = statSync(partial).size;
	if (size < MIN_BYTES[name]) {
		rmSync(partial, { force: true });
		throw new Error(`${name} came back as ${size} bytes — probably an error page, not the model`);
	}
	renameSync(partial, destination);
	return size;
}

/**
 * Ensure every model file exists.
 * @returns the directory the model is in, plus what was downloaded.
 */
export async function fetchModel(options = {}) {
	const dir = options.dir ?? modelDir();
	mkdirSync(dir, { recursive: true });
	const force = Boolean(options.force);
	const wanted = MODEL_FILES.filter((name) => force || !existsSync(join(dir, name)));
	if (wanted.length === 0) return { dir, downloaded: [], skipped: MODEL_FILES };

	const order = options.mirror === "cn" ? ["cn"] : options.mirror === "hf" ? ["hf"] : ["hf", "cn"];
	let lastError = null;
	for (const key of order) {
		const base = MIRRORS[key];
		process.stderr.write(`model: downloading from ${base}\n`);
		try {
			const downloaded = [];
			for (const name of wanted) {
				const size = await downloadOne(base, name, join(dir, name));
				downloaded.push({ name, size });
				process.stderr.write(`  ${name}: ${mb(size)} saved\n`);
			}
			return { dir, source: base, downloaded, skipped: MODEL_FILES.filter((n) => !wanted.includes(n)) };
		} catch (error) {
			lastError = error;
			process.stderr.write(`model: ${key} failed (${error instanceof Error ? error.message : error}), trying next mirror\n`);
			for (const name of wanted) rmSync(join(dir, `${name}.part`), { force: true });
		}
	}
	throw new Error(
		`could not download the SenseVoice model: ${lastError instanceof Error ? lastError.message : lastError}\n` +
			`Download model.int8.onnx and tokens.txt manually from https://huggingface.co/${REPO}/tree/main and put both into ${dir}`
	);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
	try {
		const args = parseArgs(process.argv.slice(2));
		if (args.help) {
			process.stdout.write("usage: node tools/fetch-model.mjs [--mirror auto|hf|cn] [--force]\n");
		} else {
			const result = await fetchModel(args);
			process.stdout.write(`model ready: ${result.dir}\n`);
		}
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
		process.exitCode = 1;
	}
}
