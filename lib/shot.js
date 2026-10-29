/**
 * mira_live2d / shot.js —— 截图：前端 canvas.toDataURL() → POST /live2d/api/shot → 落盘
 *
 * 为什么是这条路（PLAN §3.11）：
 *   Live2D 模型渲染在浏览器 canvas 里，宿主进程没有渲染器。现有 `lib/index.js`
 *   通过 `ctx.webServer.register({kind:'prefix', path:'/live2d'})` 自带一个 HTTP
 *   端点（老代码的 `/live2d/api/*` 就走它），因此不需要 Playwright：前端把
 *   `canvas.toDataURL('image/png')` POST 上来，这里校验、解码、原子写入
 *   `shot.mediaDir`（默认 `$DSH_HOME/mira_config/mira_live2d/media`），返回绝对路径。
 *
 * 宿主没有可用上传端点时（webServer 没有 register / 测试里显式关闭），
 * `request()` 立刻返回 `{ok:false,error:{code:'platform/unsupported'}}`，
 * 不会静默留白，也不引入任何渲染依赖。
 *
 * 工具语义：`mira_screenshot` 下发 `screenshot` 指令（带 requestId），然后等前端
 * POST 回来；超时返回 `shot/unavailable` 并说明「页面没开 / 模型没显示」。
 */

import { renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ensureDir, fail, okObj } from './kit.mjs'

const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

const DATA_URL_RE = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\r\n]+)$/

function signatureOk(buf, mime) {
  if (mime === 'image/png') {
    return buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
  }
  if (mime === 'image/jpeg') {
    return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
  }
  if (mime === 'image/webp') {
    return buf.length >= 12
      && buf.toString('latin1', 0, 4) === 'RIFF'
      && buf.toString('latin1', 8, 12) === 'WEBP'
  }
  return false
}

