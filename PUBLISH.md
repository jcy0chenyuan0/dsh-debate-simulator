# 发布到 DSH 插件市场

打包产物：`dist/local-dsh-debate-simulator-1.0.0.tgz`（1.6 MB，含 README、截图、client.js、Host 代码）。

## 为什么不能直接“上传”

DSH 插件市场（`dshmarket`）本身不接收上传：它读取精选列表
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)，
再按条目里的 npm 包名/仓库拉取元数据。上架需要两步外部操作：

1. **发布 npm 包**（需要 npm 登录 / token，且包名不能是本地私有 `@local/...`）。
2. **给 awesome-dsh-plugin 提 PR**（需要 GitHub 登录/gh CLI）。

当前机器没有 npm token，也没有 `gh`，所以这两步无法由插件自动完成。

## 当前发布状态（2026-10-24）

- **npm**：`dsh-debate-simulator` 包名已成功注册，但 `1.0.0` 尚未正式上线。
  直接 `npm publish` 时 npm 自动走了“Staged Publishing”（同一条命令也下发了一个 `0.0.0-stage` 占位版），
  真正的 `1.0.0` 需要发布者带 2FA **提升（promote）** 才会出现在 `latest`。
  下一步（生成本机可信发布者身份后）：
  ```bash
  npm login            # 一次性
  npm stage list dsh-debate-simulator
  npm stage promote dsh-debate-simulator@1.0.0   # 需 2FA
  ```
- **插件市场**：awesome-dsh-plugin 的 PR **#8529** 已提交，`check` 与 `Submission gate` 两个检查均通过（CLEAN），等待维护者合并。
- **GitHub**：源码已推送到 `jcy0chenyuan0/dsh-debate-simulator`（含训练结束条件设置）。


## 建议的上架方式

### 1. 改成公开包名并发布

`package.json` 当前是：

```json
"name": "@local/dsh-debate-simulator",
"private": true
```

上架前改为可用的公开名，例如：

```json
"name": "dsh-debate-simulator",
"private": false,
"version": "1.0.0"
```

然后：

```bash
npm login
npm publish --access public
```

如果坚持 `@scope/` 包名，需要先在 npm 创建该 scope。

### 2. 给 awesome-dsh-plugin 提 PR

在其仓库的插件列表里加一条，包含：

- 名称：`dsh-debate-simulator`
- 一句话简介：多智能体中文辩论模拟、实时计分、训练方加赛、每轮 ZIP 与 Word 备赛包
- npm 包名
- 仓库地址（GitHub）
- 分类：Agent / Productivity（以列表实际分类为准）

市场站点和 dshmarket 会自动收录，通常一天内生效。

### 3. 本机安装验证（不上架也能用）

```text
plugin_manager
  action: install_bundle
  target: C:\project\python\26.10.15-26.10.30\debate-sim\dist\local-dsh-debate-simulator-1.0.0.tgz
```

或直接指向源码目录（当前已安装方式）。

## 本地市场索引（可选）

如果只是团队内分发，可以把 tgz 放到内网静态服务器，市场索引里写：

```json
{
  "name": "dsh-debate-simulator",
  "title": "辩论模拟",
  "description": "多智能体辩论模拟、训练方加赛、ZIP/Word 归档",
  "versions": [
    { "version": "1.0.0", "source": { "type": "git", "url": "https://your.internal/repo.git", "commit": "<sha>" } }
  ]
}
```

具体索引 schema 以当前 `dshmarket` 版本为准；上架前建议先用 tgz 安装验证。
