// One-shot generator for the small repo files (UTF-8 safe, unlike PowerShell edits).
//   node tools/gen-docs.mjs
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

// GitHub owner — fill this in once, everything else is generated from it.
const OWNER = "rootryanlau-art";
const REPO = "dsh-voice-transcribe";
const SLUG = `${OWNER}__${REPO}`;
const HOMEPAGE = `https://github.com/${OWNER}/${REPO}`;

function put(rel, body) {
	const file = join(ROOT, rel);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, body.endsWith("\n") ? body : `${body}\n`, "utf8");
	process.stdout.write(`wrote ${rel}\n`);
}

put(
	".gitignore",
	`node_modules/
.venv/
venv/
models/
*.bak-*
*.log
logs/
out/
.DS_Store
Thumbs.db
screenshots/*.tmp.png
`
);

put(
	"CHANGELOG.md",
	`# Changelog

## ${pkg.version} — 2026-10-24

首个可发布版本。

- 浏览器面板：输入框工具行的 ⧉ 按钮，选择本地音视频、转写、把结果插进草稿，记住最近 5 条路径。
- 宿主路由：\`GET /dsh-voice-transcribe/status\`、\`POST /dsh-voice-transcribe/transcribe\`，自定义头闸门、绝对路径 + 扩展名白名单、16 KB body 上限、30 分钟超时。
- CLI \`dsh-vstt\`：\`setup / doctor / status / transcribe / mic\`，全部支持 \`--json\`。
- 引擎：SenseVoice-Small int8（sherpa-onnx），保留双引擎与 whisper 回退；AGC 用 95 分位帧能量 + 99.9 分位鲁棒峰值；数字静音守卫；0.30 s 静音切段、单段 ≤25 s；ITN。
- 自带 \`voice-transcribe\` 技能，agent 可直接调 CLI 转写长音视频。
- \`tools/install.mjs\` 五步幂等安装；\`tools/fetch-model.mjs\` 支持 HF 官方与国内镜像；\`dev/verify.mjs\` 45 项契约冒烟。
`
);

// The entry goes into the awesome-dsh-plugin PR as data/plugins/<owner>__<repo>.yml
put(
	`market/data/plugins/${SLUG}.yml`,
	`url: ${HOMEPAGE}
name: ${OWNER}/${REPO}
category: voice
description:
  en: Transcribe local audio and video files offline with a composer panel, a CLI, and an agent skill, powered by SenseVoice int8.
  zh: 在输入框面板、命令行与 agent 技能里离线转写本地音视频文件，引擎为 SenseVoice int8。
`
);

