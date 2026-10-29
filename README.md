# mira_live2d · DSH 看板娘插件

把 Live2D 看板娘作为 DSH 会话界面的浮层：**默认隐藏**，界面上有常驻开关按钮；菜单里可切换模型、表情、动作与背景图；模型可通过 TTS 说话，也可以把当前画面截图落盘。

本版（3.0.0）按 `重构插件/任务书.txt` 与 `重构插件/PLAN.md` §1.7 重构：

- 入口拆成 `lib/index.js`（装配/路由/单实例/热加载）+ `models.js` + `tts.js` + `shot.js` + `state.js` + `tools.js`
- 配置与状态统一落 `$DSH_HOME/mira_config/mira_live2d/`，带 `schemaVersion`
- 所有工具返回 **JSON 文本**（旧版返回中文纯文本；这是破坏性变化，见「迁移」）
- 模型/表情/动作文件缺失时逐条报出文件名与修复位置，不静默留白

仅依赖 Node 内置模块；前端运行库仍捆绑在 `assets/lib/`，没有新增 CDN 或第三方依赖。

---

## 落盘位置（先看这个）

`$DSH_HOME` = 环境变量 `DSH_HOME`（trim 后非空）→ 否则 `~/.dsh`。
例如 `DSH_HOME=/home/you/.dsh` 时，实际是 `/home/you/.dsh/mira_config/mira_live2d/`。

```
$DSH_HOME/mira_config/mira_live2d/
├── config.json             配置（schemaVersion=2；不存在 = 全默认）
├── state.json              状态（schemaVersion=1；默认 visible:false）
├── creds/tts.json          TTS 凭据（权限 600，永不回显）
├── model/                  默认模型目录（modelsDir 默认值）
├── image/                  默认背景图目录（imageDir 默认值）
└── media/                  截图落盘目录（shot.mediaDir 默认值）
```

**看一眼就知道该放哪**：三个目录在插件加载时会自动创建；`model/` 与 `image/` 里没有内容时，对应工具会返回 `config/missing` 并带上完整路径，不会静默空白。

> 插件仓库自带的 `model/StellaMira`、`model/SylviaMuse` 是**资产示例**，不是默认模型目录。想直接用它们，把 `modelsDir` 指向 `<插件目录>/model`，或把模型目录复制到上面的 `model/` 下（见「迁移」）。

---

## 安装与装配

```sh
dsh plugin --profile web add github:Stella-Mira/mira_live2d
```

在 `~/.dsh/profiles/web/cordis.patch.yml` 的 `insert` 列表登记：

```yaml
- id: mira_live2d
  name: 'mira_live2d'
  config: {}          # 新配置优先写 config.json；这里只作为旧位置的兼容兜底
```

`inject: ['webServer', 'tools']`：`webServer` 是硬依赖（前端脚本注入 `/live2d/assets/...`、指令轮询、截图上传都靠它）。DSH web 档自带 `ctx.webServer.register` / `tapIndex`。

---

## 配置表

配置文件：`$DSH_HOME/mira_config/mira_live2d/config.json`，**必须**带 `schemaVersion: 2`；不匹配会拒绝使用并给迁移提示，不会静默兼容。

优先级：**内置默认值 < profile 里的旧插件 config < config.json**。同名项以 `config.json` 为准；profile 只用于兼容老用户（搬完后建议删掉，见「迁移」）。

