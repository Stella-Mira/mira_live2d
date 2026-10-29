/**
 * mira_live2d / state.js —— 看板娘状态（显示与否 / 当前模型 / 表情动作 / 背景）
 *
 * 落盘：`$DSH_HOME/mira_config/mira_live2d/state.json`（schemaVersion = 1）。
 *
 * 为什么单独一个文件：
 *   - 「默认隐藏」是**状态**而非配置（任务书功能点1）；用户点了显示、刷新页面后
 *     应该保持显示，所以状态要落盘。
 *   - 前端每 5 秒会上报一次状态（模型/表情/动作/气泡）；只有与本文件相关的字段
 *     才会写盘，气泡、在线时间这类瞬时值只留在内存（避免每 5 秒写一次磁盘）。
 *
 * 约定9（热加载不丢内存状态）：单实例保护保证同一进程只有一个 StateStore 写
 * 这个文件；每次变更立即原子写，退场时再写一次（无变更不写）。schemaVersion
 * 不匹配 → 拒绝使用、拒绝覆盖原文件（保留用户数据），由工具返回 config/schema。
 */

import { join } from 'node:path'

import {
  MiraError, checkSchema, nowIso, readJsonStrict, writeJsonAtomic,
} from './kit.mjs'

export const STATE_SCHEMA = 1

export const STATE_DEFAULTS = {
  /** 任务书功能点1：默认隐藏。 */
  visible: false,
  /** 当前模型名（modelsDir 下的目录名）；空 = 未指定。 */
  model: '',
  /** 当前背景图（imageDir 下的文件名）；空 = 无背景。 */
  background: '',
  /** 当前开启的表情（互斥 + 叠加合并后的名字列表）。 */
  expressions: [],
  /** 最近一次播放的动作组。 */
  currentMotion: null,
  expressionsEnabled: true,
  animationsEnabled: true,
  /** 'thinking' | 'awaiting' | 'idle' */
  mood: 'idle',
}

const MOODS = new Set(['thinking', 'awaiting', 'idle'])
const PERSISTED_KEYS = [
  'visible', 'model', 'background', 'expressions', 'currentMotion',
  'expressionsEnabled', 'animationsEnabled', 'mood',
]

function str(value, max = 500) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function strList(value, maxItems = 50, maxLen = 200) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value.slice(0, maxItems)) {
    if (typeof item === 'string' && item.trim() !== '' && !out.includes(item.slice(0, maxLen))) {
      out.push(item.slice(0, maxLen))
    }
  }
  return out
}

function sanitize(raw) {
  const state = { ...STATE_DEFAULTS }
  if (!raw || typeof raw !== 'object') return state
  state.visible = bool(raw.visible, STATE_DEFAULTS.visible)
  state.model = str(raw.model)
  state.background = str(raw.background)
  state.expressions = strList(raw.expressions)
  state.currentMotion = typeof raw.currentMotion === 'string' && raw.currentMotion !== ''
    ? raw.currentMotion.slice(0, 200)
    : null
  state.expressionsEnabled = bool(raw.expressionsEnabled, STATE_DEFAULTS.expressionsEnabled)
  state.animationsEnabled = bool(raw.animationsEnabled, STATE_DEFAULTS.animationsEnabled)
  state.mood = MOODS.has(raw.mood) ? raw.mood : STATE_DEFAULTS.mood
  state.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : null
  return state
}

export class StateStore {
  constructor({ baseDir, logger = null, counters = null, now = () => Date.now() } = {}) {
    this.baseDir = baseDir
    this.file = join(baseDir, 'state.json')
    this.logger = logger
    this.counters = counters
    this.now = now
    this.error = null
    this.state = sanitize(null)
    this.clientState = null
    this.clientStateAt = 0
    this.dirty = false
  }

  /** 读盘。文件缺失 = 默认值（visible:false）；永不抛。 */
  load() {
    this.error = null
    const strict = readJsonStrict(this.file)
    if (strict.ok) {
      const checked = checkSchema(strict.value, STATE_SCHEMA, this.file)
      if (!checked.ok) {
        this.error = checked.error && checked.error.error ? checked.error.error : checked.error
      } else {
        this.state = sanitize(strict.value)
      }
    } else if (strict.reason !== 'missing') {
      this.error = {
        code: 'config/invalid',
        message: '状态文件无法读取或不是 JSON 对象：' + this.file
          + (strict.reason === 'corrupt' && strict.detail ? '（' + strict.detail + '）' : ''),
        hint: '修好或备份后删除 ' + this.file + ' 让状态回到默认（隐藏）；不会自动覆盖坏文件。',
      }
    }
    if (this.error) {
      this.logger?.warn?.('[mira_live2d] 状态不可用（' + this.error.code + '）：' + this.error.message)
    }
    return { ok: !this.error, error: this.error ?? null }
  }

  /** 当前状态副本；坏文件时抛 config/schema / config/invalid（拒绝使用）。 */
  get() {
    if (this.error) throw new MiraError(this.error.code, this.error.message, this.error.hint)
    return { ...this.state, expressions: this.state.expressions.slice() }
  }

  get fallback() {
    return sanitize(this.state)
  }

