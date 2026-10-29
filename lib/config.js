/**
 * mira_live2d / config.js —— 配置读取、schemaVersion 与默认目录
 *
 * 落盘：`$DSH_HOME/mira_config/mira_live2d/config.json`（schemaVersion = 2）。
 *
 * 优先级（后者覆盖前者）：
 *   DEFAULTS  <  config.json  <  profile 里的插件 config（旧位置，兼容用）
 *
 * 为什么还认 profile config：老用户按旧 README 把 `model` / `tts` 写在
 * `cordis.patch.yml` 里；直接不认会让升级后看板娘静默消失。profile 覆盖是
 * **显式**输入，不是自动探测；新配置请写 config.json（README「迁移」）。
 *
 * 目录为空时的默认值（任务书功能点8，README 里写明）：
 *   modelsDir = $DSH_HOME/mira_config/mira_live2d/model
 *   imageDir  = $DSH_HOME/mira_config/mira_live2d/image
 *   mediaDir  = $DSH_HOME/mira_config/mira_live2d/media   （截图落盘）
 * 相对路径按 baseDir 解析；其余「必备项」为空一律 config/missing，不猜。
 *
 * 热加载：每次 `current()` 先比较 config.json 的 mtime/size，变了就重读；
 * 因此改目录 / 模型名 / TTS / 背景目录无需重启。`enabled` 只在加载时生效
 * （要停用请重载插件），README 已写明。
 */

import { statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  MiraError, checkSchema, deepMerge, miraConfigDir, readJsonStrict,
} from './kit.mjs'

/** 配置文件版本；不兼容改动时 +1，并在 README「迁移」写转换方式。 */
export const CONFIG_SCHEMA = 2

export const DEFAULTS = {
  schemaVersion: CONFIG_SCHEMA,
  /** 总开关：false 时插件不注册路由/工具（只在加载时判断）。 */
  enabled: true,
  /** 初始模型名（modelsDir 下的目录名）。留空 = 不指定，需显式切换。 */
  model: '',
  /** 模型根目录；空 = baseDir/model。 */
  modelsDir: '',
  /** 背景图根目录；空 = baseDir/image。 */
  imageDir: '',
  canvas: { w: 480, h: 630 },
  /** 初始位置 'left' | 'right'。 */
  position: 'right',
  /** 移动端初始缩放百分比。 */
  mobileScale: 55,
  showHint: true,
  pollIntervalMs: 1500,
  shot: {
    /** 截图落盘目录；空 = baseDir/media。 */
    mediaDir: '',
    /** 工具等待前端回传的最长时间（毫秒）。 */
    timeoutMs: 4000,
    /** 单张截图解码后的字节上限（默认 16 MiB）。 */
    maxBytes: 16 * 1024 * 1024,
  },
  tts: {
    enabled: false,
    /** 'openai' | 'aliyun'（'alibaba' 作为旧别名接受）。 */
    provider: 'openai',
    /** 留空 = 供应商默认地址（README 有表）。 */
    base: '',
    /** 留空 = 供应商默认模型。 */
    model: '',
    /** 留空 = 供应商默认音色。 */
    voice: '',
    maxChars: 600,
    timeoutMs: 15000,
  },
  persona: {
    thinking: { expression: '', bubble: '' },
    awaiting: { expression: '', bubble: '' },
    idleClearMs: 3200,
  },
}

export const TTS_PROVIDERS = {
  openai: {
    base: 'https://api.openai.com/v1',
    model: 'tts-1',
    voice: 'alloy',
    docs: 'https://platform.openai.com/docs/guides/text-to-speech',
  },
  aliyun: {
    base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-tts',
    voice: 'Chelsie',
    docs: 'https://help.aliyun.com/zh/model-studio/qwen-tts',
  },
}

const PROVIDER_ALIASES = {
  alibaba: 'aliyun',
  ali: 'aliyun',
  dashscope: 'aliyun',
  openai: 'openai',
  aliyun: 'aliyun',
}

/** 本次加载的配置文件名（动态取，便于自检改 DSH_HOME）。 */
export function configFile(baseDir = miraConfigDir('mira_live2d')) {
  return join(baseDir, 'config.json')
}

/** 凭据文件（600，永不回显）。 */
export function credsFile(baseDir = miraConfigDir('mira_live2d')) {
  return join(baseDir, 'creds', 'tts.json')
}

function clampInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function resolveDir(value, baseDir, fallbackName) {
  if (typeof value === 'string' && value.trim() !== '') {
    return resolve(baseDir, value.trim())
  }
  return join(baseDir, fallbackName)
}

export function normalizeProvider(value, baseDir = miraConfigDir('mira_live2d')) {
  const key = String(value ?? '').trim().toLowerCase()
  const provider = PROVIDER_ALIASES[key]
  if (!provider) {
    throw new MiraError(
      'config/invalid',
      'TTS provider 不支持：' + JSON.stringify(value) + '（只支持 openai / aliyun）',
      '在 ' + configFile(baseDir) + ' 的 tts.provider 填 openai 或 aliyun；旧值 alibaba 会被当作 aliyun',
    )
  }
  return provider
}