| 键 | 默认值 | 说明 |
|---|---|---|
| `schemaVersion` | `2` | 必填。旧文件先备份，按「迁移」转换 |
| `enabled` | `true` | 总开关。**只在加载时判断**；改它需要重载插件 |
| `model` | `''` | 初始模型名（`modelsDir` 下目录名）。留空 = 不指定，**不自动挑默认模型**；用工具/菜单显式选 |
| `modelsDir` | `$DSH_HOME/mira_config/mira_live2d/model` | 模型根目录。留空用默认；相对路径按 `mira_live2d/` 解析 |
| `imageDir` | `$DSH_HOME/mira_config/mira_live2d/image` | 背景图根目录。留空用默认 |
| `canvas.w` / `canvas.h` | `480` / `630` | 画布内部分辨率 |
| `position` | `right` | 初始位置 `left` / `right`（用户拖过之后以 localStorage 为准） |
| `mobileScale` | `55` | 移动端初始缩放百分比 |
| `showHint` | `true` | 首次显示时弹一条操作提示 |
| `pollIntervalMs` | `1500` | 前端拉指令间隔（毫秒） |
| `shot.mediaDir` | `$DSH_HOME/mira_config/mira_live2d/media` | 截图落盘目录。留空用默认 |
| `shot.timeoutMs` | `4000` | `mira_screenshot` 等前端回传的最长时间 |
| `shot.maxBytes` | `16777216`（16 MiB） | 单张截图**解码后**字节上限 |
| `tts.enabled` | `false` | TTS 总开关 |
| `tts.provider` | `openai` | `openai` / `aliyun`（旧值 `alibaba` 视作 `aliyun`） |
| `tts.base` | 供应商默认 | OpenAI 兼容接口基地址（不含 `/audio/speech`） |
| `tts.model` | 供应商默认 | 见下方 TTS 表 |
| `tts.voice` | 供应商默认 | 见下方 TTS 表 |
| `tts.maxChars` | `600` | 单次朗读最长字符数 |
| `tts.timeoutMs` | `15000` | TTS HTTP 超时 |
| `persona.thinking.expression` / `.bubble` | `''` | 思考时表情 / 气泡 |
| `persona.awaiting.expression` / `.bubble` | `''` | 等待确认时表情 / 气泡 |
| `persona.idleClearMs` | `3200` | 空闲后清除表情的延迟 |

配置热加载：每次工具调用/`/live2d/api/config` 都会比较 `config.json` 的 mtime + size，变了就重读。**目录、model、TTS、背景目录改动无需重启**；`enabled` 除外。

“必备项为空”的纪律：模型/背景目录为空、TTS 未配置、指定模型不存在等，一律返回 `{ok:false,error:{code,message,hint}}`，不做自动探测。

---

## 模型与资源缺失诊断

模型目录结构（每个模型一个子目录，子目录里必须有 `*.model3.json`）：

```
model/
└── StellaMira/
    ├── StellaMira.model3.json      ← 入口（必须）
    ├── StellaMira.moc3
    ├── StellaMira.4096/...
    ├── 待机.motion3.json
    └── 思考.exp3.json
```

`mira_list_assets` / `mira_get_model_capabilities` 会解析 `FileReferences`，**逐项检查** `Moc`、`Textures`、`Physics`、`Pose`、`Expressions[].File`、`Motions[].File` 是否存在：

```json
{
  "ok": true,
  "models": [{
    "name": "TestModel",
    "missing": [{
      "kind": "expression",
      "file": "缺失.exp3.json",
      "path": "/home/you/.dsh/mira_config/mira_live2d/model/TestModel/缺失.exp3.json",
      "exists": false,
      "name": "缺失",
      "hint": "把 缺失.exp3.json 放到 …/TestModel，或从 …/TestModel.model3.json 的 FileReferences.Expressions 里删掉 \"缺失\""
    }]
  }]
}
```

- 只缺表情/动作文件：`mira_switch_model` 仍可切换，但返回 `missing` 与 `warning`；`mira_set_expression` / `mira_play_motion` 对该项返回 `resource/missing`（带文件路径与修复 hint）。
- 缺 `Moc` / `Textures`：`mira_switch_model` 直接返回 `resource/missing`，拒绝切换。
- 模型目录本身不存在/为空：`config/missing`，message 指出缺 `*.model3.json`（配置了 `model` 时具体到 `<model>.model3.json`），hint 指出 `modelsDir` 与 `config.json` 路径。

---

## TTS（openai / aliyun）

两个供应商都走 OpenAI 兼容的 `POST {base}/audio/speech`（不引 SDK，不直连阿里云原生 WebSocket）：

