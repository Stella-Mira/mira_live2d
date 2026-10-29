/**
 * mira_live2d 自检：node test/smoke.mjs
 *
 * 全过 → 退出码 0，末行 `==== ALL PASS（N 项断言）====`；失败逐行 `[FAIL]`，退出码 1。
 *
 * 覆盖 重构插件/PLAN.md §1.7 的 G1–G7（前端 widget 不做浏览器行为测试，只做
 * 静态存在性检查；Node 侧全部是真断言）：
 *   G2 默认隐藏：mira_get_state → visible:false；/config → visible:false；
 *      界面有开关按钮（widget.js 里的 #mira-l2d-bar）
 *   G3 模型目录为空 → config/missing，message 指出缺哪个文件、hint 指出 modelsDir/config.json
 *   G4 表情/动作文件缺失 → 列出文件名、绝对路径与修复 hint；set_expression/play_motion 拒绝
 *   G5 TTS 未配置 → config/missing + 去哪填；tts_status 只报配没配/供应商；假 fetch 不联网
 *   G6 背景目录缺图 → 报出路径；设置成功后 /config 与静态路由生效
 *   G7 截图：隐藏时明确拒绝；显示后走 HTTP 上传真落盘并返回路径；无端点 → platform/unsupported
 * 另覆盖：单实例、config/state schemaVersion、state 默认隐藏与持久化、
 *         背景/模型/状态 API、TTS 假 fetch（openai/aliyun）、密钥不外泄、工具 JSON 形状。
 *
 * 只用 Node 内置模块；DSH_HOME 指到临时目录，不碰真实 ~/.dsh。
 */

import {
  chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'

let passed = 0
const failures = []
let current = '(未命名)'

function check(ok, message) {
  if (ok) {
    passed++
    return true
  }
  failures.push('[' + current + '] ' + message)
  return false
}

function eq(actual, expected, message) {
  return check(JSON.stringify(actual) === JSON.stringify(expected),
    message + '（期望 ' + JSON.stringify(expected) + '，实得 ' + JSON.stringify(actual) + '）')
}

async function test(id, name, fn) {
  current = id + ' ' + name
  try {
    await fn()
  } catch (error) {
    failures.push('[' + current + '] 抛异常：' + (error && error.stack ? error.stack.split('\n').slice(0, 4).join(' | ') : String(error)))
  }
}

/* ── 隔离环境 ───────────────────────────────────────────── */

const TMP = join(tmpdir(), 'mira-live2d-smoke-' + process.pid + '-' + Date.now())
mkdirSync(TMP, { recursive: true })
process.env.DSH_HOME = TMP

const { apply, __testing } = await import('../lib/index.js')
const {
  ConfigStore, StateStore, ModelCatalog, TtsService, ShotService,
} = __testing

const logLines = []
const logger = {
  info: (message) => logLines.push('I ' + message),
  warn: (message) => logLines.push('W ' + message),
  error: (message) => logLines.push('E ' + message),
  debug: () => {},
}

let caseSeq = 0
/** 每个用例独立的 DSH_HOME；apply 用 kit.miraConfigDir() 读当前 env。 */
function freshHome(label = 'case') {
  caseSeq += 1
  const home = join(TMP, label + '-' + caseSeq)
  mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home
  const base = join(home, 'mira_config', 'mira_live2d')
  mkdirSync(base, { recursive: true })
  return { home, base }
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3r9wAAAABJRU5ErkJggg=='
const PNG_BYTES = Buffer.from(PNG_BASE64, 'base64')

/** 写一个可切换的测试模型：一个模型完整、一个只缺表情/动作文件、一个缺核心 moc。 */
function writeFixture(base, { withBackground = false } = {}) {
  const modelDir = join(base, 'model')
  const model = join(modelDir, 'TestModel')
  mkdirSync(join(model, 'Textures'), { recursive: true })
  writeJson(join(model, 'TestModel.model3.json'), {
    Version: 3,
    FileReferences: {
      Moc: 'TestModel.moc3',
      Textures: ['Textures/tex.png'],
      Expressions: [
        { Name: '开心', File: '开心.exp3.json' },
        { Name: '缺失', File: '缺失.exp3.json' },
      ],
      Motions: {
        Idle: [{ File: 'Idle.motion3.json' }],
        TapBody: [{ File: 'TapBody.motion3.json' }],
      },
    },
  })
  writeFileSync(join(model, 'TestModel.moc3'), Buffer.from('moc3'))
  writeFileSync(join(model, 'Textures', 'tex.png'), PNG_BYTES)
  writeJson(join(model, '开心.exp3.json'), {})
  writeJson(join(model, 'Idle.motion3.json'), {})

  const other = join(modelDir, 'OtherModel')
  mkdirSync(join(other, 'Textures'), { recursive: true })
  writeJson(join(other, 'OtherModel.model3.json'), {
    Version: 3,
    FileReferences: {
      Moc: 'OtherModel.moc3',
      Textures: ['Textures/tex.png'],
      Expressions: [],
      Motions: {},
    },
  })
  writeFileSync(join(other, 'OtherModel.moc3'), Buffer.from('moc3'))
  writeFileSync(join(other, 'Textures', 'tex.png'), PNG_BYTES)

  const broken = join(modelDir, 'BrokenModel')
  writeJson(join(broken, 'BrokenModel.model3.json'), {
    Version: 3,
    FileReferences: { Moc: 'BrokenModel.moc3', Textures: ['tex.png'] },
  })
  writeFileSync(join(broken, 'tex.png'), PNG_BYTES)

  if (withBackground) writeBackground(base, 'bg1.png')
}

function writeBackground(base, name) {
  const dir = join(base, 'image')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), PNG_BYTES)
}

function writeCreds(base, value, mode = 0o600) {
  const file = join(base, 'creds', 'tts.json')
  writeJson(file, value)
  chmodSync(file, mode)
  return file
}

/* ── 假 ctx / 假 webServer ───────────────────────────────── */

function makeWebServer() {
  const routes = new Map()
  const taps = []
  return {
    routes,
    taps,
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
    tapIndex(fn) {
      taps.push(fn)
      return () => {
        const index = taps.indexOf(fn)
        if (index >= 0) taps.splice(index, 1)
      }
    },
  }
}

function makeCtx({ webServer } = {}) {
  const ws = webServer === undefined ? makeWebServer() : webServer
  const tools = new Map()
  const disposers = []
  const ctx = {
    logger,
    tools: {
      register(def) {
        tools.set(def.name, def)
        return () => tools.delete(def.name)
      },
    },
    webServer: ws,
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    on() {
      return () => {}
    },
  }
  return {
    ctx,
    tools,
    ws,
    dispose() {
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          dispose()
        } catch {
          /* 卸载不抛 */
        }
      }
    },
  }
}

function applyCase(base, config = {}, { webServer } = {}) {
  const holder = makeCtx({ webServer })
  const result = apply(holder.ctx, config)
  holder.result = result
  holder.base = base
  return holder
}

async function callTool(tools, name, args = {}) {
  const def = tools.get(name)
  if (!def) throw new Error('没有注册工具：' + name)
  const output = await def.execute(args, {})
  if (typeof output !== 'string') throw new Error(name + ' 返回值不是 JSON 文本：' + typeof output)
  return JSON.parse(output)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 直接调 webServer 注册的 /live2d 前缀 handler，走真实 HTTP 解析/响应路径。 */
function callHttp(ws, path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const route = ws && ws.routes ? ws.routes.get('/live2d') : null
    if (!route) return reject(new Error('没有注册 /live2d 路由'))
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    req.method = method
    req.url = path
    req.headers = { 'content-type': 'application/json', ...headers }
    const chunks = []
    let status = 0
    let responseHeaders = {}
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      const buf = Buffer.concat(chunks)
      resolve({ status, headers: responseHeaders, text: buf.toString('utf8'), bytes: buf })
    }
    const res = {
      writeHead(code, value) {
        status = code
        responseHeaders = value || {}
      },
      end(value) {
        if (value) chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(String(value)))
        finish()
      },
    }
    try {
      const ret = route.handler(req, res)
      if (ret && typeof ret.catch === 'function') ret.catch(reject)
    } catch (error) {
      reject(error)
    }
  })
}

