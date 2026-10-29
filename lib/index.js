/**
 * mira_live2d — DSH 主机端插件（装配层）
 *
 * 职责：
 *   1. 读配置（$DSH_HOME/mira_config/mira_live2d/config.json，schemaVersion=2 权威；
 *      profile 里的旧 config 只作兼容兜底，见 README「迁移」）
 *   2. 单实例保护 + 热加载（改 config.json 后目录/模型/TTS 立即生效）
 *   3. 注册 20 个模型可调用的工具（lib/tools.js）
 *   4. 通过 webServer 提供静态资源（widget、Live2D 运行库、模型、背景、截图）
 *      与指令/状态/TTS/截图 API；通过 tapIndex 注入看板娘脚本
 *   5. 状态落盘（state.json，默认隐藏）；前端每 5 秒上报状态
 *   6. 截图：前端 canvas.toDataURL → POST /live2d/api/shot → 落盘 mediaDir
 *      （宿主没有 webServer.register 时工具返回 platform/unsupported，不引 Playwright）
 *
 * 仅依赖 Node 内置模块（硬约束1）；webServer 是硬依赖（前端注入/静态路由都靠它），
 * 与旧版一致。测试里若 webServer 缺 register，则工具仍在，截图返回 platform/unsupported。
 */

import { readFile } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  claimInstance, ensureDir, fail, makeCounters, miraConfigDir, nowIso, okObj,
  readJsonStrict, toError, warnCount, writeJsonAtomic, writeJsonSecure,
} from './kit.mjs'
import {
  CONFIG_SCHEMA, ConfigStore, DEFAULTS, TTS_PROVIDERS, credsFile,
} from './config.js'
import { ModelCatalog } from './models.js'
import { STATE_SCHEMA, StateStore } from './state.js'
import { CREDS_SCHEMA, TtsService } from './tts.js'
import { ShotService } from './shot.js'
import { registerTools } from './tools.js'

export const name = 'mira_live2d'

/**
 * webServer 硬依赖：static 资源、指令轮询、截图上传都在它上面。
 * 若宿主不提供，cordis 不会加载本插件（这是宿主级行为，比起半个插件更好排查）。
 * tools 之外不写别的硬依赖（不需要会话/账号）。
 */
export const inject = ['webServer', 'tools']

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ASSETS_DIR = join(ROOT, 'assets')
const INSTANCE_ID = 'mira_live2d'
const TOOL_COUNT = 20

/* ── 静态资源 MIME ─────────────────────────────────────────── */

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.moc3': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.mtn': 'application/octet-stream',
  '.fnt': 'application/octet-stream',
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type })
  res.end(body)
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8')
}

const close = (fn) => {
  try {
    fn?.()
  } catch {
    /* 退场不抛 */
  }
}

/* ── 请求来源（CSRF） ────────────────────────────────────── */

const SINCE_MAX_LEAD_MS = 24 * 60 * 60 * 1000

/**
 * 同源守卫：浏览器发起的跨站请求一律拒绝。
 *   - `Sec-Fetch-Site: cross-site` → 拒（现代浏览器都会带）；
 *   - `Origin` 存在且 host 与 `Host` 不一致（或为 `null`）→ 拒；
 *   - 没有 `Origin`（curl / Node / 同源 GET 之外的本地客户端）→ 放行。
 * 这些接口能改 state.json、落盘截图、消耗 TTS 额度，不能让随便一个网页盲写。
 */
function isSameOriginRequest(req) {
  const headers = req && req.headers ? req.headers : {}
  if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false
  const rawOrigin = headers.origin
  if (rawOrigin === undefined || rawOrigin === null) return true
  const origin = String(rawOrigin).trim()
  if (origin === '') return true
  if (origin.toLowerCase() === 'null') return false
  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const host = String(headers.host || '').trim().toLowerCase()
  if (host === '') return false
  return parsed.host.toLowerCase() === host
}

/**
 * 客户端游标只采信安全的非负整数，且最多领先当前时钟一天。
 * 否则 `?since=1e21` 会把 nextCommandId 推到浮点精度边界：之后 id++ 不再变化，
 * 客户端用同一个游标永远收不到新指令（README 承诺的「ID 单调递增」被破坏）。
 */
function clientSince(raw) {
  const parsed = Number(raw ?? 0)
  if (!Number.isFinite(parsed) || parsed <= 0) return 0
  const since = Math.floor(parsed)
  if (!Number.isSafeInteger(since)) return 0
  if (since > Date.now() * 1000 + SINCE_MAX_LEAD_MS) return 0
  return since
}

/* ── 入口 ─────────────────────────────────────────────────── */