| provider | 默认 base | 默认 model | 默认 voice |
|---|---|---|---|
| `openai` | `https://api.openai.com/v1` | `tts-1` | `alloy` |
| `aliyun` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-tts` | `Chelsie` |

### 凭据文件（600，永不回显）

```sh
mkdir -p ~/.dsh/mira_config/mira_live2d/creds
cat > ~/.dsh/mira_config/mira_live2d/creds/tts.json <<'JSON'
{
  "schemaVersion": 1,
  "provider": "openai",
  "apiKey": "sk-..."
}
JSON
chmod 600 ~/.dsh/mira_config/mira_live2d/creds/tts.json
```

- 文件里 `provider` 可省略；写了则优先于 `config.json` 的 `tts.provider`。
- `apiKey` **只**从 `creds/tts.json` 读；`mira_tts_status` 只报 `configured` / `provider` / `keySource` / `credsMode` / `credsModeOk`，绝不回传 key。
- 权限不是 600 会写一条 warn（只打印路径与权限位），但仍可读；建议立刻 `chmod 600`。
- 超过 `tts.maxChars`（默认 600，按 **code point** 计，不会劈开 emoji 的代理对）只朗读前 N 个字符，并在 `mira_speak` / `POST /api/tts` 的返回值里带 `truncated:true`、`chars`、`requestedChars`——不静默截断。
- **旧的 `tts.key` / `tts.keyEnv` 已废弃并被忽略**：会打 warn，`mira_tts_status.legacyKeyIgnored` / `legacyKeyEnvIgnored=true`，提示迁移到 `creds/tts.json`。

### 启用

```json
{
  "schemaVersion": 2,
  "tts": { "enabled": true, "provider": "openai" }
}
```

未启用/未配 key 时：

- `mira_speak` 返回 `config/missing`，message 说明是没启用还是缺 key，hint 指到 `creds/tts.json` 与 `config.json`；
- 前端菜单里的 TTS 项**仍然可见**，点击后在气泡/按钮旁显示同一段提示（功能点10），不会静默 `false`；
- 不会发起任何网络请求。

`mira_tts_status` 是只读诊断工具，不会因为没配置而失败。

---

## 背景图

- 图片放 `imageDir`（默认 `.../mira_live2d/image`）**顶层**，支持 `png / jpg / jpeg / webp / gif`。
- `mira_set_background(image="bg1.png")` 设置，`image=""` 或 `clear:true` 清除；设置后落 `state.json`，刷新页面保持。
- 菜单里也列出背景图；文件经 `/live2d/backgrounds/<文件名>` 输出。
- 目录不存在/没有图片：`config/missing`，message 带目录绝对路径，hint 指到 `imageDir` 与 `config.json`。
- 实现同时写 `body` 的背景图（`cover` / `fixed`）与一个固定在 `z-index:-1`、`pointer-events:none` 的全屏层；如果宿主主题里还有更高的不透明容器，背景仍可能被盖住（见「已知取舍」）。

---

## 截图（功能点7）——已确认的后端路径

模型是浏览器 canvas，宿主进程没有渲染器。本插件采用 PLAN §3.11 的 **(a)**：

```
前端 canvas.toDataURL('image/png')
  → POST /live2d/api/shot  { requestId, dataUrl, model }
  → 插件校验（PNG/JPEG/WebP 签名、maxBytes）
  → 原子写入 shot.mediaDir（默认 .../mira_live2d/media）
  → 返回 { ok:true, path, url, bytes, mime, ... }