function jsonOf(response) {
  return JSON.parse(response.text)
}

/* ── G2 / G8：默认隐藏、默认目录、开关按钮存在 ───────────── */

await test('G2', '默认隐藏：get_state / /config 都是 visible:false，且 widget 有开关按钮', async () => {
  const { base } = freshHome('default')
  const holder = applyCase(base)
  eq(holder.result.ok, true, 'apply 应成功')
  eq(holder.tools.size, 20, '应注册 20 个工具')

  const state = await callTool(holder.tools, 'mira_get_state')
  eq(state.ok, true, 'get_state 应 ok')
  eq(state.visible, false, '默认必须隐藏')
  eq(state.model, null, '没有指定模型时 model 应为 null')
  eq(state.modelsError && state.modelsError.code, 'config/missing', '模型目录为空应带 modelsError（不静默）')

  const configResp = await callHttp(holder.ws, '/live2d/api/config')
  eq(configResp.status, 200, '/config 应 200')
  const clientConfig = jsonOf(configResp)
  eq(clientConfig.visible, false, '/config 的 visible 也必须是 false')
  eq(clientConfig.enabled, true, '插件默认启用')
  eq(clientConfig.shot.endpoint, true, '有 webServer.register 时截图端点应可用')

  const config = await callTool(holder.tools, 'mira_get_config')
  eq(config.schemaVersion, 2, '配置 schemaVersion 应为 2')
  eq(config.modelsDir, join(base, 'model'), 'modelsDir 默认应是 $DSH_HOME/mira_config/mira_live2d/model')
  eq(config.imageDir, join(base, 'image'), 'imageDir 默认应是 $DSH_HOME/mira_config/mira_live2d/image')
  eq(config.shot.mediaDir, join(base, 'media'), '截图默认应落 $DSH_HOME/mira_config/mira_live2d/media')

  const widget = readFileSync(new URL('../assets/js/widget.js', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../assets/css/widget.css', import.meta.url), 'utf8')
  // 说话/菜单按钮取消（TTS 与菜单仍可由工具/接口触发）。
  check(!widget.includes('mira-l2d-tts-btn'), '不应再有「说话」按钮')
  check(!widget.includes('mira-l2d-menu-btn'), '不应再有「菜单」按钮')
  // 2026-10-27 二次调整：眼睛和模型是同一个可拖动物件（root），收起=小眼睛，展开=模型
  check(widget.includes("handle.id = 'mira-l2d-handle'"), 'widget 必须有眼睛手柄 #mira-l2d-handle')
  check(widget.includes('root.appendChild(handle)'), '手柄必须挂在 root 里（同一物件、位置共享）')
  check(widget.includes("root.classList.toggle('mira-collapsed'"), '收起态必须是 root 的 mira-collapsed')
  check(widget.includes('setVisible(!state.visible)'), '未拖动的一次点击必须切换展开/收起')
  check(css.includes('#mira-l2d-root.mira-collapsed'), 'CSS 必须有收起态样式')
  check(css.includes('#mira-l2d-root.mira-collapsed #mira-l2d-canvas'), '收起时必须隐藏画布')
  // 防回归：所有通过 $('id') 取的节点都必须在源码里被创建（模板 id="x" 或 createElement 后 .id='x'）
  // —— 之前替换代码块时误删了 #mira-l2d-bar 的创建，$('mira-l2d-bar-msg') 拿到 null，
  //    任何 notify() 都会抛错、右键菜单直接中断。
  const idsUsed = [...widget.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1])
  const idsCreated = new Set([
    ...[...widget.matchAll(/id="([^"]+)"/g)].map((m) => m[1]),
    ...[...widget.matchAll(/\.id\s*=\s*'([^']+)'/g)].map((m) => m[1]),
  ])
  const missingIds = [...new Set(idsUsed)].filter((id) => !idsCreated.has(id))
  check(missingIds.length === 0, '每个 $() 取的 id 都必须有创建点，缺：' + missingIds.join(', '))
  // 右键只负责菜单，不能触发显隐切换（否则右键一松手模型就收成眼睛，菜单挂在眼睛上）
  // 边界夹取必须按"当前盒子"算：收起的眼睛是 40x40，否则往右走不到边
  check(widget.includes('const COLLAPSED_SIZE = 40'), '必须有收起尺寸常量')
  check(widget.includes('function boxSize()'), '必须有 boxSize()（按显隐取实际尺寸）')
  check(widget.includes('const f = boxSize()'), 'clampPos 必须用 boxSize() 而不是模型尺寸')
  check(widget.includes("const primary = e.pointerType === 'mouse' ? e.button === 0 : true"), '点击切换必须只认主键（排除右键）')
  check(widget.includes("if (primary && !wasLongPress && !longPressFired && !dragMoved)"), '切换条件必须带 primary 判定')
  check(widget.includes("canvas.addEventListener('contextmenu'"), '右键菜单只绑在 canvas（模型）上')
  check(!widget.includes("root.addEventListener('contextmenu'"), '眼睛（root）不应有右键菜单')
  check(widget.includes("if (config.visible !== true) root.className = 'mira-collapsed'"), 'widget 初始必须是收起态（小眼睛）')
  check(!widget.includes('.mira-l2d-toolbar-btn'), '不应再有外挂顶栏按钮的样式引用')
  check(widget.includes('preserveDrawingBuffer: true'), 'PIXI 必须开 preserveDrawingBuffer，否则 toDataURL 可能空白')
  check(widget.includes("canvas.toDataURL('image/png')"), 'widget 必须用 canvas.toDataURL 截图')
  check(widget.includes("API + '/shot'"), 'widget 必须把截图 POST 给插件')
  check(widget.includes("bgLayer.id = 'mira-l2d-bg'"), 'widget 必须有背景层')
  check(css.includes('#mira-l2d-bar'), 'CSS 必须有开关按钮样式')
  check(css.includes('#mira-l2d-bg'), 'CSS 必须有背景层样式')

  eq(holder.ws.taps.length, 1, '应注册一次 index.html 注入')
  const injected = holder.ws.taps[0]('<html><head></head><body></body></html>')
  check(injected.includes('/live2d/assets/js/widget.js'), 'index.html 应注入 widget.js')

  holder.dispose()
  const stateFile = join(base, 'state.json')
  check(existsSync(stateFile), '正常退场应写一次 state.json')
  eq(JSON.parse(readFileSync(stateFile, 'utf8')).visible, false, '退场写盘的 visible 仍是 false')
})

/* ── 单实例 ─────────────────────────────────────────────── */

await test('G-instance', '单实例：第二个 apply 被拒且不注册工具；退场后可再加载', async () => {
  const { base } = freshHome('instance')
  const first = applyCase(base)
  const second = makeCtx()
  const secondResult = apply(second.ctx, {})
  eq(secondResult.ok, false, '第二个实例应失败')
  eq(secondResult.error && secondResult.error.code, 'plugin/instance', '错误码应是 plugin/instance')
  eq(second.tools.size, 0, '被拒绝的实例不应注册工具')
  check(logLines.some((line) => line.includes('已经有一个实例在跑')), '应写一条 warn 日志')
  second.dispose()
  first.dispose()

  const third = applyCase(base)
  eq(third.result.ok, true, '第一个实例退场后应能重新加载')
  third.dispose()
})

/* ── G3：模型目录为空 ───────────────────────────────────── */

await test('G3', '模型目录为空 → config/missing，message 指文件、hint 指 modelsDir/config.json', async () => {
  const { base } = freshHome('empty-model')
  const holder = applyCase(base)
  const result = await callTool(holder.tools, 'mira_list_models')
  eq(result.ok, false, '模型目录为空应 ok:false')
  eq(result.error.code, 'config/missing', '错误码应是 config/missing')
  check(result.error.message.includes('*.model3.json'), 'message 要指出缺哪个文件：' + result.error.message)
  check(result.error.message.includes(join(base, 'model')), 'message 要指出模型目录：' + result.error.message)
  check(result.error.hint.includes('modelsDir'), 'hint 要指出配置项 modelsDir：' + result.error.hint)
  check(result.error.hint.includes(join(base, 'config.json')), 'hint 要指出配置文件：' + result.error.hint)

  const assets = await callTool(holder.tools, 'mira_list_assets')
  eq(assets.ok, false, 'list_assets 在模型目录为空时也应 ok:false')
  eq(assets.error.code, 'config/missing', 'list_assets 错误码应是 config/missing')
  holder.dispose()

  // 配置了 model 时，message 要具体到 <model>.model3.json
  const second = freshHome('empty-model-named')
  writeJson(join(second.base, 'config.json'), { schemaVersion: 2, enabled: true, model: 'StellaMira' })
  const holder2 = applyCase(second.base)
  const named = await callTool(holder2.tools, 'mira_list_models')
  eq(named.ok, false, '指定 model 但没有目录时也应失败')
  check(named.error.message.includes('StellaMira.model3.json'), 'message 应具体到 StellaMira.model3.json：' + named.error.message)
  holder2.dispose()
})

/* ── G4：资源缺失诊断 ───────────────────────────────────── */

await test('G4', '表情/动作文件缺失 → 报出文件与路径；表情/动作工具拒绝；核心文件缺失拒绝切换', async () => {
  const { base } = freshHome('missing-assets')
  writeFixture(base)
  writeJson(join(base, 'config.json'), { schemaVersion: 2, enabled: true, model: 'TestModel' })
  const holder = applyCase(base)

  const assets = await callTool(holder.tools, 'mira_list_assets')
  eq(assets.ok, true, '有模型时 list_assets 应 ok')
  eq(assets.models.length, 3, '应扫描到 3 个模型')
  const testModel = assets.models.find((m) => m.name === 'TestModel')
  check(!!testModel, '应包含 TestModel')
  const missingFiles = testModel.missing.map((item) => item.file)
  check(missingFiles.includes('缺失.exp3.json'), '必须报出缺失的表情文件：' + JSON.stringify(missingFiles))
  check(missingFiles.includes('TapBody.motion3.json'), '必须报出缺失的动作文件：' + JSON.stringify(missingFiles))
  const exprMissing = testModel.missing.find((item) => item.file === '缺失.exp3.json')
  check(String(exprMissing.path).endsWith(join('TestModel', '缺失.exp3.json')), '缺失表情要带绝对路径：' + exprMissing.path)
  check(String(exprMissing.hint).includes('放到'), '缺失表情要带修复 hint：' + exprMissing.hint)

  const caps = await callTool(holder.tools, 'mira_get_model_capabilities', { model: 'TestModel' })
  eq(caps.ok, true, 'get_model_capabilities 应 ok')
  eq(caps.expressions, ['开心', '缺失'], '表情清单应来自 model3.json')
  check(caps.missing.some((item) => item.file === '缺失.exp3.json'), 'capabilities 要列出缺失表情')

  const badExpr = await callTool(holder.tools, 'mira_set_expression', { expression: '缺失' })
  eq(badExpr.ok, false, '缺失表情不应被静默接受')
  eq(badExpr.error.code, 'resource/missing', '错误码应是 resource/missing')
  check(badExpr.error.message.includes('缺失.exp3.json'), 'message 要指出缺哪个文件：' + badExpr.error.message)
  check(badExpr.error.hint.includes(join(base, 'model', 'TestModel')), 'hint 要指出模型目录：' + badExpr.error.hint)

  const badMotion = await callTool(holder.tools, 'mira_play_motion', { motion: 'TapBody' })
  eq(badMotion.ok, false, '缺失动作不应被静默接受')
  eq(badMotion.error.code, 'resource/missing', '动作缺失也应是 resource/missing')
  check(badMotion.error.message.includes('TapBody.motion3.json'), '动作 message 要指出文件')

  const goodExpr = await callTool(holder.tools, 'mira_set_expression', { expression: '开心' })
  eq(goodExpr.ok, true, '存在的表情应能设置')
  eq(goodExpr.expressions, ['开心'], '互斥表情列表应更新')

  const switchOk = await callTool(holder.tools, 'mira_switch_model', { model: 'TestModel' })
  eq(switchOk.ok, true, '核心文件齐的模型应能切换')
  check(Array.isArray(switchOk.missing) && switchOk.missing.length >= 2, '切换成功也要带回缺失清单')
  check(String(switchOk.warning).includes('资源文件缺失'), '有缺失时应给出 warning')

  const unknown = await callTool(holder.tools, 'mira_switch_model', { model: 'Nope' })
  eq(unknown.ok, false, '不存在的模型应失败')
  eq(unknown.error.code, 'model/not-found', '错误码应是 model/not-found')
  check(unknown.error.message.includes('TestModel'), 'message 要列出可用模型：' + unknown.error.message)

  const broken = await callTool(holder.tools, 'mira_switch_model', { model: 'BrokenModel' })
  eq(broken.ok, false, '缺 moc 的模型应拒绝切换')
  eq(broken.error.code, 'resource/missing', '核心文件缺失应是 resource/missing')
  check(broken.error.message.includes('BrokenModel.moc3'), 'message 要指出缺哪个核心文件：' + broken.error.message)

  holder.dispose()
})

/* ── G6：背景图 ─────────────────────────────────────────── */

await test('G6', '背景目录缺图 → 报路径；设置成功后 /config 与静态路由生效', async () => {
  const { base } = freshHome('background')
  writeFixture(base)
  writeJson(join(base, 'config.json'), { schemaVersion: 2, enabled: true, model: 'TestModel' })
  const holder = applyCase(base)

  const noImage = await callTool(holder.tools, 'mira_set_background', { image: 'bg1.png' })
  eq(noImage.ok, false, '目录里没图时应失败')
  eq(noImage.error.code, 'config/missing', '错误码应是 config/missing')
  check(noImage.error.message.includes(join(base, 'image', 'bg1.png')), 'message 要指出完整路径：' + noImage.error.message)
  check(noImage.error.hint.includes(join(base, 'image')), 'hint 要指出 imageDir：' + noImage.error.hint)

  const assetsNoBg = await callTool(holder.tools, 'mira_list_assets')
  eq(assetsNoBg.ok, true, '有模型时 list_assets 仍应 ok')
  eq(assetsNoBg.backgroundsError && assetsNoBg.backgroundsError.code, 'config/missing', '背景缺失要带 backgroundsError')
  check(assetsNoBg.backgroundsError.message.includes(join(base, 'image')), '背景错误要指出目录')

  writeBackground(base, 'bg1.png')
  const setBg = await callTool(holder.tools, 'mira_set_background', { image: 'bg1.png' })
  eq(setBg.ok, true, '有图时应设置成功')
  eq(setBg.background, 'bg1.png', '返回当前背景名')
  eq(setBg.url, '/live2d/backgrounds/bg1.png', '返回前端可用 URL')
  eq(JSON.parse(readFileSync(join(base, 'state.json'), 'utf8')).background, 'bg1.png', '背景应落 state.json')

  const configResp = await callHttp(holder.ws, '/live2d/api/config')
  const clientConfig = jsonOf(configResp)
  eq(clientConfig.backgroundUrl, '/live2d/backgrounds/bg1.png', '/config 应带 backgroundUrl')
  check(clientConfig.backgrounds.some((item) => item.name === 'bg1.png'), '/config 应列出背景图')

  const staticResp = await callHttp(holder.ws, '/live2d/backgrounds/bg1.png')
  eq(staticResp.status, 200, '背景图静态路由应 200')
  eq(staticResp.bytes.length, PNG_BYTES.length, '静态路由应返回原图字节')

  const badBg = await callTool(holder.tools, 'mira_set_background', { image: 'nope.png' })
  eq(badBg.ok, false, '不存在的背景应失败')
  check(badBg.error.message.includes(join(base, 'image', 'nope.png')), 'message 要指出路径')

  // 背景设置后图片被删掉：状态里要报 backgroundError，而不是静默给一个 404 URL。
  rmSync(join(base, 'image', 'bg1.png'))
  const stale = await callTool(holder.tools, 'mira_get_state')
  eq(stale.background, 'bg1.png', 'state.json 里仍记录着旧背景')
  eq(stale.backgroundError && stale.backgroundError.code, 'config/missing', '背景文件被删后 get_state 要报 backgroundError')
  const staleConfig = jsonOf(await callHttp(holder.ws, '/live2d/api/config'))
  eq(staleConfig.backgroundError && staleConfig.backgroundError.code, 'config/missing', '/config 也要报 backgroundError')
  eq(staleConfig.backgroundUrl, '', '背景缺失时不要给一个会 404 的 backgroundUrl')

  const cleared = await callTool(holder.tools, 'mira_set_background', { clear: true })
  eq(cleared.ok, true, '清空背景应成功')
  eq(cleared.background, null, '清空后 background 为 null')
  holder.dispose()
})

/* ── G5：TTS 未配置 / 已配置（假 fetch） ─────────────────── */

await test('G5', 'TTS 未配置 → config/missing + 去哪填；tts_status 不泄露 key；不会联网', async () => {
  const { base } = freshHome('tts-missing')
  const holder = applyCase(base)

  const fetchCalls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (...args) => {
    fetchCalls.push(args)
    return new Response(Buffer.from('SHOULD-NOT-BE-CALLED'), { status: 200 })
  }
  try {
    const status = await callTool(holder.tools, 'mira_tts_status')
    eq(status.ok, true, 'tts_status 是只读工具，本身应 ok')
    eq(status.enabled, false, '默认不启用 TTS')
    eq(status.configured, false, '默认没有配置 key')
    eq(status.provider, 'openai', '默认供应商 openai')
    check(String(status.hint).includes(join(base, 'creds', 'tts.json')), 'hint 要指到 creds/tts.json：' + status.hint)

    const speak = await callTool(holder.tools, 'mira_speak', { text: '你好' })
    eq(speak.ok, false, '未配置 TTS 时 speak 必须明确失败')
    eq(speak.error.code, 'config/missing', '错误码应是 config/missing')
    check(speak.error.message.includes('TTS'), 'message 要说明 TTS 未配置：' + speak.error.message)
    check(speak.error.hint.includes(join(base, 'config.json')), 'hint 要指出 config.json：' + speak.error.hint)
    eq(fetchCalls.length, 0, '未配置时不允许联网')

    const commands = jsonOf(await callHttp(holder.ws, '/live2d/api/commands?since=0')).commands
    check(commands.some((cmd) => cmd.action === 'bubble' && String(cmd.value).includes('未朗读')),
      '未配置 TTS 时应在气泡里给出明确提示')
  } finally {
    globalThis.fetch = realFetch
  }
  holder.dispose()

  // 旧字段 tts.key / tts.keyEnv 一律不读：凭据必须落 600 文件。
  const legacyHome = freshHome('tts-legacy')
  writeJson(join(legacyHome.base, 'config.json'), {
    schemaVersion: 2,
    enabled: true,
    tts: { enabled: true, provider: 'openai', key: 'sk-legacy-inline', keyEnv: 'LEGACY_KEY_ENV' },
  })
  const legacyHolder = applyCase(legacyHome.base)
  const legacyStatus = await callTool(legacyHolder.tools, 'mira_tts_status')
  eq(legacyStatus.configured, false, '旧 tts.key / tts.keyEnv 不得算作已配置')
  eq(legacyStatus.legacyKeyIgnored, true, '应标记旧 tts.key 被忽略')
  eq(legacyStatus.legacyKeyEnvIgnored, true, '应标记旧 tts.keyEnv 被忽略')
  const legacySpeak = await callTool(legacyHolder.tools, 'mira_speak', { text: 'x' })
  eq(legacySpeak.ok, false, '只有旧字段时 speak 必须失败')
  eq(legacySpeak.error.code, 'config/missing', '错误码应是 config/missing')
  check(JSON.stringify(legacySpeak).includes('keyEnv'), '提示里应说明 keyEnv 已废弃：' + JSON.stringify(legacySpeak))
  legacyHolder.dispose()
})

await test('G5b', 'TTS 已配置（假 fetch）：openai / aliyun 都能合成，key 不进日志/工具返回值', async () => {
  const { base } = freshHome('tts-ok')
  const secret = 'sk-smoke-SECRET-do-not-leak'
  writeJson(join(base, 'config.json'), {
    schemaVersion: 2,
    enabled: true,
    tts: { enabled: true, provider: 'openai' },
  })
  const credsFile = writeCreds(base, { schemaVersion: 1, provider: 'openai', apiKey: secret })
  eq(statSync(credsFile).mode & 0o777, 0o600, '凭据文件必须是 600')

  const holder = applyCase(base)
  const fetchCalls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url: String(url), options })
    return new Response(Buffer.from('ID3fakeaudio'), {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    })
  }
  try {
    const status = await callTool(holder.tools, 'mira_tts_status')
    eq(status.configured, true, '有 creds 文件时应报 configured:true')
    eq(status.keySource, 'creds', 'key 应来自 creds 文件')
    eq(status.provider, 'openai', 'provider 应为 openai')
    check(!JSON.stringify(status).includes(secret), 'tts_status 绝不能回显 key')

    const speak = await callTool(holder.tools, 'mira_speak', { text: '你好世界' })
    eq(speak.ok, true, '已配置时 speak 应成功')
    eq(speak.spoke, true, '应真的合成语音')
    check(typeof speak.audioId === 'string' && speak.audioId.length > 0, '应返回 audioId')
    check(!JSON.stringify(speak).includes(secret), 'speak 返回值绝不能包含 key')
    eq(fetchCalls.length, 1, '应只调用一次 TTS 接口')
    eq(fetchCalls[0].url, 'https://api.openai.com/v1/audio/speech', 'openai 默认地址')
    eq(fetchCalls[0].options.headers.Authorization, 'Bearer ' + secret, 'Authorization 应带 key')
    const sent = JSON.parse(fetchCalls[0].options.body)
    eq(sent.model, 'tts-1', '默认模型应为 tts-1')
    eq(sent.voice, 'alloy', '默认音色应为 alloy')
    eq(sent.input, '你好世界', '朗读文本应原样发送')

    const configView = await callTool(holder.tools, 'mira_get_config')
    check(!JSON.stringify(configView).includes(secret), 'get_config 绝不能包含 key')
    eq(configView.tts.keyConfigured, true, 'get_config 只报 key 是否配置')
    check(!logLines.some((line) => line.includes(secret)), '日志里绝不能出现 key')

    // 热加载：把供应商改成 aliyun（creds 不写 provider，避免覆盖配置），立刻生效。
    writeJson(credsFile, { schemaVersion: 1, apiKey: secret })
    writeJson(join(base, 'config.json'), {
      schemaVersion: 2,
      enabled: true,
      tts: { enabled: true, provider: 'aliyun' },
    })
    const aliyunStatus = await callTool(holder.tools, 'mira_tts_status')
    eq(aliyunStatus.provider, 'aliyun', 'provider 应热加载为 aliyun')
    eq(aliyunStatus.base, 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'aliyun 默认 base')
    const aliyunSpeak = await callTool(holder.tools, 'mira_speak', { text: '阿里云' })
    eq(aliyunSpeak.ok, true, 'aliyun 也应能合成')
    eq(fetchCalls[1].url, 'https://dashscope.aliyuncs.com/compatible-mode/v1/audio/speech', 'aliyun 默认地址')
    eq(JSON.parse(fetchCalls[1].options.body).model, 'qwen-tts', 'aliyun 默认模型 qwen-tts')

    // HTTP /tts 也要给前端用同一套逻辑
    const ttsResp = await callHttp(holder.ws, '/live2d/api/tts', { method: 'POST', body: { text: 'HTTP 测试' } })
    eq(ttsResp.status, 200, '/tts 应 200')
    const ttsJson = jsonOf(ttsResp)
    eq(ttsJson.ok, true, '/tts 应 ok:true')
    check(typeof ttsJson.base64 === 'string' && ttsJson.base64.length > 0, '/tts 应返回 base64 音频')
    check(!JSON.stringify(ttsJson).includes(secret), '/tts 绝不能回显 key')

    // 供应商错误里若回显了 key，必须被 redact 掉（错误体也不许带 key）。
    globalThis.fetch = async () => new Response('bad key ' + secret, {
      status: 401,
      headers: { 'content-type': 'text/plain' },
    })
    const failed = await callTool(holder.tools, 'mira_speak', { text: '失败路径' })
    eq(failed.ok, false, '供应商 401 时 speak 应失败')
    eq(failed.error.code, 'tts/failed', '供应商 401 应报 tts/failed')
    check(!JSON.stringify(failed).includes(secret), '错误体里的 key 必须被 redact')
    check(!logLines.some((line) => line.includes(secret)), '错误日志里也不能出现 key')
  } finally {
    globalThis.fetch = realFetch
  }
  holder.dispose()
})