export function apply(ctx, config) {
  const logger = ctx.logger || null
  const counters = makeCounters()
  counters.pluginName = 'mira_live2d'

  // 约定6 单实例：两个实例 = 两套指令队列/路由/state 写入，指令会翻倍。
  const claim = claimInstance(INSTANCE_ID)
  if (!claim.ok) {
    warnCount(logger, counters, 'plugin/instance',
      'mira_live2d 已经有一个实例在跑（pid=' + (claim.holder?.pid ?? '?') + '），本次加载被拒绝')
    return fail('plugin/instance', 'mira_live2d 已有实例在跑，重复加载被拒绝',
      '检查 profile 的 cordis patch 是否把 mira_live2d 挂了两遍；一个进程只允许一个实例')
  }

  const baseDir = miraConfigDir('mira_live2d')
  ensureDir(baseDir)
  // 默认目录先建出来，让用户一眼知道模型/背景图该放哪；自定义目录不替用户创建。
  ensureDir(join(baseDir, 'model'))
  ensureDir(join(baseDir, 'image'))
  ensureDir(join(baseDir, 'media'))

  const profileConfig = config && typeof config === 'object' ? config : {}
  const configStore = new ConfigStore({ baseDir, profileConfig, logger, counters })
  const loaded = configStore.load()
  if (loaded.error) {
    warnCount(logger, counters, loaded.error.code, loaded.error.message)
  }

  let cfg
  try {
    cfg = configStore.current()
  } catch {
    cfg = configStore.fallback
  }

  if (cfg.enabled === false) {
    claim.release()
    logger?.info?.('[mira_live2d] 已禁用（config.enabled=false），不注册工具/路由')
    return fail('plugin/disabled', 'mira_live2d 被 config.enabled=false 禁用', '把 config.json 里的 enabled 改回 true 再重载插件')
  }

  const stateStore = new StateStore({ baseDir, logger, counters })
  const stateLoaded = stateStore.load()
  if (stateLoaded.error) {
    warnCount(logger, counters, stateLoaded.error.code, stateLoaded.error.message)
  }

  let personaAtRuntime = structuredClone(cfg.persona)
  let personaOverridden = false
  const commandQueue = []
  // 用时间戳作指令 ID 起点：重启后指令 ID 仍递增，客户端 localStorage 游标不会超过新 ID。
  let nextCommandId = Date.now() * 1000
  const audioStore = new Map()
  let audioSeq = 0

  function pushCommand(action, value) {
    const id = nextCommandId++
    commandQueue.push({ id, action, value, ts: Date.now() })
    if (commandQueue.length > 2000) commandQueue.splice(0, commandQueue.length - 2000)
    return id
  }

  function nextAudioId() {
    return String(nextCommandId) + ':a' + (audioSeq++)
  }

  const models = (current) => new ModelCatalog({
    modelsDir: current.modelsDir,
    imageDir: current.imageDir,
    configFile: current.configFile,
    pluginRoot: ROOT,
    logger,
    counters,
  })

  const tts = (current) => new TtsService({
    config: current.tts,
    baseDir,
    configFile: current.configFile,
    logger,
    counters,
    fetchImpl: (...args) => globalThis.fetch(...args),
  })

  const ws = ctx.webServer
  const endpointAvailable = !!(ws && typeof ws.register === 'function')
  const shot = new ShotService({
    mediaDir: cfg.shot.mediaDir,
    config: cfg.shot,
    logger,
    counters,
    endpointAvailable,
  })

  function shotFor(current) {
    shot.setMediaDir(current.shot.mediaDir)
    shot.setMaxBytes(current.shot.maxBytes)
    return shot
  }

  const deps = {
    configStore,
    stateStore,
    baseDir,
    configFile: configStore.file,
    pluginRoot: ROOT,
    logger,
    counters,
    catalog: models,
    tts,
    shotFor,
    pushCommand,
    nextAudioId,
    audioStore,
    commandQueue,
    __nextCommandId: () => nextCommandId,
    __setNextCommandId: (value) => {
      nextCommandId = value
    },
    // persona 默认跟随 config.json（热加载）；一旦工具 mira_set_persona 覆写，
    // 就保持运行期值直到重载插件（README「已知取舍」）。
    getPersona: (current) => {
      if (!personaOverridden && current && current.persona) {
        personaAtRuntime = structuredClone(current.persona)
      }
      return personaAtRuntime
    },
    setPersona: (persona) => {
      personaAtRuntime = persona
      personaOverridden = true
    },
  }

  // 退场：先摘工具/路由，再落状态，最后放认领（新实例 load 到的永远是最新文件）。
  // 装配期注册步骤抛错时也必须走同一条释放路径：否则认领会一直占着（进程内只能靠
  // 重启恢复），已经挂上去的路由 / tap / 工具也会留在宿主上。
  const offs = []
  let disposeTools = null
  let tapDisposer = null
  let routeDisposer = null
  let released = false
  const releaseAll = () => {
    if (released) return
    released = true
    for (const off of offs.splice(0)) close(off)
    close(routeDisposer)
    close(tapDisposer)
    close(disposeTools)
    close(() => shot.dispose())
    close(() => stateStore.flush())
    close(() => claim.release())
  }

  try {
    disposeTools = registerTools(ctx, deps)
  } catch (error) {
    releaseAll()
    throw error
  }

  // 1. 注入看板娘脚本到 index.html
  if (endpointAvailable && typeof ws.tapIndex === 'function') {
    try {
      tapDisposer = ws.tapIndex(tapIndex)
    } catch (error) {
      warnCount(logger, counters, 'web/tap-failed', '注入 index.html 失败：' + (error?.message || error))
    }
  } else if (!endpointAvailable) {
    warnCount(logger, counters, 'platform/unsupported',
      'webServer 没有 register：前端路由与截图上传不可用，mira_screenshot 会返回 platform/unsupported')
  }

  // 2. 注册静态资源 / API 路由
  if (endpointAvailable) {
    try {
      routeDisposer = ws.register({
        kind: 'prefix',
        path: '/live2d',
        handler: (req, res) => handleRoute(req, res, deps),
      })
    } catch (error) {
      shot.endpointAvailable = false
      warnCount(logger, counters, 'web/route-failed', '注册 /live2d 路由失败：' + (error?.message || error))
    }
  }

  // 3. 思考 / 等待 / 空闲 表情联动
  if (typeof ctx.on === 'function') {
    const offStatus = ctx.on('agent/status', (payload) => {
      if (!payload || !payload.status) return
      if (payload.status === 'running') pushCommand('mood', 'thinking')
      else if (payload.status === 'idle') pushCommand('mood', 'idle')
    })
    if (typeof offStatus === 'function') offs.push(offStatus)

    const offTools = ctx.on('tools/result', (exec) => {
      if (exec && exec.name === 'ask_user_question') pushCommand('mood', 'awaiting')
    })
    if (typeof offTools === 'function') offs.push(offTools)
  }

  // 4. 注册退场清理（宿主 dispose 时执行；装配失败时下面 catch 里立即执行同一条路径）
  try {
    ctx.effect(() => releaseAll)
  } catch (error) {
    releaseAll()
    throw error
  }

  const status = configStore.status()
  logger?.info?.('[mira_live2d] 已加载：模型目录 ' + cfg.modelsDir + '，背景目录 ' + cfg.imageDir
    + '，截图目录 ' + cfg.shot.mediaDir + '，工具 ' + TOOL_COUNT + ' 个，截图端点 '
    + (shot.endpointAvailable ? '可用' : '不可用'))
  if (stateLoaded.error) {
    logger?.warn?.('[mira_live2d] state.json 不可用：' + stateLoaded.error.code + '（工具会拒绝读写状态，原文件保留）')
  }

  return okObj({
    configFile: configStore.file,
    stateFile: stateStore.file,
    modelsDir: cfg.modelsDir,
    imageDir: cfg.imageDir,
    mediaDir: cfg.shot.mediaDir,
    endpointAvailable: shot.endpointAvailable,
    tools: TOOL_COUNT,
    configError: status.error,
  })
}

