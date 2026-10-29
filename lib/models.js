/**
 * mira_live2d / models.js —— 模型 / 表情 / 动作清单扫描与资源缺失诊断
 *
 * 任务书功能点2/3/9：
 *   - 扫描 modelsDir 下每个含 `*.model3.json` 的子目录；
 *   - 解析 model3.json 的 FileReferences，列出表情与动作组；
 *   - **逐项检查被引用的文件是否存在**，缺哪个就报哪个（含绝对路径与「从哪配」的
 *     hint），绝不静默留白。
 *
 * 错误码（README「错误码」有全集）：
 *   config/missing   目录不存在 / 没有模型 / 背景目录没有图 / 背景图不存在
 *   model/not-found  指定的模型名不在 modelsDir
 *   model/broken     model3.json 读不了或不是 JSON
 *   resource/missing 模型引用的文件（moc/贴图/表情/动作）缺失
 *
 * 不自动挑模型：modelsDir 里有几个模型、默认用哪个，一律由 config.model 或
 * `mira_switch_model` 显式指定（任务书约定2：禁止自动探测/猜默认）。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'

import { MiraError, okObj } from './kit.mjs'

export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const CORE_KINDS = new Set(['moc', 'texture'])

/** 路径越界保护：返回 null 表示 rel 逃出了 root。 */
function safeJoin(root, rel) {
  const full = resolve(root, rel)
  if (full === root) return null
  if (!full.startsWith(root + sep)) return null
  return full
}

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** 把 model3.json 里的一处引用解析成诊断条目。 */
function ref(root, rel, kind, extra = {}) {
  const clean = String(rel ?? '').replace(/\\/g, '/')
  const full = clean === '' ? null : safeJoin(root, clean)
  const exists = full ? isFile(full) : false
  return {
    kind,
    file: clean,
    path: full,
    exists,
    ...extra,
  }
}

function hintForMissing(entry, modelDir, model3Path) {
  if (CORE_KINDS.has(entry.kind)) {
    return '模型文件不完整：把 ' + entry.file + ' 放回 ' + modelDir
      + '（路径来自 ' + model3Path + ' 的 FileReferences）'
  }
  if (entry.kind === 'expression') {
    return '把 ' + entry.file + ' 放到 ' + modelDir
      + '，或从 ' + model3Path + ' 的 FileReferences.Expressions 里删掉 ' + JSON.stringify(entry.name ?? entry.file)
  }
  if (entry.kind === 'motion') {
    return '把 ' + entry.file + ' 放到 ' + modelDir
      + '，或从 ' + model3Path + ' 的 FileReferences.Motions.' + (entry.group ?? '?') + ' 里删掉该条'
  }
  return '把 ' + entry.file + ' 放回 ' + modelDir + '（路径来自 ' + model3Path + '）'
}

export class ModelCatalog {
  /**
   * @param {object} options
   * @param {string} options.modelsDir  已解析的模型根目录
   * @param {string} options.imageDir   已解析的背景图根目录
   * @param {string} options.configFile config.json 绝对路径（hint 用）
   * @param {string} [options.pluginRoot] 插件根目录（hint 里指向自带模型）
   */
  constructor({ modelsDir, imageDir, configFile, pluginRoot = '', logger = null, counters = null }) {
    this.modelsDir = modelsDir
    this.imageDir = imageDir
    this.configFile = configFile
    this.pluginRoot = pluginRoot
    this.logger = logger
    this.counters = counters
  }

  _assertDir(dir, key, what) {
    let st = null
    try {
      st = statSync(dir)
    } catch {
      throw new MiraError(
        'config/missing',
        what + '不存在：' + dir,
        '在 ' + this.configFile + ' 里把 ' + key + ' 指到存在的目录，或创建 ' + dir + '（本插件不自动探测）',
      )
    }
    if (!st.isDirectory()) {
      throw new MiraError(
        'config/missing',
        what + '不是目录：' + dir,
        '在 ' + this.configFile + ' 里把 ' + key + ' 改成目录路径',
      )
    }
  }