/* ── G7：截图 ───────────────────────────────────────────── */

await test('G7', '截图：隐藏时明确拒绝；显示后前端上传真落盘并返回路径；无端点 → platform/unsupported', async () => {
  const { base } = freshHome('screenshot')
  writeFixture(base)
  writeJson(join(base, 'config.json'), { schemaVersion: 2, enabled: true, model: 'TestModel' })
  const holder = applyCase(base)

  const hidden = await callTool(holder.tools, 'mira_screenshot')
  eq(hidden.ok, false, '隐藏时截图应失败')
  eq(hidden.error.code, 'shot/unavailable', '隐藏时错误码应是 shot/unavailable')
  check(hidden.error.hint.includes('mira_show'), 'hint 要指出先显示模型：' + hidden.error.hint)

  const shown = await callTool(holder.tools, 'mira_set_visible', { visible: true })
  eq(shown.ok, true, '显示指令应成功')
  eq(shown.visible, true, 'visible 应为 true')

  const pending = holder.tools.get('mira_screenshot').execute({}, {})
  let command = null
  for (let i = 0; i < 40 && !command; i++) {
    const response = await callHttp(holder.ws, '/live2d/api/commands?since=0')
    const list = jsonOf(response).commands || []
    command = list.find((cmd) => cmd.action === 'screenshot')
    if (!command) await sleep(5)
  }
  check(!!command, '应下发 screenshot 指令')
  check(typeof command.value?.requestId === 'string', 'screenshot 指令应带 requestId')

  const upload = await callHttp(holder.ws, '/live2d/api/shot', {
    method: 'POST',
    body: {
      requestId: command.value.requestId,
      dataUrl: 'data:image/png;base64,' + PNG_BASE64,
      model: 'TestModel',
    },
  })
  eq(upload.status, 200, '截图上传应 200')
  const uploaded = jsonOf(upload)
  eq(uploaded.ok, true, '上传应 ok:true')
  check(existsSync(uploaded.path), '截图必须真的落盘：' + uploaded.path)
  eq(statSync(uploaded.path).size, PNG_BYTES.length, '落盘字节数应与上传一致')
  eq(readFileSync(uploaded.path).subarray(0, 8).toString('hex'), '89504e470d0a1a0a', '落盘文件必须是 PNG 签名')
  check(uploaded.path.startsWith(join(base, 'media')), '截图应落在 mediaDir：' + uploaded.path)

  const toolResult = JSON.parse(await pending)
  eq(toolResult.ok, true, '截图工具应拿到上传结果')
  eq(toolResult.path, uploaded.path, '工具返回的路径应与落盘一致')

  const state = await callTool(holder.tools, 'mira_get_state')
  eq(state.shot.lastShot.path, uploaded.path, 'get_state 应能看到最近一次截图')

  const mediaResp = await callHttp(holder.ws, uploaded.url)
  eq(mediaResp.status, 200, '截图静态路由应 200')
  eq(mediaResp.bytes.length, PNG_BYTES.length, '截图静态路由应返回原图')

  const invalid = await callHttp(holder.ws, '/live2d/api/shot', {
    method: 'POST',
    body: { requestId: 'bad', dataUrl: 'data:image/png;base64,AAAA' },
  })
  eq(invalid.status, 400, '无效截图应 400')
  eq(jsonOf(invalid).error.code, 'shot/invalid', '无效截图应报 shot/invalid')
  holder.dispose()

  // 没有 webServer.register：工具仍在，截图返回 platform/unsupported
  const noEndpointHome = freshHome('screenshot-no-endpoint')
  writeJson(join(noEndpointHome.base, 'config.json'), {
    schemaVersion: 2, enabled: true, model: 'TestModel',
  })
  const noEndpoint = applyCase(noEndpointHome.base, {}, { webServer: { tapIndex() { return () => {} } } })
  eq(noEndpoint.result.endpointAvailable, false, '没有 register 时应报端点不可用')
  await callTool(noEndpoint.tools, 'mira_set_visible', { visible: true })
  const unsupported = await callTool(noEndpoint.tools, 'mira_screenshot')
  eq(unsupported.ok, false, '没有上传端点时截图应失败')
  eq(unsupported.error.code, 'platform/unsupported', '错误码应是 platform/unsupported')
  check(unsupported.error.message.includes('上传端点'), 'message 要说清是没有上传端点：' + unsupported.error.message)
  noEndpoint.dispose()

  // ShotService 的等待/失败路径：前端回报错误、超时
  const service = new ShotService({
    mediaDir: join(base, 'media'),
    config: { maxBytes: 1024 * 1024 },
    endpointAvailable: true,
    now: () => Date.now(),
  })
  const waiting = service.request({ requestId: 'wait-1', timeoutMs: 5000 })
  const rejected = service.handleUpload({ requestId: 'wait-1', error: '模型未显示' })
  eq(rejected.ok, false, '前端回报错误应直接失败')
  const waited = await waiting
  eq(waited.ok, false, '等待中的工具应立刻收到错误')
  eq(waited.error.code, 'shot/unavailable', '前端回报错误应是 shot/unavailable')
  const timeout = await service.request({ requestId: 'wait-2', timeoutMs: 120 })
  eq(timeout.ok, false, '没人上传时应超时失败')
  eq(timeout.error.code, 'shot/unavailable', '超时也应是 shot/unavailable')
  service.dispose()
})

