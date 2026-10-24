/**
 * 语音转写 · dsh-voice-transcribe —— 浏览器半区。
 *
 * 这段代码不是被 import 的，而是被 DSH 客户端模块加载器当脚本文本取走、
 * 在页面里执行。约定：
 *   1. 调用 window.__ModuleLoader__.load({ id, factory })
 *   2. id 必须等于 package.json 里的包名
 *   3. factory(require) 里用 require('react') 拿 React（宿主模块表提供，不要自己装）
 *   4. factory 只返回插件对象，副作用放在 apply 里
 *
 * 它做三件事：
 *   - 在输入框工具行画一个 ⧉（槽位 conversation.input.left）
 *   - 点开后浮出一个面板（槽位 conversation.input.overlay）：填本地音视频路径 → 转写
 *   - 转写结果一键插到草稿的光标处（官方 inputActions.insertText）
 *
 * 真正的转写在宿主半区（index.js）+ Python 引擎里跑，浏览器只发一个同源请求，
 * 所以不碰文件系统、不要 Node 权限，也不 require 任何 @deepseek-ai/* 包。
 */

window.__ModuleLoader__.load({
  id: 'dsh-voice-transcribe',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // ------------------------------------------------------------ 常量

    const TOGGLE_SLOT = 'conversation.input.left'
    const PANEL_SLOT = 'conversation.input.overlay'
    const NS = 'voice-transcribe'
    const GATE_HEADER = 'x-dsh-voice-transcribe'
    const GATE_VALUE = 'run'
    const STATUS_URL = '/dsh-voice-transcribe/status'
    const TRANSCRIBE_URL = '/dsh-voice-transcribe/transcribe'
    const RECENT_KEY = 'dsh-voice-transcribe.recent'
    const RECENT_MAX = 5
    const PANEL_WIDTH = 420
    const LANGS = ['zh', 'en', 'yue', 'ja', 'ko']

    // 槽位注册是常驻的：面板组件一直在，靠这个模块级 store 决定「开还是关」。
    const store = { open: false, anchor: null }
    const listeners = new Set()

    function emit() {
      listeners.forEach((fn) => {
        try {
          fn()
        } catch {
          /* 一个订阅者出错不影响别的 */
        }
      })
    }

    function setStoreOpen(open, anchor) {
      store.open = Boolean(open)
      store.anchor = anchor || null
      emit()
    }

    function subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    }

    const DICT = {
      zh: {
        toggleShow: '语音转写：把本地录音/视频转成文字，插到输入框',
        toggleHide: '收起语音转写',
        title: '语音转写',
        hint: '本地离线识别（SenseVoice），音频不出本机',
        pathLabel: '音视频文件路径（本机绝对路径）',
        pathPlaceholder: '例如 D:\\录音\\周会.m4a',
        langLabel: '语言',
        run: '开始转写',
        running: '正在转写…',
        check: '检查环境',
        close: '关闭',
        insert: '插入输入框',
        copy: '复制',
        copied: '已复制',
        recent: '最近用过',
        empty: '先在上面填一个本地音视频文件的绝对路径，再点「开始转写」。',
        notReady: '引擎还没装好：{detail}',
        needPath: '请先填文件路径',
        failed: '转写出错：{message}',
        inserted: '已插入草稿',
        noInput: '输入框没接上，插不进去',
        conflict: '草稿刚变过，再点一次「插入输入框」',
        chars: '{n} 字 / 音频 {dur}s / 用时 {elapsed}s',
        okReady: '引擎就绪：{engine}',
        broke: '语音转写加载出错，已停用这一块界面'
      },
      en: {
        toggleShow: 'Voice transcription: turn a local audio/video file into text in the composer',
        toggleHide: 'Hide voice transcription',
        title: 'Voice transcription',
        hint: 'Local, offline (SenseVoice) — the audio never leaves this machine',
        pathLabel: 'Media file path (absolute, on this machine)',
        pathPlaceholder: 'e.g. D:\\recordings\\standup.m4a',
        langLabel: 'Language',
        run: 'Transcribe',
        running: 'Transcribing…',
        check: 'Check engine',
        close: 'Close',
        insert: 'Insert into composer',
        copy: 'Copy',
        copied: 'Copied',
        recent: 'Recent files',
        empty: 'Paste the absolute path of a local audio or video file above, then press Transcribe.',
        notReady: 'Engine is not set up yet: {detail}',
        needPath: 'Enter a file path first',
        failed: 'Transcription failed: {message}',
        inserted: 'Inserted into the draft',
        noInput: 'The composer input is not available, cannot insert',
        conflict: 'The draft just changed; press Insert again',
        chars: '{n} chars / audio {dur}s / took {elapsed}s',
        okReady: 'Engine ready: {engine}',
        broke: 'Voice transcription failed to load and is disabled'
      }
    }

    // ------------------------------------------------------------ 工具

    function format(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (whole, key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole
      )
    }

    function readRecent() {
      try {
        const raw = window.localStorage.getItem(RECENT_KEY)
        const list = raw ? JSON.parse(raw) : []
        return Array.isArray(list) ? list.filter((item) => typeof item === 'string').slice(0, RECENT_MAX) : []
      } catch {
        return []
      }
    }

    function pushRecent(path) {
      const next = [path, ...readRecent().filter((item) => item !== path)].slice(0, RECENT_MAX)
      try {
        window.localStorage.setItem(RECENT_KEY, JSON.stringify(next))
      } catch {
        /* private mode: recents are a convenience, not a feature */
      }
      return next
    }

    function keepFocus(event) {
      // 不 preventDefault 的话，点按钮会把草稿的光标/选区抢走，插入位置就丢了。
      event.preventDefault()
    }

    function describeError(error) {
      return error instanceof Error ? error.message : String(error)
    }

    /** 把文字插到草稿当前光标处；返回 {ok} 或 {ok:false, reason}。 */
    function insertIntoDraft(actions, text) {
      if (!actions || typeof actions.insertText !== 'function') return { ok: false, reason: 'noInput' }
      let span
      try {
        span = typeof actions.captureInsertion === 'function' ? actions.captureInsertion() : undefined
      } catch {
        span = undefined
      }
      let inserted = false
      try {
        inserted = actions.insertText(text, span)
      } catch {
        inserted = false
      }
      return inserted ? { ok: true } : { ok: false, reason: 'conflict' }
    }

    /** 面板配色：插件拿不到 DSH 的主题变量名，所以直接量页面底色。 */
    function themePalette() {
      let dark = false
      try {
        const probe = window.getComputedStyle(document.body).backgroundColor
        const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(probe || '')
        if (m) {
          const r = Number(m[1])
          const g = Number(m[2])
          const b = Number(m[3])
          dark = 0.2126 * r + 0.7152 * g + 0.0722 * b < 128
        } else if (window.matchMedia) {
          dark = window.matchMedia('(prefers-color-scheme: dark)').matches
        }
      } catch {
        dark = false
      }
      return dark
        ? { bg: '#1f2023', border: 'rgba(255,255,255,0.16)', text: '#e9e9ec' }
        : { bg: '#ffffff', border: 'rgba(0,0,0,0.14)', text: '#1c1c1e' }
    }

    // ------------------------------------------------------------ 组件

    function createComponents(ctx) {
      const t = ctx.locale.bind(NS)

      function withGate(headers) {
        return Object.assign({ [GATE_HEADER]: GATE_VALUE }, headers || {})
      }

      async function callStatus() {
        const response = await fetch(STATUS_URL, { headers: withGate(), cache: 'no-store' })
        if (!response.ok) throw new Error(`status HTTP ${response.status}`)
        return response.json()
      }

      async function callTranscribe(path, lang) {
        const response = await fetch(TRANSCRIBE_URL, {
          method: 'POST',
          headers: withGate({ 'content-type': 'application/json' }),
          body: JSON.stringify({ path, lang })
        })
        let payload = null
        try {
          payload = await response.json()
        } catch {
          payload = null
        }
        if (!response.ok || !payload || payload.ok !== true) {
          throw new Error((payload && payload.error) || `transcribe HTTP ${response.status}`)
        }
        return payload
      }

      function Toggle(props) {
        const [open, setOpen] = React.useState(store.open)
        const buttonRef = React.useRef(null)
        const label = t(open ? 'toggleHide' : 'toggleShow')

        React.useEffect(() => subscribe(() => setOpen(store.open)), [])

        const toggle = React.useCallback((event) => {
          event.preventDefault()
          const box = buttonRef.current && buttonRef.current.getBoundingClientRect()
          const anchor = box ? { left: box.left, top: box.top, bottom: box.bottom, right: box.right } : null
          setStoreOpen(!store.open, anchor)
        }, [])

        React.useEffect(() => {
          if (!open) return undefined
          const onKey = (event) => {
            if (event.key === 'Escape') setStoreOpen(false)
          }
          window.addEventListener('keydown', onKey)
          return () => window.removeEventListener('keydown', onKey)
        }, [open])

        return h(
          'button',
          {
            ref: buttonRef,
            type: 'button',
            title: label,
            'aria-label': label,
            'aria-expanded': open,
            onMouseDown: keepFocus,
            onClick: toggle,
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              height: 28,
              padding: 0,
              border: 'none',
              borderRadius: 8,
              background: open ? 'rgba(99, 132, 255, 0.18)' : 'transparent',
              color: 'inherit',
              cursor: 'pointer',
              fontSize: 15,
              lineHeight: 1,
              opacity: open ? 1 : 0.75
            }
          },
          '⧉'
        )
      }

      function Panel(props) {
        const [path, setPath] = React.useState('')
        const [lang, setLang] = React.useState('zh')
        const [busy, setBusy] = React.useState(false)
        const [notice, setNotice] = React.useState(null)
        const [result, setResult] = React.useState(null)
        const [recent, setRecent] = React.useState(readRecent)
        const [ready, setReady] = React.useState(null)
        const startedAt = React.useRef(0)

        const [visible, setVisible] = React.useState(store.open)
        const [anchor, setAnchor] = React.useState(store.anchor)

        React.useEffect(
          () =>
            subscribe(() => {
              setVisible(store.open)
              setAnchor(store.anchor)
            }),
          []
        )
        const palette = themePalette()
        const style = {
          position: 'fixed',
          zIndex: 40,
          width: Math.min(PANEL_WIDTH, Math.max(280, window.innerWidth - 24)),
          padding: 12,
          borderRadius: 12,
          border: '1px solid ' + palette.border,
          background: palette.bg,
          boxShadow: '0 12px 32px rgba(0, 0, 0, 0.28)',
          color: palette.text,
          maxHeight: '70vh',
          overflow: 'auto',
          fontSize: 13,
          display: 'flex',
          flexDirection: 'column',
          gap: 8
        }
        if (anchor) {
          const left = Math.max(8, Math.min(anchor.left, window.innerWidth - style.width - 8))
          const below = anchor.bottom + 8
          const estimated = 320
          style.left = left
          style.top = below + estimated > window.innerHeight ? Math.max(8, anchor.top - estimated - 8) : below
        } else {
          style.left = 16
          style.bottom = 96
        }

        React.useEffect(() => {
          let alive = true
          callStatus()
            .then((state) => {
              if (alive) setReady(state)
            })
            .catch(() => {
              if (alive) setReady({ ready: false, python: '?', modelMissing: ['engine unreachable'] })
            })
          return () => {
            alive = false
          }
        }, [])

        const transcribe = React.useCallback(async () => {
          const value = path.trim().replace(/^"(.*)"$/, '$1')
          if (!value) {
            setNotice({ kind: 'error', text: t('needPath') })
            return
          }
          setBusy(true)
          setNotice({ kind: 'info', text: t('running') })
          setResult(null)
          startedAt.current = Date.now()
          try {
            const payload = await callTranscribe(value, lang)
            setResult(payload)
            setRecent(pushRecent(value))
            setNotice({
              kind: 'ok',
              text: format(t('chars'), {
                n: payload.text.length,
                dur: payload.duration,
                elapsed: Date.now() - startedAt.current
              })
            })
          } catch (error) {
            setNotice({ kind: 'error', text: format(t('failed'), { message: describeError(error) }) })
          } finally {
            setBusy(false)
          }
        }, [path, lang])

        const insert = React.useCallback(() => {
          if (!result) return
          const outcome = insertIntoDraft(props.inputActions, result.text)
          if (outcome.ok) setNotice({ kind: 'ok', text: t('inserted') })
          else setNotice({ kind: 'error', text: t(outcome.reason === 'noInput' ? 'noInput' : 'conflict') })
        }, [result, props.inputActions])

        const copy = React.useCallback(async () => {
          if (!result) return
          try {
            await navigator.clipboard.writeText(result.text)
            setNotice({ kind: 'ok', text: t('copied') })
          } catch (error) {
            setNotice({ kind: 'error', text: format(t('failed'), { message: describeError(error) }) })
          }
        }, [result])

        if (!visible) return null

        const noticeColor =
          notice && notice.kind === 'error' ? '#d9534f' : notice && notice.kind === 'ok' ? '#2e9e6b' : 'inherit'

        const row = (children) => h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } }, children)

        return h(
          'div',
          {
            role: 'dialog',
            'aria-label': t('title'),
            style,
            onMouseDown: (event) => event.stopPropagation(),
            onKeyDown: (event) => event.stopPropagation()
          },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
            h('strong', { style: { fontSize: 13 } }, t('title')),
            h(
              'button',
              {
                type: 'button',
                onMouseDown: keepFocus,
                onClick: () => setStoreOpen(false),
                title: t('close'),
                style: { border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit', fontSize: 14 }
              },
              '×'
            )
          ),
          h('div', { style: { opacity: 0.7, fontSize: 12 } }, t('hint')),
          h('label', { style: { fontSize: 12, opacity: 0.8 } }, t('pathLabel')),
          h('input', {
            type: 'text',
            value: path,
            spellCheck: false,
            placeholder: t('pathPlaceholder'),
            onChange: (event) => setPath(event.target.value),
            onMouseDown: (event) => event.stopPropagation(),
            style: {
              padding: '6px 8px',
              borderRadius: 8,
              border: '1px solid rgba(128, 128, 128, 0.35)',
              background: 'transparent',
              color: 'inherit',
              fontSize: 12,
              fontFamily: 'inherit'
            }
          }),
          recent.length
            ? h(
                'div',
                { style: { display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center', fontSize: 11 } },
                h('span', { style: { opacity: 0.6 } }, `${t('recent')}:`),
                recent.map((item) =>
                  h(
                    'button',
                    {
                      key: item,
                      type: 'button',
                      title: item,
                      onMouseDown: keepFocus,
                      onClick: () => setPath(item),
                      style: {
                        maxWidth: 140,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        border: '1px solid rgba(128, 128, 128, 0.3)',
                        borderRadius: 6,
                        background: 'transparent',
                        color: 'inherit',
                        cursor: 'pointer',
                        fontSize: 11,
                        padding: '1px 6px'
                      }
                    },
                    item.split(/[\\/]/).pop()
                  )
                )
              )
            : null,
          row([
            h('span', { style: { fontSize: 12, opacity: 0.8 } }, t('langLabel')),
            h(
              'select',
              {
                value: lang,
                onChange: (event) => setLang(event.target.value),
                style: {
                  padding: '4px 6px',
                  borderRadius: 8,
                  border: '1px solid rgba(128, 128, 128, 0.35)',
                  background: 'transparent',
                  color: 'inherit',
                  fontSize: 12
                }
              },
              LANGS.map((code) => h('option', { key: code, value: code }, code))
            ),
            h('span', { style: { flex: 1 } }),
            h(
              'button',
              {
                type: 'button',
                disabled: busy,
                onMouseDown: keepFocus,
                onClick: transcribe,
                style: {
                  padding: '5px 10px',
                  borderRadius: 8,
                  border: 'none',
                  background: busy ? 'rgba(128,128,128,0.35)' : 'rgba(99, 132, 255, 0.9)',
                  color: '#fff',
                  cursor: busy ? 'default' : 'pointer',
                  fontSize: 12
                }
              },
              busy ? t('running') : t('run')
            )
          ]),
          ready && ready.ready === false
            ? h(
                'div',
                { style: { fontSize: 11, color: '#d9534f' } },
                format(t('notReady'), {
                  detail: [ready.modelMissing && ready.modelMissing.length ? `model: ${ready.modelMissing.join(', ')}` : null, ready.python ? `python: ${ready.python}` : null]
                    .filter(Boolean)
                    .join(' · ') || 'run: node bin/vstt.mjs setup'
                })
              )
            : null,
          notice ? h('div', { style: { fontSize: 12, color: noticeColor } }, notice.text) : null,
          result
            ? h('textarea', {
                readOnly: true,
                value: result.text,
                rows: 6,
                onMouseDown: (event) => event.stopPropagation(),
                style: {
                  width: '100%',
                  resize: 'vertical',
                  padding: '6px 8px',
                  borderRadius: 8,
                  border: '1px solid rgba(128, 128, 128, 0.35)',
                  background: 'transparent',
                  color: 'inherit',
                  fontSize: 12,
                  fontFamily: 'inherit',
                  lineHeight: 1.5
                }
              })
            : h('div', { style: { fontSize: 12, opacity: 0.55, lineHeight: 1.5 } }, t('empty')),
          result
            ? row([
                h(
                  'button',
                  {
                    type: 'button',
                    onMouseDown: keepFocus,
                    onClick: insert,
                    style: {
                      padding: '5px 10px',
                      borderRadius: 8,
                      border: 'none',
                      background: 'rgba(46, 158, 107, 0.9)',
                      color: '#fff',
                      cursor: 'pointer',
                      fontSize: 12
                    }
                  },
                  t('insert')
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    onMouseDown: keepFocus,
                    onClick: copy,
                    style: {
                      padding: '5px 10px',
                      borderRadius: 8,
                      border: '1px solid rgba(128, 128, 128, 0.35)',
                      background: 'transparent',
                      color: 'inherit',
                      cursor: 'pointer',
                      fontSize: 12
                    }
                  },
                  t('copy')
                ),
                h('span', { style: { flex: 1 } }),
                h('span', { style: { fontSize: 11, opacity: 0.6 } }, `engine: ${result.engine}`)
              ])
            : null
        )
      }

      // 出错时不炸掉整个输入框：包一层错误边界，界面上只留一句提示。
      class Guard extends React.Component {
        constructor(props) {
          super(props)
          this.state = { failed: false }
        }

        static getDerivedStateFromError() {
          return { failed: true }
        }

        componentDidCatch(error) {
          console.error('[dsh-voice-transcribe]', error)
        }

        render() {
          if (this.state.failed) return h('span', { style: { fontSize: 11, opacity: 0.6 } }, t('broke'))
          return this.props.children
        }
      }

      function GuardedToggle(props) {
        return h(Guard, null, h(Toggle, props))
      }

      function GuardedPanel(props) {
        return h(Guard, null, h(Panel, props))
      }

      return { Toggle, Panel, GuardedToggle, GuardedPanel, insertIntoDraft, readRecent }
    }

    // ------------------------------------------------------------ 插件

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // 字典必须先注册：否则 ctx.locale.bind(NS) 拿不到词条，t('pathPlaceholder') 会原样返回 key。
        ctx.effect(() => ctx.locale.register(NS, DICT), 'voice-transcribe:dictionaries')
        const components = createComponents(ctx)
        const slots = ctx.slots

        slots.inject(TOGGLE_SLOT, () =>
          slots.register(
            { name: TOGGLE_SLOT, id: 'voice-transcribe-toggle', order: 6, locale: NS },
            components.GuardedToggle
          )
        )
        slots.inject(PANEL_SLOT, () =>
          slots.register(
            { name: PANEL_SLOT, id: 'voice-transcribe-panel', order: 22, locale: NS },
            components.GuardedPanel
          )
        )

        window.__dshVoiceTranscribe = {
          insertIntoDraft: components.insertIntoDraft,
          readRecent: components.readRecent,
          components
        }
      }
    }
  }
})
