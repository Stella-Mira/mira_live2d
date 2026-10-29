/**
 * mira_live2d / tts.js —— OpenAI / 阿里云（DashScope 兼容模式）TTS
 *
 * 两个供应商都走 OpenAI 兼容的 `POST {base}/audio/speech`：
 *   openai  https://api.openai.com/v1                       model=tts-1     voice=alloy
 *   aliyun  https://dashscope.aliyuncs.com/compatible-mode/v1 model=qwen-tts voice=Chelsie
 * 不引入任何 SDK；只用 node 内置 fetch + AbortSignal。
 *
 * 凭据纪律（任务书约定8 / 硬约束8）：
 *   - key **只**从 `$DSH_HOME/mira_config/mira_live2d/creds/tts.json`（权限 600）读取；
 *   - 绝不回显、绝不进日志、绝不进工具返回值（status() 只报配没配/哪个供应商）；
 *   - 旧位置的 tts.key / tts.keyEnv 一律忽略并提示迁移（凭据必须落 600 文件）。
 *
 * 未配置时的明确提示（功能点10 / G5）：抛 config/missing，message 说清是没启用
 * 还是没 key，hint 指到具体文件与字段。
 */

import { join } from 'node:path'

import {
  MiraError, checkSchema, fileMode, readJsonStrict,
} from './kit.mjs'
import { TTS_PROVIDERS } from './config.js'

export const CREDS_SCHEMA = 1

// 供应商默认值只维护一份（config.js），避免 README/工具/额度三处漂移。
const PROVIDER_DEFAULTS = TTS_PROVIDERS

const PROVIDER_ALIASES = {
  openai: 'openai',
  aliyun: 'aliyun',
  alibaba: 'aliyun',
  ali: 'aliyun',
  dashscope: 'aliyun',
}

/** 凭据文件路径（动态取 baseDir，便于自检隔离 DSH_HOME）。 */
export function ttsCredsFile(baseDir) {
  return join(baseDir, 'creds', 'tts.json')
}

function normalizeProvider(value) {
  return PROVIDER_ALIASES[String(value ?? '').trim().toLowerCase()] || null
}

function modeLabel(mode) {
  return mode === -1 ? null : '0o' + mode.toString(8)
}

function redact(text, secret) {
  let out = String(text ?? '')
  if (secret) out = out.split(secret).join('***')
  // 形如 Authorization: Bearer xxx 的片段也抹掉，防止供应商把请求头回显进报错。
  out = out.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ***')
  return out.slice(0, 300)
}

export class TtsService {
  /**
   * @param {object} options
   * @param {object} options.config      规整后的 cfg.tts（provider/base/model/voice/enabled/...）
   * @param {string} options.baseDir     $DSH_HOME/mira_config/mira_live2d
   * @param {string} options.configFile  config.json 绝对路径（hint 用）
   * @param {object} [options.logger]
   * @param {object} [options.counters]
   * @param {Function} [options.fetchImpl] 自检可注入假 fetch
   */
  constructor({ config, baseDir, configFile, logger = null, counters = null, fetchImpl = null }) {
    this.config = config && typeof config === 'object' ? config : {}
    this.baseDir = baseDir
    this.configFile = configFile
    this.logger = logger
    this.counters = counters
    this.fetchImpl = fetchImpl || ((...args) => globalThis.fetch(...args))
    this.credsFile = ttsCredsFile(baseDir)
  }

  get provider() {
    return normalizeProvider(this.config.provider) || 'openai'
  }

  /** 读凭据文件；坏文件/版本不匹配转成结构化错误（不含内容）。 */
  readCreds() {
    const strict = readJsonStrict(this.credsFile)
    if (strict.reason === 'missing') return { ok: true, value: null, mode: -1 }
    if (!strict.ok) {
      return {
        ok: false,
        error: {
          code: 'creds/missing',
          message: 'TTS 凭据文件不可读或不是 JSON 对象：' + this.credsFile
            + (strict.reason === 'corrupt' && strict.detail ? '（' + strict.detail + '）' : ''),
          hint: '修好 ' + this.credsFile + '（{"schemaVersion":1,"provider":"openai","apiKey":"..."}，权限 600），或删除后按 README 重建',
        },
      }
    }
    const checked = checkSchema(strict.value, CREDS_SCHEMA, this.credsFile)
    if (!checked.ok) return { ok: false, error: checked.error && checked.error.error ? checked.error.error : checked.error }
    const rawProvider = typeof strict.value.provider === 'string' ? strict.value.provider.trim() : ''
    if (rawProvider !== '' && !normalizeProvider(rawProvider)) {
      return {
        ok: false,
        error: {
          code: 'config/invalid',
          message: 'TTS 凭据文件里的 provider 不支持：' + JSON.stringify(rawProvider) + '（只支持 openai / aliyun）',
          hint: '把 ' + this.credsFile + ' 的 provider 改成 openai 或 aliyun；旧值 alibaba 视作 aliyun',
        },
      }
    }
    const mode = fileMode(this.credsFile)
    if (mode !== -1 && mode !== 0o600 && !warnedCredsMode.has(this.credsFile)) {
      warnedCredsMode.add(this.credsFile)
      // 只报路径与权限位，不碰内容；每个文件只警告一次（TtsService 是每次调用新建的）。
      this.logger?.warn?.('[mira_live2d] ' + this.credsFile + ' 权限是 ' + mode.toString(8)
        + '，凭据文件应为 600（chmod 600 ' + this.credsFile + '）')
    }
    return { ok: true, value: strict.value, mode }
  }