/** 把任意来源的配置规整成运行期形状（目录全部解析成绝对路径）。 */
export function normalizeConfig(raw, { baseDir = miraConfigDir('mira_live2d') } = {}) {
  const cfg = deepMerge(structuredClone(DEFAULTS), raw && typeof raw === 'object' ? raw : {})

  cfg.modelsDir = resolveDir(cfg.modelsDir, baseDir, 'model')
  cfg.imageDir = resolveDir(cfg.imageDir, baseDir, 'image')
  cfg.shot = cfg.shot && typeof cfg.shot === 'object' ? cfg.shot : {}
  cfg.shot.mediaDir = resolveDir(cfg.shot.mediaDir, baseDir, 'media')
  cfg.shot.timeoutMs = clampInt(cfg.shot.timeoutMs, DEFAULTS.shot.timeoutMs, 500, 30_000)
  cfg.shot.maxBytes = clampInt(cfg.shot.maxBytes, DEFAULTS.shot.maxBytes, 1024, 64 * 1024 * 1024)

  cfg.canvas = cfg.canvas && typeof cfg.canvas === 'object' ? cfg.canvas : {}
  cfg.canvas.w = clampInt(cfg.canvas.w, DEFAULTS.canvas.w, 1, 4096)
  cfg.canvas.h = clampInt(cfg.canvas.h, DEFAULTS.canvas.h, 1, 4096)
  cfg.mobileScale = clampInt(cfg.mobileScale, DEFAULTS.mobileScale, 25, 300)
  cfg.pollIntervalMs = clampInt(cfg.pollIntervalMs, DEFAULTS.pollIntervalMs, 250, 60_000)
  cfg.position = cfg.position === 'left' ? 'left' : 'right'
  cfg.showHint = cfg.showHint !== false

  cfg.tts = cfg.tts && typeof cfg.tts === 'object' ? cfg.tts : {}
  cfg.tts.provider = normalizeProvider(cfg.tts.provider, baseDir)
  cfg.tts.maxChars = clampInt(cfg.tts.maxChars, DEFAULTS.tts.maxChars, 1, 2000)
  cfg.tts.timeoutMs = clampInt(cfg.tts.timeoutMs, DEFAULTS.tts.timeoutMs, 1000, 120_000)
  cfg.tts.enabled = cfg.tts.enabled === true

  cfg.persona = cfg.persona && typeof cfg.persona === 'object' ? cfg.persona : {}
  cfg.model = typeof cfg.model === 'string' ? cfg.model.trim() : ''

  cfg.baseDir = baseDir
  cfg.configFile = configFile(baseDir)
  cfg.credsFile = credsFile(baseDir)
  return cfg
}

/**
 * 配置仓库：读 config.json + 校验 schemaVersion + 热加载 + 旧位置覆盖。
 *
 * `load()` 永不抛：返回 `{ ok, error? }`，并把可安全兜底的配置放进
 * `this.config`（默认值 + profile 覆盖）。`current()` 在有错误时抛 MiraError，
 * 让所有需要配置的工具统一返回 `{ok:false,error}`（不静默用坏配置）。
 */
export class ConfigStore {
  constructor({ baseDir = miraConfigDir('mira_live2d'), profileConfig = {}, logger = null, counters = null } = {}) {
    this.baseDir = baseDir
    this.profileConfig = profileConfig && typeof profileConfig === 'object' ? profileConfig : {}
    this.logger = logger
    this.counters = counters
    this.file = configFile(baseDir)
    this.error = null
    this.warnings = []
    this.legacyTtsKey = false
    this.schemaVersion = CONFIG_SCHEMA
    this._stamp = null
    this._fileConfig = {}
    // profile 里 provider 写错时不能让构造函数把插件加载整个炸掉：
    // 回到默认配置，并把错误留给 load()/current() 统一报 config/invalid。
    try {
      this.config = normalizeConfig(this.profileConfig, { baseDir })
    } catch (error) {
      this.config = normalizeConfig({}, { baseDir })
      this.error = {
        code: error?.code || 'config/invalid',
        message: error?.message || String(error),
        hint: error?.hint || ('检查 ' + configFile(baseDir) + ' 的配置项（README 有完整配置表）'),
      }
    }
  }