/* ── HTTP：静态文件 / API ─────────────────────────────────── */

function currentCfg(deps) {
  try {
    return deps.configStore.current()
  } catch {
    return deps.configStore.fallback
  }
}

function stateSafe(deps) {
  try {
    return { state: deps.stateStore.get(), error: null }
  } catch (error) {
    return { state: deps.stateStore.fallback, error: toError(error).error }
  }
}

function buildClientConfig(deps) {
  let cfg
  let configError = null
  try {
    cfg = deps.configStore.current()
  } catch (error) {
    configError = toError(error).error
    cfg = deps.configStore.fallback
  }
  const { state, error: stateError } = stateSafe(deps)
  const model = String(state.model || cfg.model || '').trim()

  let models = []
  let modelsError = null
  try {
    models = deps.catalog(cfg).scanModels({ expected: model }).models.map((m) => ({ name: m.name, entry: m.entry }))
  } catch (error) {
    modelsError = toError(error).error
  }

  let capabilities = null
  let modelError = null
  let modelEntry = null
  if (model) {
    try {
      const caps = deps.catalog(cfg).capabilities(model)
      modelEntry = caps.entry
      capabilities = {
        expressions: caps.expressions,
        motions: caps.motions,
        missing: caps.missing,
        coreMissing: caps.coreMissing,
      }
    } catch (error) {
      modelError = toError(error).error
    }
  }

  let backgrounds = []
  let backgroundsError = null
  try {
    backgrounds = deps.catalog(cfg).backgrounds().images.map((b) => ({ name: b.name, url: b.url }))
  } catch (error) {
    backgroundsError = toError(error).error
  }

  const ttsStatus = deps.tts(cfg).status()
  const shotStatus = deps.shotFor(cfg).status()
  let backgroundUrl = ''
  let backgroundError = null
  if (state.background) {
    try {
      const resolved = deps.catalog(cfg).resolveBackground(state.background)
      backgroundUrl = resolved ? resolved.url : ''
    } catch (error) {
      backgroundError = toError(error).error
    }
  }

  return {
    enabled: configError ? false : cfg.enabled !== false,
    fatalError: configError,
    stateError,
    visible: state.visible === true,
    model: model || null,
    modelEntry,
    expressions: state.expressions,
    currentMotion: state.currentMotion,
    mood: state.mood,
    models,
    modelsError,
    capabilities,
    modelError,
    backgrounds,
    backgroundsError,
    background: state.background || '',
    backgroundUrl,
    backgroundError,
    canvas: cfg.canvas,
    position: cfg.position,
    mobileScale: cfg.mobileScale,
    showHint: cfg.showHint,
    pollIntervalMs: cfg.pollIntervalMs,
    tts: {
      enabled: ttsStatus.enabled,
      configured: ttsStatus.configured,
      provider: ttsStatus.provider,
      hint: ttsStatus.configured && ttsStatus.enabled ? '' : ttsStatus.hint,
    },
    shot: {
      endpoint: shotStatus.endpointAvailable,
      timeoutMs: cfg.shot.timeoutMs,
      maxBytes: cfg.shot.maxBytes,
    },
    persona: deps.getPersona(cfg),
    paths: {
      configFile: cfg.configFile,
      modelsDir: cfg.modelsDir,
      imageDir: cfg.imageDir,
      mediaDir: cfg.shot.mediaDir,
    },
  }
}