/* ── schemaVersion / state 持久化 ────────────────────────── */

await test('G-schema', 'config/state schemaVersion 不匹配 → 拒绝使用并保留原文件', async () => {
  const configHome = freshHome('schema-config')
  writeFixture(configHome.base)
  writeJson(join(configHome.base, 'config.json'), { schemaVersion: 1, enabled: true, model: 'TestModel' })
  const configHolder = applyCase(configHome.base)
  eq(configHolder.result.ok, true, 'schema 不匹配时 apply 仍返回可诊断对象')
  eq(configHolder.result.configError && configHolder.result.configError.code, 'config/schema', 'apply 应报 config/schema')
  const stateResult = await callTool(configHolder.tools, 'mira_get_state')
  eq(stateResult.ok, false, '配置 schema 不匹配时工具应拒绝')
  eq(stateResult.error.code, 'config/schema', '工具错误码应是 config/schema')
  const configHttp = jsonOf(await callHttp(configHolder.ws, '/live2d/api/config'))
  eq(configHttp.enabled, false, '/config 应报不可用')
  eq(configHttp.fatalError.code, 'config/schema', '/config 应带 fatalError')
  configHolder.dispose()
  eq(JSON.parse(readFileSync(join(configHome.base, 'config.json'), 'utf8')).schemaVersion, 1, '原配置文件必须原样保留')

  const stateHome = freshHome('schema-state')
  writeFixture(stateHome.base)
  writeJson(join(stateHome.base, 'config.json'), { schemaVersion: 2, enabled: true, model: 'TestModel' })
  writeJson(join(stateHome.base, 'state.json'), { schemaVersion: 99, visible: true, model: 'TestModel' })
  const stateHolder = applyCase(stateHome.base)
  const brokenState = await callTool(stateHolder.tools, 'mira_get_state')
  eq(brokenState.ok, false, 'state schema 不匹配时 get_state 应拒绝')
  eq(brokenState.error.code, 'config/schema', 'state 错误码应是 config/schema')
  const setVisible = await callTool(stateHolder.tools, 'mira_set_visible', { visible: false })
  eq(setVisible.ok, false, 'state 坏了时不允许写状态')
  stateHolder.dispose()
  eq(JSON.parse(readFileSync(join(stateHome.base, 'state.json'), 'utf8')).schemaVersion, 99, '原 state 文件必须原样保留')
})

