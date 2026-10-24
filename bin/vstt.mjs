#!/usr/bin/env node
// dsh-vstt --command line front end for the `dsh-voice-transcribe` plugin.
//
//   dsh-vstt setup [--no-mic] [--with-whisper] [--no-model] [--python <exe>] [--index <url>]
//   dsh-vstt doctor
//   dsh-vstt transcribe <media> [--json] [-o DIR] [--lang zh] [--engine sensevoice|whisper]
//   dsh-vstt mic [--seconds N] [--device N] [--quiet]
//   dsh-vstt status [--json]
//
// The heavy lifting is engine/vstt_engine.py in a private venv under
// ~/.dsh/voice-transcribe, so nothing here needs Node dependencies.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
	DATA_DIR,
	ENGINE_FILE,
	PKG_DIR,
	pythonPath,
	readiness,
	venvPython,
	VENV_DIR
} from "../lib/paths.mjs";
import { resolveTarget } from "../lib/media.mjs";
import { fetchModel } from "../tools/fetch-model.mjs";

const NAME = "dsh-vstt";

function say(message = "") {
	process.stdout.write(`${message}\n`);
}

function warn(message) {
	process.stderr.write(`${message}\n`);
}

function parseArgs(argv) {
	const [command, ...rest] = argv;
	const options = { command, positional: [] };
	for (let i = 0; i < rest.length; i += 1) {
		const token = rest[i];
		switch (token) {
			case "--json":
				options.json = true;
				break;
			case "--no-mic":
				options.noMic = true;
				break;
			case "--with-whisper":
				options.withWhisper = true;
				break;
			case "--no-model":
				options.noModel = true;
				break;
			case "--force":
				options.force = true;
				break;
			case "--quiet":
				options.quiet = true;
				break;
			case "--python":
				options.python = rest[++i];
				break;
			case "--index":
			case "--pip-index":
				options.index = rest[++i];
				break;
			case "--lang":
				options.lang = rest[++i];
				break;
			case "--engine":
				options.engine = rest[++i];
				break;
			case "--out":
			case "-o":
				options.out = rest[++i];
				break;
			case "--seconds":
				options.seconds = rest[++i];
				break;
			case "--device":
				options.device = rest[++i];
				break;
			case "--help":
			case "-h":
				options.help = true;
				break;
			default:
				if (token.startsWith("-")) throw new Error(`unknown option: ${token}`);
				options.positional.push(token);
		}
	}
	return options;
}

function usage() {
	return `usage:
  ${NAME} setup [--no-mic] [--with-whisper] [--no-model] [--python <exe>]
  ${NAME} doctor
  ${NAME} transcribe <media> [--json] [-o DIR] [--lang zh] [--engine sensevoice|whisper]
  ${NAME} mic [--seconds N] [--device N] [--quiet]
  ${NAME} status [--json]

data dir : ${DATA_DIR}
engine   : ${ENGINE_FILE}`;
}

/** Run a command, inheriting stdio unless capture is requested. */
function run(command, args, { capture = false } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: capture ? ["ignore", "pipe", "pipe"] : ["inherit", "inherit", "inherit"],
			windowsHide: true
		});
		let stdout = "";
		let stderr = "";
		if (capture) {
			child.stdout.on("data", (chunk) => {
				stdout += chunk.toString("utf8");
			});
			child.stderr.on("data", (chunk) => {
				stderr += chunk.toString("utf8");
			});
		}
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

/** Find a system Python to build the venv from. */
function findBasePython(explicit) {
	const candidates = explicit ? [explicit] : process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
	for (const candidate of candidates) {
		const probe = spawnSync(candidate, ["--version"], { encoding: "utf8", windowsHide: true });
		const version = `${probe.stdout ?? ""}${probe.stderr ?? ""}`.trim();
		const match = version.match(/Python (\d+)\.(\d+)/);
		if (match && Number(match[1]) >= 3 && Number(match[2]) >= 9) return { command: candidate, version };
	}
	throw new Error(
		"no Python 3.9+ found. Install Python from https://www.python.org/downloads/ " +
			"(on Windows tick \"Add python.exe to PATH\", then rerun: dsh-vstt setup"
	);
}

/** Packages to install into the private venv. */
function packagesFor(options) {
	const packages = ["sherpa-onnx==2.0.0", "numpy>=2.0"];
	if (!options.noMic) {
		packages.push("sounddevice>=0.5.0", "pyperclip>=1.8");
		if (process.platform === "win32") packages.push("pycaw>=20240210", "comtypes>=1.4");
	}
	if (options.withWhisper) packages.push("faster-whisper==1.2.1");
	return packages;
}

async function commandSetup(options) {
	mkdirSync(DATA_DIR, { recursive: true });
	const existing = venvPython();
	let python = existing;
	if (!python) {
		const base = findBasePython(options.python);
		say(`venv    : creating ${VENV_DIR} (from ${base.command}, ${base.version})`);
		const created = await run(base.command, ["-m", "venv", VENV_DIR]);
		if (created.code !== 0) throw new Error("python -m venv failed (see the output above)");
		python = venvPython();
		if (!python) throw new Error(`venv was created but no interpreter was found under ${VENV_DIR}`);
	} else {
		say(`venv    : reusing ${python}`);
	}

	// PyPI is slow from mainland China; VSTT_PIP_INDEX (or pip.conf / PIP_INDEX_URL) wins.
	const indexUrl = options.index || process.env.VSTT_PIP_INDEX || "";
	const indexArgs = indexUrl ? ["--index-url", indexUrl] : [];
	if (indexUrl) say(`pip     : using index ${indexUrl}`);

	say("pip     : upgrading pip");
	await run(python, ["-m", "pip", "install", "--upgrade", "--disable-pip-version-check", ...indexArgs, "pip"]);

	const packages = packagesFor(options);
	say(`pip     : installing ${packages.join(" ")}`);
	const installed = await run(python, ["-m", "pip", "install", "--disable-pip-version-check", ...indexArgs, ...packages]);
	if (installed.code !== 0) throw new Error("pip install failed (see the output above)");

	if (!options.noModel) {
		say("model   : checking SenseVoice weights");
		const result = await fetchModel({ force: options.force });
		say(`model   : ready in ${result.dir}`);
	}
	say("");
	say(`done    : run \`${NAME} doctor\` to confirm, or \`${NAME} transcribe <file>\``);
}