/* ── 设置页：GET/POST /live2d/api/settings ─────────────────── */

/**
 * 设置页视图 + 表单回填值。**永远不含 TTS key**：只回 `keyConfigured`。
 * 配置坏（schema 不匹配 / 文件损坏）时仍给一份可展出的 fallback，并附 `configError`，
 * 让设置页能把「为什么现在不可用」显示出来，而不是整块 503。
 */
function buildSettingsView(deps) {
  let cfg
  let configError = null
  try {
    cfg = deps.configStore.current()
  } catch (error) {
    configError = toError(error).error
    cfg = deps.configStore.fallback
  }

  const warnings = Array.isArray(deps.configStore.warnings) ? deps.configStore.warnings.slice() : []
  const service = deps.tts(cfg)
  let ttsStatus = null
  try {
    ttsStatus = service.status()
  } catch {
    ttsStatus = null
  }

  return {
    ok: true,
    schemaVersion: CONFIG_SCHEMA,
    configFile: deps.configStore.file,
    credsFile: service.credsFile,
    configError,
    warnings,
    keyConfigured: ttsStatus ? ttsStatus.configured === true : false,
    ttsProvider: ttsStatus ? ttsStatus.provider : (cfg.tts.provider || 'openai'),
    ttsProviders: Object.keys(TTS_PROVIDERS),
    values: {
      model: cfg.model || '',
      position: cfg.position,
      mobileScale: cfg.mobileScale,
      showHint: cfg.showHint,
      canvas: { w: cfg.canvas.w, h: cfg.canvas.h },
      tts: {
        enabled: cfg.tts.enabled === true,
        base: cfg.tts.base || '',
        model: cfg.tts.model || '',
        voice: cfg.tts.voice || '',
      },
    },
  }
}

/** 表单数字：接受数字或数字字符串，其它一律 NaN（空串不是 0）。 */
function settingsNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : NaN
  }
  return NaN
}

function invalidSetting(field, reason, hint) {
  return fail('config/invalid', '配置项 ' + field + ' 非法：' + reason,
    hint || ('修正 ' + field + ' 后重试；不想改的项可以省略或留空'))
}

/** POST 既接受 `{values:{...}}` 也接受扁平对象（都是本插件自己的客户端发来的）。 */
function pickSettingsInput(body) {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    if (body.values && typeof body.values === 'object' && !Array.isArray(body.values)) return body.values
    return body
  }
  return null
}

/**
 * 校验并归一设置补丁。**只收白名单字段**，apiKey 空串 = 不改凭据。
 * 返回 `{ ok:true, patch }` 或 `{ ok:false, error }`（config/invalid，message 指名哪一项）。
 */
function readSettingsPatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {
      ok: false,
      error: fail('config/invalid', '设置请求体必须是 JSON 对象',
        'POST {"values":{...}}；字段清单见 GET /live2d/api/settings'),
    }
  }
  const patch = {}

  if (input.model !== undefined) {
    if (typeof input.model !== 'string') return { ok: false, error: invalidSetting('model', '必须是字符串') }
    const model = input.model.trim()
    if (model.length > 200) return { ok: false, error: invalidSetting('model', '长度超过 200 字符') }
    if (model !== '') patch.model = model // 空 = 不改变
  }

  if (input.position !== undefined) {
    const position = typeof input.position === 'string' ? input.position.trim().toLowerCase() : ''
    if (position !== 'left' && position !== 'right') {
      return {
        ok: false,
        error: invalidSetting('position',
          '只接受 left / right（收到 ' + JSON.stringify(input.position) + '）',
          'position 决定看板娘停靠左侧还是右侧'),
      }
    }
    patch.position = position
  }

  if (input.mobileScale !== undefined) {
    const scale = settingsNumber(input.mobileScale)
    if (!Number.isFinite(scale) || scale < 0 || scale > 100) {
      return {
        ok: false,
        error: invalidSetting('mobileScale',
          '必须是 0–100 的数字（收到 ' + JSON.stringify(input.mobileScale) + '）',
          'mobileScale 是移动端缩放百分比，0 表示不缩放'),
      }
    }
    patch.mobileScale = Math.round(scale)
  }

  if (input.showHint !== undefined) {
    if (typeof input.showHint !== 'boolean') return { ok: false, error: invalidSetting('showHint', '必须是 true 或 false') }
    patch.showHint = input.showHint
  }

  if (input.canvas !== undefined) {
    if (!input.canvas || typeof input.canvas !== 'object' || Array.isArray(input.canvas)) {
      return { ok: false, error: invalidSetting('canvas', '必须是对象 {w,h}') }
    }
    const canvas = {}
    for (const key of ['w', 'h']) {
      if (input.canvas[key] === undefined) continue
      const size = settingsNumber(input.canvas[key])
      if (!Number.isFinite(size) || size < 1 || size > 4096) {
        return {
          ok: false,
          error: invalidSetting('canvas.' + key,
            '必须是 1–4096 的数字（收到 ' + JSON.stringify(input.canvas[key]) + '）',
            'canvas.' + key + ' 是看板娘画布的像素尺寸'),
        }
      }
      canvas[key] = Math.round(size)
    }
    if (Object.keys(canvas).length) patch.canvas = canvas
  }

  if (input.tts !== undefined) {
    if (!input.tts || typeof input.tts !== 'object' || Array.isArray(input.tts)) {
      return { ok: false, error: invalidSetting('tts', '必须是对象') }
    }
    const tts = {}
    if (input.tts.enabled !== undefined) {
      if (typeof input.tts.enabled !== 'boolean') return { ok: false, error: invalidSetting('tts.enabled', '必须是 true 或 false') }
      tts.enabled = input.tts.enabled
    }
    for (const key of ['base', 'model', 'voice']) {
      if (input.tts[key] === undefined) continue
      if (typeof input.tts[key] !== 'string') return { ok: false, error: invalidSetting('tts.' + key, '必须是字符串') }
      const text = input.tts[key].trim()
      if (text.length > 500) return { ok: false, error: invalidSetting('tts.' + key, '长度超过 500 字符') }
      tts[key] = text
    }
    if (Object.keys(tts).length) patch.tts = tts
    if (input.tts.apiKey !== undefined) {
      if (typeof input.tts.apiKey !== 'string') return { ok: false, error: invalidSetting('tts.apiKey', '必须是字符串') }
      const apiKey = input.tts.apiKey.trim()
      if (apiKey.length > 4096) return { ok: false, error: invalidSetting('tts.apiKey', '长度超过 4096 字符') }
      if (apiKey !== '') patch.apiKey = apiKey // 空 = 不改凭据
    }
  }

  if (!Object.keys(patch).length) {
    return {
      ok: false,
      error: fail('config/invalid', '没有任何可写字段',
        '至少提交一项：model / position / mobileScale / showHint / canvas / tts（apiKey 留空 = 不改）'),
    }
  }
  return { ok: true, patch }
}

/**
 * 写设置：config.json 原子写（沿用现有键，不把 normalize 后的绝对目录烤进文件），
 * apiKey 非空时另写 creds/tts.json（600）。返回 `{ status, body }`。
 */
