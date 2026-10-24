#!/usr/bin/env node
// Smoke test for dsh-voice-transcribe. No browser, no Python venv needed.
//
//   node dev/verify.mjs
//
// Checks the contracts the DSH plugin loader and the awesome-dsh-plugin CI
// actually enforce, plus the few things that silently break the UI (slot ids,
// insertion API, bootstrap shape). Exits non-zero on the first failing group.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const results = [];
let failed = 0;

function check(label, ok, detail = "") {
	results.push({ label, ok, detail });
	if (!ok) failed += 1;
}

function read(rel) {
	const file = join(ROOT, rel);
	return existsSync(file) ? readFileSync(file, "utf8") : "";
}

// ---------------------------------------------------------------- 1. manifest

const pkg = JSON.parse(read("package.json"));
check("package name is a plain npm name", /^[a-z0-9][a-z0-9._-]*$/.test(pkg.name), pkg.name);
check("version is semver", /^\d+\.\d+\.\d+/.test(pkg.version), pkg.version);
check("license is declared", Boolean(pkg.license), String(pkg.license));

// market CI: dsh.bundle is mandatory, dsh.client alone is rejected
check("dsh.bundle.patch points at cordis.patch.yml", pkg.dsh?.bundle?.patch === "./cordis.patch.yml", String(pkg.dsh?.bundle?.patch));
check("dsh.client.platform is web", pkg.dsh?.client?.platform === "web", String(pkg.dsh?.client?.platform));
check("dsh.client.inject lists the conversation bundle", (pkg.dsh?.client?.inject || []).includes("@deepseek-ai/dsh-client-ui-conversation"));
check("dsh.client.immediately is true", pkg.dsh?.client?.immediately === true);
check("files array lists the shipped dirs", Array.isArray(pkg.files) && pkg.files.length >= 6, JSON.stringify(pkg.files || []));
check("bin entry exists on disk", Boolean(pkg.bin) && existsSync(join(ROOT, Object.values(pkg.bin)[0])), JSON.stringify(pkg.bin || {}));

// pre-release host: a plain ^0.0.1 range would silently exclude rc builds
const peer = pkg.peerDependencies?.["@deepseek-ai/cordis"] || "";
check("cordis peer range covers the rc branch", /rc\./.test(peer) && peer.includes("||"), peer);
check("no runtime dependency on @deepseek-ai packages", !Object.keys(pkg.dependencies || {}).some((d) => d.startsWith("@deepseek-ai/")), JSON.stringify(pkg.dependencies || {}));
check("keywords include dsh-plugin", (pkg.keywords || []).includes("dsh-plugin"), JSON.stringify(pkg.keywords || []));

// ---------------------------------------------------------------- 2. cordis patch

const patch = read("cordis.patch.yml");
check("cordis.patch.yml has an insert block", patch.includes("- insert:"));
check("cordis.patch.yml inserts this package", new RegExp(`name: ["']?${pkg.name}["']?`).test(patch), patch.trim().split("\n").slice(-3).join(" / "));

// ---------------------------------------------------------------- 3. host half