  load() {
    this.error = null
    this.warnings = []
    this.legacyTtsKey = false
    this.legacyTtsKeyEnv = false
    this.profileRejected = false

    const profile = this.profileConfig
    if (profile.schemaVersion !== undefined && profile.schemaVersion !== CONFIG_SCHEMA) {
      this.profileRejected = true
      this.error = {
        code: 'config/schema',
        message: 'profile 里的 mira_live2d.schemaVersion=' + JSON.stringify(profile.schemaVersion)
          + '，本代码要求 ' + CONFIG_SCHEMA,
        hint: '按 README「迁移」把配置搬到 ' + this.file + '（schemaVersion=' + CONFIG_SCHEMA + '），或删掉 profile 里的 schemaVersion；不会静默兼容。',
      }
    }

    let fileConfig = {}
    const strict = readJsonStrict(this.file)
    if (strict.ok) {
      const checked = checkSchema(strict.value, CONFIG_SCHEMA, this.file)
      if (!checked.ok) {
        // kit.checkSchema 返回 { ok:false, error: fail(...) }；这里要取里面的 error 本体。
        this.error = this.error || (checked.error && checked.error.error ? checked.error.error : checked.error)
      } else {
        fileConfig = strict.value
      }
      this._stamp = this._statStamp()
    } else if (strict.reason === 'missing') {
      this._stamp = null
    } else {
      this.error = this.error || {
        code: 'config/invalid',
        message: '配置文件无法读取或不是 JSON 对象：' + this.file
          + (strict.reason === 'corrupt' && strict.detail ? '（' + strict.detail + '）' : ''),
        hint: '修好 ' + this.file + '（参照 README 的配置表），或先备份后删除它让插件回到默认值；不会静默兼容。',
      }
      this._stamp = this._statStamp()
    }

    // 旧位置的 tts.key：凭据必须落在 creds/tts.json（600），这里只警告、绝不使用。
    if (hasOwn(fileConfig, 'tts') && fileConfig.tts && typeof fileConfig.tts.key === 'string' && fileConfig.tts.key.trim() !== '') {
      this.legacyTtsKey = true
    }
    if (hasOwn(profile, 'tts') && profile.tts && typeof profile.tts.key === 'string' && profile.tts.key.trim() !== '') {
      this.legacyTtsKey = true
    }
    if ((hasOwn(fileConfig, 'tts') && fileConfig.tts && typeof fileConfig.tts.keyEnv === 'string' && fileConfig.tts.keyEnv.trim() !== '')
      || (hasOwn(profile, 'tts') && profile.tts && typeof profile.tts.keyEnv === 'string' && profile.tts.keyEnv.trim() !== '')) {
      this.legacyTtsKeyEnv = true
    }
    if (this.legacyTtsKey) {
      this.warnings.push('检测到旧配置 tts.key：凭据必须放到 ' + credsFile(this.baseDir)
        + '（权限 600），tts.key 已被忽略；见 README「迁移」')
    }
    if (this.legacyTtsKeyEnv) {
      this.warnings.push('检测到旧配置 tts.keyEnv：凭据必须放到 ' + credsFile(this.baseDir)
        + '（权限 600），tts.keyEnv 已被忽略；见 README「迁移」')
    }

    // 优先级：DEFAULTS < profile（旧位置，兼容）< config.json（权威）。
    // 坏文件/坏 profile 都拒绝使用对应那一层；这样 config.json 改一个字段
    // 不会被 profile 里的旧值盖回去。
    const profilePart = this.profileRejected ? {} : stripSchemaVersion(this.profileConfig)
    const filePart = this.error ? {} : fileConfig
    const merged = deepMerge(deepMerge(structuredClone(DEFAULTS), profilePart), filePart)

    try {
      this.config = normalizeConfig(merged, { baseDir: this.baseDir })
      this._fileConfig = fileConfig
    } catch (error) {
      // provider 写错这类异常也在 load 阶段转成结构化错误，留给 current() 抛。
      this.error = this.error || {
        code: error?.code || 'config/invalid',
        message: error?.message || String(error),
        hint: error?.hint || '检查 ' + this.file + ' 的配置项（README 有完整配置表）',
      }
      this._fileConfig = fileConfig
    }

    if (this.error) {
      this.logger?.warn?.('[mira_live2d] 配置不可用（' + this.error.code + '）：' + this.error.message)
    }
    for (const warning of this.warnings) this.logger?.warn?.('[mira_live2d] ' + warning)

    return { ok: !this.error, error: this.error ?? null, warnings: this.warnings.slice() }
  }

  /** 配置变了（mtime/size）就重读；每次工具调用/HTTP 配置请求都会走这里。 */
  current() {
    this.reloadIfChanged()
    if (this.error) throw new MiraError(this.error.code, this.error.message, this.error.hint)
    return this.config
  }

  /** 给路由/前端用的兜底配置（配置坏时仍能回一份可展出的 JSON）。 */
  get fallback() {
    return this.config
  }

  reloadIfChanged() {
    const stamp = this._statStamp()
    if (stamp === this._stamp) return false
    this.load()
    return true
  }

  _statStamp() {
    try {
      const st = statSync(this.file)
      return String(st.mtimeMs) + ':' + String(st.size)
    } catch {
      return null
    }
  }

  status() {
    return {
      file: this.file,
      baseDir: this.baseDir,
      schemaVersion: CONFIG_SCHEMA,
      loaded: !this.error,
      error: this.error,
      warnings: this.warnings.slice(),
      legacyTtsKey: this.legacyTtsKey,
      legacyTtsKeyEnv: this.legacyTtsKeyEnv,
      modelsDir: this.config.modelsDir,
      imageDir: this.config.imageDir,
      mediaDir: this.config.shot?.mediaDir,
    }
  }
}

function hasOwn(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key)
}

function stripSchemaVersion(config) {
  if (!config || typeof config !== 'object') return {}
  const out = { ...config }
  delete out.schemaVersion
  return out
}
