# Changelog

## 0.2.0 — 2026-10-24

路径可以填**文件夹**了（这是实际用起来第一个卡住人的地方：指着「录音」目录点转写会报 `not a file`）。

- 面板 / CLI / 宿主路由统一支持文件夹：批量转写目录里的音视频，**最新的排前面**、最多 20 个，
  输出按 `【文件名】` 分段；面板顶部显示「已批量转写 N/M 个文件（最新的优先）」。
- 路径容错：兼容资源管理器「复制文件地址」带引号的路径、正斜杠路径；错误文案区分
  「路径不存在 / 是空文件 / 扩展名不支持 / 文件夹里没有音视频」。
- 新增 `lib/media.mjs`：路径解析与媒体枚举由宿主路由和 CLI 共用（`resolveTarget()`）。
- `dev/verify.mjs` 45 → 49 项（新增文件夹批量、引号容错、CLI 同步支持等契约）。

## 0.1.0 — 2026-10-24

首个可发布版本。

- 浏览器面板：输入框工具行的 ⧉ 按钮，选择本地音视频、转写、把结果插进草稿，记住最近 5 条路径。
- 宿主路由：`GET /dsh-voice-transcribe/status`、`POST /dsh-voice-transcribe/transcribe`，自定义头闸门、绝对路径 + 扩展名白名单、16 KB body 上限、30 分钟超时。
- CLI `dsh-vstt`：`setup / doctor / status / transcribe / mic`，全部支持 `--json`。
- 引擎：SenseVoice-Small int8（sherpa-onnx），保留双引擎与 whisper 回退；AGC 用 95 分位帧能量 + 99.9 分位鲁棒峰值；数字静音守卫；0.30 s 静音切段、单段 ≤25 s；ITN。
- 自带 `voice-transcribe` 技能，agent 可直接调 CLI 转写长音视频。
- `tools/install.mjs` 五步幂等安装；`tools/fetch-model.mjs` 支持 HF 官方与国内镜像；`dev/verify.mjs` 45 项契约冒烟。