put(
	"docs/上架步骤.md",
	`# 上架步骤（awesome-dsh-plugin）

插电市场（dshmarket）的目录来自精选仓库 <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>，
**没有独立投稿入口**：仓库可装 + 往那个仓库提一个 PR，只加一条 \`data/plugins/${SLUG}.yml\`。

owner 已填好：\`${OWNER}\`，仓库将建在 <${HOMEPAGE}>。

## 0. 前置

- GitHub 账号已有（\`${OWNER}\`）。
- 本机已有**便携版 git**：\`E:\\tools\\git\\cmd\\git.exe\`（2.56.0）。仓库已在本地 \`git init\` 并提交（22 个文件，commit \`abeaf06\`），branch = \`main\`。
- 本机网络实况：**\`github.com:443\` 不通**（HTTPS 与 Web 都超时），但 **SSH 22 端口通**。→ 推仓库只能走 SSH。
- 已生成 SSH 密钥：\`C:\\Users\\win\\.ssh\\id_ed25519_gh_dsh_voice\`（公钥同目录 \`.pub\`），并写好 \`~/.ssh/config\` 让 \`github.com\` 自动用它；\`git remote\` 已设为 \`git@github.com:${OWNER}/${REPO}.git\`。
- **还差两步需要你在能上 GitHub 的环境里做**：① 把公钥贴到 GitHub → Settings → SSH and GPG keys；② 在 GitHub 上建 public 仓库 \`${REPO}\`（别勾 README/License）。做完告我一声，剩下的 \`git push -u origin main\` 我来跑。
- 不想配 SSH 的话还有网页上传路线：\`C:\\Users\\win\\Desktop\\dsh-voice-transcribe-0.1.0-upload.zip\`（103 KB，来自 \`git archive\`，不含 venv/models）→ GitHub 仓库页 Add file → Upload files 直接拖进去。
- 仓库创建满 **1 天** 后才能提 PR（CI 会查）。

1. 建仓库 \`${OWNER}/${REPO}\`（public），把本目录（除 \`models/\`、\`venv/\`、\`node_modules/\`）推上去。
2. 仓库 Settings → Topics 加 \`dsh-plugin\`。
3. 等满 1 天。

## 1. 已替你准备好的部分

- \`market/data/plugins/${SLUG}.yml\` — 市场条目，可直接放进 PR。
- \`package.json\` 已带 \`repository\` / \`homepage\` / \`bugs\`，指向 <${HOMEPAGE}>。
- README 里已写仓库地址。

提交 PR 时，只把 \`market/data/plugins/${SLUG}.yml\` 复制成 awesome-dsh-plugin 仓库里的同路径文件即可，内容不用改。

## 2. 截图（CI 会查）

仓库根放 \`screenshots.json\`，1–8 张**相对路径**的 png（不许越出仓库目录，绝对 URL 只接受 GitHub 托管的 https）。建议两张：

1. \`screenshots/panel.png\` — 输入框 ⧉ 面板展开、一条转写结果；
2. \`screenshots/cli.png\` — 终端里 \`dsh-vstt transcribe ... --json\` 与结果。

已经拍好 \`screenshots/panel.png\`（真实运行里点开 ⧉ 的面板，暗色主题）。要补 CLI 图时：

拍法：重启 DSH → 点 ⧉ → 拖一张自己录的语音进去 → Win+Shift+S 截图存到 \`screenshots/\`。
**截图必须来自真实运行**，别用示意图（维护者会读源码，也会对照截图）。

\`\`\`json
{ "screenshots": ["screenshots/panel.png"] }
\`\`\`

## 3. （可选但推荐）发 npm

好处：用户 \`dsh plugin add\` 不用 \`allowBuilds\`，市场页显示下载量。要求包 \`repository\` 指回被收录的仓库。

\`\`\`bash
npm login
npm publish --access public
\`\`\`

不发 npm 也行：在 GitHub Release 挂一个预构建 \`.tgz\`，在 yml 里用 \`tarball:\` 指向
\`${HOMEPAGE}/releases/latest/download/${REPO}.tgz\`
（\`latest/download/\` 下的文件名不能带版本号）。

## 4. 提 PR

- fork \`awesome-dsh-plugin/awesome-dsh-plugin\`；
- 只加/改你自己那一条 \`data/plugins/${SLUG}.yml\`；
- 一个 PR 最多 3 条；
- 描述与代码必须对得上，不写营销词。

\`\`\`yaml
url: ${HOMEPAGE}
name: ${OWNER}/${REPO}
category: voice
description:
  en: Transcribe local audio and video files offline with a composer panel, a CLI, and an agent skill, powered by SenseVoice int8.
  zh: 在输入框面板、命令行与 agent 技能里离线转写本地音视频文件，引擎为 SenseVoice int8。
\`\`\`

## 5. 自检清单

- [ ] \`node dev/verify.mjs\` → \`ALL PASS\`（45 项）
- [ ] \`node tools/install.mjs --dry-run\` 无报错
- [ ] 真实跑过一次 \`dsh-vstt transcribe\`，出字正确
- [ ] \`package.json\` 有 \`dsh.bundle.patch\` **和** \`dsh.client.platform\`（只声明 client 会被拒）
- [ ] \`peerDependencies\` 的 cordis 范围带 rc 分支
- [ ] 仓库有 \`dsh-plugin\` topic、创建满 1 天
- [ ] \`screenshots.json\` 里的图真实存在
`
);

put(
	"market/README.md",
	`# market/

\`data/plugins/${SLUG}.yml\` 是准备提给
<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin> 的条目（owner 已填 \`${OWNER}\`），
按 [\`../docs/上架步骤.md\`](../docs/上架步骤.md) 提交。
`
);

// Drop the placeholder entry from earlier runs, if any.
try {
	rmSync(join(ROOT, "market/data/plugins/_OWNER__dsh-voice-transcribe.yml"), { force: true });
	process.stdout.write("removed market/data/plugins/_OWNER__dsh-voice-transcribe.yml\n");
} catch {
	/* already gone */
}

process.stdout.write("\ndone\n");
