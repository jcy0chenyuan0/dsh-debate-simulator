# 跨机器安装（给别的机器上的 DSH 智能体看）

> 目标：在一台新机器上把这个插件装进 DSH 并跑起来。约 2 分钟读完，含一次自检。
> 依赖口径：**能下载的走下载（git / npm），下载不了的用本仓库 `dist/` 里的 tgz**。

## 0. 前置

- DSH 桌面版或 Web 版（`plugin_manager` 可用）。
- Node `^22.19.0 || >=24.0.0`（DSH 自带运行时即可，不必另装）。
- 插件**无第三方运行时依赖**；`cordis` / `react` 由 DSH 宿主提供，不要单独装。

## 1. 取包（三选一）

| 路径 | 命令 | 适用 |
| --- | --- | --- |
| A. git（推荐） | `git clone https://github.com/jcy0chenyuan0/dsh-debate-simulator.git dsh-debate-simulator` | 目标机器能访问 GitHub |
| B. npm | `npm install dsh-debate-simulator` | 包名已注册；若 `npm view dsh-debate-simulator dist-tags` 无 `latest`，说明还在 staged，走 A 或 C |
| C. 离线包 | 拷 `dist/dsh-debate-simulator-<版本>.tgz` 过去 | 目标机器不能联网，或 A/B 都失败 |

C 的包在源机器上生成（无需 npm）：

```bash
cd debate-sim && node scripts/pack.mjs     # → dist/dsh-debate-simulator-1.0.0.tgz
```

tgz 内已含 `index.js`、`client.js`、`lib/`、`cordis.patch.yml`、`locale/`、图标与文档，解压即完整插件。

## 2. 安装

在目标机器上开一个 DSH 会话，调：

```text
plugin_manager
  action: install_bundle
  target: <A/B 解压出的插件目录，或 C 的 .tgz 绝对路径>
```

安装后**刷新 Web GUI**。成功的标志：左侧边栏「工具管理」下方出现「辩论模拟」。

## 3. 自检（三条都要过，缺一条就回到第 4 节）

1. 侧边栏能看到「辩论模拟」并点得开。
2. 本会话工具列表里出现 `debate_simulation`。
3. 起一轮快测并落盘产物：

   ```text
   debate_simulation
     action: start
     topic: 安装自检
     config: { "rounds": 1, "bubbleSeconds": 1, "discussionSeconds": 30, "timeScale": 60 }
   ```

   完成后工作区应出现 `debate-runs/<runId>/`，内含 `rounds-index.json` 与 `第01轮_辩论归档.zip`。

## 4. 排障

- **没有侧边栏入口**：插件未启用。看 DSH 插件管理里是否列出该包，启停一次后刷新页面。
- **`install_bundle` 报目标无效**：`target` 要是**插件根目录**（含 `package.json`）或 `.tgz` 绝对路径，不是它的上级目录。
- **tgz 装不上**：确认是 `package/` 前缀的 npm 布局（用 `scripts/pack.mjs` 生成的就是）。
- **跑起来全是演示文本**：模型服务不可用；在「模型」里选 provider/model，或填 OpenAI 兼容 API 地址 + 密钥（仅内存，不写归档）。
- **讨论拖很久**：讨论跑到计时结束；用「跳过」或把 `discussionSeconds` 调小。

## 5. 装好之后怎么用

一条工具调用即可，不需要点界面：

```text
debate_simulation
  action: start
  topic: <辩题>
  config: { "rounds": 3, "trainingSide": "pro", "trainingStop": "winrate", "trainingWinRate": 60 }
```

`action` 还有 `status / records / pause / resume / skip / stop`。界面细节见 [USER-GUIDE.md](USER-GUIDE.md)。
