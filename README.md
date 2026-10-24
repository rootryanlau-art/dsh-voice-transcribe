# dsh-voice-transcribe

仓库：<https://github.com/rootryanlau-art/dsh-voice-transcribe>（MIT）

把本机的**音频 / 视频文件**离线转成文字，供 agent 直接调用。

在 DSH 里它是三件东西合起来的一个插件包：

- **浏览器面板** — 输入框工具栏上的 ⧉ 按钮，选文件、转写、把结果一键插进草稿；
- **宿主路由** — `/dsh-voice-transcribe/transcribe`，面板用它调引擎；
- **CLI + 技能** — `dsh-vstt` 命令行与自带的 `voice-transcribe` 技能，让 agent 能批量转写长音视频（会议、访谈、录屏）。

引擎是 **SenseVoice-Small int8**（阿里 FunAudioLLM，Apache-2.0）+ sherpa-onnx，纯 CPU、纯本地，音频不出这台机器、不联网、不要 API key。

> **和 `dsh-hold-to-talk` 的区别**：那个是「按住输入框说话、边说边出字」，解决的是**输入框听写**；这个解决的是**桌上已有的音视频文件**——一场 90 分钟的会议、一集录屏、一段访谈。两者互补，可以同时装。

## 安装

```bash
# 从市场（收录后）
dsh plugin add dsh-voice-transcribe

# 或者从本地 checkout
node tools/install.mjs            # 写 profile 依赖 + bundle + junction + patch + 技能
node bin/vstt.mjs setup           # 私有 Python venv + SenseVoice 模型（约 239 MB，一次）
# 国内网络建议走镜像，否则默认 PyPI 可能十几分钟拉不完：
node bin/vstt.mjs setup --index https://pypi.tuna.tsinghua.edu.cn/simple
```

`tools/install.mjs` 支持 `--profile <目录>`、`--dry-run`、`--no-skill`；改动前都会备份（`.bak-<时间戳>-voice-transcribe`）。

装完重启 DSH（或刷新页面），输入框工具行会出现 ⧉。

## 用法

### 面板

点 ⧉ → 填/选一个本地文件路径（会记住最近 5 条）→ 选语言 → 转写 → 结果可「插入输入框」或复制。

路径先在本机转写，再把文本交给模型，所以**不用先把几十兆音频塞进对话**。

### CLI

```bash
dsh-vstt status --json                     # 环境就绪情况
dsh-vstt doctor                            # 人读的诊断
dsh-vstt transcribe "D:\会议\r1.m4a" --json # {engine,duration,rtf,segments,text}
dsh-vstt transcribe "D:\会议\r1.m4a" -o out # 额外写 out\r1.stt.txt
dsh-vstt mic --seconds 10                  # 麦克风口述（可选依赖）
```

- `--json` 输出**一行** JSON（引擎日志走 stderr）；`--lang zh|en|yue|ja|ko`；`--engine sensevoice|whisper`。
- 非 wav 用 ffmpeg 转换；没有 ffmpeg 就让用户给 16 kHz 单声道 wav，或用 `VSTT_FFMPEG` 指一个可执行文件。

## 环境变量

| 变量 | 作用 |
|---|---|
| `VSTT_HOME` | 数据目录（默认 `~/.dsh/voice-transcribe`） |
| `VSTT_VENV` | 私有 venv 位置 |
| `VSTT_PYTHON` | 直接用某个 python（跳过 venv 检查） |
| `VSTT_MODEL_DIR` | SenseVoice 模型目录 |
| `VSTT_FFMPEG` | ffmpeg 可执行文件 |
| `VSTT_PIP_INDEX` | `setup` 装依赖用的 PyPI 镜像，例如 `https://pypi.tuna.tsinghua.edu.cn/simple`（等价于 `setup --index <url>`；国内不设会明显更慢） |

## 实测

`E:\tools\stt\test\ref.wav`（23.70 s，中文女声）：

| 引擎 | 耗时 | RTF | CER |
|---|---|---|---|
| SenseVoice int8（本插件） | 0.79 s ASR（另 1.38 s 模型加载） | 0.033 ≈ 30× 实时 | 0 % |
| whisper-small + initial_prompt | 4.86 s | 0.205 | 3.3 % |
| whisper-small 原样 | — | — | 39.6 %（一半是繁体） |

71.1 s 长音频切成 18 段共 3.64 s，CER 0 %；衰减 40 dB（−63 dBFS）后 CER 仍 0 %。真实 71 s 素材上 SenseVoice 3.55 s 全对，whisper 17.19 s 且带繁体错字。

## 局限

- 无说话人分离：双人访谈会是一整段。
- 无热词表：专有名词可能同音错。
- 非流式：整段录完再识别（`mic` 40 s 语音约 1 s 出字）；边录边出字请用 `dsh-hold-to-talk`。
- 长文件按 0.30 s 静音切段、单段 ≤25 s，正好切在词中间时可能漏字。
- 数字与标点做 ITN 规整，别手动改回去。

## 开发

```bash
node dev/verify.mjs          # 45 项契约冒烟，不需要浏览器、不需要 venv
node tools/fetch-model.mjs   # 只下模型（--mirror cn 走 HF 镜像）
```

## License

MIT。第三方：SenseVoice-Small Apache-2.0；sherpa-onnx Apache-2.0；ffmpeg 由其自身许可决定（LGPL/GPL）。
