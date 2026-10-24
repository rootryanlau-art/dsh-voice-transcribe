#!/usr/bin/env node
// Install `dsh-voice-transcribe` into a DSH profile, from this checkout.
//
//   node tools/install.mjs [--profile <dir>] [--dry-run] [--no-skill]
//
// What it does, all idempotent, every touched file backed up first:
//   1. profile/package.json  -> dependencies["dsh-voice-transcribe"] = file:<this dir>
//   2. profile/package.json  -> dsh.profile.bundles += "dsh-voice-transcribe"
//   3. node_modules/<name>   -> junction pointing back here (no copy to keep in sync)
//   4. profile/cordis.patch.yml -> one managed insert block
//   5. ~/.dsh/skills/voice-transcribe -> the bundled skill, so the agent knows the CLI
//
// The engine itself (Python venv + 239 MB model) is NOT installed here; run
// `node bin/vstt.mjs setup` afterwards, or use the panel's “check engine” button.
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
const NAME = PACKAGE.name;
const BLOCK_ID = "voice-transcribe";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const noSkill = argv.includes("--no-skill");
const profileArg = argv.indexOf("--profile");
const profileDir = resolve(
	profileArg >= 0 && argv[profileArg + 1] ? argv[profileArg + 1] : join(homedir(), ".dsh", "profiles", "desktop")
);

function log(line = "") {
	process.stdout.write(`${line}\n`);
}

function stamp() {
	return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

function backup(file) {
	if (!existsSync(file)) return null;
	const target = `${file}.bak-${stamp()}-voice-transcribe`;
	if (!dryRun) writeFileSync(target, readFileSync(file));
	return target;
}

function lstatExists(target) {
	try {
		lstatSync(target);
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------- 前置检查

if (!existsSync(join(profileDir, "package.json"))) {
	process.stderr.write(`no DSH profile at ${profileDir}\nuse --profile <dir> to point at one\n`);
	process.exit(10);
}
log(`profile : ${profileDir}`);
log(`package : ${PACKAGE_ROOT}`);
log(dryRun ? "mode    : dry run, nothing is written\n" : "");

// ---------------------------------------------------------------- 1+2. profile package.json

const profileFile = join(profileDir, "package.json");
const profile = JSON.parse(readFileSync(profileFile, "utf8"));
const spec = `file:${PACKAGE_ROOT.replace(/\\/g, "/")}`;
profile.dependencies = profile.dependencies || {};
profile.dsh = profile.dsh || {};
profile.dsh.profile = profile.dsh.profile || {};
profile.dsh.profile.bundles = Array.isArray(profile.dsh.profile.bundles) ? profile.dsh.profile.bundles : [];

const dependencyChanged = profile.dependencies[NAME] !== spec;
const bundleChanged = !profile.dsh.profile.bundles.includes(NAME);
if (!dependencyChanged && !bundleChanged) {
	log(`deps    : already present (${spec})`);
} else {
	backup(profileFile);
	profile.dependencies[NAME] = spec;
	if (bundleChanged) profile.dsh.profile.bundles.push(NAME);
	if (!dryRun) writeFileSync(profileFile, `${JSON.stringify(profile, null, 2)}\n`);
	log(`deps    : ${dependencyChanged ? `set ${NAME} = ${spec}` : "unchanged"}`);
	log(`bundle  : ${bundleChanged ? `added ${NAME} to dsh.profile.bundles` : "already listed"}`);
}

// ---------------------------------------------------------------- 3. node_modules junction

const linkPath = join(profileDir, "node_modules", NAME);
if (existsSync(linkPath) || lstatExists(linkPath)) {
	const stat = lstatSync(linkPath);
	log(`link    : node_modules/${NAME} ${stat.isSymbolicLink() ? "already a link" : "exists as a real directory, left alone"}`);
} else if (dryRun) {
	log(`link    : would create node_modules/${NAME} -> ${PACKAGE_ROOT}`);
} else {
	mkdirSync(join(profileDir, "node_modules"), { recursive: true });
	try {
		symlinkSync(PACKAGE_ROOT, linkPath, "junction");
		log(`link    : node_modules/${NAME} -> ${PACKAGE_ROOT}`);
	} catch (error) {
		log(`link    : failed (${error.message}); run pnpm install inside the profile afterwards`);
	}
}

// ---------------------------------------------------------------- 4. cordis.patch.yml

const patchFile = join(profileDir, "cordis.patch.yml");
const begin = `# >>> ${NAME} (managed by tools/install.mjs) >>>`;
const end = `# <<< ${NAME} <<<`;
const patchText = existsSync(patchFile) ? readFileSync(patchFile, "utf8") : "";
if (patchText.includes(begin)) {
	log("patch   : managed insert block already present");
} else {
	backup(patchFile);
	const block = [begin, "- insert:", `    - id: ${BLOCK_ID}`, `      name: ${NAME}`, end, ""].join("\n");
	if (!dryRun) writeFileSync(patchFile, `${patchText}${patchText === "" || patchText.endsWith("\n") ? "" : "\n"}${block}`);
	log("patch   : appended one insert block");
}

// ---------------------------------------------------------------- 5. bundled skill

const skillSource = join(PACKAGE_ROOT, "skills", "voice-transcribe");
const skillTarget = join(homedir(), ".dsh", "skills", "voice-transcribe");
if (noSkill) {
	log("skill   : skipped (--no-skill)");
} else if (!existsSync(join(skillSource, "SKILL.md"))) {
	log("skill   : bundled SKILL.md missing, skipped");
} else if (existsSync(join(skillTarget, "SKILL.md"))) {
	log(`skill   : already installed at ${skillTarget}`);
} else if (dryRun) {
	log(`skill   : would copy ${skillSource} -> ${skillTarget}`);
} else {
	mkdirSync(skillTarget, { recursive: true });
	writeFileSync(join(skillTarget, "SKILL.md"), readFileSync(join(skillSource, "SKILL.md")));
	log(`skill   : copied to ${skillTarget}`);
}

// ---------------------------------------------------------------- next steps

log("");
log("next    : 1) node bin/vstt.mjs setup      # private venv + SenseVoice model (~239 MB)");
log("          2) restart DSH (desktop “重启DSH.cmd”) or reload the page");
log("          3) the composer toolbar gets a ⧉ button; the agent can also call the CLI directly");
log(`verify  : node ${join(PACKAGE_ROOT, "dev", "verify.mjs").replace(/\\/g, "/")}`);