  /** 内部用：解析出完整参数（含 key）。任何公开返回值都不许带 key。 */
  _resolve() {
    if (this.config.enabled !== true) {
      throw new MiraError(
        'config/missing',
        'TTS 未启用：tts.enabled=false，模型无法朗读',
        '在 ' + this.configFile + ' 里把 tts.enabled 改成 true，并按 README 配好 ' + this.credsFile,
      )
    }

    const provider = this.provider
    const defaults = PROVIDER_DEFAULTS[provider]
    const creds = this.readCreds()
    if (!creds.ok) {
      throw new MiraError(creds.error.code, creds.error.message, creds.error.hint)
    }

    const credsValue = creds.value || {}
    const credsProvider = normalizeProvider(credsValue.provider)
    const effectiveProvider = credsProvider || provider
    const effectiveDefaults = PROVIDER_DEFAULTS[effectiveProvider]

    const fileKey = typeof credsValue.apiKey === 'string' ? credsValue.apiKey.trim() : ''
    const key = fileKey
    const keySource = fileKey ? 'creds' : 'none'
    const legacyKey = typeof this.config.key === 'string' && this.config.key.trim() !== ''
    const legacyKeyEnv = typeof this.config.keyEnv === 'string' && this.config.keyEnv.trim() !== ''

    if (!key) {
      throw new MiraError(
        'config/missing',
        'TTS 未配置：缺少 API key（provider=' + effectiveProvider + '）'
          + (legacyKey ? '；旧的 tts.key 已废弃并被忽略' : '')
          + (legacyKeyEnv ? '；旧的 tts.keyEnv 也已废弃（凭据必须落 600 文件）' : ''),
        '把 key 写进 ' + this.credsFile
          + '（{"schemaVersion":1,"provider":"' + effectiveProvider + '","apiKey":"..."}，chmod 600）'
          + (legacyKey ? '；然后删掉旧配置里的 tts.key' : '')
          + (legacyKeyEnv ? '；keyEnv 的环境变量值也搬进这个文件' : ''),
      )
    }

    return {
      provider: effectiveProvider,
      base: String(this.config.base || effectiveDefaults.base).replace(/\/+$/, ''),
      model: String(this.config.model || effectiveDefaults.model),
      voice: String(this.config.voice || effectiveDefaults.voice),
      key,
      keySource,
      legacyKey,
    }
  }

  /**
   * 只读状态：配没配、哪个供应商、key 从哪来。
   * **绝不包含 key 本体**；凭据文件坏了也只报文件名与错误码。
   */
  status() {
    const provider = this.provider
    const creds = this.readCreds()
    const credsValue = creds.ok ? (creds.value || {}) : {}
    const credsProvider = normalizeProvider(credsValue.provider)
    const effectiveProvider = credsProvider || provider
    const defaults = PROVIDER_DEFAULTS[effectiveProvider]
    const fileKey = typeof credsValue.apiKey === 'string' ? credsValue.apiKey.trim() : ''
    const keySource = fileKey ? 'creds' : 'none'
    const legacyKey = typeof this.config.key === 'string' && this.config.key.trim() !== ''
    const legacyKeyEnv = typeof this.config.keyEnv === 'string' && this.config.keyEnv.trim() !== ''
    // 凭据文件坏了就等同「未配好」：_resolve() 会拒绝，status 不能报 configured=true。
    const configured = creds.ok && keySource !== 'none'
    const status = {
      ok: true,
      enabled: this.config.enabled === true,
      provider: effectiveProvider,
      configured,
      keySource,
      legacyKeyIgnored: legacyKey,
      legacyKeyEnvIgnored: legacyKeyEnv,
      credsFile: this.credsFile,
      credsMode: creds.ok ? modeLabel(creds.mode) : null,
      credsModeOk: creds.ok ? creds.mode === 0o600 : false,
      configFile: this.configFile,
      base: String(this.config.base || defaults.base).replace(/\/+$/, ''),
      model: String(this.config.model || defaults.model),
      voice: String(this.config.voice || defaults.voice),
      maxChars: this.config.maxChars,
    }
    if (!creds.ok) status.credsError = creds.error
    if (!configured) {
      status.hint = this.missingHint(legacyKey, legacyKeyEnv, creds.error)
    } else if (this.config.enabled !== true) {
      status.hint = 'TTS 已配好 key，但 tts.enabled=false；在 ' + this.configFile + ' 把 tts.enabled 改成 true'
    }
    return status
  }

