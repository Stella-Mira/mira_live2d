/* mira_live2d 前端看板娘
 * 由主机端通过 tapIndex 注入 index.html，随每个会话的对话界面加载。
 * 支持：默认隐藏 + 开关按钮、模型/表情/动作/背景菜单、拖拽移动、滚轮缩放、
 *       语音/气泡、指令轮询、状态上报、思考/等待表情联动、canvas 截图上传。
 */
;(function () {
  'use strict'
  if (window.__MIRA_L2D_BOOT__) return
  window.__MIRA_L2D_BOOT__ = true

  const $ = (id) => document.getElementById(id)
  const API = '/live2d/api'

  /** 配置/状态坏了也要让人看见：顶部一条固定的错误条，而不是静默空白。 */
  function showFatal(config) {
    const fatal = config && config.fatalError
    if (!fatal) return
    const box = document.createElement('div')
    box.id = 'mira-l2d-fatal'
    box.textContent = 'mira_live2d 不可用：' + (fatal.message || '配置错误')
      + (fatal.hint ? '（' + fatal.hint + '）' : '')
    document.body.appendChild(box)
  }

  async function main() {
    let config
    try {
      config = await (await fetch(API + '/config')).json()
    } catch (e) {
      return
    }
    if (!config) return
    if (config.enabled === false) {
      showFatal(config)
      return
    }
    let serverConfig = config

    const W = (config.canvas && config.canvas.w) || 480
    const H = (config.canvas && config.canvas.h) || 630

    /* ── DOM ── */
    // 背景层放在最前面、z-index 最低：不拦截点击，也不参与看板娘的拖拽。
    const bgLayer = document.createElement('div')
    bgLayer.id = 'mira-l2d-bg'
    bgLayer.className = 'mira-hide'
    document.body.insertBefore(bgLayer, document.body.firstChild)

    const root = document.createElement('div')
    root.id = 'mira-l2d-root'
    // 功能点1：默认隐藏；只有服务端 state.visible=true（用户之前点过显示）才初始显示。
    if (config.visible !== true) root.className = 'mira-collapsed'
    root.innerHTML =
      '<canvas id="mira-l2d-canvas"></canvas>' +
      '<div id="mira-l2d-bubble" class="mira-hide"></div>'
    document.body.appendChild(root)

    // 菜单独立挂到 body：root 上设了 touch-action:none，若菜单作为其子元素，
    // 触摸/滚轮会被 root 拦截而无法滚动菜单；脱离 root 后 menu 自身可正常滚动。
    const menu = document.createElement('div')
    menu.id = 'mira-l2d-menu'
    menu.className = 'mira-hide'
    document.body.appendChild(menu)

    // 开关不再是外挂按钮：**眼睛手柄和模型是同一个可拖动物件**（root）。
    // 收起 = root 缩成小眼睛；展开 = root 显示模型。拖哪个都是拖 root，位置共享。
    const handle = document.createElement('div')
    handle.id = 'mira-l2d-handle'
    handle.setAttribute('role', 'button')
    handle.setAttribute('aria-label', '展开/收起看板娘')
    handle.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" '
      + 'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      + '<path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/>'
      + '<circle cx="12" cy="12" r="2.6"/></svg>'
    root.appendChild(handle)
    const toggleBtn = handle // 兼容旧代码里对 toggleBtn 的引用（下面都已改成手柄语义）

    // 通知气泡容器（上一版替换外挂按钮时连同它一起被误删，导致 barMsg 为 null，
    // 任何 notify() 都会抛 "Cannot set properties of null"，右键菜单等流程中途中断）
    const bar = document.createElement('div')
    bar.id = 'mira-l2d-bar'
    bar.innerHTML = '<div id="mira-l2d-bar-msg" class="mira-hide"></div>'
    document.body.appendChild(bar)

    const barMsg = $('mira-l2d-bar-msg')
    // 画布/气泡引用（上一版替换外挂按钮时误删，导致 main 里 canvas is not defined）
    const canvas = $('mira-l2d-canvas')
    const bubble = $('mira-l2d-bubble')

    /* ── 状态 ── */
    const state = {
      visible: config.visible === true,
      model: config.model || null,
      entry: config.modelEntry || null,
      expressionsEnabled: true,
      animationsEnabled: true,
      mood: 'idle',
      currentExpression: null,
      currentMotion: null,
      currentUtterance: '',
      expressions: [],
      motions: [],
      background: config.background || '',
    }
    // 可叠加表情栈：name -> { motion, active }（开关-* / 动作-* 等非互斥表情）
    const stackActive = new Map()
    let persona = Object.assign(
      { thinking: { expression: '', bubble: '' }, awaiting: { expression: '', bubble: '' }, idleClearMs: 3200 },
      config.persona || {}
    )

    /* ── 画布与 PIXI ── */
    canvas.width = W
    canvas.height = H
    let app
    let model = null
    let viewScale = 1

    /* ── 位置与缩放持久化 ── */
    const POS_KEY = 'mira_l2d_pos'
    const SCALE_KEY = 'mira_l2d_scale'

    function footprint() {
      return { w: W * viewScale, h: H * viewScale }
    }

    const COLLAPSED_SIZE = 40
    // 当前位置的**实际**盒子尺寸：收起时是小眼睛（40x40），展开时才是模型尺寸。
    // 之前一律用模型尺寸夹边界，导致收起的眼睛往右只能走到 innerWidth-模型宽，靠不到右边。
    function boxSize() {
      if (state && state.visible === false) return { w: COLLAPSED_SIZE, h: COLLAPSED_SIZE }
      return footprint()
    }
    function clampPos(x, y) {
      const f = boxSize()
      x = Math.max(0, Math.min(x, window.innerWidth - f.w))
      y = Math.max(0, Math.min(y, window.innerHeight - f.h))
      return [x, y]
    }

    function applyPos(x, y) {
      ;[x, y] = clampPos(x, y)
      root.style.left = x + 'px'
      root.style.top = y + 'px'
    }

    function applyScale(s) {
      viewScale = Math.max(0.25, Math.min(3, s))
      root.style.width = W * viewScale + 'px'
      root.style.height = H * viewScale + 'px'
      canvas.style.transform = 'scale(' + viewScale + ')'
      try {
        localStorage.setItem(SCALE_KEY, JSON.stringify(viewScale))
      } catch (e) {}
    }

    // 初始位置：右下 / 左下
    const savedPos = safeGet(POS_KEY)
    const savedScale = safeGet(SCALE_KEY)
    const isMobile = ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0
    if (savedScale && typeof savedScale === 'number') {
      viewScale = savedScale
    } else if (isMobile && config.mobileScale) {
      viewScale = Math.max(0.25, Math.min(3, config.mobileScale / 100))
    }
    root.style.width = W * viewScale + 'px'
    root.style.height = H * viewScale + 'px'
    canvas.style.transform = 'scale(' + viewScale + ')'

    const f0 = footprint()
    const margin = 16
    if (savedPos && typeof savedPos.x === 'number') {
      applyPos(savedPos.x, savedPos.y)
    } else if (config.position === 'left') {
      applyPos(margin, window.innerHeight - f0.h - margin)
    } else {
      applyPos(window.innerWidth - f0.w - margin, window.innerHeight - f0.h - margin)
    }

    function safeGet(key) {
      try {
        return JSON.parse(localStorage.getItem(key) || 'null')
      } catch (e) {
        return null
      }
    }

    /* ── 模型加载 ── */
    async function loadModel(entry) {
      return await PIXI.live2d.Live2DModel.from('/live2d/models/' + entry)
    }

    // 代次保护：并发 setModel 时，只有最新一次调用能把模型挂上舞台，先到的加载结果作废销毁
    let modelGen = 0
    async function setModel(entry, name) {
      const gen = ++modelGen
      if (!app) {
        app = new PIXI.Application({
          view: canvas,
          autoStart: true,
          transparent: true,
          width: W,
          height: H,
          resolution: (window.devicePixelRatio || 1) * 3,
          autoDensity: true,
          // 截图靠 canvas.toDataURL()：WebGL 默认不保留绘制缓冲，必须显式打开，
          // 否则 toDataURL 会在部分浏览器上得到空白图。
          preserveDrawingBuffer: true,
        })
      }
      ensureLipTicker()
      let next
      try {
        next = await loadModel(entry)
      } catch (e) {
        if (gen === modelGen) showBubble('模型加载失败：' + (e && e.message ? e.message : e))
        return
      }
      if (gen !== modelGen) {
        // 已被更新的切换取代：丢弃这次加载结果
        try {
          next.destroy && next.destroy()
        } catch (e) {}
        return
      }
      if (model) {
        try {
          app.stage.removeChild(model)
          model.destroy && model.destroy()
        } catch (e) {}
        model = null
      }
      model = next
      mouthParamId = null
      app.stage.addChild(model)
      const s = Math.min(W / model.width, H / model.height) * 0.98
      model.scale.set(s)
      model.anchor.set(0.5, 1)
      model.x = W / 2
      model.y = H
      state.model = name
      state.entry = entry
      state.currentExpression = null
      state.currentMotion = null
      stackActive.clear()
      // 叠加层随模型重建：新模型加载后按当前叠加状态重建合成表情
      rebuildStackedExpression()
      refreshLists()
      if (state.animationsEnabled) {
        try {
          model.motion('Idle')
        } catch (e) {}
      }
      pushState()
    }

    function refreshLists() {
      try {
        state.expressions = (model.internalModel.settings.expressions || []).map((x) => x.Name)
      } catch (e) {
        state.expressions = []
      }
      try {
        state.motions = Object.keys(model.internalModel.settings.motions || {})
      } catch (e) {
        state.motions = []
      }
    }

    function currentExpression() {
      try {
        const em = model.internalModel && model.internalModel.motionManager
          ? model.internalModel.motionManager.expressionManager : null
        return em && em.currentExpression ? em.currentExpression.Name : null
      } catch (e) {
        return null
      }
    }

    /* ── 开关按钮 / 提示 / 背景 ── */
    let hintShown = false
    let barMsgTimer = null
    // 页面刷新后把服务端记录的「已开启表情」恢复到模型上；只消费一次，
    // 避免后续工具切换模型时把旧表情又贴上来。
    let restoreExpressions = Array.isArray(config.expressions) ? config.expressions.slice() : []

    function updateBar() {
      // 手柄只在收起时可见（CSS 控制）；这里只维护语义与提示
      handle.setAttribute('aria-pressed', state.visible ? 'true' : 'false')
      handle.title = state.visible ? '点一下收起看板娘（拖动可搬家）' : '点一下展开看板娘（拖动可搬家）'
    }

    // 模型隐藏时气泡在 root 里看不见，用常驻的 bar 文本兜底（TTS 未配置等提示）。
    function notify(text) {
      const message = String(text || '')
      if (!message) return
      if (state.visible) showBubble(message, 'hint')
      barMsg.textContent = message
      barMsg.classList.remove('mira-hide')
      clearTimeout(barMsgTimer)
      barMsgTimer = setTimeout(() => barMsg.classList.add('mira-hide'), 9000)
    }

    function backgroundUrlFor(name) {
      if (!name) return ''
      return '/live2d/backgrounds/' + String(name).split('/').map(encodeURIComponent).join('/')
    }

    function applyBackground(url) {
      const image = url ? 'url("' + String(url).replace(/"/g, '%22') + '")' : ''
      bgLayer.style.backgroundImage = image
      // 同时写到 body：宿主 body 有自己的不透明底色，仅靠 z-index:-1 的层
      // 在部分主题里会被盖住；body 内联背景能多覆盖一种布局。清空时置空，
      // 让宿主样式表重新生效。
      document.body.style.backgroundImage = image
      document.body.style.backgroundSize = url ? 'cover' : ''
      document.body.style.backgroundPosition = url ? 'center center' : ''
      document.body.style.backgroundRepeat = url ? 'no-repeat' : ''
      document.body.style.backgroundAttachment = url ? 'fixed' : ''
      if (url) {
        bgLayer.classList.remove('mira-hide')
        document.body.classList.add('mira-l2d-has-bg')
      } else {
        bgLayer.classList.add('mira-hide')
        document.body.classList.remove('mira-l2d-has-bg')
      }
    }

    function availableExpressions() {
      if (state.expressions.length) return state.expressions
      const caps = serverConfig && serverConfig.capabilities
      return (caps && Array.isArray(caps.expressions)) ? caps.expressions : []
    }

    function availableMotions() {
      if (state.motions.length) return state.motions
      const caps = serverConfig && serverConfig.capabilities
      return (caps && Array.isArray(caps.motions)) ? caps.motions : []
    }

    function activeExpressionList() {
      const out = []
      const current = currentExpression() || state.currentExpression
      if (current) out.push(current)
      for (const [name, item] of stackActive) {
        if (item && item.active && !out.includes(name)) out.push(name)
      }
      return out
    }

    function missingExpression(name) {
      const missing = (serverConfig.capabilities && serverConfig.capabilities.missing) || []
      return missing.find((item) => item && item.kind === 'expression' && item.name === name) || null
    }

    function missingMotion(group) {
      const missing = (serverConfig.capabilities && serverConfig.capabilities.missing) || []
      return missing.find((item) => item && item.kind === 'motion' && item.group === group) || null
    }

    async function loadCapabilities(name) {
      try {
        const r = await (await fetch(API + '/capabilities?model=' + encodeURIComponent(name))).json()
        if (r && r.ok) {
          serverConfig.capabilities = {
            expressions: r.expressions || [],
            motions: r.motions || [],
            missing: r.missing || [],
          }
          serverConfig.modelEntry = r.entry || null
          serverConfig.model = r.model || name
        } else {
          serverConfig.capabilities = null
          serverConfig.modelEntry = null
        }
      } catch (e) {
        serverConfig.capabilities = null
        serverConfig.modelEntry = null
      }
    }

    function modelErrorText() {
      const direct = serverConfig.modelsError || serverConfig.modelError
      if (direct) return (direct.message || '模型不可用') + (direct.hint ? '\n' + direct.hint : '')
      return '未配置模型：请把模型放进 ' + ((serverConfig.paths && serverConfig.paths.modelsDir) || 'modelsDir')
        + '，或在 config.json 里改 modelsDir / model'
    }

    async function ensureModel() {
      if (model) return true
      if (!state.entry && serverConfig.modelEntry) {
        state.entry = serverConfig.modelEntry
        state.model = serverConfig.model || state.model
      }
      if (!state.entry) {
        notify('看板娘没有可显示的模型：' + modelErrorText())
        collapseForError('没有可显示的模型')
        return false
      }
      try {
        await setModel(state.entry, state.model)
      } catch (err) {
        console.error('[mira-live2d] 模型加载失败：', err)
        notify('看板娘模型加载失败：' + ((err && err.message) || err))
        collapseForError('模型加载失败')
        return false
      }
      if (model) {
        if (state.background) applyBackground(serverConfig.backgroundUrl || backgroundUrlFor(state.background))
        await restoreSavedExpressions()
        if (serverConfig.showHint !== false && !hintShown) {
          hintShown = true
          showBubble('菜单里可切换模型 / 表情 / 动作 / 背景；滚轮缩放 · 拖拽移动', 'hint')
        }
      }
      return !!model
    }

    async function restoreSavedExpressions() {
      if (!model || restoreExpressions.length === 0) return
      const saved = restoreExpressions.splice(0)
      if (!state.expressionsEnabled) return
      for (let i = 0; i < saved.length; i += 1) {
        const name = saved[i]
        if (availableExpressions().indexOf(name) < 0) continue
        if (missingExpression(name)) continue
        await setExpression(name, i > 0)
      }
    }

    // 模型渲染不出来时，退化成小眼睛（而不是什么都不显示），点一下还能重试
    function collapseForError(reason) {
      try {
        state.visible = false
        root.classList.add('mira-collapsed')
        root.classList.remove('mira-hidden')
        root.style.width = '40px'
        root.style.height = '40px'
        if (handle) {
          handle.title = '看板娘暂时不可用（' + String(reason || '') + '）；点一下重试'
          root.dataset.miraError = String(reason || '')
        }
        updateBar()
      } catch { /* noop */ }
    }

    function setVisible(visible) {
      state.visible = !!visible
      // 收起 = 同一个 root 缩成小眼睛（不再 display:none，否则眼睛也没了）
      root.classList.toggle('mira-collapsed', !state.visible)
      root.classList.remove('mira-hidden')
      if (!state.visible) {
        // 收起的盒子固定 40x40，位置沿用 root 当前的 left/top（就是模型脑袋所在处）
        root.style.width = '40px'
        root.style.height = '40px'
        hideMenu()
        try { hideBubble('collapsed') } catch { /* noop */ }
      } else {
        applyScale(viewScale) // 恢复画布尺寸
        // 尺寸从小眼睛变大：用新盒子重新夹一次，防止半个模型跑到屏幕外
        const r = root.getBoundingClientRect()
        applyPos(r.left, r.top)
        ensureModel()
      }
      updateBar()
      pushState()
    }

    async function selectModel(name) {
      const hit = (serverConfig.models || []).find((m) => m && m.name === name)
      if (!hit || !hit.entry) {
        notify('没有这个模型：' + name + '（可用：' + ((serverConfig.models || []).map((m) => m.name).join('、') || '（无）') + '）')
        return
      }
      state.model = name
      state.entry = hit.entry
      state.expressions = []
      state.motions = []
      state.currentMotion = null
      restoreExpressions = []
      stackActive.clear()
      if (state.visible) await setModel(hit.entry, name)
      await loadCapabilities(name)
      pushState()
      notify('已切换模型：' + name)
    }

    async function selectBackground(name) {
      try {
        const resp = await fetch(API + '/background', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: name || '' }),
        })
        const r = await resp.json().catch(() => null)
        if (!r || !r.ok) {
          const err = r && r.error
          notify('设置背景失败：' + ((err && err.message) || ('HTTP ' + resp.status))
            + (err && err.hint ? '\n' + err.hint : ''))
          return
        }
        state.background = r.background || ''
        applyBackground(r.url || '')
        pushState()
        notify(r.background ? '背景已切换：' + r.background : '已清除背景')
      } catch (e) {
        notify('设置背景失败：' + (e && e.message ? e.message : e))
      }
    }

    /* ── TTS 试听（未配置时给明确提示，不是静默 false） ── */
    function playBase64(base64, mime) {
      if (!base64) return
      try {
        if (audio) {
          try { audio.pause() } catch (e) {}
        }
        audio = new Audio('data:' + (mime || 'audio/mpeg') + ';base64,' + base64)
        ensureAudioGraph(audio)
        const p = audio.play()
        if (p) p.catch(() => {})
      } catch (e) {}
    }

    async function speakDemo() {
      const tts = serverConfig.tts || {}
      if (!tts.enabled || !tts.configured) {
        notify(tts.hint || 'TTS 未配置：在 config.json 启用 tts.enabled，并把 API key 写进 creds/tts.json（权限 600）')
        return
      }
      const text = '你好，我是看板娘。'
      try {
        const resp = await fetch(API + '/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        })
        const r = await resp.json().catch(() => null)
        if (!r || !r.ok) {
          const err = r && r.error
          notify('TTS 失败：' + ((err && err.message) || ('HTTP ' + resp.status))
            + (err && err.hint ? '\n' + err.hint : ''))
          return
        }
        showBubble(text, 'speak')
        playBase64(r.base64, r.mime)
      } catch (e) {
        notify('TTS 请求失败：' + (e && e.message ? e.message : e))
      }
    }

    /* ── 截图：canvas.toDataURL → POST /live2d/api/shot ── */
    async function reportShotError(requestId, message) {
      if (!requestId) return
      try {
        await fetch(API + '/shot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId, error: message }),
        })
      } catch (e) {}
    }

    async function capture(requestId, manual) {
      if (!state.visible || !model) {
        const message = '模型未显示，无法截图'
        if (requestId) await reportShotError(requestId, message)
        if (manual) notify('先显示看板娘，等模型加载完成后再截图')
        return
      }
      let dataUrl
      try {
        dataUrl = canvas.toDataURL('image/png')
      } catch (e) {
        if (requestId) await reportShotError(requestId, 'canvas.toDataURL 失败：' + (e && e.message ? e.message : e))
        if (manual) notify('截图失败：' + (e && e.message ? e.message : e))
        return
      }
      const id = requestId || ('ui-' + Date.now().toString(36))
      try {
        const resp = await fetch(API + '/shot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId: id, dataUrl, model: state.model }),
        })
        const r = await resp.json().catch(() => null)
        if (!r || !r.ok) {
          const err = r && r.error
          const message = (err && err.message) || ('HTTP ' + resp.status)
          // 让等待中的 mira_screenshot 立刻拿到失败原因，而不是干等到超时。
          if (requestId) await reportShotError(requestId, message + (err && err.hint ? '（' + err.hint + '）' : ''))
          if (manual) notify('截图失败：' + message + (err && err.hint ? '\n' + err.hint : ''))
          return
        }
        if (manual) notify('截图已保存：' + r.path)
      } catch (e) {
        if (requestId) await reportShotError(requestId, '上传截图失败：' + (e && e.message ? e.message : e))
        if (manual) notify('截图上传失败：' + (e && e.message ? e.message : e))
      }
    }

    /* ── 气泡 ── */
    let bubbleTimer = null
    // 气泡来源标记：speak/hint 气泡由自身计时器清理，mood 气泡由 idle 流程清理，
    // 避免 agent 回 idle 后把还在朗读的 speak 气泡提前隐藏（B5 修复）
    function showBubble(text, source) {
      if (!text) return
      bubble.textContent = text
      bubble.classList.remove('mira-hide')
      state.currentUtterance = text
      state.bubbleSource = source || 'generic'
      clearTimeout(bubbleTimer)
      const ms = Math.min(12000, Math.max(3000, String(text).length * 90))
      bubbleTimer = setTimeout(() => hideBubble(state.bubbleSource), ms)
    }
    function hideBubble(source) {
      if (source && state.bubbleSource && source !== state.bubbleSource) return
      bubble.classList.add('mira-hide')
      state.currentUtterance = ''
      state.bubbleSource = null
    }

    /* ── 语音 + RMS 口型 ── */
    let audio = null
    let audioUnlocked = false
    let audioCtx = null
    let analyser = null
    let lipEl = null
    let mouthParamId = null
    let lipLevel = 0
    let lipDriving = false
    let lipBuf = null
    let lipTickerAdded = false

    function unlockAudio() {
      if (audioUnlocked) return
      audioUnlocked = true
      const a = new Audio('data:audio/mp3;base64,//uQZAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCA')
      a.play().then(() => a.pause()).catch(() => {})
      try {
        if (!audioCtx) {
          const AC = window.AudioContext || window.webkitAudioContext
          if (AC) {
            audioCtx = new AC()
            if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {})
          }
        } else if (audioCtx.state === 'suspended') {
          audioCtx.resume().catch(() => {})
        }
      } catch (e) {}
    }
    document.addEventListener('pointerdown', unlockAudio, { once: false })

    // 把 audio 元素接进 Web Audio 图：MediaElementSource -> Analyser -> destination。
    // data: URL 属同源，分析数据不受 CORS 污染；元素一旦接上 MediaElementSource，
    // 声音必须经此图输出，因此必须连到 destination，否则会静音。
    function ensureAudioGraph(el) {
      try {
        if (!audioCtx) {
          const AC = window.AudioContext || window.webkitAudioContext
          if (!AC) return null
          audioCtx = new AC()
        }
        if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {})
        const src = audioCtx.createMediaElementSource(el)
        analyser = audioCtx.createAnalyser()
        analyser.fftSize = 512
        analyser.smoothingTimeConstant = 0.5
        src.connect(analyser)
        analyser.connect(audioCtx.destination)
        lipEl = el
        lipBuf = new Uint8Array(analyser.fftSize)
        return analyser
      } catch (e) {
        return null
      }
    }

    // 探测口型参数 id：参数表来自 moc3（Cubism5），优先精确匹配，其次模糊匹配；
    // 找不到口型参数返回 null，驱动循环会直接跳过（不误写伪索引）。
    function findMouthParam(cm) {
      try {
        const ids = cm && cm._parameterIds
        if (Array.isArray(ids) && ids.length) {
          for (const id of ['ParamMouthOpen', 'ParamMouthOpenY']) {
            if (ids.includes(id)) return id
          }
          const hit = ids.find((x) => /MouthOpen/i.test(String(x)))
          if (hit) return hit
          return null
        }
        if (cm && typeof cm.getParameterIndex === 'function') {
          for (const id of ['ParamMouthOpen', 'ParamMouthOpenY']) {
            if (cm.getParameterIndex(id) >= 0) return id
          }
        }
      } catch (e) {}
      return 'ParamMouthOpen'
    }

    // 每帧 RMS -> ParamMouthOpen。ticker 回调在模型自身 onTickerUpdate 之前执行，
    // 数值会经 saveParameters 进入基线，随后模型内部 update（表情/物理）与渲染
    // 依次读到该值；音频结束后把 0 写回基线，口型即自然闭合。
    function ensureLipTicker() {
      if (lipTickerAdded || !app) return
      lipTickerAdded = true
      app.ticker.add(() => {
        let cm = null
        try {
          cm = model && model.internalModel ? model.internalModel.coreModel : null
        } catch (e) {}
        if (!cm) return
        if (lipEl && analyser && !lipEl.ended && !lipEl.paused) {
          try {
            analyser.getByteTimeDomainData(lipBuf)
            let sum = 0
            for (let i = 0; i < lipBuf.length; i++) {
              const v = (lipBuf[i] - 128) / 128
              sum += v * v
            }
            const rms = Math.sqrt(sum / lipBuf.length)
            const target = Math.min(1, Math.max(0, (rms - 0.035) * 8))
            const k = target > lipLevel ? 0.55 : 0.22
            lipLevel += (target - lipLevel) * k
            if (!mouthParamId) mouthParamId = findMouthParam(cm)
            if (mouthParamId) cm.setParameterValueById(mouthParamId, lipLevel, 1)
            lipDriving = true
          } catch (e) {}
        } else if (lipDriving) {
          lipDriving = false
          lipLevel = 0
          try {
            if (!mouthParamId) mouthParamId = findMouthParam(cm)
            if (mouthParamId) cm.setParameterValueById(mouthParamId, 0, 1)
          } catch (e) {}
        }
      })
    }

    async function playAudio(audioId) {
      try {
        const r = await (await fetch(API + '/audio/' + encodeURIComponent(audioId))).json()
        if (!r || !r.base64) return
        if (audio) {
          try {
            audio.pause()
          } catch (e) {}
        }
        if (lipEl) {
          lipEl = null
          lipLevel = 0
          lipDriving = false
        }
        audio = new Audio('data:' + (r.mime || 'audio/mpeg') + ';base64,' + r.base64)
        ensureAudioGraph(audio)
        audio.addEventListener('ended', () => {
          if (lipEl === audio) {
            lipEl = null
            lipDriving = false
          }
        })
        const p = audio.play()
        if (p) p.catch(() => {})
      } catch (e) {}
    }

    /* ── 表情 / 动作 ── */
    function getExpressionManager() {
      try {
        return model && model.internalModel && model.internalModel.motionManager
          ? model.internalModel.motionManager.expressionManager
          : null
      } catch (e) {
        return null
      }
    }

    function resetExpression() {
      // model.expression(null) 会被 setExpression(null) 当成「找不到该表情」直接返回 false，
      // 因此必须调用 expressionManager.resetExpression() 才能真正恢复默认表情。
      const em = getExpressionManager()
      if (em && typeof em.resetExpression === 'function') {
        try {
          em.resetExpression()
          if (em.defaultExpression) em.currentExpression = em.defaultExpression
        } catch (e) {}
      } else if (model) {
        try {
          model.expression(null)
        } catch (e) {}
      }
      state.currentExpression = null
      // 默认表情 = 恢复初始状态：同时清空所有叠加表情
      for (const item of stackActive.values()) item.active = false
      pushState()
    }

    async function getExpressionMotion(name) {
      const em = getExpressionManager()
      if (!em || typeof em.loadExpression !== 'function') return null
      const idx = (em.definitions || []).findIndex((d) => d && d.Name === name)
      if (idx < 0) return null
      try {
        return await em.loadExpression(idx)
      } catch (e) {
        return null
      }
    }

    async function toggleStackExpression(name) {
      const item = stackActive.get(name)
      if (item) {
        item.active = !item.active
        rebuildStackedExpression()
        pushState()
        return
      }
      const motion = await getExpressionMotion(name)
      if (!motion) return
      stackActive.set(name, { motion, active: true })
      rebuildStackedExpression()
      pushState()
    }

    // 把「当前互斥表情 + 所有 active 叠加表情」合并成一个合成 ExpressionMotion，
    // 通过 expressionManager 的官方队列应用。
    // 官方队列的更新位于 coreModel.saveParameters() 之后、下一帧 loadParameters() 之前：
    // 每帧从干净基线重新应用，不会把叠加值写进 saved 基线，因此不会逐帧累积漂移；
    // 关闭叠加后 rebuild 出的合成表情不含该参数，下一帧即自然恢复。
    const BLEND_NAMES = ['Add', 'Multiply', 'Overwrite']
    function rebuildStackedExpression() {
      const em = getExpressionManager()
      if (!em) return
      const merged = new Map() // parameterId -> { blend, value }
      let any = false
      try {
        const ce = em.currentExpression
        if (ce && ce !== em.defaultExpression && ce._parameters) {
          any = true
          for (const p of ce._parameters) {
            merged.set(String(p.parameterId), { blend: p.blendType, value: p.value })
          }
        }
      } catch (e) {}
      for (const item of stackActive.values()) {
        if (!item.active || !item.motion) continue
        any = true
        for (const p of item.motion._parameters || []) {
          merged.set(String(p.parameterId), { blend: p.blendType, value: p.value })
        }
      }
      if (!any) {
        try {
          em.resetExpression()
        } catch (e) {}
        return
      }
      try {
        const Parameters = []
        for (const entry of merged) {
          Parameters.push({
            Id: entry[0],
            Value: entry[1].value,
            Blend: BLEND_NAMES[entry[1].blend] || 'Add',
          })
        }
        const motion = em.createExpression({ Parameters })
        if (motion && typeof motion.setFadeInTime === 'function') motion.setFadeInTime(0)
        em._setExpression(motion)
      } catch (e) {}
    }

    async function setExpression(name, stack) {
      if (!model) {
        notify('先显示看板娘，等模型加载完成后再切换表情')
        return
      }
      if (!state.expressionsEnabled) {
        notify('表情系统已关闭（可用 mira_set_expressions_enabled 打开）')
        return
      }
      if (!name) {
        resetExpression()
        return
      }
      if (availableExpressions().indexOf(name) < 0) {
        notify('当前模型没有这个表情：' + name)
        return
      }
      if (stack) {
        await toggleStackExpression(name)
        return
      }
      try {
        if (availableExpressions().indexOf(name) >= 0) {
          await model.expression(name)
          state.currentExpression = name
          // 互斥表情切换后重建叠加层：把新表情参数与 active 叠加表情合并进官方队列
          rebuildStackedExpression()
        }
      } catch (e) {}
      pushState()
    }

    function playMotion(name) {
      if (!model) {
        notify('先显示看板娘，等模型加载完成后再播放动作')
        return
      }
      if (!state.animationsEnabled) {
        notify('动画播放已关闭（可用 mira_set_animations_enabled 打开）')
        return
      }
      try {
        model.motion(name)
        state.currentMotion = name
      } catch (e) {
        notify('动作播放失败：' + (e && e.message ? e.message : name))
      }
      pushState()
    }

    /* ── 心情（思考 / 等待 / 空闲） ── */
    let idleTimer = null
    function applyMood(mood) {
      state.mood = mood
      if (mood === 'thinking') {
        clearTimeout(idleTimer)
        const p = persona.thinking || {}
        if (p.expression) setExpression(p.expression)
        if (p.bubble) showBubble(p.bubble, 'mood')
      } else if (mood === 'awaiting') {
        clearTimeout(idleTimer)
        const p = persona.awaiting || {}
        if (p.expression) setExpression(p.expression)
        if (p.bubble) showBubble(p.bubble, 'mood')
      } else {
        // idle：延迟后恢复默认（只清理 mood 自己显示的气泡，不打断 speak/hint 气泡）
        clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          if (state.mood !== 'idle') return
          if (state.expressionsEnabled) {
            resetExpression()
          }
          hideBubble('mood')
        }, persona.idleClearMs || 0)
      }
      pushState()
    }

    /* ── 指令执行 ── */
    async function execCommand(cmd) {
      switch (cmd.action) {
        case 'expression': {
          const v = cmd.value
          const nm = (v && typeof v === 'object') ? (v.name || '') : (v || '')
          const stack = !!(v && typeof v === 'object' && v.stack)
          setExpression(nm, stack)
          break
        }
        case 'motion':
          playMotion(cmd.value)
          break
        case 'speak':
          if (cmd.value && cmd.value.text) showBubble(cmd.value.text, 'speak')
          if (cmd.value && cmd.value.audioId) await playAudio(cmd.value.audioId)
          break
        case 'bubble':
          showBubble(cmd.value || '', 'speak')
          break
        case 'show':
          setVisible(true)
          break
        case 'hide':
          setVisible(false)
          break
        case 'set_visible':
          setVisible(!!cmd.value)
          break
        case 'switch_model':
          if (cmd.value && cmd.value.entry) {
            restoreExpressions = []
            if (state.visible) {
              await setModel(cmd.value.entry, cmd.value.model || cmd.value.entry.split('/')[0])
            } else {
              state.model = cmd.value.model || state.model
              state.entry = cmd.value.entry
              await loadCapabilities(state.model)
            }
            pushState()
          }
          break
        case 'set_background':
          state.background = (cmd.value && cmd.value.name) || ''
          applyBackground((cmd.value && cmd.value.url) || '')
          pushState()
          break
        case 'screenshot':
          await capture(cmd.value && cmd.value.requestId, false)
          break
        case 'set_expressions':
          state.expressionsEnabled = !!cmd.value
          if (!state.expressionsEnabled) {
            resetExpression()
          }
          pushState()
          break
        case 'set_animations':
          state.animationsEnabled = !!cmd.value
          pushState()
          break
        case 'set_persona':
          persona = Object.assign(
            { thinking: { expression: '', bubble: '' }, awaiting: { expression: '', bubble: '' }, idleClearMs: 3200 },
            cmd.value || {}
          )
          break
        case 'mood':
          applyMood(cmd.value || 'idle')
          break
      }
    }

    /* ── 指令轮询 ── */
    // 消费位置持久化：刷新后从上次位置继续，不重放历史指令（避免重新触发模型切换等副作用）
    const CMD_ID_KEY = 'mira_l2d_cmd_id'
    // 一次性事件指令：页面刚加载的首轮轮询只重建「状态型」指令，不重放这些瞬时指令。
    // 否则当 localStorage 游标丢失（归零）时，刷新页面会把历史气泡与声音全部再执行一遍。
    const TRANSIENT_ACTIONS = { speak: true, bubble: true, motion: true, screenshot: true }
    let lastCommandId = (() => {
      try {
        const v = JSON.parse(localStorage.getItem(CMD_ID_KEY) || '0')
        return typeof v === 'number' && v > 0 ? v : 0
      } catch (e) {
        return 0
      }
    })()
    let polling = false
    let firstPoll = true
    async function pollCommands() {
      if (polling) return
      polling = true
      try {
        const r = await (await fetch(API + '/commands?since=' + lastCommandId)).json()
        const list = (r && r.commands) || []
        for (const cmd of list) {
          if (!cmd || cmd.id <= lastCommandId) continue
          lastCommandId = cmd.id
          try {
            localStorage.setItem(CMD_ID_KEY, JSON.stringify(lastCommandId))
          } catch (e) {}
          if (firstPoll && TRANSIENT_ACTIONS[cmd.action]) continue
          try {
            await execCommand(cmd)
          } catch (e) {}
        }
        firstPoll = false
      } catch (e) {
      } finally {
        polling = false
      }
    }
    setInterval(pollCommands, config.pollIntervalMs || 1500)
    pollCommands()

    /* ── 状态上报 ── */
    let pushingState = false
    function pushState() {
      if (pushingState) return
      pushingState = true
      const payload = {
        visible: state.visible,
        model: state.model,
        background: state.background,
        currentExpression: currentExpression() || state.currentExpression,
        currentMotion: state.currentMotion,
        currentUtterance: state.currentUtterance,
        stacked: [...stackActive.keys()].filter((k) => {
          const it = stackActive.get(k)
          return !!(it && it.active)
        }),
        expressions: activeExpressionList(),
        availableExpressions: state.expressions,
        motions: state.motions,
        expressionsEnabled: state.expressionsEnabled,
        animationsEnabled: state.animationsEnabled,
        mood: state.mood,
        t: Date.now(),
      }
      fetch(API + '/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .catch(() => {})
        .finally(() => {
          pushingState = false
        })
    }
    setInterval(pushState, 5000)

    /* ── 缩放（以指针/滚轮位置为锚点；修正原实现中 applyScale 先改 viewScale 导致锚点失效的问题） ── */
    function zoomAt(cx, cy, factor) {
      const r = root.getBoundingClientRect()
      const oldScale = viewScale
      const px = cx - r.left
      const py = cy - r.top
      const ns = Math.max(0.25, Math.min(3, oldScale * factor))
      if (ns === oldScale) return
      applyScale(ns)
      applyPos(cx - px * (ns / oldScale), cy - py * (ns / oldScale))
    }

    /* ── 拖拽移动 / 双指缩放 / 长按菜单 ── */
    const pointers = new Map() // pointerId -> { x, y, startX, startY }
    let dragging = false
    let dragPointerId = null
    let dragDx = 0
    let dragDy = 0
    let lastPinchDist = 0
    let longPressTimer = null
    let longPressPointerId = null
    let longPressFired = false
    let dragMoved = false
    let suppressClickUntil = 0
    const LONG_PRESS_MS = 500
    const MOVE_TOLERANCE = 6

    function dist(a, b) {
      return Math.hypot(a.x - b.x, a.y - b.y)
    }
    function midpoint(a, b) {
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    }
    function cancelLongPress() {
      if (longPressTimer) {
        clearTimeout(longPressTimer)
        longPressTimer = null
      }
      longPressPointerId = null
    }
    function savePos() {
      const r = root.getBoundingClientRect()
      try {
        localStorage.setItem(POS_KEY, JSON.stringify({ x: r.left, y: r.top }))
      } catch (e) {}
    }
    function startLongPress(e) {
      cancelLongPress()
      const sx = e.clientX
      const sy = e.clientY
      longPressPointerId = e.pointerId
      longPressFired = false
      longPressTimer = setTimeout(() => {
        longPressTimer = null
        if (longPressFired) return
        longPressFired = true
        dragging = false
        buildMenu(sx, sy)
      }, LONG_PRESS_MS)
    }

    root.addEventListener('pointerdown', (e) => {
      if (e.target === menu || menu.contains(e.target)) return
      if (e.pointerType === 'mouse' && e.button !== 0) return
      e.preventDefault()
      try {
        root.setPointerCapture(e.pointerId)
      } catch (err) {}
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY })

      if (pointers.size === 1) {
        dragPointerId = e.pointerId
        const r = root.getBoundingClientRect()
        dragDx = e.clientX - r.left
        dragDy = e.clientY - r.top
        dragging = true
        longPressFired = false
        dragMoved = false
        if (e.pointerType === 'touch' || e.pointerType === 'pen') startLongPress(e)
      } else if (pointers.size === 2) {
        cancelLongPress()
        dragging = false
        const pts = [...pointers.values()]
        lastPinchDist = dist(pts[0], pts[1])
      } else {
        cancelLongPress()
        dragging = false
      }
    })

    root.addEventListener('pointermove', (e) => {
      const p = pointers.get(e.pointerId)
      if (!p) return
      p.x = e.clientX
      p.y = e.clientY

      if (pointers.size === 2) {
        cancelLongPress()
        dragging = false
        const pts = [...pointers.values()]
        const d = dist(pts[0], pts[1])
        if (lastPinchDist > 0 && d > 0) {
          const mid = midpoint(pts[0], pts[1])
          zoomAt(mid.x, mid.y, d / lastPinchDist)
        }
        lastPinchDist = d
        return
      }

      if (!dragging || e.pointerId !== dragPointerId || longPressFired) return
      if (Math.hypot(e.clientX - p.startX, e.clientY - p.startY) > MOVE_TOLERANCE) dragMoved = true
      if (longPressTimer && dragMoved) {
        cancelLongPress()
      }
      applyPos(e.clientX - dragDx, e.clientY - dragDy)
    })

    function pointerEnd(e) {
      const wasLongPress = longPressFired && e.pointerId === dragPointerId
      pointers.delete(e.pointerId)
      if (e.pointerId === longPressPointerId) cancelLongPress()
      if (e.pointerId === dragPointerId) {
        // 只有**主键**（鼠标左键 / 触摸）才算"点一下切换显隐"。
        // 右键（button=2）只用于弹菜单，绝不能再触发切换 —— 之前右键一松手就把模型收成眼睛，
        // 菜单也正好挂在眼睛上，看起来像"眼睛有右键菜单"。
        const primary = e.pointerType === 'mouse' ? e.button === 0 : true
        if (primary && !wasLongPress && !longPressFired && !dragMoved) {
          setVisible(!state.visible)
          dragging = false
          return
        }
        if (dragging && !longPressFired) savePos()
        dragging = false
        if (wasLongPress) suppressClickUntil = Date.now() + 150
        longPressFired = false
      }
      if (pointers.size === 1) {
        const first = pointers.entries().next().value
        if (first) {
          dragPointerId = first[0]
          const r = root.getBoundingClientRect()
          dragDx = first[1].x - r.left
          dragDy = first[1].y - r.top
          dragging = true
        }
      } else if (pointers.size === 0) {
        dragging = false
        lastPinchDist = 0
      }
    }
    root.addEventListener('pointerup', pointerEnd)
    root.addEventListener('pointercancel', pointerEnd)

    /* ── 滚轮缩放 ── */
    root.addEventListener(
      'wheel',
      (e) => {
        if (e.target === menu || menu.contains(e.target)) return
        e.preventDefault()
        zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.08 : 0.92)
      },
      { passive: false }
    )

    /* ── 右键 / 长按 / 菜单按钮：模型 · 表情 · 动作 · 背景 · 截图 · TTS ── */
    function buildMenu(x, y) {
      menu.innerHTML = ''
      const addSep = () => {
        const sep = document.createElement('div')
        sep.className = 'mira-menu-sep'
        menu.appendChild(sep)
      }
      const addTitle = (text) => {
        const title = document.createElement('div')
        title.className = 'mira-menu-title'
        title.textContent = text
        menu.appendChild(title)
      }
      const addItem = (label, onClick, active, disabled) => {
        const item = document.createElement('div')
        item.className = 'mira-menu-item'
        if (active) item.classList.add('mira-menu-item-active')
        if (disabled) item.classList.add('mira-menu-item-disabled')
        item.textContent = label
        item.addEventListener('click', () => {
          hideMenu()
          if (disabled || typeof onClick !== 'function') return
          onClick()
        })
        menu.appendChild(item)
      }

      addTitle('看板娘')
      addItem(state.visible ? '隐藏看板娘' : '显示看板娘（默认隐藏）', () => setVisible(!state.visible))

      addSep()
      addTitle('模型')
      const models = serverConfig.models || []
      if (models.length === 0) {
        addItem('（没有可用模型）', () => notify(modelErrorText()), false, true)
      } else {
        for (const m of models) {
          addItem((state.model === m.name ? '✓ ' : '') + m.name, () => selectModel(m.name), state.model === m.name)
        }
      }

      addSep()
      addTitle('表情')
      const expressions = availableExpressions()
      const anyStack = [...stackActive.values()].some((item) => item && item.active)
      const current = currentExpression() || state.currentExpression
      addItem('默认表情', () => setExpression('', false), !current && !anyStack)
      if (expressions.length === 0) {
        addItem('（当前模型没有表情）', null, false, true)
      } else {
        for (const exp of expressions) {
          const on = stackActive.has(exp) && stackActive.get(exp).active
          const miss = missingExpression(exp)
          if (miss) {
            addItem('⚠ ' + exp + '（文件缺失）', () => notify(
              '表情文件缺失：' + (miss.file || '') + (miss.path ? '\n' + miss.path : '')
                + (miss.hint ? '\n' + miss.hint : '')
            ), false)
          } else {
            addItem((on ? '✓ ' : '') + exp, () => setExpression(exp, true), on)
          }
        }
      }

      addSep()
      addTitle('动作')
      const motions = availableMotions()
      if (motions.length === 0) {
        addItem('（当前模型没有动作）', null, false, true)
      } else {
        for (const motion of motions) {
          const miss = missingMotion(motion)
          if (miss) {
            addItem('⚠ ' + motion + '（文件缺失）', () => notify(
              '动作文件缺失：' + (miss.file || '') + (miss.path ? '\n' + miss.path : '')
                + (miss.hint ? '\n' + miss.hint : '')
            ), false)
          } else {
            addItem((state.currentMotion === motion ? '✓ ' : '') + motion, () => playMotion(motion), state.currentMotion === motion)
          }
        }
      }

      addSep()
      addTitle('背景')
      addItem(state.background ? '无背景' : '✓ 无背景', () => selectBackground(''), !state.background)
      for (const bg of (serverConfig.backgrounds || [])) {
        addItem((state.background === bg.name ? '✓ ' : '') + bg.name, () => selectBackground(bg.name), state.background === bg.name)
      }
      if ((serverConfig.backgrounds || []).length === 0) {
        addItem('（背景目录里没有图片）', () => notify(
          (serverConfig.backgroundsError && serverConfig.backgroundsError.message)
            || '背景图目录里没有图片'
        ), false, true)
      }

      addSep()
      addTitle('工具')
      addItem('截图', () => capture(null, true))
      const tts = serverConfig.tts || {}
      addItem(
        tts.enabled && tts.configured ? '试听 TTS' : 'TTS 未配置（点击查看）',
        () => speakDemo(),
        false,
        false
      )

      menu.classList.remove('mira-hide')
      menu.style.left = Math.max(0, Math.min(x, window.innerWidth - menu.offsetWidth - 8)) + 'px'
      menu.style.top = Math.max(0, Math.min(y, window.innerHeight - menu.offsetHeight - 10)) + 'px'
    }
    function hideMenu() {
      menu.classList.add('mira-hide')
    }
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      buildMenu(e.clientX, e.clientY)
    })
    document.addEventListener('click', (e) => {
      if (Date.now() < suppressClickUntil) return
      if (menu.contains(e.target)) return
      hideMenu()
    })
    document.addEventListener('scroll', (e) => {
      if (e.target === menu || menu.contains(e.target)) return
      hideMenu()
    }, true)

    /* ── 通知气泡 ── */
    // 开关已改为「同一个物件」：点击在 root 的 pointerup 里判定（见 dragMoved），
    // 这里有 click 处理器会和对端逻辑重复触发，必须不加。
    barMsg.addEventListener('click', () => barMsg.classList.add('mira-hide'))

    /* ── 视线跟随 ── */
    document.addEventListener('pointermove', (e) => {
      if (!model) return
      const r = canvas.getBoundingClientRect()
      try {
        model.focus((e.clientX - r.left) / viewScale, (e.clientY - r.top) / viewScale)
      } catch (err) {}
    })

    /* ── 初始状态：默认隐藏；只有服务端 state.visible=true 才自动显示 ── */
    updateBar()
    // 即使隐藏也先上报一次，让 mira_get_state 的 online 立刻为 true。
    pushState()
    applyBackground(config.backgroundUrl || '')
    if (config.backgroundError) {
      const err = config.backgroundError
      notify('背景图不可用：' + (err.message || '') + (err.hint ? '\n' + err.hint : ''))
    }
    if (config.stateError) {
      const err = config.stateError
      notify('状态文件不可用（显隐/模型不会持久化）：' + (err.message || '')
        + (err.hint ? '\n' + err.hint : ''))
    }
    if (state.visible) await ensureModel()

    // 暴露给调试/手动控制
    window.MiraL2D = {
      setExpression,
      playMotion,
      showBubble,
      setMood: applyMood,
      setVisible,
      get visible() { return state.visible },
      get model() { return state.model },
      show: () => setVisible(true),
      hide: () => setVisible(false),
      screenshot: () => capture(null, true),
      setBackground: selectBackground,
      selectModel,
    }
  }

  main().catch((err) => {
    console.error('[mira-live2d] 初始化失败：', err)
    try {
      const box = document.getElementById('mira-l2d-root')
      if (box) {
        box.classList.add('mira-collapsed')
        box.classList.remove('mira-hidden')
        box.style.cssText += ';position:fixed;left:12px;bottom:12px;z-index:2147483001;width:40px;height:40px;'
        box.dataset.miraError = String((err && err.message) || err)
      }
      const msg = document.getElementById('mira-l2d-bar-msg')
      if (msg) {
        msg.textContent = '看板娘初始化失败：' + ((err && err.message) || err)
        msg.classList.remove('mira-hide')
      }
    } catch { /* noop */ }
  })
})()