  /**
   * 扫描模型。
   * @param {{diagnose?: boolean, expected?: string}} [options]
   *   diagnose=true 时顺带解析每个模型的缺失文件（mira_list_assets 用）。
   * @returns {{dir:string, models:Array<object>}}
   */
  scanModels(options = {}) {
    const { diagnose = false, expected = '' } = options
    this._assertDir(this.modelsDir, 'modelsDir', '模型目录')

    let entries
    try {
      entries = readdirSync(this.modelsDir, { withFileTypes: true })
    } catch (error) {
      throw new MiraError('config/missing', '模型目录不可读：' + this.modelsDir + '（' + (error?.message || error) + '）',
        '检查目录权限；或在 ' + this.configFile + ' 里改 modelsDir')
    }

    const models = []
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue
      const dir = join(this.modelsDir, entry.name)
      let files
      try {
        files = readdirSync(dir)
      } catch {
        continue
      }
      const model3Files = files.filter((f) => f.endsWith('.model3.json')).sort()
      if (model3Files.length === 0) continue
      const model3 = join(dir, model3Files[0])
      const model = {
        name: entry.name,
        dir,
        entry: entry.name + '/' + model3Files[0],
        model3,
        model3Files,
      }
      if (diagnose) {
        try {
          const caps = this.capabilities(entry.name)
          model.expressions = caps.expressions
          model.motions = caps.motions
          model.missing = caps.missing
          model.missingCount = caps.missing.length
          model.coreMissing = caps.coreMissing
        } catch (error) {
          model.error = { code: error?.code || 'model/broken', message: error?.message || String(error) }
          model.missing = []
          model.missingCount = 0
          model.coreMissing = []
        }
      }
      models.push(model)
    }

    if (models.length === 0) {
      const wanted = expected ? expected + '.model3.json' : '*.model3.json'
      const bundled = this.pluginRoot ? join(this.pluginRoot, 'model') : ''
      throw new MiraError(
        'config/missing',
        '模型目录里没有可用的模型：' + this.modelsDir + '（缺少 ' + wanted + '）',
        '把含 *.model3.json 的模型目录放到 ' + this.modelsDir + '，或在 ' + this.configFile
          + ' 里改 modelsDir；' + (bundled ? '插件自带模型在 ' + bundled + '（可把 modelsDir 指向它，或把模型复制到默认目录）' : ''),
      )
    }

