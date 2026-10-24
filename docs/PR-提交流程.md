# 提 PR 实操（手机也能做）

仓库已就绪 → <https://github.com/rootryanlau-art/dsh-voice-transcribe>

**还差三件事**（按顺序）：

1. **加 topic**：仓库页 → 右侧 About 旁边的齿轮 ⚙ → Topics 填 `dsh-plugin`（可再加 `voice`、`asr`、`sensevoice`）→ 保存。
2. **等满 1 天**：仓库创建于 2026-10-24 08:58 UTC / 16:58 北京时间，CI 查"仓库满 1 天"，所以最早 **2026-10-25 16:58（北京时间）之后** 提 PR。
3. **提 PR**（下面 §2）。

---

## 1. 目标与规则（一句话版）

插电市场的目录来自精选仓库 <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>，
**没有独立投稿入口**：给它提一个 PR，只加**一个文件** `data/plugins/rootryanlau-art__dsh-voice-transcribe.yml`。
一个 PR 最多 3 条；PR 里只改自己那一条。

## 2. 手机/网页提 PR 的步骤

1. 打开 <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin> → 右上 **Fork**（Fork 到你自己的账号下）。
2. 在你的 fork 里点 **Add file → Create new file**。
3. 文件名填（**注意不是** `data/plugins/`，是它下面的一层）：

   ```
   data/plugins/rootryanlau-art__dsh-voice-transcribe.yml
   ```

   > 在文件名输入框里直接敲 `/` 会自动建目录。

4. 内容逐字复制本仓库的 `market/data/plugins/rootryanlau-art__dsh-voice-transcribe.yml`：

   ```yaml
   url: https://github.com/rootryanlau-art/dsh-voice-transcribe
   name: rootryanlau-art/dsh-voice-transcribe
   category: voice
   description:
     en: Transcribe local audio and video files offline with a composer panel, a CLI, and an agent skill, powered by SenseVoice int8.
     zh: 在输入框面板、命令行与 agent 技能里离线转写本地音视频文件，引擎为 SenseVoice int8。
   ```

5. 提交（Commit changes）→ 回到该仓库首页，会出现 **Compare & pull request** → 点它。
6. 标题与正文用 §3 的文案 → **Create pull request**。

## 3. PR 文案（可直接粘贴）

**标题**

```
Add rootryanlau-art/dsh-voice-transcribe
```

**正文**

```markdown
Adds `dsh-voice-transcribe`: offline audio/video transcription for DSH.

**What it does**

- A `⧉` button left of the composer opens a panel: pick a local audio/video file, transcribe it, then insert the text straight into the draft. Nothing is uploaded — inference runs locally.
- A CLI (`dsh-vstt transcribe|status|doctor|setup|mic`, `--json` output) so an agent can batch-transcribe long recordings.
- A bundled agent skill (`voice-transcribe`) that tells the agent when and how to call that CLI.

**Engine**

SenseVoice-Small int8 via sherpa-onnx 2.0.0 + onnxruntime, running in a private Python venv created by `setup`. The 228 MB model is fetched from Hugging Face (mirror fallback included). No API key, no network at inference time.

**Measured on a 23.70 s Chinese reference clip**

- SenseVoice int8: CER 0.0 %, 0.74 s ASR time, RTF 0.031 (~32× real time)
- whisper-small int8 for comparison: CER 39.6 % as-is, 3.3 % with an `initial_prompt`

**Files**

- `package.json` declares `dsh.bundle` (`cordis.patch.yml`) and `dsh.client` (`platform: web`); cordis peer range includes the rc branch.
- `screenshots.json` + `screenshots/panel.png` (taken from a real run).
- MIT licensed; third-party notices for SenseVoice (Apache-2.0), sherpa-onnx and ffmpeg are in `LICENSE`.

**Differentiation from `wangzhanchao883/dsh-hold-to-talk`**

`dsh-hold-to-talk` covers live microphone dictation inside the composer. This plugin deliberately does not: it targets **local files** (meetings, lectures, screen recordings, videos — long-form media) and exposes the same engine to the agent as a CLI, so transcription can be scripted and batched.

**Not included (on purpose)**

Speaker diarization, hotword lists, and streaming partial results.
```

## 4. 合并之后

- 目录会自动重建，`dshmarket` 里出现本插件；
- （可选）发 npm 包可在市场显示下载量：`npm publish`。本机没有 npm token，需要你自己登录；
  不发 npm 也可以——用户用 `dsh plugin add <git url>` 或市场一键装即可。

## 5. 万一 CI 报错，对照这几条

| CI 检查 | 本仓库对应事实 |
|---|---|
| `package.json` 有 `dsh.bundle` | 有：`"bundle": {"patch": "./cordis.patch.yml"}` |
| 有 `cordis.patch.yml` | 有，`- insert: [{id: voice-transcribe, name: 'dsh-voice-transcribe'}]` |
| `url` 与仓库完全一致 | `https://github.com/rootryanlau-art/dsh-voice-transcribe`（无 `.git`、无尾斜杠） |
| `name` = owner/repo | `rootryanlau-art/dsh-voice-transcribe` |
| `description.en` 以句号结尾 | 是 |
| 截图 | 根目录 `screenshots.json` → `screenshots/panel.png`（真实截图） |
| 仓库满 1 天 | 2026-10-25 16:58（北京时间）之后 |
| topic `dsh-plugin` | 见 §0 第 1 条，需手动加 |
