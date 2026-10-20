# dsh-sillytavern

SillyTavern 的三大创作系统，重写为 DeepSeek Harness（下称 DSH）插件组：

| 系统 | 上游实现 | 本插件 |
|---|---|---|
| **角色卡** | `src/character-card-parser.js`、`src/charx.js`、`public/scripts/char-data.js` | PNG(tEXt)/JSON/CHARX 导入导出、卡片库、会话绑定、字段注入提示词 |
| **世界书** | `public/scripts/world-info.js`（1.19.0，6400 行） | 完整条目模型 + 激活引擎（关键词/次级键/递归/粘滞冷却/预算/分组/位置） |
| **对话预设** | `public/scripts/openai.js`、`PromptManager.js` | 提示词管理器顺序、`main`/`jailbreak` 卡片覆写、采样参数映射 |

对话输入输出、消息历史、渲染、文件与会话管理全部复用 DSH 自身能力，本项目**不重写前端聊天界面**，只提供两个入口：设置页里的三个库管理界面，以及输入框左侧的"当前会话绑定"控件。

## 安装

已在 `desktop` profile 安装并启用（bundle 名 `dsh-sillytavern`）。重新安装/更新：

```text
plugin_manager install_bundle  target: <绝对路径>/packages/dsh-sillytavern
```

或在仓库根目录把该目录交给 `install_bundle`。三行插件（`st-characters`、`st-worldbook`、`st-presets`）可分别通过 profile 的 `cordis.patch.yml` 按 id 禁用。

## 数据目录

默认 `%DSH_HOME%\data\sillytavern`（本机为 `C:\Users\lenovo\.dsh\data\sillytavern`）；进程环境里存在 `DSH_PROFILE_DIR` 时优先用 `<profile>/data/sillytavern`。也可用环境变量 `DSH_SILLYTAVERN_DATA` 或各行 config 的 `dataDir` 覆盖：

```
data/sillytavern/
  characters/<id>.json   规范化卡片
  characters/<id>.png    原始立绘（PNG 卡片才有）
  worlds/<id>.json       世界书，保持 SillyTavern 磁盘结构
  presets/<id>.json      对话预设（提示词条目 + 采样参数）
  state.json             会话绑定与全局默认
```

## 给模型的工具

| 工具 | 作用 |
|---|---|
| `st_character` | `list` / `get` / `import` / `export` / `delete` / `use`（绑定当前会话）/ `unuse` / `default` / `greeting` |
| `st_worldbook` | `list` / `get` / `import` / `delete` / `use` / `unuse` / `default` / `entry_put` / `entry_delete` / `scan`（干跑激活） |
| `st_preset` | `list` / `get` / `import` / `delete` / `use` / `unuse` / `default` / `preview` |

`use` 不传 `sessionId` 时绑定调用者所在会话；`default` 写入全局默认，新会话继承。

## Web GUI

- **设置 → SillyTavern**：三个标签页，分别管理角色卡（含立绘、导出）、世界书（条目编辑、激活测试）、预设（提示词顺序勾选、合成预览）。
- **输入框左侧**：显示当前会话绑定的角色，点击可切换角色/预设。

## 行为了对齐与差异

实现细节来自 `research/` 下三份逐行引用源码的规格文档，以下为与上游的**有意差异**：

1. **聊天历史**：由 DSH 自己维护，插件从不重建 `chatHistory`；预设的 `chatHistory` 标记只是占位。
2. **深度注入**：世界书的 `position: 4`（@D）与预设的 `injection_position: 1`（绝对位置）无法插进 DSH 的消息栈，统一追加到系统提示末尾（世界书深度条目在角色字段之后）。
3. **首条问候语**：不自动作为助手消息插入（DSH 的会话起点是用户消息），可用 `st_character greeting` 读取。
4. **`characterFilter`**（按角色包含/排除条目）未实现：绑定关系由会话显式决定。
5. **文本补全路径**（`story_string`、instruct 模板）未实现：上游的 Chat Completion 路径本身也不使用它们。
6. **token 预算**：使用字符启发式估算（CJK 1 字 1 token，其余 4 字符 1 token），不是真实分词器。

## 结构

```
packages/dsh-sillytavern/
  characters/index.js   角色卡行：库操作 + st_character 工具
  worldbook/index.js    世界书行：库操作 + st_worldbook 工具
  presets/index.js      预设行：库操作 + st_preset 工具
  lib/card.js           卡片解析（PNG/JSON/CHARX）
  lib/png.js            PNG tEXt 编解码
  lib/worldinfo.js      世界书激活引擎（纯函数）
  lib/prompt.js         预设模型与提示词装配
  lib/runtime.js        三行共享的库、绑定、合成与注入
  lib/api.js            /st-api HTTP 路由（GUI 与绑定控件使用）
  lib/store.js          原子写入的文件库
  lib/tokens.js         token 估算
  client/index.js       Web GUI 两个界面
  test/                 smoke（纯模块）+ plugin（假 Cordis 上下文）测试
```

## 测试

```powershell
node test/smoke.mjs     # PNG 编解码、世界书引擎、卡片解析
node test/plugin.mjs    # 三行插件经假上下文跑通导入/绑定/合成/导出
```

`ST_ROOT` 环境变量可指向另一份 SillyTavern 检出以复用测试素材。