    return { dir: this.modelsDir, models }
  }

  /** 找模型条目；没有再扫描。 */
  find(name) {
    const wanted = typeof name === 'string' ? name.trim() : ''
    if (wanted === '') {
      throw new MiraError('config/missing', '没有指定模型名（model 为空）',
        '在 ' + this.configFile + ' 里填 model（modelsDir 下的目录名），或先调用 mira_switch_model；不自动挑默认模型')
    }
    const { models } = this.scanModels()
    const hit = models.find((m) => m.name === wanted)
    if (!hit) {
      throw new MiraError(
        'model/not-found',
        '没有这个模型：' + wanted + '（可用：' + models.map((m) => m.name).join('、') + '）',
        '用 mira_list_assets / mira_list_models 查看可切换模型；模型目录：' + this.modelsDir,
      )
    }
    return hit
  }

  /** 读 model3.json；坏文件报 model/broken 并指出文件。 */
  readModel3(name) {
    const model = this.find(name)
    let raw
    try {
      raw = readFileSync(model.model3, 'utf8')
    } catch (error) {
      throw new MiraError('model/broken', 'model3.json 读取失败：' + model.model3 + '（' + (error?.message || error) + '）',
        '检查文件权限；模型入口必须是 ' + model.name + '.model3.json')
    }
    let json
    try {
      json = JSON.parse(raw)
    } catch (error) {
      throw new MiraError('model/broken', 'model3.json 不是合法 JSON：' + model.model3 + '（' + (error?.message || error) + '）',
        '重新导出/复制模型文件；入口 JSON 损坏时模型无法加载')
    }
    return { model, json }
  }

  /**
   * 解析模型能力 + 资源诊断。
   * @returns {{model:string,entry:string,dir:string,model3:string,expressions:string[],
   *   motions:string[],expressionFiles:Array, motionFiles:Array, missing:Array,
   *   coreMissing:Array, fileRefs:object}}
   */
  capabilities(name) {
    const { model, json } = this.readModel3(name)
    const refs = json && json.FileReferences && typeof json.FileReferences === 'object'
      ? json.FileReferences
      : {}

    const missing = []
    const expressionFiles = []
    const motionFiles = []

    // 核心：moc + 贴图。缺了模型肯定加载不了，单独标 coreMissing。
    const moc = typeof refs.Moc === 'string' && refs.Moc.trim() !== ''
      ? ref(model.dir, refs.Moc, 'moc')
      : { kind: 'moc', file: '', path: null, exists: false, name: 'Moc' }
    if (!moc.exists) missing.push(moc)

    const textures = Array.isArray(refs.Textures) ? refs.Textures : []
    if (textures.length === 0) {
      missing.push({ kind: 'texture', file: '', path: null, exists: false })
    } else {
      for (const texture of textures) {
        const item = ref(model.dir, texture, 'texture')
        if (!item.exists) missing.push(item)
      }
    }

    for (const [kind, value] of [['physics', refs.Physics], ['pose', refs.Pose]]) {
      if (typeof value === 'string' && value.trim() !== '') {
        const item = ref(model.dir, value, kind)
        if (!item.exists) missing.push(item)
      } else if (value !== undefined && value !== null && typeof value !== 'string') {
        missing.push({ kind, file: '', path: null, exists: false })
      }
    }

    const expressions = []
    const expressionList = Array.isArray(refs.Expressions) ? refs.Expressions : []
    for (const item of expressionList) {
      if (!item || typeof item !== 'object') continue
      const exprName = typeof item.Name === 'string' ? item.Name : ''
      if (exprName) expressions.push(exprName)
      const file = typeof item.File === 'string' ? item.File : ''
      const detail = ref(model.dir, file, 'expression', { name: exprName || '(未命名)' })
      expressionFiles.push(detail)
      if (!detail.exists) missing.push(detail)
    }

    const motions = []
    const motionGroups = refs.Motions && typeof refs.Motions === 'object' ? refs.Motions : {}
    for (const group of Object.keys(motionGroups).sort()) {
      motions.push(group)
      const rawList = motionGroups[group]
      const list = Array.isArray(rawList) ? rawList : []
      if (list.length === 0) {
        // 组存在但没有任何文件：不能假装可播放（前端 model.motion() 会静默失败）。
        const detail = { kind: 'motion', file: '', group, index: motionFiles.length, exists: false }
        motionFiles.push(detail)
        missing.push(detail)
        continue
      }
      for (const item of list) {
        if (!item || typeof item !== 'object') continue
        const file = typeof item.File === 'string' ? item.File : ''
        const detail = ref(model.dir, file, 'motion', { group, index: motionFiles.length })
        motionFiles.push(detail)
        if (!detail.exists) missing.push(detail)
      }
    }

    for (const item of missing) {
      item.hint = hintForMissing(item, model.dir, model.model3)
      if (item.kind === 'texture' && item.file === '') item.hint = 'model3.json 的 FileReferences.Textures 为空：请把贴图路径写回去'
      if (item.kind === 'moc' && item.file === '') item.hint = 'model3.json 的 FileReferences.Moc 为空：请把 moc3 路径写回去'
      if (item.kind === 'expression' && item.file === '') {
        item.hint = 'model3.json 的 FileReferences.Expressions 里 ' + JSON.stringify(item.name)
          + ' 没有 File：补上表情文件路径，或删掉该条'
      }
      if (item.kind === 'motion' && item.file === '') {
        item.hint = 'model3.json 的 FileReferences.Motions.' + (item.group ?? '?')
          + ' 没有任何动作文件：补上 File 或删掉该组'
      }
    }

    const coreMissing = missing.filter((item) => CORE_KINDS.has(item.kind))

    return {
      model: model.name,
      entry: model.entry,
      dir: model.dir,
      model3: model.model3,
      expressions,
      motions,
      expressionFiles,
      motionFiles,
      missing,
      coreMissing,
      fileRefs: refs,
    }
  }

  /** 当前模型下确认某个表情存在且文件齐；否则抛错（指出缺哪个文件）。 */
  requireExpression(name, modelName) {
    const caps = this.capabilities(modelName)
    const wanted = String(name ?? '')
    if (!caps.expressions.includes(wanted)) {
      throw new MiraError(
        'model/not-found',
        '模型 ' + modelName + ' 没有表情：' + wanted + '（可用：' + (caps.expressions.join('、') || '（无）') + '）',
        '用 mira_get_model_capabilities 查看表情清单；表情来自 ' + caps.model3 + ' 的 FileReferences.Expressions',
      )
    }
    const entry = caps.expressionFiles.find((item) => item.name === wanted)
    if (entry && !entry.exists) {
      throw new MiraError(
        'resource/missing',
        '表情文件缺失：' + (entry.file || '(空)') + '（模型 ' + modelName + ' 引用了它）',
        entry.hint,
      )
    }
    return { caps, entry }
  }

  /** 当前模型下确认动作组存在且文件齐；否则抛错。 */
  requireMotion(group, modelName) {
    const caps = this.capabilities(modelName)
    const wanted = String(group ?? '')
    if (!caps.motions.includes(wanted)) {
      throw new MiraError(
        'model/not-found',
        '模型 ' + modelName + ' 没有动作组：' + wanted + '（可用：' + (caps.motions.join('、') || '（无）') + '）',
        '用 mira_get_model_capabilities 查看动作清单；动作来自 ' + caps.model3 + ' 的 FileReferences.Motions',
      )
    }
    const entries = caps.motionFiles.filter((item) => item.group === wanted)
    const broken = entries.find((item) => !item.exists)
    if (broken) {
      throw new MiraError(
        'resource/missing',
        '动作文件缺失：' + (broken.file || '(空)') + '（模型 ' + modelName + ' 的 ' + wanted + ' 动作组引用了它）',
        broken.hint,
      )
    }
    return { caps, entries }
  }

  /** 扫描背景图（imageDir 顶层图片）。目录缺失/没图都报出绝对路径。 */
  backgrounds() {
    this._assertDir(this.imageDir, 'imageDir', '背景图目录')
    let entries
    try {
      entries = readdirSync(this.imageDir, { withFileTypes: true })
    } catch (error) {
      throw new MiraError('config/missing', '背景图目录不可读：' + this.imageDir + '（' + (error?.message || error) + '）',
        '检查目录权限；或在 ' + this.configFile + ' 里改 imageDir')
    }
    const images = []
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile()) continue
      if (!IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue
      images.push({
        name: entry.name,
        path: join(this.imageDir, entry.name),
        url: '/live2d/backgrounds/' + encodeURIComponent(entry.name),
      })
    }
    if (images.length === 0) {
      throw new MiraError(
        'config/missing',
        '背景图目录里没有图片：' + this.imageDir,
        '把 png/jpg/jpeg/webp/gif 放进 ' + this.imageDir + '，或在 ' + this.configFile + ' 里改 imageDir',
      )
    }
    return { dir: this.imageDir, images }
  }

  /** 解析一张背景图；name 为空返回 null（清空背景）。 */
  resolveBackground(name) {
    const wanted = typeof name === 'string' ? name.trim() : ''
    if (wanted === '') return null
    const full = safeJoin(this.imageDir, wanted)
    if (!full || !isFile(full) || !IMAGE_EXTENSIONS.has(extname(full).toLowerCase())) {
      const shown = full || join(this.imageDir, wanted)
      throw new MiraError(
        'config/missing',
        '背景图不存在或不是图片：' + shown,
        '把图片放到 ' + this.imageDir + '，或在 ' + this.configFile + ' 里改 imageDir；用 mira_list_assets 查看已有背景',
      )
    }
    return {
      name: wanted,
      path: full,
      url: '/live2d/backgrounds/' + wanted.split('/').map(encodeURIComponent).join('/'),
    }
  }

  /** 扫描结果 + 诊断（mira_list_assets 用）。 */
  assets({ expected = '' } = {}) {
    const scan = this.scanModels({ diagnose: true, expected })
    return okObj({
      modelsDir: this.modelsDir,
      imageDir: this.imageDir,
      models: scan.models.map((model) => ({
        name: model.name,
        entry: model.entry,
        model3: model.model3,
        expressions: model.expressions ?? [],
        motions: model.motions ?? [],
        missing: model.missing ?? [],
        missingCount: model.missingCount ?? 0,
        coreMissing: model.coreMissing ?? [],
        error: model.error ?? null,
      })),
    })
  }
}

/** 便于自检/其它模块判断：这个诊断条目是否让模型无法加载。 */
export function isCoreMissing(entry) {
  return CORE_KINDS.has(entry?.kind)
}