  /** 前端上报的瞬时状态（不进 state.json）。 */
  setClient(payload) {
    if (!payload || typeof payload !== 'object') return
    this.clientState = {
      visible: typeof payload.visible === 'boolean' ? payload.visible : undefined,
      model: typeof payload.model === 'string' ? payload.model.slice(0, 200) : undefined,
      currentExpression: typeof payload.currentExpression === 'string' ? payload.currentExpression.slice(0, 200) : undefined,
      currentMotion: typeof payload.currentMotion === 'string' ? payload.currentMotion.slice(0, 200) : undefined,
      stacked: Array.isArray(payload.stacked) ? strList(payload.stacked) : undefined,
      expressions: Array.isArray(payload.expressions) ? strList(payload.expressions, 100) : undefined,
      motions: Array.isArray(payload.motions) ? strList(payload.motions, 100) : undefined,
      expressionsEnabled: typeof payload.expressionsEnabled === 'boolean' ? payload.expressionsEnabled : undefined,
      animationsEnabled: typeof payload.animationsEnabled === 'boolean' ? payload.animationsEnabled : undefined,
      mood: MOODS.has(payload.mood) ? payload.mood : undefined,
      background: typeof payload.background === 'string' ? payload.background.slice(0, 500) : undefined,
      t: typeof payload.t === 'number' ? payload.t : this.now(),
    }
    // 未定义字段去掉，避免把 undefined 混进对外 JSON。
    for (const key of Object.keys(this.clientState)) {
      if (this.clientState[key] === undefined) delete this.clientState[key]
    }
    this.clientStateAt = this.now()
  }

  client() {
    return {
      data: this.clientState ? { ...this.clientState } : null,
      at: this.clientStateAt || null,
      msAgo: this.clientStateAt ? this.now() - this.clientStateAt : null,
    }
  }

  /** 前端上报里可持久化的字段（模型/显隐/背景/表情/动作）合并进来。 */
  applyClient(payload) {
    if (!payload || typeof payload !== 'object') return { changed: false }
    const patch = {}
    if (typeof payload.visible === 'boolean') patch.visible = payload.visible
    if (typeof payload.model === 'string') patch.model = payload.model.slice(0, 200)
    if (typeof payload.background === 'string') patch.background = payload.background.slice(0, 500)
    if (Array.isArray(payload.expressions)) patch.expressions = strList(payload.expressions)
    if (typeof payload.currentMotion === 'string' || payload.currentMotion === null) patch.currentMotion = payload.currentMotion
    if (typeof payload.expressionsEnabled === 'boolean') patch.expressionsEnabled = payload.expressionsEnabled
    if (typeof payload.animationsEnabled === 'boolean') patch.animationsEnabled = payload.animationsEnabled
    if (MOODS.has(payload.mood)) patch.mood = payload.mood
    return this.set(patch)
  }

  setVisible(visible) {
    return this.set({ visible: !!visible })
  }

  setModel(model) {
    return this.set({ model: str(model, 200) })
  }

  setBackground(background) {
    return this.set({ background: str(background) })
  }

  setExpressions(expressions) {
    return this.set({ expressions: strList(expressions) })
  }

  setMotion(motion) {
    return this.set({ currentMotion: typeof motion === 'string' && motion !== '' ? motion.slice(0, 200) : null })
  }

  setExpressionsEnabled(enabled) {
    return this.set({ expressionsEnabled: !!enabled })
  }

  setAnimationsEnabled(enabled) {
    return this.set({ animationsEnabled: !!enabled })
  }

  setMood(mood) {
    if (!MOODS.has(mood)) throw new MiraError('config/invalid', 'mood 只能是 thinking / awaiting / idle', '传 thinking、awaiting 或 idle')
    return this.set({ mood })
  }

  /**
   * 合并并落盘。只有值真的变了才写；写失败抛 state/write-failed（不静默丢状态）。
   * @returns {{changed:boolean, state:object}}
   */
  set(patch) {
    if (this.error) throw new MiraError(this.error.code, this.error.message, this.error.hint)
    if (!patch || typeof patch !== 'object') return { changed: false, state: this.get() }
    const next = { ...this.state }
    for (const key of PERSISTED_KEYS) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key]
    }
    const normalized = sanitize(next)
    const changed = PERSISTED_KEYS.some((key) => JSON.stringify(normalized[key]) !== JSON.stringify(this.state[key]))
    if (!changed) return { changed: false, state: this.get() }
    normalized.updatedAt = nowIso(this.now())
    const payload = { schemaVersion: STATE_SCHEMA, ...normalized }
    delete payload.updatedAt
    payload.updatedAt = normalized.updatedAt
    const ok = writeJsonAtomic(this.file, payload)
    if (!ok) {
      throw new MiraError(
        'state/write-failed',
        '状态写盘失败：' + this.file,
        '检查目录权限/磁盘空间；状态目录在 $DSH_HOME/mira_config/mira_live2d（可用 DSH_HOME 覆盖）',
      )
    }
    this.state = normalized
    this.dirty = false
    this.counters?.bump?.('state.write')
    return { changed: true, state: this.get() }
  }

  /** 退场时再写一次（无变更不写）。 */
  flush() {
    if (this.error) return false
    const payload = { schemaVersion: STATE_SCHEMA, ...this.state, updatedAt: nowIso(this.now()) }
    return writeJsonAtomic(this.file, payload)
  }

  status() {
    return {
      file: this.file,
      schemaVersion: STATE_SCHEMA,
      error: this.error,
      state: this.fallback,
      client: this.client(),
    }
  }
}
