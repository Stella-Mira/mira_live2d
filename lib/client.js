/**
 * mira_live2d — 客户端模块：DSH 设置里的「看板娘」一栏。
 *
 * 事实源：
 *   - 槽位契约 `settings.section`（list 类）：注册需要 id / order / label，owner props 只有 `{ close }`；
 *   - 官方模板 templates/decoration/client.js：`window.__ModuleLoader__.load({ id, factory })`，
 *     `factory` 里不做副作用，React 从浏览器模块表 `require('react')` 取，不引任何 `@deepseek-ai/*` 客户端包；
 *   - 样式只吃主题变量（`var(--dsw-..., 兜底)`），没有写死的颜色。
 *
 * 数据流：挂载时 GET /live2d/api/settings → 表单 → POST 保存。key 永远不回显：
 * 服务端只回 `keyConfigured`，输入框留空 = 不改凭据。
 *
 * 这个文件是浏览器侧模块（不是 Node 模块），只做语法自检（node --check）。
 */

window.__ModuleLoader__.load({
  id: 'mira_live2d',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/live2d/api/settings'

    const CSS = [
      '.mira-l2d-set{display:flex;flex-direction:column;gap:16px;font:inherit;color:inherit;max-width:760px;}',
      '.mira-l2d-set-head{margin:0;}',
      '.mira-l2d-set-title{margin:0;font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary, inherit);}',
      '.mira-l2d-set-sub{margin:4px 0 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary, inherit);}',
      '.mira-l2d-set-group{margin:0;padding:12px 14px 14px;display:flex;flex-direction:column;gap:12px;border:1px solid var(--dsw-alias-border-l2, currentColor);border-radius:var(--dsw-radius-md, 8px);min-width:0;min-inline-size:0;}',
      '.mira-l2d-set-legend{padding:0 4px;margin:0 0 2px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary, inherit);}',
      '.mira-l2d-set-row{display:grid;grid-template-columns:132px minmax(0, 1fr);gap:6px 12px;align-items:start;font-size:13px;min-width:0;}',
      '.mira-l2d-set-row > .mira-l2d-set-mid{display:flex;flex-direction:column;gap:4px;min-width:0;}',
      '.mira-l2d-set-label{padding-top:6px;font-size:13px;color:var(--dsw-alias-label-primary, inherit);}',
      '.mira-l2d-set-hint{margin:0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary, inherit);}',
      '.mira-l2d-set-input{box-sizing:border-box;width:100%;font:inherit;font-size:13px;padding:5px 8px;border-radius:var(--dsw-radius-sm, 6px);border:1px solid var(--dsw-alias-border-l2, currentColor);background:var(--dsw-alias-bg-layer-2, transparent);color:var(--dsw-alias-label-primary, inherit);}',
      '.mira-l2d-set-input:focus-visible{outline:2px solid var(--dsw-focus-ring-color, currentColor);outline-offset:1px;}',
      '.mira-l2d-set-inline{display:flex;align-items:center;gap:8px;}',
      '.mira-l2d-set-check{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--dsw-alias-label-primary, inherit);cursor:pointer;padding-top:5px;}',
      '.mira-l2d-set-actions{display:flex;flex-wrap:wrap;align-items:center;gap:12px;}',
      '.mira-l2d-set-button{font:inherit;font-size:13px;padding:6px 16px;border-radius:var(--dsw-radius-md, 8px);border:1px solid var(--dsw-alias-border-l2, currentColor);background:var(--dsw-alias-bg-layer-2, transparent);color:var(--dsw-alias-label-primary, inherit);cursor:pointer;}',
      '.mira-l2d-set-button:hover:enabled{background:var(--dsw-alias-interactive-bg-hover, transparent);}',
      '.mira-l2d-set-button:disabled{opacity:.55;cursor:default;}',
      '.mira-l2d-set-button:focus-visible{outline:2px solid var(--dsw-focus-ring-color, currentColor);outline-offset:1px;}',
      '.mira-l2d-set-notice{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary, inherit);}',
      '.mira-l2d-set-notice[data-kind="error"]{color:var(--dsw-alias-state-error-primary, inherit);}',
      '.mira-l2d-set-notice[data-kind="success"]{color:var(--dsw-alias-state-success-primary, inherit);}',
      '.mira-l2d-set-meta{margin:0;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary, inherit);word-break:break-all;}',
      '@media (max-width: 560px){.mira-l2d-set-row{grid-template-columns:minmax(0, 1fr);}}',
    ].join('\n')

    /** 服务端 GET 回来的 values → 表单草稿（缺项都有兜底，坏响应也不会把表单炸掉）。 */
    function toDraft(raw) {
      const v = raw && typeof raw === 'object' ? raw : {}
      const canvas = v.canvas && typeof v.canvas === 'object' ? v.canvas : {}
      const tts = v.tts && typeof v.tts === 'object' ? v.tts : {}
      return {
        model: typeof v.model === 'string' ? v.model : '',
        position: v.position === 'left' ? 'left' : 'right',
        mobileScale: typeof v.mobileScale === 'number' ? v.mobileScale : '',
        showHint: v.showHint !== false,
        canvas: {
          w: typeof canvas.w === 'number' ? canvas.w : '',
          h: typeof canvas.h === 'number' ? canvas.h : '',
        },
        tts: {
          enabled: tts.enabled === true,
          base: typeof tts.base === 'string' ? tts.base : '',
          model: typeof tts.model === 'string' ? tts.model : '',
          voice: typeof tts.voice === 'string' ? tts.voice : '',
        },
      }
    }

    function errorText(error, status) {
      const code = error && error.code ? '[' + error.code + '] ' : ''
      const message = (error && error.message) || ('保存失败（HTTP ' + status + '）')
      const hint = error && error.hint ? '；' + error.hint : ''
      return code + message + hint
    }

    function Section() {
      const [values, setValues] = React.useState(null)
      const [baseline, setBaseline] = React.useState(null)
      const [apiKey, setApiKey] = React.useState('')
      const [keyConfigured, setKeyConfigured] = React.useState(false)
      const [configFile, setConfigFile] = React.useState('')
      const [warnings, setWarnings] = React.useState([])
      const [notice, setNotice] = React.useState({ kind: 'loading', text: '正在读取看板娘配置…' })
      const [saving, setSaving] = React.useState(false)

      function readBack(json) {
        const draft = toDraft(json.values)
        setValues(draft)
        setBaseline(toDraft(json.values))
        setKeyConfigured(json.keyConfigured === true)
        if (typeof json.configFile === 'string') setConfigFile(json.configFile)
        setWarnings(Array.isArray(json.warnings) ? json.warnings.map(String) : [])
        if (json.configError && json.configError.message) {
          setNotice({ kind: 'error', text: '当前配置不可用：' + errorText(json.configError, 200) })
        }
      }

      React.useEffect(() => {
        let alive = true
        setNotice({ kind: 'loading', text: '正在读取看板娘配置…' })
        fetch(API, { headers: { accept: 'application/json' } })
          .then((response) => response.json().then((json) => ({ response, json })))
          .then(({ response, json }) => {
            if (!alive) return
            if (!response.ok || !json || json.ok !== true) {
              setNotice({ kind: 'error', text: errorText(json && json.error, response.status) })
              return
            }
            readBack(json)
            setNotice({ kind: 'info', text: '已读取当前配置；修改后点「保存」写回 config.json。' })
          })
          .catch((error) => {
            if (!alive) return
            setNotice({ kind: 'error', text: '读取失败：' + ((error && error.message) || String(error)) })
          })
        return () => {
          alive = false
        }
      }, [])

      const patchValue = (key, value) => setValues((prev) => (prev ? { ...prev, [key]: value } : prev))
      const patchCanvas = (key, value) => setValues((prev) => (prev
        ? { ...prev, canvas: { ...prev.canvas, [key]: value } }
        : prev))
      const patchTts = (key, value) => setValues((prev) => (prev
        ? { ...prev, tts: { ...prev.tts, [key]: value } }
        : prev))

      function numeric(event) {
        const raw = event.target.value
        return raw === '' ? '' : Number(raw)
      }

      async function save() {
        if (!values) return
        setSaving(true)
        setNotice({ kind: 'info', text: '正在保存…' })
        const draft = { ...values, tts: { ...values.tts } }
        const trimmedKey = apiKey.trim()
        if (trimmedKey !== '') draft.tts.apiKey = trimmedKey
        try {
          const response = await fetch(API, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ values: draft }),
          })
          const json = await response.json().catch(() => ({}))
          if (!response.ok || !json || json.ok !== true) {
            setNotice({ kind: 'error', text: errorText(json && json.error, response.status) })
            return
          }
          setApiKey('')
          if (json.values) readBack(json)
          const changed = Array.isArray(json.changed) && json.changed.length
            ? json.changed.join('、')
            : '无改动'
          setNotice({
            kind: 'success',
            text: '已保存：' + changed
              + (json.keyConfigured ? '；TTS key 已就绪' : '')
              + '。模型/位置/画布改动刷新页面后生效。',
          })
        } catch (error) {
          setNotice({ kind: 'error', text: '保存失败：' + ((error && error.message) || String(error)) })
        } finally {
          setSaving(false)
        }
      }

      const row = (label, control, hint) => h('div', { className: 'mira-l2d-set-row', key: label },
        h('span', { className: 'mira-l2d-set-label' }, label),
        h('div', { className: 'mira-l2d-set-mid' },
          control,
          hint ? h('p', { className: 'mira-l2d-set-hint' }, hint) : null))

      const textInput = (key, value, placeholder, onInput) => h('input', {
        className: 'mira-l2d-set-input',
        type: 'text',
        value: value,
        placeholder: placeholder || '',
        spellCheck: false,
        onChange: (event) => onInput(key, event.target.value),
      })

      const numberInput = (value, min, max, onChange) => h('input', {
        className: 'mira-l2d-set-input',
        type: 'number',
        min: min,
        max: max,
        value: value,
        onChange: (event) => onChange(numeric(event)),
      })

      let body
      if (!values) {
        body = h('p', { className: 'mira-l2d-set-notice', 'data-kind': notice.kind, role: 'status' }, notice.text)
      } else {
        body = h(React.Fragment, null,
          h('fieldset', { className: 'mira-l2d-set-group' },
            h('legend', { className: 'mira-l2d-set-legend' }, '显示'),
            row('模型',
              textInput('model', values.model, '留空 = 不改', (key, value) => patchValue(key, value)),
              'config.json 里的初始模型名；留空表示不修改当前值。'),
            row('位置',
              h('select', {
                className: 'mira-l2d-set-input',
                value: values.position,
                onChange: (event) => patchValue('position', event.target.value),
              },
              h('option', { value: 'right' }, '右侧'),
              h('option', { value: 'left' }, '左侧')),
              '看板娘初始停靠的屏幕一侧。'),
            row('移动端缩放',
              h('input', {
                className: 'mira-l2d-set-input',
                type: 'number',
                min: 0,
                max: 100,
                value: values.mobileScale,
                onChange: (event) => patchValue('mobileScale', numeric(event)),
              }),
              '0–100（百分比）；窄屏时按这个比例缩小。'),
            row('提示气泡',
              h('label', { className: 'mira-l2d-set-check' },
                h('input', {
                  type: 'checkbox',
                  checked: values.showHint,
                  onChange: (event) => patchValue('showHint', event.target.checked),
                }),
                h('span', null, '显示提示气泡')),
              '首次打开时是否给操作提示。')),
          h('fieldset', { className: 'mira-l2d-set-group' },
            h('legend', { className: 'mira-l2d-set-legend' }, '画布'),
            row('宽度',
              numberInput(values.canvas.w, 1, 4096, (value) => patchCanvas('w', value)),
              '像素，1–4096。'),
            row('高度',
              numberInput(values.canvas.h, 1, 4096, (value) => patchCanvas('h', value)),
              '像素，1–4096。')),
          h('fieldset', { className: 'mira-l2d-set-group' },
            h('legend', { className: 'mira-l2d-set-legend' }, '语音（TTS）'),
            row('启用',
              h('label', { className: 'mira-l2d-set-check' },
                h('input', {
                  type: 'checkbox',
                  checked: values.tts.enabled,
                  onChange: (event) => patchTts('enabled', event.target.checked),
                }),
                h('span', null, '允许 mira_speak 朗读')),
              '关闭时工具会明确报 config/missing（不会偷偷联网）。'),
            row('接口地址',
              textInput('base', values.tts.base, '留空 = 供应商默认', (key, value) => patchTts(key, value)),
              'OpenAI 兼容的 …/v1 地址；留空用内置默认。'),
            row('模型',
              textInput('model', values.tts.model, '留空 = 供应商默认', (key, value) => patchTts(key, value)),
              '如 tts-1 / qwen-tts。'),
            row('音色',
              textInput('voice', values.tts.voice, '留空 = 供应商默认', (key, value) => patchTts(key, value)),
              '如 alloy / Chelsie。'),
            row('API key',
              h('input', {
                className: 'mira-l2d-set-input',
                type: 'password',
                value: apiKey,
                autoComplete: 'off',
                placeholder: keyConfigured ? '已配置，留空 = 不改' : '未配置，填入后保存',
                onChange: (event) => setApiKey(event.target.value),
              }),
              keyConfigured
                ? '当前已配置 key（只显示状态，永不回显）；留空保存不会覆盖。'
                : '未配置 key；填写后保存到 creds/tts.json（权限 600）。')),
          h('div', { className: 'mira-l2d-set-actions' },
            h('button', {
              type: 'button',
              className: 'mira-l2d-set-button',
              disabled: saving,
              onClick: () => { void save() },
            }, saving ? '保存中…' : '保存'),
            h('button', {
              type: 'button',
              className: 'mira-l2d-set-button',
              disabled: saving || !baseline,
              onClick: () => {
                if (!baseline) return
                setValues(toDraft(baseline))
                setApiKey('')
                setNotice({ kind: 'info', text: '已撤销未保存的改动。' })
              },
            }, '撤销改动')),
          h('p', { className: 'mira-l2d-set-notice', 'data-kind': notice.kind, role: 'status', 'aria-live': 'polite' }, notice.text),
          warnings.length
            ? h('ul', { className: 'mira-l2d-set-meta' }, warnings.map((warning, index) => h('li', { key: index }, warning)))
            : null,
          configFile ? h('p', { className: 'mira-l2d-set-meta' }, '配置文件：' + configFile) : null)
      }

      return h('section', { className: 'mira-l2d-set', 'aria-label': '看板娘设置' },
        h('style', null, CSS),
        h('header', { className: 'mira-l2d-set-head' },
          h('h2', { className: 'mira-l2d-set-title' }, '看板娘'),
          h('p', { className: 'mira-l2d-set-sub' },
            'Live2D 看板娘的模型、位置、画布与语音。保存会原子写回 config.json；刷新页面后生效。')),
        body)
    }

    return {
      // 只依赖槽位服务：不碰别的插件，也不注册全局副作用。
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'mira-live2d',
          order: 46,
          label: () => '看板娘',
        }, Section))
      },
    }
  },
})