function writeSettings(deps, body, cfg) {
  const parsed = readSettingsPatch(pickSettingsInput(body))
  if (!parsed.ok) return { status: 400, body: parsed.error }
  const patch = parsed.patch

  const file = deps.configStore.file
  const strict = readJsonStrict(file)
  if (!strict.ok && strict.reason !== 'missing') {
    return {
      status: 400,
      body: fail('config/invalid', '配置文件无法读取或不是 JSON 对象：' + file,
        '修好 ' + file + ' 后重试；不会在坏文件上覆盖写入'),
    }
  }
  const base = strict.ok ? structuredClone(strict.value) : { schemaVersion: CONFIG_SCHEMA }

  const changed = []
  if (patch.model !== undefined) {
    base.model = patch.model
    changed.push('model')
  }
  if (patch.position !== undefined) {
    base.position = patch.position
    changed.push('position')
  }
  if (patch.mobileScale !== undefined) {
    base.mobileScale = patch.mobileScale
    changed.push('mobileScale')
  }
  if (patch.showHint !== undefined) {
    base.showHint = patch.showHint
    changed.push('showHint')
  }
  if (patch.canvas) {
    const canvas = base.canvas && typeof base.canvas === 'object' && !Array.isArray(base.canvas) ? base.canvas : {}
    base.canvas = { ...canvas, ...patch.canvas }
    for (const key of Object.keys(patch.canvas)) changed.push('canvas.' + key)
  }
  if (patch.tts) {
    const tts = base.tts && typeof base.tts === 'object' && !Array.isArray(base.tts) ? base.tts : {}
    base.tts = { ...tts, ...patch.tts }
    for (const key of Object.keys(patch.tts)) changed.push('tts.' + key)
  }
  base.schemaVersion = CONFIG_SCHEMA

  if (!writeJsonAtomic(file, base)) {
    deps.logger?.warn?.('[mira_live2d] 设置页写盘失败：' + file)
    return {
      status: 500,
      body: fail('config/write-failed', '配置写入失败：' + file,
        '检查 $DSH_HOME/mira_config/mira_live2d 是否可写后重试'),
    }
  }

  if (patch.apiKey) {
    const creds = credsFile(deps.baseDir)
    const written = writeJsonSecure(creds, {
      schemaVersion: CREDS_SCHEMA,
      provider: cfg.tts.provider,
      apiKey: patch.apiKey,
      updatedAt: nowIso(),
    })
    if (!written) {
      deps.logger?.warn?.('[mira_live2d] TTS 凭据写盘失败：' + creds)
      return {
        status: 500,
        body: {
          ...fail('config/write-failed', 'TTS 凭据写入失败：' + creds,
            'config.json 已写入；检查 creds 目录权限后只重填 key 再保存'),
          partial: true,
          changed,
        },
      }
    }
    changed.push('tts.apiKey')
  }

  // 写盘后显式重读：mtime+size 的漂移检测在粗粒度文件系统上可能漏一次。
  const reloaded = deps.configStore.load()
  const view = buildSettingsView(deps)
  deps.logger?.info?.('[mira_live2d] 设置页写入：' + (changed.join('、') || '无'))
  return {
    status: 200,
    body: okObj({
      changed,
      keyConfigured: view.keyConfigured,
      values: view.values,
      configFile: view.configFile,
      warnings: view.warnings,
      configError: view.configError || (reloaded.error ?? null),
    }),
  }
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolveBody) => {
    const chunks = []
    let size = 0
    let tooLarge = false
    let finished = false
    const done = (value) => {
      if (finished) return
      finished = true
      resolveBody(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        tooLarge = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) {
        done({
          ok: false,
          status: 413,
          error: {
            code: 'payload/too-large',
            message: '请求体超过上限 ' + maxBytes + ' 字节',
            hint: '截图请调小画布或在 config.json 调大 shot.maxBytes；普通 API 请求体应小于 256 KiB',
          },
        })
        return
      }
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') {
        done({ ok: true, value: {} })
        return
      }
      try {
        done({ ok: true, value: JSON.parse(raw) })
      } catch {
        done({
          ok: false,
          status: 400,
          error: { code: 'payload/invalid', message: '请求体不是合法 JSON', hint: '用 Content-Type: application/json 并检查拼写' },
        })
      }
    })
    req.on('error', (error) => {
      done({
        ok: false,
        status: 400,
        error: { code: 'payload/read-failed', message: '读取请求体失败：' + (error?.message || error), hint: '重试' },
      })
    })
  })
}

async function serveStaticFrom(root, relPath, res) {
  const rootAbs = resolve(root)
  const full = resolve(rootAbs, ...normalize(relPath).split(/[\\/]+/).filter(Boolean))
  if (full !== rootAbs && !full.startsWith(rootAbs + sep)) {
    send(res, 403, 'forbidden')
    return
  }
  try {
    const buf = await readFile(full)
    const type = MIME[extname(full).toLowerCase()] || 'application/octet-stream'
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' })
    res.end(buf)
  } catch {
    send(res, 404, 'not found')
  }
}