async function commandDoctor(options) {
	const python = pythonPath();
	const status = readiness();
	if (options.json) {
		say(JSON.stringify(status));
		return;
	}
	say(`package : ${PKG_DIR}`);
	say(`data    : ${DATA_DIR}`);
	say(`python  : ${python}${status.pythonFromVenv ? "" : "  (not the private venv --run dsh-vstt setup)"}`);
	say(`model   : ${status.modelReady ? "OK" : `MISSING ${status.modelMissing.join(", ")} in ${status.modelDir}`}`);
	if (!existsSync(ENGINE_FILE)) {
		say("engine  : missing engine/vstt_engine.py");
		return;
	}
	const probe = await run(python, [ENGINE_FILE, "doctor"], { capture: true });
	say("--- engine doctor ---");
	say(`${probe.stdout}${probe.stderr}`.trimEnd());
	if (probe.code !== 0) throw new Error(`engine doctor exited ${probe.code}`);
}

async function transcribeOne(media, options) {
	const python = pythonPath();
	const args = [ENGINE_FILE, "file", media, "--json"];
	if (options.lang) args.push("--lang", options.lang);
	if (options.engine) args.push("--engine", options.engine);
	if (options.out) args.push("-o", options.out);
	const result = await run(python, args, { capture: true });
	if (result.stderr) warn(result.stderr.trimEnd());
	if (result.code !== 0) throw new Error(`transcription failed (exit ${result.code})`);
	const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
	try {
		return JSON.parse(line);
	} catch {
		throw new Error(`unreadable engine output: ${line.slice(0, 200)}`);
	}
}

async function commandTranscribe(options) {
	const media = options.positional[0];
	if (!media) throw new Error("transcribe needs a media file or folder: dsh-vstt transcribe <file|folder>");
	const target = resolveTarget(media);

	if (target.kind === "file") {
		const parsed = await transcribeOne(target.path, options);
		if (options.json) {
			say(JSON.stringify(parsed));
			return;
		}
		say(parsed.text ?? "");
		say("");
		say(`engine=${parsed.engine} duration=${parsed.duration}s segments=${parsed.segments?.length ?? 0} rtf=${parsed.rtf}`);
		return;
	}

	// Folder: newest-first, capped by MAX_BATCH_FILES; failures on one file do not kill the batch.
	const results = [];
	const failures = [];
	for (const item of target.files) {
		if (!options.json) warn(`[${results.length + failures.length + 1}/${target.files.length}] ${item.name}`);
		try {
			results.push({ name: item.name, ...(await transcribeOne(item.path, options)) });
		} catch (error) {
			failures.push({ name: item.name, error: error instanceof Error ? error.message : String(error) });
		}
	}
	if (options.json) {
		say(
			JSON.stringify({
				mode: "batch",
				path: target.path,
				total: target.total,
				taken: target.files.length,
				files: results.map(({ name, duration, rtf, text }) => ({ name, duration, rtf, chars: text.length })),
				failures,
				text: results.map((entry) => `\u3010${entry.name}\u3011\n${entry.text}`.trimEnd()).join("\n\n")
			})
		);
		return;
	}
	for (const entry of results) {
		say(`\u3010${entry.name}\u3011`);
		say(entry.text ?? "");
		say("");
	}
	if (failures.length > 0) {
		warn(`${failures.length} file(s) failed:`);
		for (const failure of failures) warn(`  ${failure.name}: ${failure.error}`);
	}
	say(`folder=${target.path} files=${results.length}/${target.files.length} total=${target.total}`);
}

async function commandMic(options) {
	const python = pythonPath();
	const args = [ENGINE_FILE, "mic"];
	if (options.seconds) args.push("--seconds", options.seconds);
	if (options.device) args.push("--device", options.device);
	if (options.quiet) args.push("--quiet");
	const result = await run(python, args);
	if (result.code !== 0) throw new Error(`mic exited ${result.code}`);
}

function commandStatus(options) {
	const status = readiness();
	if (options.json) {
		say(JSON.stringify(status));
		return;
	}
	say(`ready   : ${status.modelReady && status.pythonFromVenv ? "yes" : "no"}`);
	say(`python  : ${status.python}`);
	say(`model   : ${status.modelReady ? status.modelDir : `missing ${status.modelMissing.join(", ")}`}`);
	say(`version : ${status.version}`);
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (!options.command || options.help || options.command === "help") {
		say(usage());
		return;
	}
	switch (options.command) {
		case "setup":
			return commandSetup(options);
		case "doctor":
			return commandDoctor(options);
		case "transcribe":
			return commandTranscribe(options);
		case "mic":
			return commandMic(options);
		case "status":
			return commandStatus(options);
		default:
			throw new Error(`unknown command: ${options.command}\n\n${usage()}`);
	}
}

main().catch((error) => {
	warn(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
