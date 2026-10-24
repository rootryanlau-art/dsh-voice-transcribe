---
name: voice-transcribe
description: Transcribe a local audio or video file into text with the offline SenseVoice engine installed by the dsh-voice-transcribe plugin — meetings, lectures, interviews, screen recordings, voice memos. Use when the user asks to 转写 / 语音转文字 / 把这段录音变成文字 / 会议纪要 / subtitle a local media file, or pastes a path ending in .m4a .mp3 .wav .mp4 .mkv .mov and wants the words. Not for live microphone dictation (that is the composer's hold-to-talk button).
---

# voice-transcribe

Turn a local audio/video file into text. Everything runs on this machine:
SenseVoice int8 via sherpa-onnx, CPU, no API key, no network at run time.

## When to use

- The user points at a local media file and wants its words: 会议录音、访谈、课程、录屏、语音备忘录。
- The user wants a transcript to summarize, quote, or turn into meeting notes.
- A video needs subtitles or a searchable text copy.

Do **not** use it for: live microphone dictation (the composer's hold-to-talk
plugin covers that), cloud transcription of a URL, or speaker diarization
(not supported).

## Locate the CLI

The plugin is linked into the active profile, so the canonical path is:

```
node ~/.dsh/profiles/desktop/node_modules/dsh-voice-transcribe/bin/vstt.mjs status --json
```

If that path is missing, the package is not installed into this profile — check
for a checkout (`<repo>/bin/vstt.mjs`) or ask the user to install it. Never
reimplement transcription with another tool when the plugin is present.

## Commands

```bash
CLI="node ~/.dsh/profiles/desktop/node_modules/dsh-voice-transcribe/bin/vstt.mjs"

$CLI status --json          # { ready, modelReady, python, modelDir, version }
$CLI doctor                 # human-readable engine report
$CLI transcribe "<file>" --json   # { engine, duration, rtf, segments:[{start,end,text}], text }
$CLI transcribe "<file>" -o "<dir>"  # also writes <stem>.stt.txt
$CLI mic --seconds 10       # microphone dictation (optional packages)
```

Notes:

- `--json` prints one JSON object on the **last line** of stdout; engine logs go
  to stderr. Parse the last non-empty stdout line.
- `--lang` accepts `zh` (default), `en`, `yue`, `ja`, `ko`.
- Non-wav input is converted with ffmpeg; if ffmpeg is missing, ask for a `.wav`
  16 kHz mono file or set `VSTT_FFMPEG` to an ffmpeg executable.
- Rough speed: ~30× real time on CPU, so a 30-minute meeting takes about a minute.

## First run

If `status --json` reports `ready: false`, the private Python environment or the
model is missing. Ask before spending bandwidth — the model is ~239 MB:

```bash
node <plugin>/bin/vstt.mjs setup          # venv + model, one time
node <plugin>/bin/vstt.mjs setup --no-model   # venv only, then fetch the model yourself
```

## Reporting back

Give the user the transcript text, not just a path. Include the audio duration
and (when it matters) the segment timestamps. Mention the engine line printed on
stderr only if the user asks how it was produced, or if it fell back to whisper.

## Limits

- No speaker separation; a two-person interview comes back as one stream.
- Long files are segmented at 0.30 s silence with 25 s caps, so a word split
  exactly at a cut can be misheard.
- Numbers and punctuation are normalized (ITN); do not "fix" them back.
- No hotword list yet — proper nouns may come out homophonically wrong; keep the
  user's names in mind and ask before rewriting them.
