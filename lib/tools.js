/**
 * mira_live2d / tools.js —— 模型可调用的工具（共 20 个，全部返回 JSON 文本）
 *
 * 保留旧工具：get_state / list_models / get_model_capabilities / switch_model /
 * set_expression / play_motion / speak / bubble / show / hide /
 * set_expressions_enabled / set_animations_enabled / set_mood / set_persona / get_config
 * 新增：set_visible（显式开关，替代 show/hide 二选一的那种调用方式）/ list_assets /
 *       set_background / screenshot / tts_status
 *
 * 所有工具走 kit 的 `textTool`（内部 runTool：同步/异步皆可，永远 JSON、不抛）。
 * 错误一律 `{ok:false,error:{code,message,hint}}`；缺什么文件/缺哪项配置都写进
 * message 与 hint，不静默留白。
 */

import {
  MiraError, fail, okObj, textTool,
} from './kit.mjs'

function obj(props, required = []) {
  return { type: 'object', properties: props, required }
}
function str(description) {
  return { type: 'string', description }
}
function bool(description) {
  return { type: 'boolean', description }
}
function num(description) {
  return { type: 'number', description }
}

function currentModel(cfg, state) {
  return String(state.model || cfg.model || '').trim()
}

function requireModel(cfg, state) {
  const model = currentModel(cfg, state)
  if (!model) {
    throw new MiraError(
      'config/missing',
      '当前没有指定模型（model 为空）',
      '在 ' + cfg.configFile + ' 里填 model（modelsDir 下的目录名），或用 mira_switch_model / 界面菜单选一个；不自动挑默认模型',
    )
  }
  return model
}

function errorFrom(error) {
  const code = error?.code || 'unknown/error'
  const message = error?.message || String(error)
  const hint = error?.hint || ''
  return { code, message, hint }
}

/** 缺资源时的统一提示（列文件名，别只说“失败”）。 */
function missingSummary(missing, cfg) {
  if (!Array.isArray(missing) || missing.length === 0) return ''
  return missing.map((m) => (m.kind || 'file') + '：' + (m.file || '(空)')).join('；')
    + '（模型目录 ' + cfg.modelsDir + '）'
}

