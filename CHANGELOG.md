# Changelog

## 0.1.0 — 2026-10-24

首个可发布版本。

- 浏览器面板：输入框工具行的 ⧉ 按钮，选择本地音视频、转写、把结果插进草稿，记住最近 5 条路径。
- 宿主路由：`GET /dsh-voice-transcribe/status`、`POST /dsh-voice-transcribe/transcribe`，自定义头闸门、绝对路径 + 扩展名白名单、16 KB body 上限、30 分钟超时。
- CLI `dsh-vstt`：`setup / doctor / status / transcribe / mic`，全部支持 `--json`。
- 引擎：SenseVoice-Small int8（sherpa-onnx），保留双引擎与 whisper 回退；AGC 用 95 分位帧能量 + 99.9 分位鲁棒峰值；数字静音守卫；0.30 s 静音切段、单段 ≤25 s；ITN。
- 自带 `voice-transcribe` 技能，agent 可直接调 CLI 转写长音视频。
- `tools/install.mjs` 五步幂等安装；`tools/fetch-model.mjs` 支持 HF 官方与国内镜像；`dev/verify.mjs` 45 项契约冒烟。