async function handleRoute(req, res, deps) {
  const url = new URL(req.url, 'http://x')
  let pathname
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    pathname = url.pathname
  }

  if (pathname.startsWith('/live2d/api/')) {
    return handleApi(pathname, req, res, deps)
  }
  const cfg = currentCfg(deps)
  if (pathname.startsWith('/live2d/assets/')) {
    return serveStaticFrom(ASSETS_DIR, pathname.slice('/live2d/assets/'.length), res)
  }
  if (pathname.startsWith('/live2d/models/')) {
    return serveStaticFrom(cfg.modelsDir, pathname.slice('/live2d/models/'.length), res)
  }
  if (pathname.startsWith('/live2d/backgrounds/')) {
    return serveStaticFrom(cfg.imageDir, pathname.slice('/live2d/backgrounds/'.length), res)
  }
  if (pathname.startsWith('/live2d/media/')) {
    return serveStaticFrom(cfg.shot.mediaDir, pathname.slice('/live2d/media/'.length), res)
  }
  send(res, 404, 'not found')
}

async function handleApi(pathname, req, res, deps) {
  const sub = pathname.slice('/live2d/api/'.length)
  const method = (req.method || 'GET').toUpperCase()
  // 所有 /live2d/api/* 用同一口径：只接受同源请求（含 GET，保持完全一致）。
  if (!isSameOriginRequest(req)) {
    return sendJson(res, 403, fail('http/forbidden',
      '拒绝跨站请求：/live2d/api/' + sub + ' 只接受与页面同源的请求',
      '这些接口能改状态、落盘截图、消耗 TTS 额度；前端页面必须和插件同源，其它站点不能调用'))
  }
  let cfg
  let configFailure = null
  try {
    cfg = deps.configStore.current()
  } catch (error) {
    configFailure = toError(error)
    cfg = deps.configStore.fallback
  }
  // 配置 schemaVersion 不匹配 / 文件坏了：除 /config（负责把 fatalError 报给前端）与
  // /settings（设置页要能显示「为什么不可用」）外，其余 API 一律拒绝使用，
  // 避免「工具拒绝、路由却照跑」的两套行为。settings 的写入口自己也会拒绝。
  if (configFailure && sub !== 'config' && sub !== 'settings') {
    return sendJson(res, 503, configFailure)
  }

  if (sub === 'config' && method === 'GET') {
    return sendJson(res, 200, buildClientConfig(deps))
  }

  // 设置页（客户端 lib/client.js）：GET 只回可编辑项 + keyConfigured，永不回 key。
  if (sub === 'settings' && method === 'GET') {
    return sendJson(res, 200, buildSettingsView(deps))
  }

  if (sub === 'settings' && method === 'POST') {
    // 写盘要求配置本身可用：坏文件/schemaVersion 不匹配时先修文件，不在坏文件上覆盖。
    if (configFailure) return sendJson(res, 503, configFailure)
    const parsed = await readJsonBody(req, 64 * 1024)
    if (!parsed.ok) return sendJson(res, parsed.status, parsed)
    const result = writeSettings(deps, parsed.value, cfg)
    return sendJson(res, result.status, result.body)
  }

  if (sub === 'commands' && method === 'GET') {
    const url = new URL(req.url, 'http://x')
    const since = clientSince(url.searchParams.get('since'))
    // 时钟回拨/客户端游标领先时同步 ID 起点，保证新指令 ID 永远大于客户端游标。
    if (since > 0 && since >= deps.__nextCommandId()) {
      deps.__setNextCommandId(since + 1)
    }
    const list = deps.commandQueue.filter((c) => c.id > since)
    return sendJson(res, 200, { commands: list })
  }

  // 前端菜单用：不切换模型也能拿到新模型的表情/动作清单（隐藏状态下也能列菜单）。
  if (sub === 'capabilities' && method === 'GET') {
    const url = new URL(req.url, 'http://x')
    const { state } = stateSafe(deps)
    const model = String(url.searchParams.get('model') || state.model || cfg.model || '').trim()
    if (!model) {
      return sendJson(res, 400, fail('config/missing', '没有指定模型',
        '传 ?model=<模型名>，或在 ' + cfg.configFile + ' 里填 model'))
    }
    try {
      const caps = deps.catalog(cfg).capabilities(model)
      return sendJson(res, 200, okObj({
        model: caps.model,
        entry: caps.entry,
        expressions: caps.expressions,
        motions: caps.motions,
        missing: caps.missing,
        coreMissing: caps.coreMissing,
      }))
    } catch (error) {
      return sendJson(res, 400, toError(error))
    }
  }

  if (sub === 'command-result' && method === 'POST') {
    const parsed = await readJsonBody(req, 64 * 1024)
    if (!parsed.ok) return sendJson(res, parsed.status, parsed)
    // 前端执行结果只用于排障，不阻塞指令队列。
    deps.logger?.debug?.('[mira_live2d] 指令结果：' + JSON.stringify(parsed.value).slice(0, 200))
    return sendJson(res, 200, { ok: true })
  }

  if (sub === 'state' && method === 'POST') {
    const parsed = await readJsonBody(req, 256 * 1024)
    if (!parsed.ok) return sendJson(res, parsed.status, parsed)
    const payload = parsed.value && typeof parsed.value === 'object' ? parsed.value : {}
    deps.stateStore.setClient(payload)
    let warning = ''
    try {
      const patch = { ...payload }
      if (typeof patch.background === 'string' && patch.background !== '') {
        try {
          const resolved = deps.catalog(cfg).resolveBackground(patch.background)
          patch.background = resolved ? resolved.name : ''
        } catch {
          delete patch.background
          warning = '前端上报的背景图不在 imageDir 里，已忽略'
        }
      }
      if (typeof patch.model === 'string' && patch.model !== '') {
        try {
          deps.catalog(cfg).find(patch.model)
        } catch {
          delete patch.model
          warning = (warning ? warning + '；' : '') + '前端上报的模型不在 modelsDir 里，已忽略'
        }
      }
      deps.stateStore.applyClient(patch)
    } catch (error) {
      const failure = toError(error)
      return sendJson(res, 200, { ok: true, persisted: false, warning, stateError: failure.error })
    }
    return sendJson(res, 200, { ok: true, persisted: true, warning })
  }

  if (sub.startsWith('audio/') && method === 'GET') {
    const id = sub.slice('audio/'.length)
    const audio = deps.audioStore.get(id)
    if (!audio) return sendJson(res, 404, fail('audio/not-found', '音频不存在或已淘汰：' + id, '重新调用 mira_speak 生成'))
    return sendJson(res, 200, audio)
  }

  if (sub === 'tts' && method === 'POST') {
    const parsed = await readJsonBody(req, 64 * 1024)
    if (!parsed.ok) return sendJson(res, parsed.status, parsed)
    const text = String(parsed.value?.text ?? '')
    try {
      const audio = await deps.tts(cfg).synthesize(text)
      deps.logger?.info?.('[mira_live2d] HTTP TTS：provider=' + audio.provider + '，' + audio.bytes + ' 字节')
      return sendJson(res, 200, okObj(audio))
    } catch (error) {
      const failure = toError(error)
      deps.logger?.warn?.('[mira_live2d] TTS 失败：' + failure.error.code + '：' + failure.error.message)
      return sendJson(res, 400, failure)
    }
  }

  if (sub === 'shot' && method === 'POST') {
    const readLimit = Math.ceil(Number(cfg.shot.maxBytes || 16 * 1024 * 1024) * 1.5) + 8192
    const parsed = await readJsonBody(req, readLimit)
    if (!parsed.ok) return sendJson(res, parsed.status, parsed)
    const result = deps.shotFor(cfg).handleUpload(parsed.value)
    const status = result.ok ? 200 : (result.error?.code === 'shot/too-large' ? 413 : 400)
    return sendJson(res, status, result)
  }

  if (sub === 'background' && method === 'POST') {
    const parsed = await readJsonBody(req, 64 * 1024)
    if (!parsed.ok) return sendJson(res, parsed.status, parsed)
    try {
      const image = String(parsed.value?.image ?? parsed.value?.background ?? '')
      const resolved = deps.catalog(cfg).resolveBackground(image)
      deps.stateStore.setBackground(resolved ? resolved.name : '')
      return sendJson(res, 200, okObj({
        background: resolved ? resolved.name : null,
        url: resolved ? resolved.url : null,
        path: resolved ? resolved.path : null,
      }))
    } catch (error) {
      return sendJson(res, 400, toError(error))
    }
  }

  return sendJson(res, 404, fail('http/not-found', '没有这个 API：/live2d/api/' + sub, '可用：config / settings / commands / command-result / state / audio/<id> / tts / shot / background'))
}