function stamp(now) {
  const iso = new Date(now).toISOString() // 2026-10-27T08:00:00.000Z
  return iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

export class ShotService {
  constructor({
    mediaDir,
    config = {},
    logger = null,
    counters = null,
    endpointAvailable = true,
    now = () => Date.now(),
  }) {
    this.mediaDir = mediaDir
    this.maxBytes = Number(config.maxBytes) > 0 ? Number(config.maxBytes) : 16 * 1024 * 1024
    this.logger = logger
    this.counters = counters
    this.endpointAvailable = endpointAvailable !== false
    this.now = now
    this.waiters = new Map()
    this.lastShot = null
    this.seq = 0
  }

  setMediaDir(mediaDir) {
    if (typeof mediaDir === 'string' && mediaDir !== '') this.mediaDir = mediaDir
  }

  setMaxBytes(maxBytes) {
    const n = Number(maxBytes)
    if (Number.isFinite(n) && n >= 1024) this.maxBytes = Math.min(64 * 1024 * 1024, Math.round(n))
  }

  status() {
    return {
      endpointAvailable: this.endpointAvailable,
      mediaDir: this.mediaDir,
      maxBytes: this.maxBytes,
      pending: this.waiters.size,
      lastShot: this.lastShot,
    }
  }

  /** 前端回报失败（如模型未显示）时，让等待中的工具立刻拿到明确原因。 */
  _failWaiter(requestId, error) {
    const waiter = requestId ? this.waiters.get(requestId) : null
    if (!waiter) return false
    clearTimeout(waiter.timer)
    this.waiters.delete(requestId)
    waiter.resolve(fail(error.code, error.message, error.hint))
    return true
  }

  /**
   * 处理一次上传。同步返回 JSON 对象（路由直接回给前端，工具侧由 waiter 拿到）。
   * @param {object} payload { dataUrl, requestId?, model?, error? }
   */
  handleUpload(payload) {
    if (!this.endpointAvailable) {
      return fail('platform/unsupported', '当前宿主没有可用的上传端点',
        '截图需要宿主提供 webServer.register（DSH web 档自带）；没有端点时不落盘，也不引入 Playwright 之类的渲染依赖')
    }
    if (!payload || typeof payload !== 'object') {
      return fail('shot/invalid', '截图请求体必须是 JSON 对象', '前端应 POST {dataUrl, requestId?}')
    }

    const requestId = typeof payload.requestId === 'string' ? payload.requestId.slice(0, 120) : ''

    if (payload.error) {
      const error = {
        code: 'shot/unavailable',
        message: '看板娘页面回报无法截图：' + String(payload.error).slice(0, 300),
        hint: '先调用 mira_show / mira_set_visible({visible:true}) 显示模型，等模型加载完成后再试',
      }
      this._failWaiter(requestId, error)
      this.counters?.bump?.('shot.fail')
      return fail(error.code, error.message, error.hint)
    }

    const dataUrl = typeof payload.dataUrl === 'string' ? payload.dataUrl.trim() : ''
    const matched = DATA_URL_RE.exec(dataUrl)
    if (!matched) {
      this._failWaiter(requestId, {
        code: 'shot/invalid',
        message: '截图 dataUrl 格式不对（需要 data:image/png;base64,...）',
        hint: '前端用 canvas.toDataURL("image/png") 生成；不要手工拼 base64',
      })
      this.counters?.bump?.('shot.invalid')
      return fail('shot/invalid', '截图 dataUrl 格式不对（需要 data:image/png;base64,...）',
        '前端用 canvas.toDataURL("image/png") 生成；不要手工拼 base64')
    }

    const mime = matched[1]
    const base64 = matched[2].replace(/\s+/g, '')
    const estimated = Math.floor(base64.length * 3 / 4)
    if (estimated > this.maxBytes) {
      this._failWaiter(requestId, {
        code: 'shot/too-large',
        message: '截图过大：约 ' + estimated + ' 字节，上限 ' + this.maxBytes + ' 字节',
        hint: '在 config.json 调大 shot.maxBytes，或降低画布分辨率（canvas.w/h）',
      })
      this.counters?.bump?.('shot.too-large')
      return fail('shot/too-large', '截图过大：约 ' + estimated + ' 字节，上限 ' + this.maxBytes + ' 字节',
        '在 config.json 调大 shot.maxBytes，或降低画布分辨率（canvas.w/h）')
    }

    let buf
    try {
      buf = Buffer.from(base64, 'base64')
    } catch (error) {
      this._failWaiter(requestId, {
        code: 'shot/invalid',
        message: '截图 base64 解码失败：' + (error?.message || error),
        hint: '重新截图；持续失败请检查浏览器 canvas 是否被跨域纹理污染',
      })
      return fail('shot/invalid', '截图 base64 解码失败：' + (error?.message || error),
        '重新截图；持续失败请检查浏览器 canvas 是否被跨域纹理污染')
    }
    if (buf.length === 0 || !signatureOk(buf, mime)) {
      this._failWaiter(requestId, {
        code: 'shot/invalid',
        message: '截图内容不是有效的 ' + mime + ' 图片（可能是空白 canvas）',
        hint: '确认模型已加载并显示；PIXI 需要 preserveDrawingBuffer 才能 toDataURL',
      })
      this.counters?.bump?.('shot.invalid')
      return fail('shot/invalid', '截图内容不是有效的 ' + mime + ' 图片（可能是空白 canvas）',
        '确认模型已加载并显示；PIXI 需要 preserveDrawingBuffer 才能 toDataURL')
    }

    const now = this.now()
    this.seq += 1
    const ext = MIME_EXT[mime]
    const nonce = Math.random().toString(36).slice(2, 6)
    const file = 'mira-live2d-' + stamp(now) + '-' + String(this.seq).padStart(3, '0') + '-' + nonce + '.' + ext
    const path = join(this.mediaDir, file)
    const tmp = path + '.tmp'

    try {
      ensureDir(this.mediaDir)
      writeFileSync(tmp, buf)
      renameSync(tmp, path)
    } catch (error) {
      try {
        unlinkSync(tmp)
      } catch {
        /* 临时文件可能都没建出来 */
      }
      this._failWaiter(requestId, {
        code: 'shot/write-failed',
        message: '截图落盘失败：' + path + '（' + (error?.message || error) + '）',
        hint: '检查目录权限/磁盘空间；媒体目录在 $DSH_HOME/mira_config/mira_live2d/media（config.json 的 shot.mediaDir）',
      })
      this.counters?.bump?.('shot.fail')
      return fail('shot/write-failed', '截图落盘失败：' + path + '（' + (error?.message || error) + '）',
        '检查目录权限/磁盘空间；媒体目录在 $DSH_HOME/mira_config/mira_live2d/media（config.json 的 shot.mediaDir）')
    }

    const result = okObj({
      path,
      file,
      url: '/live2d/media/' + encodeURIComponent(file),
      bytes: buf.length,
      mime,
      at: new Date(now).toISOString(),
      model: typeof payload.model === 'string' ? payload.model.slice(0, 200) : '',
      requestId: requestId || null,
    })
    this.lastShot = { path, file, bytes: buf.length, mime, at: result.at, model: result.model }
    this.counters?.bump?.('shot.ok')
    this.logger?.info?.('[mira_live2d] 截图已保存：' + path + '（' + buf.length + ' 字节）')

    const waiter = requestId ? this.waiters.get(requestId) : null
    if (waiter) {
      clearTimeout(waiter.timer)
      this.waiters.delete(requestId)
      waiter.resolve(result)
    }
    return result
  }

  /**
   * 等待前端回传某次截图。永远 resolve，不 reject。
   * @returns {Promise<object>} okObj(...) 或 fail(...)
   */
  request({ requestId, timeoutMs = 4000 } = {}) {
    if (!this.endpointAvailable) {
      return Promise.resolve(fail('platform/unsupported', '当前宿主没有可用的上传端点',
        '截图需要宿主提供 webServer.register（DSH web 档自带）；没有端点时不落盘，也不引入 Playwright 之类的渲染依赖'))
    }
    const id = typeof requestId === 'string' && requestId !== '' ? requestId.slice(0, 120) : ''
    if (!id) {
      return Promise.resolve(fail('shot/invalid', '截图请求缺少 requestId', '由插件内部生成 requestId；不要手工调用'))
    }
    if (this.waiters.has(id)) {
      return Promise.resolve(fail('shot/invalid', '同一个截图 requestId 已经在等待：' + id, '重试会生成新的 requestId'))
    }
    const ms = Math.max(100, Math.min(60_000, Number(timeoutMs) || 4000))
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id)
        this.counters?.bump?.('shot.timeout')
        resolve(fail('shot/unavailable',
          '前端没有在 ' + ms + 'ms 内回传截图（requestId=' + id + '）',
          '确认浏览器里看板娘页面已打开、模型处于显示状态，且 widget 已加载；重试或在页面上用菜单「截图」'))
      }, ms)
      // 故意不 unref：等待前端回传期间必须让事件循环保持存活，
      // 否则在最小宿主（以及自检脚本）里超时永远不触发，工具会挂到进程结束。
      this.waiters.set(id, { resolve, timer, at: this.now() })
    })
  }

  /** 插件卸载：等待中的请求立刻返回明确错误，不留悬挂 Promise。 */
  dispose() {
    for (const [id, waiter] of this.waiters) {
      clearTimeout(waiter.timer)
      waiter.resolve(fail('shot/unavailable', '插件已卸载，截图请求取消（requestId=' + id + '）',
        '重新加载插件后再截图'))
    }
    this.waiters.clear()
  }
}