await test('G-state', 'state 默认隐藏且可持久化：显示后重启仍显示，隐藏后重启仍隐藏', async () => {
  const { base } = freshHome('state-persist')
  writeFixture(base)
  writeJson(join(base, 'config.json'), { schemaVersion: 2, enabled: true, model: 'TestModel' })

  const first = applyCase(base)
  eq((await callTool(first.tools, 'mira_get_state')).visible, false, '首次加载默认隐藏')
  await callTool(first.tools, 'mira_set_visible', { visible: true })
  first.dispose()
  const saved = JSON.parse(readFileSync(join(base, 'state.json'), 'utf8'))
  eq(saved.schemaVersion, 1, 'state.json 应带 schemaVersion=1')
  eq(saved.visible, true, '显示状态应落盘')

  const second = applyCase(base)
  eq((await callTool(second.tools, 'mira_get_state')).visible, true, '重启后应保持显示')
  await callTool(second.tools, 'mira_hide')
  second.dispose()

  const third = applyCase(base)
  eq((await callTool(third.tools, 'mira_get_state')).visible, false, '隐藏后重启应保持隐藏')
  third.dispose()
})

/* ── HTTP API / 前端上报 ────────────────────────────────── */

await test('G-api', '/config /commands /capabilities /state /background 走真实 HTTP，前端上报能持久化', async () => {
  const { base } = freshHome('api')
  writeFixture(base, { withBackground: true })
  writeJson(join(base, 'config.json'), { schemaVersion: 2, enabled: true, model: 'TestModel' })
  const holder = applyCase(base)

  const configResp = await callHttp(holder.ws, '/live2d/api/config')
  eq(configResp.status, 200, '/config 应 200')
  const clientConfig = jsonOf(configResp)
  eq(clientConfig.model, 'TestModel', '/config 应带当前模型')
  eq(clientConfig.modelEntry, 'TestModel/TestModel.model3.json', '/config 应带模型入口')
  eq(clientConfig.modelEntry, clientConfig.modelEntry, 'modelEntry 非空')
  eq(clientConfig.capabilities.expressions, ['开心', '缺失'], '/config 应带表情清单')
  eq(clientConfig.capabilities.motions, ['Idle', 'TapBody'], '/config 应带动作清单')
  check(Array.isArray(clientConfig.capabilities.missing) && clientConfig.capabilities.missing.length >= 2, '/config 应带缺失诊断')
  eq(clientConfig.backgrounds.length, 1, '/config 应列出背景图')
  eq(clientConfig.tts.configured, false, '/config 应带 TTS 是否配置（不带 key）')

  const capsResp = await callHttp(holder.ws, '/live2d/api/capabilities?model=OtherModel')
  eq(capsResp.status, 200, '/capabilities 应 200')
  eq(jsonOf(capsResp).expressions, [], 'OtherModel 没有表情')

  const show = await callTool(holder.tools, 'mira_show')
  eq(show.ok, true, 'mira_show 应成功')
  const commands = jsonOf(await callHttp(holder.ws, '/live2d/api/commands?since=0')).commands
  check(commands.some((cmd) => cmd.action === 'show' && cmd.value === true), '/commands 应有 show 指令')

  const statePost = await callHttp(holder.ws, '/live2d/api/state', {
    method: 'POST',
    body: {
      visible: true,
      model: 'TestModel',
      background: 'bg1.png',
      expressions: ['开心'],
      currentMotion: 'Idle',
      mood: 'idle',
      t: Date.now(),
    },
  })
  eq(statePost.status, 200, '/state 应 200')
  const stateJson = jsonOf(statePost)
  eq(stateJson.ok, true, '/state 应 ok')
  eq(stateJson.persisted, true, '/state 应持久化')
  const after = await callTool(holder.tools, 'mira_get_state')
  eq(after.visible, true, '前端上报的 visible 应进入服务端状态')
  eq(after.background, 'bg1.png', '前端上报的背景应进入服务端状态')
  eq(after.expressions, ['开心'], '前端上报的表情应进入服务端状态')

  const invalidBg = await callHttp(holder.ws, '/live2d/api/state', {
    method: 'POST',
    body: { background: '../escape.png' },
  })
  eq(invalidBg.status, 200, '/state 非法背景仍应 200')
  check(String(jsonOf(invalidBg).warning).includes('背景图'), '非法背景应给出 warning，不静默接受')
  eq((await callTool(holder.tools, 'mira_get_state')).background, 'bg1.png', '非法背景不应覆盖原背景')

  const bgPost = await callHttp(holder.ws, '/live2d/api/background', { method: 'POST', body: { image: 'bg1.png' } })
  eq(bgPost.status, 200, '/background 应 200')
  eq(jsonOf(bgPost).background, 'bg1.png', '/background 应返回背景名')

  const ttsPost = await callHttp(holder.ws, '/live2d/api/tts', { method: 'POST', body: { text: 'x' } })
  eq(ttsPost.status, 400, 'TTS 未配置时 /tts 应 400')
  eq(jsonOf(ttsPost).error.code, 'config/missing', '/tts 应带 config/missing')

  const notFound = await callHttp(holder.ws, '/live2d/api/nope')
  eq(notFound.status, 404, '未知 API 应 404')
  holder.dispose()
})