/* ── index.html 注入 ──────────────────────────────────────── */

const INJECTED_ASSETS = [
  '<link rel="stylesheet" href="/live2d/assets/css/widget.css">',
  '<script defer src="/live2d/assets/lib/live2dcubismcore.min.js"></script>',
  '<script defer src="/live2d/assets/lib/pixi.min.js"></script>',
  '<script defer src="/live2d/assets/lib/cubism4.min.js"></script>',
  '<script defer src="/live2d/assets/js/widget.js"></script>',
].join('\n')

function tapIndex(html) {
  if (html.includes('/live2d/assets/js/widget.js')) return html
  if (html.includes('</head>')) return html.replace('</head>', INJECTED_ASSETS + '\n</head>')
  if (html.includes('<head>')) return html.replace('<head>', '<head>\n' + INJECTED_ASSETS)
  return INJECTED_ASSETS + '\n' + html
}

/* ── 自检导出（不是 DSH 接口） ────────────────────────────── */

export const __testing = {
  DEFAULTS,
  CONFIG_SCHEMA,
  STATE_SCHEMA,
  ConfigStore,
  StateStore,
  ModelCatalog,
  TtsService,
  ShotService,
  TTS_PROVIDERS,
  defaults: () => structuredClone(DEFAULTS),
}