```

依据：`lib/index.js` 本来就用 `ctx.webServer.register({ kind:'prefix', path:'/live2d', handler })` 提供 `/live2d/api/*`（旧版 `readBody` 就在这个 handler 里读 JSON），DSH 的 `dsh-host-webserver` 约定 `WebRoute.handler` 拥有完整请求/响应生命周期。因此**不需要、也没有引入 Playwright**。

`mira_screenshot` 的语义：

1. 模型必须处于显示状态（`visible:true`），否则 `shot/unavailable`，hint 让你先 `mira_show` / `mira_set_visible`；
2. 下发带 `requestId` 的 `screenshot` 指令，等前端回传（默认 4s，可用参数 `timeoutMs` 覆盖，500–30000ms）；
3. 成功返回绝对路径与 `/live2d/media/<file>` URL；失败返回 `shot/unavailable`（页面没开/模型没显示/超时）、`shot/invalid`（空白 canvas/坏 dataUrl）、`shot/too-large`、`shot/write-failed`；
4. 前端 PIXI 已开 `preserveDrawingBuffer: true`，否则部分浏览器 `toDataURL` 会得到空白图。

限制：

- 只截 canvas 内容（透明背景不会带页面背景），不是整页截图；
- 需要浏览器里看板娘页面已打开且模型已加载；
- 若宿主没有可用的上传端点（`webServer.register` 缺失），工具返回 `platform/unsupported`，**不落盘**，也不引渲染依赖；
- `shot.maxBytes` 限制解码后大小；请求体读取上限是它的 1.5 倍 + 8 KiB。

---

## 工具清单（20 个，全部返回 JSON 文本）

| 工具 | 说明 |
|---|---|
| `mira_get_state` | 显示与否、当前模型、开启的表情/动作、背景、TTS 是否配置、可切换模型、资源缺失诊断、浏览器是否连上。默认 `visible:false` |
| `mira_list_models` | 列出模型（目录名 + model3.json 相对入口）；目录为空返回 `config/missing` |
| `mira_list_assets` | 模型/表情/动作/背景图 + 逐文件缺失诊断（`missing[].hint`） |
| `mira_get_model_capabilities` | 解析指定/当前模型的 model3.json，返回表情、动作组、缺失文件 |
| `mira_switch_model` | 切换模型；核心文件缺失拒绝，非核心缺失带回 warning |
| `mira_set_expression` | 设置表情（空串恢复默认；`stack=true` 叠加开关） |
| `mira_play_motion` | 播放动作组 |
| `mira_speak` | TTS 合成 + 气泡；未配置返回 `config/missing` 并给提示 |
| `mira_bubble` | 只显示气泡 |
| `mira_set_visible` | **显式开关**：`{"visible":true|false}`，状态落盘 |
| `mira_show` / `mira_hide` | 旧工具保留（等价于 set_visible） |
| `mira_set_expressions_enabled` | 开关表情系统 |
| `mira_set_animations_enabled` | 开关动作播放 |
| `mira_set_mood` | `thinking` / `awaiting` / `idle` |
| `mira_set_persona` | 思考/等待表情气泡与 idleClearMs（运行期，不落盘） |
| `mira_get_config` | 当前生效配置（目录绝对路径；TTS key 只报是否配置） |
| `mira_set_background` | 设置/清除背景图，落 state.json |
| `mira_screenshot` | 前端 canvas 截图 → POST 上传 → 落盘并返回路径 |
| `mira_tts_status` | 只读：是否启用、供应商、key 是否配置、key 来源、creds 文件权限（不含 key） |

旧版返回中文纯文本（如 `'已下发切换模型指令：X'`），3.0.0 起统一为 JSON；按 `ok` / `error.code` 判断，不要正则解析文案。

---

## 前端交互

- **默认隐藏**：页面加载后模型不出现，左下角有常驻的「显示看板娘 / 隐藏看板娘」「说话」「菜单」三个按钮。
- **菜单**（菜单按钮 / 右键 canvas / 移动端长按）：
  - 模型：列出 `modelsDir` 下所有模型（当前项 `✓`）；
  - 表情：默认表情 + 当前模型表情；有文件缺失的项标 `⚠`，点击显示缺失文件名与修复位置；
  - 动作：当前模型动作组；
  - 背景：无背景 + `imageDir` 里的图片；
  - 截图：当前画面落盘后提示路径；
  - TTS：已配置为「试听 TTS」，未配置为「TTS 未配置（点击查看）」，点击给明确提示；左下角「说话」按钮同样常驻，未配好时点击给出同一段提示。
- 拖拽移动 / 滚轮缩放 / 双指捏合 / 位置与缩放记忆（localStorage）保持旧版行为。
- 气泡、语音、RMS 口型、思考/等待表情联动保持旧版行为。
- 前端每 5 秒 POST `/live2d/api/state` 上报状态；服务端只持久化显隐/模型/背景/表情/动作，气泡与在线时间只留在内存。

---

## 内部 HTTP API（前端用；非模型工具）

| 方法/路径 | 用途 |
|---|---|
| `GET /live2d/api/config` | 前端启动配置：可见性、模型/入口、模型清单、能力、背景、TTS 状态、截图端点 |
| `GET /live2d/api/commands?since=` | 拉取指令（ID 单调递增，带时钟回拨防护） |
| `POST /live2d/api/command-result` | 前端指令执行结果（仅日志） |
| `POST /live2d/api/state` | 前端状态上报 + 持久化 |
| `GET /live2d/api/audio/<id>` | 取 TTS 音频（base64） |
| `POST /live2d/api/tts` | 前端试听 TTS（与工具同一套配置/校验） |
| `POST /live2d/api/shot` | 截图上传（dataUrl） |
| `POST /live2d/api/background` | 前端菜单设置背景 |
| `GET /live2d/api/capabilities?model=` | 隐藏状态下也要列表情/动作菜单 |
| `GET /live2d/{assets,models,backgrounds,media}/...` | 静态资源（路径越界一律 403） |

- **只接受同源请求**：`/live2d/api/*` 全部同一口径——带 `Origin` 且 host 与 `Host` 不一致、`Origin: null`、或 `Sec-Fetch-Site: cross-site` 一律 `403 http/forbidden`（这些接口能改状态、落盘截图、消耗 TTS 额度，不能让任意网页盲写）。没有 `Origin` 的本地客户端（curl / Node）不受影响。
- `GET /commands?since=` 只采信安全的非负整数且最多领先当前时钟一天；异常游标会被忽略（仍返回 200），不会把指令 ID 推到浮点精度边界而破坏「ID 单调递增」。

---

## 错误码

| code | 场景 |
|---|---|
| `config/missing` | 必备配置/目录为空、模型目录没有模型、背景目录没有图、TTS 未配置 |
| `config/schema` | `config.json` / `state.json` / `creds/tts.json` 的 schemaVersion 不匹配 |
| `config/invalid` | 配置值非法（如 provider 拼错）或工具参数类型不对 |
| `model/not-found` | 指定模型/表情/动作名不在清单里（message 列出可选项） |
| `model/broken` | model3.json 读不了或不是 JSON |
| `resource/missing` | model3.json 引用的文件缺失（moc/贴图/表情/动作） |
| `tts/failed` | TTS 网络/接口/空音频失败（错误里已抹掉 key） |
| `creds/missing` | TTS 凭据文件坏或读不了 |
| `shot/unavailable` | 模型隐藏、前端没回传/超时、前端回报错误 |
| `shot/invalid` / `shot/too-large` / `shot/write-failed` | 空白 canvas/格式错 / 超上限 / 落盘失败 |
| `platform/unsupported` | 宿主没有 webServer.register（没有上传端点） |
| `plugin/instance` | 同 id 第二个实例（单实例保护） |
| `plugin/disabled` | `config.enabled=false` |
| `state/write-failed` | 状态文件写盘失败 |

---

## 迁移（从 2.0.2 到 3.0.0）

先备份：`cp -a ~/.dsh/mira_config/mira_live2d ~/mira_live2d.bak`（如果没有该目录就备份 profile 配置）。

1. **建配置文件**：新建 `$DSH_HOME/mira_config/mira_live2d/config.json`，至少写：

   ```json
   { "schemaVersion": 2, "model": "StellaMira" }
   ```

   把旧 `cordis.patch.yml` 里 `mira_live2d.config` 的字段搬进来（`model` / `modelsDir` / `canvas` / `position` / `mobileScale` / `showHint` / `pollIntervalMs` / `persona` / `tts.*`）。搬完建议把 profile 里那一节删成 `config: {}`；同名项以 `config.json` 为准。

2. **模型目录**：旧默认是插件包内 `model/`，新默认是 `$DSH_HOME/mira_config/mira_live2d/model`。二选一：
   - `cp -a <插件目录>/model/* ~/.dsh/mira_config/mira_live2d/model/`；或
   - 在 `config.json` 里写 `"modelsDir": "<插件目录>/model"`。

3. **TTS 凭据**：把旧 `tts.key`（字面量）或 `tts.keyEnv` 指向的环境变量值搬进 `creds/tts.json` 的 `apiKey` 并 `chmod 600`；这两个旧字段会被忽略并打 warn。旧 `provider: "alibaba"` 自动当作 `aliyun`。

4. **默认显隐**：旧版默认显示，新版默认隐藏（任务书功能点1）。用户点过「显示看板娘」后状态落 `state.json`，刷新保持；要强制默认隐藏，删 `state.json`。

5. **工具返回值**：从中文文本改为 JSON；调用方按 `ok` / `error.code` 处理。`mira_list_models` 从数组变为 `{ok,modelsDir,models}`。

6. **schemaVersion 不匹配**：插件会拒绝使用对应文件并在日志/`mira_get_state` 报 `config/schema`，不会静默兼容；先备份再按上表重写。旧版没有 `config.json` 时不算不匹配。

---

## 已知取舍 / 未做项

- **前端行为没有浏览器自动化测试**：`test/smoke.mjs` 只测 Node 侧 + widget.js/CSS 的静态存在性（常驻按钮、`preserveDrawingBuffer`、`toDataURL`、上传路径）。真实拖拽/菜单/背景视觉需人工验证。
- **背景层可能被宿主主题盖住**：同时设置 `body` 背景与 `z-index:-1` 固定层，但不保证在所有布局下可见；没有改宿主 CSS/结构，避免污染全局样式。
- **TTS 只支持 OpenAI 兼容 `/audio/speech`**：阿里云走 DashScope 兼容模式，不实现原生 WebSocket 流式；流式/字幕等未做。
- **`tts.key` / `tts.keyEnv` 不再支持**：凭据必须 600 落 `creds/tts.json`；这是任务书约定8的直接结果。
- **`enabled` 不是热加载项**：改它要重载插件；其余目录/模型/TTS 配置热生效。
- **状态是单进程内存 + 文件**：没有多实例/多进程合并；单实例保护会拒绝第二个实例。
- **截图只截 canvas**：透明背景、分辨率随 `canvas.w/h` 与 PIXI resolution；不做整页/多显示器截图。`media/` 下的历史截图不会自动清理，需要时手工删。
- **不自动探测**：不自动挑模型、不自动找 key、不扫描插件自带模型当默认。
- **`set_persona` 是运行期覆盖**：不写盘；未用工具覆写前 `config.json` 的 `persona` 会热加载，覆写后保持到重载插件。要持久请写 `config.json`。
- **背景图只列 `imageDir` 顶层**：子目录里的图不自动列，但 `mira_set_background` 可传相对子路径（仍限制在 `imageDir` 内）。

---

## 自检

```sh
cd mira_live2d
node test/smoke.mjs                 # 末行 ==== ALL PASS（N 项断言）====，退出 0
cd ..
node 重构插件/tools/check-zero-dep.mjs mira_live2d
node 重构插件/tools/check-kit.mjs
```

自检把 `DSH_HOME` 指到临时目录，不碰真实 `~/.dsh`；TTS 用假 `fetch`，不发真实网络请求；截图用合成 PNG 走真实 HTTP handler 落盘到临时目录。

`lib/kit.mjs` 是 `重构插件/kit/kit.mjs` 的逐字节副本；改 kit 请改规范源后重新复制，并跑 `check-kit.mjs`。