/* ── 设置页：/live2d/api/settings + 客户端模块 ───────────── */

await test('G-settings', '设置页 API：GET 不泄漏 key、POST 原子写盘可回读、非法值被拒、creds 600、客户端模块存在', async () => {
  const { base } = freshHome('settings')
  writeFixture(base, { withBackground: true })
  const SECRET = 'sk-live2d-super-secret-9f3a'
  const credsPath = writeCreds(base, { schemaVersion: 1, provider: 'openai', apiKey: SECRET }, 0o600)
  writeJson(join(base, 'config.json'), {
    schemaVersion: 2,
    enabled: true,
    model: 'TestModel',
    position: 'left',
    mobileScale: 42,
    showHint: false,
    canvas: { w: 320, h: 480 },
    tts: { enabled: false, base: '', model: '', voice: '' },
    pollIntervalMs: 1500,
  })
  const holder = applyCase(base)

  // ① GET 只回可编辑项 + keyConfigured，不泄漏 key。
  const getResp = await callHttp(holder.ws, '/live2d/api/settings')
  eq(getResp.status, 200, 'GET /settings 应 200')
  check(!getResp.text.includes(SECRET), 'GET /settings 响应里不得出现 apiKey 原值')
  check(!/apiKey/i.test(getResp.text), 'GET /settings 不应返回 apiKey 字段')
  const view = jsonOf(getResp)
  eq(view.ok, true, 'GET /settings 应 ok:true')
  eq(view.keyConfigured, true, 'creds 已配置时 keyConfigured 应为 true')
  eq(view.values.model, 'TestModel', 'GET 应带当前模型')
  eq(view.values.position, 'left', 'GET 应带当前位置')
  eq(view.values.mobileScale, 42, 'GET 应带当前移动端缩放')
  eq(view.values.showHint, false, 'GET 应带当前 showHint')
  eq(view.values.canvas, { w: 320, h: 480 }, 'GET 应带当前画布尺寸')
  eq(view.values.tts.enabled, false, 'GET 应带 tts.enabled')
  check(String(view.configFile).endsWith('config.json'), 'GET 应带 configFile')
  check(String(view.credsFile).endsWith(join('creds', 'tts.json')), 'GET 应带 credsFile 路径')

  // ② POST 写盘 → GET 读回；未编辑的键与 schemaVersion 必须保住。
  const postResp = await callHttp(holder.ws, '/live2d/api/settings', {
    method: 'POST',
    body: {
      values: {
        model: 'OtherModel',
        position: 'right',
        mobileScale: 66,
        showHint: true,
        canvas: { w: 640, h: 800 },
        tts: { enabled: true, base: 'https://example.test/v1', model: 'tts-1', voice: 'alloy' },
      },
    },
  })
  eq(postResp.status, 200, 'POST /settings 应 200')
  const saved = jsonOf(postResp)
  eq(saved.ok, true, 'POST /settings 应 ok:true')
  check(Array.isArray(saved.changed) && saved.changed.includes('model'), 'POST 应回报改动字段（含 model）')
  check(saved.changed.includes('canvas.w'), 'POST 应回报 canvas.w 改动')
  const disk = JSON.parse(readFileSync(join(base, 'config.json'), 'utf8'))
  eq(disk.schemaVersion, 2, '写盘后 schemaVersion 必须保留')
  eq(disk.model, 'OtherModel', 'config.json 应写入 model')
  eq(disk.position, 'right', 'config.json 应写入 position')
  eq(disk.mobileScale, 66, 'config.json 应写入 mobileScale')
  eq(disk.showHint, true, 'config.json 应写入 showHint')
  eq(disk.canvas, { w: 640, h: 800 }, 'config.json 应合并写入 canvas')
  eq(disk.tts.enabled, true, 'config.json 应写入 tts.enabled')
  eq(disk.tts.base, 'https://example.test/v1', 'config.json 应写入 tts.base')
  eq(disk.pollIntervalMs, 1500, '写盘不得丢掉未编辑的现有键')

  const reread = jsonOf(await callHttp(holder.ws, '/live2d/api/settings'))
  eq(reread.values.model, 'OtherModel', 'GET 应读回 POST 写入的 model')
  eq(reread.values.position, 'right', 'GET 应读回 POST 写入的 position')
  eq(reread.values.canvas, { w: 640, h: 800 }, 'GET 应读回 POST 写入的画布')
  eq(reread.values.tts.enabled, true, 'GET 应读回 POST 写入的 tts.enabled')

  // ③ 非法值被拒：400 + config/invalid，message 点名哪一项；文件原样。
  const badCases = [
    ['position', { values: { position: 'middle' } }],
    ['mobileScale', { values: { mobileScale: 101 } }],
    ['canvas.w', { values: { canvas: { w: 0 } } }],
    ['tts.enabled', { values: { tts: { enabled: 'yes' } } }],
    ['model', { values: { model: 42 } }],
  ]
  for (const [field, body] of badCases) {
    const resp = await callHttp(holder.ws, '/live2d/api/settings', { method: 'POST', body })
    eq(resp.status, 400, '非法 ' + field + ' 应 400')
    const failure = jsonOf(resp)
    eq(failure.ok, false, '非法 ' + field + ' 应 ok:false')
    eq(failure.error.code, 'config/invalid', '非法 ' + field + ' 应 config/invalid')
    check(String(failure.error.message).includes(field), '错误信息必须点名 ' + field)
  }
  eq(JSON.parse(readFileSync(join(base, 'config.json'), 'utf8')).position, 'right', '非法请求不得改动 config.json')

  // ④ 写入 key：creds/tts.json 600，响应与 GET 都不回显；留空 = 不改。
  const keyPost = await callHttp(holder.ws, '/live2d/api/settings', {
    method: 'POST',
    body: { values: { model: 'OtherModel', tts: { apiKey: 'sk-new-secret-abc123' } } },
  })
  eq(keyPost.status, 200, '带 apiKey 的 POST 应 200')
  check(!keyPost.text.includes('sk-new-secret-abc123'), 'POST 响应不得回显 apiKey')
  eq(jsonOf(keyPost).keyConfigured, true, '写入 key 后 keyConfigured 应为 true')
  eq(statSync(credsPath).mode & 0o777, 0o600, 'creds/tts.json 权限必须是 600')
  const creds = JSON.parse(readFileSync(credsPath, 'utf8'))
  eq(creds.apiKey, 'sk-new-secret-abc123', 'creds 应写入新 key')
  eq(creds.schemaVersion, 1, 'creds schemaVersion 应为 1')
  eq(creds.provider, 'openai', 'creds 应带有效供应商')
  check(typeof creds.updatedAt === 'string' && creds.updatedAt.length > 0, 'creds 应带 updatedAt')
  const credsBefore = readFileSync(credsPath, 'utf8')
  const keep = await callHttp(holder.ws, '/live2d/api/settings', {
    method: 'POST',
    body: { values: { model: 'OtherModel', tts: { apiKey: '' } } },
  })
  eq(keep.status, 200, 'apiKey 留空仍应保存其它项')
  eq(readFileSync(credsPath, 'utf8'), credsBefore, 'apiKey 留空不得改写 creds/tts.json')

  // ⑤ 客户端模块与 package.json 清单（客户端代码在浏览器里跑，这里只做静态检查）。
  const clientUrl = new URL('../lib/client.js', import.meta.url)
  check(existsSync(clientUrl), 'lib/client.js 必须存在')
  const clientText = existsSync(clientUrl) ? readFileSync(clientUrl, 'utf8') : ''
  check(clientText.includes('__ModuleLoader__.load'), '客户端模块必须走 window.__ModuleLoader__.load')
  check(clientText.includes("id: 'mira_live2d'"), '客户端模块 id 必须是包名 mira_live2d')
  check(clientText.includes('settings.section'), '客户端模块必须注册 settings.section')
  check(clientText.includes("label: () => '看板娘'"), '设置页标签必须是「看板娘」')
  check(clientText.includes('/live2d/api/settings'), '客户端必须调用 /live2d/api/settings')
  check(!/require\(\s*['"]@deepseek-ai\//.test(clientText), '客户端模块不得 require 官方客户端包')
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  eq(pkg.main, 'lib/index.js', 'package.json main 应保持不变')
  eq(pkg.exports['./client'], './lib/client.js', 'package.json 应导出 ./client')
  eq(pkg.exports['.'], './lib/index.js', 'package.json 应保留根导出 .')
  eq(pkg.dsh.client.platform, 'web', 'dsh.client.platform 应为 web')
  check(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'),
    'dsh.client.inject 应包含 @deepseek-ai/dsh-client-ui-settings')

  // ⑥ 配置坏（schemaVersion 不匹配）：GET 仍 200 并带 configError；POST 503 不覆盖坏文件。
  const broken = JSON.stringify({ schemaVersion: 99, model: 'OtherModel' }, null, 2) + '\n'
  writeFileSync(join(base, 'config.json'), broken, 'utf8')
  const brokenGet = await callHttp(holder.ws, '/live2d/api/settings')
  eq(brokenGet.status, 200, '配置坏时 GET /settings 仍应 200（设置页要能显示原因）')
  const brokenView = jsonOf(brokenGet)
  eq(brokenView.configError.code, 'config/schema', 'GET 应带 config/schema 的 configError')
  const brokenPost = await callHttp(holder.ws, '/live2d/api/settings', {
    method: 'POST',
    body: { values: { position: 'left' } },
  })
  eq(brokenPost.status, 503, '配置坏时 POST /settings 应 503')
  eq(jsonOf(brokenPost).error.code, 'config/schema', 'POST 应回报 config/schema')
  eq(readFileSync(join(base, 'config.json'), 'utf8'), broken, '配置坏时不得覆盖写入')

  holder.dispose()
})

/* ── 工具参数校验 / 旧工具兼容 ─────────────────────────── */

await test('G-tools', '旧工具保留 + 显式开关参数校验；get_config 不含凭据；persona 运行期生效', async () => {
  const { base } = freshHome('tools')
  writeFixture(base)
  writeJson(join(base, 'config.json'), { schemaVersion: 2, enabled: true, model: 'TestModel' })
  const holder = applyCase(base)

  const names = [...holder.tools.keys()].sort()
  for (const expected of [
    'mira_get_state', 'mira_list_models', 'mira_list_assets', 'mira_get_model_capabilities',
    'mira_switch_model', 'mira_set_expression', 'mira_play_motion', 'mira_speak', 'mira_bubble',
    'mira_set_visible', 'mira_show', 'mira_hide', 'mira_set_expressions_enabled',
    'mira_set_animations_enabled', 'mira_set_mood', 'mira_set_persona', 'mira_get_config',
    'mira_set_background', 'mira_screenshot', 'mira_tts_status',
  ]) {
    check(names.includes(expected), '必须保留/新增工具 ' + expected)
  }

  const badVisible = await callTool(holder.tools, 'mira_set_visible', { visible: 'yes' })
  eq(badVisible.ok, false, 'visible 非布尔应失败')
  eq(badVisible.error.code, 'config/invalid', '参数错误应是 config/invalid')

  const persona = await callTool(holder.tools, 'mira_set_persona', {
    thinkingExpression: '开心',
    thinkingBubble: '思考中',
    idleClearMs: 1200,
  })
  eq(persona.ok, true, 'set_persona 应成功')
  eq(persona.persona.idleClearMs, 1200, 'idleClearMs 应更新')
  eq((await callTool(holder.tools, 'mira_get_state')).serverKnown.persona.thinking.expression, '开心',
    '运行期 persona 应反映在 get_state')

  const bubble = await callTool(holder.tools, 'mira_bubble', { text: '测试气泡' })
  eq(bubble.ok, true, 'mira_bubble 应成功')

  const mood = await callTool(holder.tools, 'mira_set_mood', { mood: 'thinking' })
  eq(mood.ok, true, 'mira_set_mood 应成功')
  const badMood = await callTool(holder.tools, 'mira_set_mood', { mood: 'angry' })
  eq(badMood.ok, false, '非法 mood 应失败')

  const exprOff = await callTool(holder.tools, 'mira_set_expressions_enabled', { enabled: false })
  eq(exprOff.ok, true, '表情开关应成功')
  const animOff = await callTool(holder.tools, 'mira_set_animations_enabled', { enabled: false })
  eq(animOff.ok, true, '动画开关应成功')
  const state = await callTool(holder.tools, 'mira_get_state')
  eq(state.expressionsEnabled, false, '表情开关应落状态')
  eq(state.animationsEnabled, false, '动画开关应落状态')

  const getConfig = await callTool(holder.tools, 'mira_get_config')
  check(!JSON.stringify(getConfig).includes('apiKey'), 'get_config 绝不能包含 apiKey')
  eq(getConfig.configFile, join(base, 'config.json'), 'get_config 应给出配置文件路径')
  holder.dispose()
})

/* ── 安全 / 生命周期回归 ──────────────────────────────────── */

await test('G-api-sec', '跨站 API 一律 403；since 不污染指令 ID；apply 抛错释放认领与路由；TTS 截断回报', async () => {
  const { base } = freshHome('api-sec')
  writeFixture(base)
  writeJson(join(base, 'config.json'), { schemaVersion: 2, enabled: true, model: 'TestModel' })
  const holder = applyCase(base)

  // 1) CSRF：跨站请求不许改状态 / 拍截图；同源照常放行。
  const evilState = await callHttp(holder.ws, '/live2d/api/state', {
    method: 'POST', body: { visible: true }, headers: { origin: 'https://evil.example' },
  })
  eq(evilState.status, 403, '跨站 POST /state 应 403')
  eq(jsonOf(evilState).error.code, 'http/forbidden', '跨站请求应报 http/forbidden')
  eq((await callTool(holder.tools, 'mira_get_state')).visible, false, '跨站请求不能改状态')

  const fetchSite = await callHttp(holder.ws, '/live2d/api/state', {
    method: 'POST', body: { visible: true }, headers: { 'sec-fetch-site': 'cross-site' },
  })
  eq(fetchSite.status, 403, 'Sec-Fetch-Site: cross-site 也应 403')

  const evilGet = await callHttp(holder.ws, '/live2d/api/config', { headers: { origin: 'https://evil.example' } })
  eq(evilGet.status, 403, '跨站 GET /api/* 与 POST 同一口径（403）')

  const mediaDir = join(base, 'media')
  const mediaBefore = readdirSync(mediaDir).length
  const evilShot = await callHttp(holder.ws, '/live2d/api/shot', {
    method: 'POST',
    body: { dataUrl: 'data:image/png;base64,' + PNG_BASE64 },
    headers: { origin: 'https://evil.example' },
  })
  eq(evilShot.status, 403, '跨站 /shot 应 403')
  eq(readdirSync(mediaDir).length, mediaBefore, '跨站截图不得落盘')

  const same = await callHttp(holder.ws, '/live2d/api/state', {
    method: 'POST',
    body: { visible: true },
    headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' },
  })
  eq(same.status, 200, '同源请求必须照常放行')
  eq((await callTool(holder.tools, 'mira_get_state')).visible, true, '同源上报仍可持久化')

  // 2) 客户端游标不再能污染 nextCommandId（否则 id++ 卡在浮点精度上，指令永远发不出去）。
  const poison = await callHttp(holder.ws, '/live2d/api/commands?since=1e21')
  eq(poison.status, 200, '异常 since 仍返回 200（只是不采信）')
  await callTool(holder.tools, 'mira_set_mood', { mood: 'thinking' })
  const seen = jsonOf(await callHttp(holder.ws, '/live2d/api/commands?since=0')).commands
  const last = seen[seen.length - 1]
  check(Number.isSafeInteger(last.id) && last.id < 1e16, 'since=1e21 不能把指令 ID 推到浮点精度边界')
  await callTool(holder.tools, 'mira_set_mood', { mood: 'idle' })
  const next = jsonOf(await callHttp(holder.ws, '/live2d/api/commands?since=' + last.id)).commands
  check(next.length === 1 && next[0].action === 'mood' && next[0].id > last.id,
    '用上一条 ID 当游标必须还能收到新指令（ID 严格递增）')
  holder.dispose()

  // 3) 装配中途抛错：已注册的 tap/路由/工具要摘掉、认领要释放（否则进程内无法再 apply）。
  const bad = makeCtx()
  const badTapCount = bad.ws.taps.length
  bad.ctx.effect = () => { throw new Error('boom') }
  let threw = false
  try {
    apply(bad.ctx, {})
  } catch {
    threw = true
  }
  check(threw, '装配期抛错时 apply 应把错误抛出去（不吞）')
  eq(bad.ws.routes.size, 0, 'apply 抛错后不应留下 /live2d 路由')
  eq(bad.ws.taps.length, badTapCount, 'apply 抛错后不应留下 tap')
  eq(bad.tools.size, 0, 'apply 抛错后不应留下工具')
  const again = applyCase(base)
  eq(again.result.ok, true, 'apply 抛错后认领必须已释放，可以重新 apply')

  // 4) TTS 长文本：按 code point 截断并回报 truncated/chars（不许静默、不许劈开代理对）。
  writeCreds(base, { schemaVersion: 1, apiKey: 'sk-sec-test' })
  writeJson(join(base, 'config.json'), { schemaVersion: 2, enabled: true, model: 'TestModel', tts: { enabled: true } })
  const fetchCalls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url: String(url), options })
    return new Response(Buffer.from('ID3fakeaudio'), { status: 200, headers: { 'content-type': 'audio/mpeg' } })
  }
  try {
    const speak = await callTool(again.tools, 'mira_speak', { text: '😀'.repeat(601) })
    eq(speak.ok, true, '长文本仍应合成成功')
    eq(speak.truncated, true, '超过 maxChars 必须在返回值里标 truncated:true')
    eq(speak.requestedChars, 601, 'requestedChars 应报原始长度')
    eq(speak.chars, 600, 'chars 应报实际朗读长度')
    const sent = JSON.parse(fetchCalls[0].options.body).input
    eq(Array.from(sent).length, 600, '发给供应商的文本应为 600 个 code point')
    check(sent.isWellFormed(), '截断不能劈开代理对（必须是合法 UTF-16）')
    const short = await callTool(again.tools, 'mira_speak', { text: '短' })
    eq(short.truncated, false, '未超长时 truncated 必须是 false')
  } finally {
    globalThis.fetch = realFetch
  }
  again.dispose()
})

/* ── 收尾 ───────────────────────────────────────────────── */

try {
  rmSync(TMP, { recursive: true, force: true })
} catch {
  /* 临时目录清理失败不影响结论 */
}

console.log('通过 ' + passed + ' 项断言')
if (failures.length) {
  for (const failure of failures) console.log('[FAIL] ' + failure)
  console.log('\n==== FAIL（' + failures.length + ' 项失败）====')
  process.exit(1)
}
console.log('\n==== ALL PASS（' + passed + ' 项断言）====')
process.exit(0)