const hostSrc = read("index.js");
const mediaSrc = read("lib/media.mjs");
const cliSrc = read("bin/vstt.mjs");
check("host half exports webServer injection", /inject\s*=\s*\[[^\]]*"webServer"/.test(hostSrc));
check("host half registers exactly-two exact routes", (hostSrc.match(/kind:\s*["']exact["']/g) || []).length === 2, String((hostSrc.match(/kind:\s*["']exact["']/g) || []).length));
check("host half gates writes with the custom header", hostSrc.includes("x-dsh-voice-transcribe"));
check("path guard lives in lib/media.mjs and rejects non-absolute paths", mediaSrc.includes("isAbsolute") && mediaSrc.includes("resolve("), "");
check("path guard accepts a folder (batch mode)", mediaSrc.includes("isDirectory") && mediaSrc.includes("MAX_BATCH_FILES"));
check("path guard tolerates quoted paths from Explorer", mediaSrc.includes("^\\\"(.*)\\\"$") || mediaSrc.includes('cleanPath'));
check("host half transcribes folders as a batch", hostSrc.includes('mode: "batch"'));
check("CLI accepts a folder too", cliSrc.includes("resolveTarget") && cliSrc.includes('"batch"'));

const hostModule = await import(pathToFileURL(join(ROOT, "index.js")).href);
check("host module imports cleanly", typeof hostModule.apply === "function", typeof hostModule.apply);
check("host module declares name", typeof hostModule.name === "string" && hostModule.name.length > 0, String(hostModule.name));

// ---------------------------------------------------------------- 4. client half

const clientSrc = read("client.js");
check("client loads through __ModuleLoader__", clientSrc.includes("window.__ModuleLoader__.load"));
check("client id matches package name", clientSrc.includes(`id: "${pkg.name}"`) || clientSrc.includes(`id: '${pkg.name}'`));
check("client injects slots + locale", /inject:\s*\[\s*["']slots["']\s*,\s*["']locale["']/.test(clientSrc));
check("client registers into the left toolbar", clientSrc.includes("conversation.input.left"));
check("client registers into the overlay layer", clientSrc.includes("conversation.input.overlay"));
check("client never calls a non-existent slots.render", !clientSrc.includes(".slots.render"));
check("client inserts drafts via the official API", clientSrc.includes("captureInsertion") && clientSrc.includes("insertText"));
check("client keeps composer focus on mousedown", clientSrc.includes("preventDefault"));
check("client exposes a debug seam", clientSrc.includes("__dshVoiceTranscribe"));
check("client has zh + en dictionaries", clientSrc.includes("zh:") && clientSrc.includes("en:"));

// ---------------------------------------------------------------- 5. engine + tooling

const engine = read("engine/vstt_engine.py");
check("engine keeps the SenseVoice path", engine.includes("sherpa_onnx") && engine.includes("SenseVoice"));
check("engine keeps the gain normaliser", engine.includes("normalize_gain"));
check("engine keeps the digital-silence guard", engine.includes("0.0005"));
check("engine keeps silence-based segmentation", engine.includes("segment_ranges"));
check("engine is path-parameterised (no E:\\tools hardcode)", !/E:\\\\tools|E:\/tools/.test(engine));
check("engine honours VSTT_HOME / VSTT_MODEL_DIR", engine.includes("VSTT_HOME") && engine.includes("VSTT_MODEL_DIR"));
check("engine requirements exist", existsSync(join(ROOT, "engine", "requirements.txt")));
check("model fetcher exists", existsSync(join(ROOT, "tools", "fetch-model.mjs")));
check("installer exists", existsSync(join(ROOT, "tools", "install.mjs")));

// ---------------------------------------------------------------- 6. bundled skill

const skill = read(join("skills", "voice-transcribe", "SKILL.md"));
const front = /^---\n([\s\S]*?)\n---\n/.exec(skill);
check("skill has frontmatter", Boolean(front));
check("skill frontmatter declares name voice-transcribe", Boolean(front) && /name:\s*voice-transcribe/.test(front[1]));
check("skill description has a description long enough for triggers", Boolean(front) && front[1].split("description:")[1].length > 120);

// ---------------------------------------------------------------- 7. CLI runs

const cli = join(ROOT, "bin", "vstt.mjs");
const out = spawnSync(process.execPath, [cli, "status", "--json"], { encoding: "utf8", timeout: 60_000 });
const lastLine = (out.stdout || "").trim().split("\n").filter(Boolean).pop() || "";
let status = null;
try {
	status = JSON.parse(lastLine);
} catch {
	status = null;
}
check("`vstt status --json` exits 0", out.status === 0, `exit ${out.status} ${(out.stderr || "").slice(0, 200)}`);
check("`vstt status --json` prints one JSON line", status !== null, lastLine.slice(0, 160));
check("status reports a boolean ready flag", status !== null && typeof status.ready === "boolean", JSON.stringify(status && { ready: status.ready, modelReady: status.modelReady }));

// ---------------------------------------------------------------- report

const pad = Math.max(...results.map((r) => r.label.length));
for (const r of results) {
	const line = `${r.ok ? "PASS" : "FAIL"}  ${r.label.padEnd(pad)}${r.ok || !r.detail ? "" : `  <- ${r.detail}`}`;
	process.stdout.write(`${line}\n`);
}
process.stdout.write(`\n${results.length - failed}/${results.length} checks passed\n`);
if (failed > 0) {
	process.stdout.write(`${failed} FAILED\n`);
	process.exit(1);
}
process.stdout.write("ALL PASS\n");