  missingHint(legacyKey = false, legacyKeyEnv = false, credsError = null) {
    if (credsError) return credsError.hint
    return '把 key 写进 ' + this.credsFile
      + '（{"schemaVersion":1,"provider":"' + this.provider + '","apiKey":"..."}，chmod 600）；启用还要把 tts.enabled 改成 true'
      + (legacyKey ? '；旧的 tts.key 已废弃，请迁移到 creds 文件' : '')
      + (legacyKeyEnv ? '；旧的 tts.keyEnv 已废弃，环境变量值也请搬进 creds 文件' : '')
  }

  /** 未配置时就抛 config/missing（G5：按钮可见，点了给明确提示）。 */
  requireReady() {
    return this._resolve()
  }

  /**
   * 合成语音。返回 { mime, base64, bytes, provider, model, voice }（不含 key）。
   * 网络/供应商错误 → tts/failed，detail 已抹掉 key。
   */
  async synthesize(text, { signal = null, timeoutMs = null } = {}) {
    const resolved = this._resolve()
    const maxChars = this.config.maxChars || 600
    const raw = String(text ?? '')
    // 按 code point 截断：直接 slice(0, maxChars) 会把 emoji 的代理对劈成半个字符，
    // 发给供应商的是非法 UTF-16。截断事实要回报给调用方（truncated/chars），不许静默。
    const codePoints = Array.from(raw)
    const truncated = codePoints.length > maxChars
    const input = truncated ? codePoints.slice(0, maxChars).join('') : raw
    if (input.trim() === '') {
      throw new MiraError('tts/failed', '朗读文本为空', '传 text（1–' + maxChars + ' 字符）')
    }

    if (typeof this.fetchImpl !== 'function') {
      throw new MiraError('tts/failed', '当前 Node 没有可用的 fetch，无法调用 TTS', '升级到 Node 18+；或改用其它宿主')
    }

    const controller = new AbortController()
    const ms = Number(timeoutMs ?? this.config.timeoutMs ?? 15000)
    const timer = setTimeout(() => controller.abort(new Error('TTS 请求超时')), Math.max(1000, ms))
    if (typeof timer.unref === 'function') timer.unref()
    const combined = signal && typeof AbortSignal?.any === 'function'
      ? AbortSignal.any([signal, controller.signal])
      : (signal || controller.signal)

    let resp
    try {
      resp = await this.fetchImpl(resolved.base + '/audio/speech', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + resolved.key,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: resolved.model,
          input,
          voice: resolved.voice,
          response_format: 'mp3',
        }),
        signal: combined,
      })
    } catch (error) {
      this.counters?.bump?.('tts.fail')
      throw new MiraError(
        'tts/failed',
        'TTS 请求失败：' + redact(error?.message || error, resolved.key),
        '检查网络、' + this.configFile + ' 的 tts.base 与 ' + this.credsFile + ' 的 key；mira_tts_status 可看当前供应商',
      )
    } finally {
      clearTimeout(timer)
    }

    if (!resp || resp.ok !== true) {
      const status = resp?.status ?? 0
      let detail = ''
      try {
        detail = resp && typeof resp.text === 'function' ? await resp.text() : ''
      } catch {
        detail = ''
      }
      this.counters?.bump?.('tts.fail')
      throw new MiraError(
        'tts/failed',
        'TTS 接口返回 ' + status + '：' + redact(detail.trim() || '(无响应体)', resolved.key),
        '检查 provider/base/model/voice 与 key 是否正确；' + this.credsFile + ' 权限应为 600；mira_tts_status 可看当前供应商',
      )
    }

    let buf
    try {
      buf = Buffer.from(await resp.arrayBuffer())
    } catch (error) {
      this.counters?.bump?.('tts.fail')
      throw new MiraError('tts/failed', 'TTS 响应读取失败：' + redact(error?.message || error, resolved.key),
        '重试；持续失败请检查供应商状态')
    }
    if (buf.length === 0) {
      this.counters?.bump?.('tts.fail')
      throw new MiraError('tts/failed', 'TTS 返回了 0 字节音频', '检查 tts.model / tts.voice 是否是供应商支持的组合')
    }

    this.counters?.bump?.('tts.ok')
    const contentType = typeof resp.headers?.get === 'function' ? resp.headers.get('content-type') : ''
    return {
      mime: contentType && contentType.startsWith('audio/') ? contentType.split(';')[0] : 'audio/mpeg',
      base64: buf.toString('base64'),
      bytes: buf.length,
      chars: codePoints.length > maxChars ? maxChars : codePoints.length,
      requestedChars: codePoints.length,
      truncated,
      provider: resolved.provider,
      model: resolved.model,
      voice: resolved.voice,
    }
  }
}