export function registerTools(ctx, deps) {
  const defs = []

  /* ── 状态 / 清单 ───────────────────────────────────────── */

  defs.push(textTool(
    'mira_get_state',
    '获取看板娘当前状态：是否显示、当前模型、开启的表情/动作、背景、TTS 是否配置、可切换模型、资源缺失诊断、浏览器是否连上。默认隐藏（visible=false）。',
    obj({}),
    async () => {
      const cfg = deps.configStore.current()
      const state = deps.stateStore.get()
      const model = currentModel(cfg, state)
      const client = deps.stateStore.client()

      let models = []
      let modelsError = null
      try {
        models = deps.catalog(cfg).scanModels({ expected: model }).models.map((m) => ({ name: m.name, entry: m.entry }))
      } catch (error) {
        modelsError = errorFrom(error)
      }

      let capabilities = null
      let capabilitiesError = null
      if (model) {
        try {
          const caps = deps.catalog(cfg).capabilities(model)
          capabilities = {
            expressions: caps.expressions,
            motions: caps.motions,
            missing: caps.missing,
            coreMissing: caps.coreMissing,
          }
        } catch (error) {
          capabilitiesError = errorFrom(error)
        }
      }

      const tts = deps.tts(cfg).status()
      const shot = deps.shotFor(cfg).status()
      let backgroundUrl = null
      let backgroundError = null
      if (state.background) {
        try {
          const resolved = deps.catalog(cfg).resolveBackground(state.background)
          backgroundUrl = resolved ? resolved.url : null
        } catch (error) {
          backgroundError = errorFrom(error)
        }
      }

      const payload = okObj({
        online: client.data !== null,
        visible: state.visible === true,
        model: model || null,
        currentModel: model || null,
        expressions: state.expressions.slice(),
        motions: state.currentMotion ? [state.currentMotion] : [],
        expressionsAvailable: capabilities ? capabilities.expressions : [],
        motionsAvailable: capabilities ? capabilities.motions : [],
        currentMotion: state.currentMotion,
        background: state.background || null,
        backgroundUrl,
        backgroundError,
        expressionsEnabled: state.expressionsEnabled,
        animationsEnabled: state.animationsEnabled,
        mood: state.mood,
        modelsAvailable: models.map((m) => m.name),
        modelsError,
        capabilities,
        capabilitiesError,
        modelsDir: cfg.modelsDir,
        imageDir: cfg.imageDir,
        mediaDir: cfg.shot.mediaDir,
        configFile: cfg.configFile,
        tts: { enabled: tts.enabled, configured: tts.configured, provider: tts.provider },
        shot: { endpointAvailable: shot.endpointAvailable, lastShot: shot.lastShot, pending: shot.pending },
        serverKnown: {
          enabled: cfg.enabled,
          configuredModel: cfg.model,
          modelsAvailable: models.map((m) => m.name),
          ttsEnabled: tts.enabled,
          ttsProvider: tts.provider,
          persona: deps.getPersona(cfg),
        },
        client: client.data,
        lastSeenMsAgo: client.msAgo,
        counters: deps.counters ? deps.counters.snapshot() : {},
      })
      if (client.data === null) {
        payload.note = '浏览器尚未连上看板娘（没有打开任何会话页面，或 widget 未加载）；显隐/表情指令会排队等页面连上'
      }
      if (modelsError) {
        payload.noteModels = '模型不可用：' + modelsError.message + '。' + (modelsError.hint || '')
      }
      return payload
    },
  ))

  defs.push(textTool(
    'mira_list_models',
    '列出 modelsDir 下所有可切换模型（目录名 + model3.json 相对入口）。模型目录为空时返回 config/missing，并指出缺哪个文件、从哪配。',
    obj({}),
    async () => {
      const cfg = deps.configStore.current()
      let expected = cfg.model
      try {
        expected = currentModel(cfg, deps.stateStore.get())
      } catch {
        /* state 坏了仍可列模型；只是 message 里少了具体模型名 */
      }
      const scan = deps.catalog(cfg).scanModels({ expected })
      return okObj({
        modelsDir: cfg.modelsDir,
        models: scan.models.map((m) => ({ name: m.name, entry: m.entry })),
      })
    },
  ))

  defs.push(textTool(
    'mira_list_assets',
    '列出模型/表情/动作/背景图，并逐个检查 model3.json 引用的文件是否存在；缺哪个文件、路径与修复位置都写在 missing/hint 里。',
    obj({}),
    async () => {
      const cfg = deps.configStore.current()
      let state = {}
      try {
        state = deps.stateStore.get()
      } catch {
        /* list_assets 是诊断工具：状态坏了也要能列出模型/背景 */
      }
      const model = currentModel(cfg, state) || cfg.model
      const catalog = deps.catalog(cfg)

      let models = []
      let modelsError = null
      try {
        models = catalog.scanModels({ diagnose: true, expected: model }).models.map((m) => ({
          name: m.name,
          entry: m.entry,
          model3: m.model3,
          expressions: m.expressions ?? [],
          motions: m.motions ?? [],
          missing: m.missing ?? [],
          missingCount: m.missingCount ?? 0,
          coreMissing: m.coreMissing ?? [],
          error: m.error ?? null,
        }))
      } catch (error) {
        modelsError = errorFrom(error)
      }

      let backgrounds = []
      let backgroundsError = null
      try {
        backgrounds = catalog.backgrounds().images.map((b) => ({ name: b.name, url: b.url, path: b.path }))
      } catch (error) {
        backgroundsError = errorFrom(error)
      }

      const missingTotal = models.reduce((sum, m) => sum + (m.missingCount || 0), 0)

      if (modelsError) {
        return {
          ...fail(modelsError.code, modelsError.message, modelsError.hint),
          modelsDir: cfg.modelsDir,
          imageDir: cfg.imageDir,
          models: [],
          backgrounds,
          backgroundsError,
        }
      }

      const payload = okObj({
        modelsDir: cfg.modelsDir,
        imageDir: cfg.imageDir,
        models,
        backgrounds,
        backgroundsError,
        missingTotal,
      })
      if (missingTotal > 0) {
        payload.hint = '有 ' + missingTotal + ' 个被引用的资源文件缺失，详见各模型的 missing[].hint；缺文件不会自动留白，切换/播放时会再报一次'
      }
      if (backgroundsError) payload.hintBackgrounds = backgroundsError.message + '。' + (backgroundsError.hint || '')
      return payload
    },
  ))

  defs.push(textTool(
    'mira_get_model_capabilities',
    '解析指定模型的 model3.json，返回表情与动作组清单；被引用但不存在的文件会逐条列在 missing（含绝对路径与修复 hint）。',
    obj({ model: str('模型名（mira_list_models 返回的 name）；留空用当前模型') }),
    async (args) => {
      const cfg = deps.configStore.current()
      let state = {}
      try {
        state = deps.stateStore.get()
      } catch {
        /* 只读能力查询：state 坏了也能按显式 model 参数解析 */
      }
      const model = String(args.model || currentModel(cfg, state) || '').trim()
      if (!model) throw new MiraError('config/missing', '没有指定模型',
        '传 model（mira_list_models 返回的 name），或在 ' + cfg.configFile + ' 里填 model')
      const caps = deps.catalog(cfg).capabilities(model)
      return okObj({
        model: caps.model,
        entry: caps.entry,
        model3: caps.model3,
        expressions: caps.expressions,
        motions: caps.motions,
        expressionsDetail: caps.expressionFiles,
        motionsDetail: caps.motionFiles,
        missing: caps.missing,
        coreMissing: caps.coreMissing,
        note: caps.missing.length
          ? '有 ' + caps.missing.length + ' 个被引用的文件缺失：' + missingSummary(caps.missing, cfg)
          : '所有被引用的文件都存在',
      })
    },
  ))

  /* ── 模型 / 表情 / 动作切换 ─────────────────────────────── */

  defs.push(textTool(
    'mira_switch_model',
    '切换看板娘展示的模型（modelsDir 下的目录名）。缺 moc/贴图会拒绝并报出文件；只缺表情/动作文件时照常切换但把缺失清单带回来。',
    obj({ model: str('模型名（mira_list_models 返回的 name）') }, ['model']),
    async (args) => {
      const cfg = deps.configStore.current()
      const name = String(args.model || '').trim()
      if (!name) throw new MiraError('config/missing', '缺少模型名', '传 model（mira_list_models 返回的 name）')
      deps.stateStore.get() // schemaVersion 不匹配就拒绝
      const caps = deps.catalog(cfg).capabilities(name)
      if (caps.coreMissing.length > 0) {
        throw new MiraError(
          'resource/missing',
          '模型 ' + name + ' 的核心文件缺失：' + missingSummary(caps.coreMissing, cfg),
          caps.coreMissing[0]?.hint || ('把模型文件放回 ' + caps.dir),
        )
      }
      deps.stateStore.setModel(name)
      deps.pushCommand('switch_model', { model: name, entry: caps.entry })
      deps.counters?.bump?.('model.switch')
      deps.logger?.info?.('[mira_live2d] 切换模型：' + name + '（' + caps.entry + '）')
      const payload = okObj({
        model: name,
        entry: caps.entry,
        missing: caps.missing,
      })
      if (caps.missing.length) {
        payload.warning = '模型已切换，但有 ' + caps.missing.length + ' 个资源文件缺失：' + missingSummary(caps.missing, cfg)
      }
      return payload
    },
  ))

  defs.push(textTool(
    'mira_set_expression',
    '切换看板娘表情；空字符串恢复默认表情。stack=true 时作为叠加开关（可多个并存），否则互斥替换。表情文件缺失会报出文件路径。',
    obj({
      expression: str('表情名（空串恢复默认）'),
      stack: bool('true=叠加开关（可多个并存）；false=互斥替换（默认）'),
    }),
    async (args) => {
      const cfg = deps.configStore.current()
      const state = deps.stateStore.get()
      const name = String(args.expression ?? '')
      if (name === '') {
        deps.stateStore.setExpressions([])
        deps.pushCommand('expression', { name: '', stack: false })
        return okObj({ model: currentModel(cfg, state) || null, expressions: [] })
      }
      const model = requireModel(cfg, state)
      deps.catalog(cfg).requireExpression(name, model)
      const stack = args.stack === true
      const next = stack
        ? [...new Set([...state.expressions, name])]
        : [name]
      deps.stateStore.setExpressions(next)
      deps.pushCommand('expression', { name, stack })
      deps.counters?.bump?.('expression.set')
      return okObj({ model, expressions: next, stack })
    },
  ))

  defs.push(textTool(
    'mira_play_motion',
    '播放看板娘动作组；动作文件缺失会报出文件路径。',
    obj({ motion: str('动作组名（mira_get_model_capabilities 返回的 motions）') }, ['motion']),
    async (args) => {
      const cfg = deps.configStore.current()
      const state = deps.stateStore.get()
      const model = requireModel(cfg, state)
      const motion = String(args.motion || '')
      if (!motion) throw new MiraError('config/missing', '缺少动作组名', '传 motion（mira_get_model_capabilities 返回的 motions）')
      deps.catalog(cfg).requireMotion(motion, model)
      deps.stateStore.setMotion(motion)
      deps.pushCommand('motion', motion)
      deps.counters?.bump?.('motion.play')
      return okObj({ model, motion })
    },
  ))

  /* ── 说话 / 气泡 ───────────────────────────────────────── */

  defs.push(textTool(
    'mira_speak',
    '让看板娘说话：用已配置的 TTS（openai / aliyun）合成语音，同时用气泡展示文字。TTS 未配置时返回 config/missing，并在界面气泡里给出「去哪填 key」的提示（不静默降级）。',
    obj({ text: str('要朗读并显示的文字') }, ['text']),
    async (args, exec) => {
      const cfg = deps.configStore.current()
      const fullText = String(args.text ?? '')
      if (!fullText.trim()) throw new MiraError('tts/failed', '朗读文本为空', '传 text（1–' + cfg.tts.maxChars + ' 字符）')
      // 不在这里静默截断：交给 synthesize 按 code point 截断，并用 truncated/chars
      // 把「只朗读了前 N 个字符」回报给调用方（气泡也只用真正朗读的那段）。
      const maxChars = cfg.tts.maxChars
      const requestedChars = Array.from(fullText).length
      const truncated = requestedChars > maxChars
      const text = truncated ? Array.from(fullText).slice(0, maxChars).join('') : fullText
      const tts = deps.tts(cfg)
      let audio
      try {
        audio = await tts.synthesize(fullText, { signal: exec?.signal })
      } catch (error) {
        if (['config/missing', 'config/schema', 'creds/missing', 'config/invalid'].includes(error?.code)) {
          const message = '未朗读：' + (error?.message || 'TTS 未配置')
          deps.pushCommand('bubble', (message + (error?.hint ? '\n' + error.hint : '')).slice(0, 1200))
        }
        throw error
      }
      const audioId = deps.nextAudioId()
      deps.audioStore.set(audioId, { mime: audio.mime, base64: audio.base64 })
      if (deps.audioStore.size > 100) deps.audioStore.delete(deps.audioStore.keys().next().value)
      deps.pushCommand('speak', { text, audioId })
      deps.logger?.info?.('[mira_live2d] TTS 合成：provider=' + audio.provider + '，' + audio.bytes + ' 字节'
        + (audio.truncated ? '（文本截断 ' + audio.requestedChars + '→' + audio.chars + ' 字符）' : ''))
      return okObj({
        spoke: true,
        audioId,
        bytes: audio.bytes,
        provider: audio.provider,
        model: audio.model,
        voice: audio.voice,
        chars: audio.chars ?? text.length,
        requestedChars: audio.requestedChars ?? requestedChars,
        truncated: audio.truncated === true,
      })
    },
  ))

  defs.push(textTool(
    'mira_bubble',
    '让看板娘用气泡显示文字（不朗读）。',
    obj({ text: str('气泡文字') }, ['text']),
    async (args) => {
      const text = String(args.text ?? '').slice(0, 600)
      deps.pushCommand('bubble', text)
      return okObj({ shown: text.length })
    },
  ))

  /* ── 显隐 ─────────────────────────────────────────────── */

  defs.push(textTool(
    'mira_set_visible',
    '显式开关看板娘：visible=true 显示、false 隐藏（默认隐藏）。显隐状态落盘，刷新页面后保持。',
    obj({ visible: bool('true 显示 / false 隐藏') }, ['visible']),
    async (args) => {
      if (typeof args.visible !== 'boolean') {
        throw new MiraError('config/invalid', 'visible 必须是布尔值', '传 {"visible":true} 或 {"visible":false}; 旧工具 mira_show / mira_hide 仍可用')
      }
      deps.configStore.current()
      deps.stateStore.setVisible(args.visible)
      deps.pushCommand('set_visible', args.visible)
      deps.logger?.info?.('[mira_live2d] 显隐切换：visible=' + args.visible)
      return okObj({ visible: args.visible })
    },
  ))

  defs.push(textTool('mira_show', '显示看板娘（等价于 mira_set_visible visible=true）。', obj({}), async () => {
    deps.configStore.current()
    deps.stateStore.setVisible(true)
    deps.pushCommand('show', true)
    deps.logger?.info?.('[mira_live2d] 显示看板娘')
    return okObj({ visible: true })
  }))

  defs.push(textTool('mira_hide', '隐藏看板娘（等价于 mira_set_visible visible=false）。', obj({}), async () => {
    deps.configStore.current()
    deps.stateStore.setVisible(false)
    deps.pushCommand('hide', true)
    deps.logger?.info?.('[mira_live2d] 隐藏看板娘')
    return okObj({ visible: false })
  }))

  /* ── 表情/动画/情绪/配置 ───────────────────────────────── */

  defs.push(textTool(
    'mira_set_expressions_enabled',
    '打开或关闭表情系统（关闭后前端不再响应表情切换）。',
    obj({ enabled: bool('true 打开 / false 关闭') }, ['enabled']),
    async (args) => {
      if (typeof args.enabled !== 'boolean') throw new MiraError('config/invalid', 'enabled 必须是布尔值', '传 {"enabled":true|false}')
      deps.configStore.current()
      deps.stateStore.setExpressionsEnabled(args.enabled)
      deps.pushCommand('set_expressions', args.enabled)
      return okObj({ expressionsEnabled: args.enabled })
    },
  ))

  defs.push(textTool(
    'mira_set_animations_enabled',
    '打开或关闭动作/动画播放。',
    obj({ enabled: bool('true 打开 / false 关闭') }, ['enabled']),
    async (args) => {
      if (typeof args.enabled !== 'boolean') throw new MiraError('config/invalid', 'enabled 必须是布尔值', '传 {"enabled":true|false}')
      deps.configStore.current()
      deps.stateStore.setAnimationsEnabled(args.enabled)
      deps.pushCommand('set_animations', args.enabled)
      return okObj({ animationsEnabled: args.enabled })
    },
  ))

  defs.push(textTool(
    'mira_set_mood',
    '手动设置看板娘情绪状态：thinking（思考）/ awaiting（等待确认）/ idle（空闲默认）。',
    obj({ mood: str('thinking / awaiting / idle') }, ['mood']),
    async (args) => {
      const mood = String(args.mood || '')
      if (!['thinking', 'awaiting', 'idle'].includes(mood)) {
        throw new MiraError('config/invalid', 'mood 只能是 thinking / awaiting / idle', '传 thinking、awaiting 或 idle')
      }
      deps.configStore.current()
      deps.stateStore.setMood(mood)
      deps.pushCommand('mood', mood)
      return okObj({ mood })
    },
  ))

  defs.push(textTool(
    'mira_set_persona',
    '设置思考与等待时的表情和气泡（空串表示不设置/清除该表情），以及空闲后表情清除的延迟毫秒数。运行期生效，不落盘；要持久请写 config.json 的 persona。',
    obj({
      thinkingExpression: str('思考时表情（空串=不设）'),
      thinkingBubble: str('思考时气泡文字（空串=不显示）'),
      awaitingExpression: str('等待确认时表情（空串=不设）'),
      awaitingBubble: str('等待确认时气泡文字（空串=不显示）'),
      idleClearMs: num('空闲多少毫秒后清除表情/气泡，默认 3200'),
    }),
    async (args) => {
      const cfg = deps.configStore.current()
      const current = deps.getPersona(cfg)
      const idle = args.idleClearMs === undefined
        ? (current.idleClearMs ?? 3200)
        : Number(args.idleClearMs)
      if (!Number.isFinite(idle) || idle < 0) {
        throw new MiraError('config/invalid', 'idleClearMs 必须是非负数', '传毫秒数，例如 3200')
      }
      const persona = {
        thinking: {
          expression: String(args.thinkingExpression ?? current.thinking?.expression ?? ''),
          bubble: String(args.thinkingBubble ?? current.thinking?.bubble ?? ''),
        },
        awaiting: {
          expression: String(args.awaitingExpression ?? current.awaiting?.expression ?? ''),
          bubble: String(args.awaitingBubble ?? current.awaiting?.bubble ?? ''),
        },
        idleClearMs: Math.round(idle),
      }
      deps.setPersona(persona)
      deps.pushCommand('set_persona', persona)
      return okObj({ persona })
    },
  ))

  defs.push(textTool(
    'mira_get_config',
    '获取插件当前生效配置（目录已解析成绝对路径；TTS key/凭据只返回是否已配置，绝不回传明文）。',
    obj({}),
    async () => {
      const cfg = deps.configStore.current()
      const view = structuredClone(cfg)
      const ttsStatus = deps.tts(cfg).status()
      if (view.tts) {
        delete view.tts.key
        delete view.tts.keyEnv
        view.tts.keyConfigured = ttsStatus.configured
        view.tts.keySource = ttsStatus.keySource
        view.tts.credsFile = ttsStatus.credsFile
      }
      view.configFile = cfg.configFile
      view.stateFile = deps.stateStore ? deps.stateStore.file : null
      view.models = []
      view.modelsError = null
      try {
        view.models = deps.catalog(cfg).scanModels({ expected: cfg.model }).models.map((m) => m.name)
      } catch (error) {
        view.modelsError = errorFrom(error)
      }
      view.backgrounds = []
      view.backgroundsError = null
      try {
        view.backgrounds = deps.catalog(cfg).backgrounds().images.map((b) => b.name)
      } catch (error) {
        view.backgroundsError = errorFrom(error)
      }
      return okObj(view)
    },
  ))

  /* ── 背景图 ───────────────────────────────────────────── */

  defs.push(textTool(
    'mira_set_background',
    '设置会话页面背景图（imageDir 下的图片文件名）；传空字符串或 clear=true 清除背景。背景目录缺图/文件不存在都会报出路径。',
    obj({
      image: str('imageDir 下的图片文件名（空串=清除背景）'),
      clear: bool('true=清除背景（等价于 image=""）'),
    }),
    async (args) => {
      const cfg = deps.configStore.current()
      deps.stateStore.get()
      const clear = args.clear === true || args.image === ''
      if (clear) {
        deps.stateStore.setBackground('')
        deps.pushCommand('set_background', { name: '', url: '' })
        return okObj({ background: null, url: null })
      }
      const resolved = deps.catalog(cfg).resolveBackground(String(args.image ?? ''))
      if (!resolved) {
        deps.stateStore.setBackground('')
        deps.pushCommand('set_background', { name: '', url: '' })
        return okObj({ background: null, url: null })
      }
      deps.stateStore.setBackground(resolved.name)
      deps.pushCommand('set_background', { name: resolved.name, url: resolved.url })
      deps.counters?.bump?.('background.set')
      deps.logger?.info?.('[mira_live2d] 背景切换：' + resolved.name)
      return okObj({ background: resolved.name, url: resolved.url, path: resolved.path })
    },
  ))

  /* ── 截图 ─────────────────────────────────────────────── */

  defs.push(textTool(
    'mira_screenshot',
    '截取当前看板娘画面：下发截图指令，前端 canvas.toDataURL 后 POST 回来，插件落盘并返回绝对文件路径。需要模型处于显示状态且浏览器页面已打开；拿不到上传端点会返回 platform/unsupported。',
    obj({ timeoutMs: num('等待前端回传的毫秒数（默认取配置 shot.timeoutMs=4000）') }),
    async (args) => {
      const cfg = deps.configStore.current()
      const state = deps.stateStore.get()
      const shot = deps.shotFor(cfg)
      if (!shot.endpointAvailable) {
        return fail('platform/unsupported', '当前宿主没有可用的上传端点',
          '截图需要宿主提供 webServer.register（DSH web 档自带）；没有端点时不落盘，也不引入 Playwright 之类的渲染依赖')
      }
      if (state.visible !== true) {
        throw new MiraError('shot/unavailable', '看板娘当前是隐藏的，无法截图',
          '先调用 mira_show 或 mira_set_visible({visible:true})，等页面加载出模型后再截图')
      }
      const requestId = 'shot-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
      deps.pushCommand('screenshot', { requestId, model: currentModel(cfg, state) })
      const timeoutMs = args.timeoutMs === undefined
        ? cfg.shot.timeoutMs
        : Math.max(500, Math.min(30_000, Number(args.timeoutMs) || cfg.shot.timeoutMs))
      const result = await shot.request({ requestId, timeoutMs })
      if (result.ok) {
        deps.counters?.bump?.('screenshot.ok')
        deps.logger?.info?.('[mira_live2d] 截图完成：' + result.path)
        return { ...result, requestId }
      }
      deps.counters?.bump?.('screenshot.fail')
      return { ...result, requestId }
    },
  ))

  /* ── TTS 状态 ─────────────────────────────────────────── */

  defs.push(textTool(
    'mira_tts_status',
    'TTS 只读状态：是否启用、哪个供应商、key 是否已配置、从哪读（不回显 key）。',
    obj({}),
    async () => {
      const cfg = deps.configStore.current()
      return deps.tts(cfg).status()
    },
  ))

  // 约定5：工具错误打一行 warn 并按错误码计数（只记 code，不记可能带路径/内容的 message）。
  for (const def of defs) {
    const execute = def.execute
    def.execute = async (args, exec) => {
      const output = await execute(args, exec)
      try {
        const parsed = JSON.parse(output)
        if (parsed && parsed.ok === false) {
          const code = parsed.error && parsed.error.code ? parsed.error.code : 'unknown/error'
          deps.counters?.bump?.(code)
          deps.logger?.warn?.('[mira_live2d] 工具 ' + def.name + ' 失败：' + code)
        }
      } catch {
        /* 输出不是 JSON 时交给宿主/自检处理 */
      }
      return output
    }
  }

  const disposers = defs.map((def) => ctx.tools.register(def))
  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose?.()
      } catch {
        /* 卸载不抛 */
      }
    }
  }
}
