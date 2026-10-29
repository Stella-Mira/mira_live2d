# 看板娘模型资产（插件自带示例）

本目录是**插件自带的模型资产**，不是默认模型目录。

新的默认模型目录是：

```
$DSH_HOME/mira_config/mira_live2d/model
```

（`$DSH_HOME` 缺省 `~/.dsh`。见 `README.md`「落盘位置」「配置表」「迁移」。）

## 想直接用这里的模型

二选一：

1. **复制到默认目录**（推荐，默认目录可写、与插件升级解耦）

   ```sh
   mkdir -p ~/.dsh/mira_config/mira_live2d/model
   cp -a model/StellaMira ~/.dsh/mira_config/mira_live2d/model/
   ```

2. **把 `modelsDir` 指向本目录**

   在 `~/.dsh/mira_config/mira_live2d/config.json` 里写：

   ```json
   { "schemaVersion": 2, "modelsDir": "<插件目录>/model", "model": "StellaMira" }
   ```

   然后 `chmod`/路径按本机实际调整；不自动探测，`modelsDir` 为空时用默认目录。

## 目录结构

每个模型一个子目录，子目录里必须有一个 `*.model3.json`：

```
model/
└── StellaMira/                  ← 模型名 = 目录名
    ├── StellaMira.model3.json   ← 入口（必须）
    ├── StellaMira.moc3
    ├── StellaMira.4096/texture_00.png
    ├── 待机.motion3.json
    ├── 思考.exp3.json
    └── …（整个模型文件夹原样放入）
```

- 插件内置 Cubism 5（cubism4）运行时，仅支持 Cubism 4/5 模型，Cubism 2/3 老模型不支持。
- `mira_list_models` / `mira_list_assets` 会扫描 `modelsDir`，自动发现所有含 `.model3.json` 的子目录，并逐项检查 `Moc`/贴图/表情/动作文件是否存在；缺哪个文件会报出完整路径与修复位置。
- 切换模型用 `mira_switch_model(model="目录名")`，或前端菜单（菜单 → 模型）。
- 模型文件经 `/live2d/models/` 由主机端代理输出，不会暴露为独立静态目录。

> 注：模型文件（`.moc3` / 贴图 / `.exp3.json` / `.motion3.json`）不入版本库（`.gitignore` 已排除 `model/*`），请自行获取后放入 `modelsDir`。
