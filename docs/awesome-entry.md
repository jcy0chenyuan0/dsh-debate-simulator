# awesome-dsh-plugin 收录条目（待提交）

建议分类：**Workflow & Automation**

在 `README.md` 对应分类末尾追加一行（把 `<owner>` 换成你的 GitHub 用户名/组织）：

```markdown
- [dsh-debate-simulator](https://github.com/<owner>/dsh-debate-simulator) - 多智能体中文辩论模拟：管理员调度、8 名辩手串行发言、评委实时计分、正反实时讨论与草稿纸、思考层、单边计时、训练方自动加赛至超过对手、每轮 ZIP 归档与最终 Word/训练方备赛包；支持自定义 API 与按人提示词 JSON。
```

前置条件（当前都不满足）：

1. 插件必须有**公开仓库**，且仓库根目录含可安装的 `package.json` + `cordis.patch.yml`；
2. 包名不能是本地私有 `@local/dsh-debate-simulator`，需改成公开 npm 名（建议 `dsh-debate-simulator`）并发布到 npm；
3. 用 `dsh plugin add <包名>` 能实际安装成功；
4. 用 GitHub 账号 fork → 改 README → 提 PR。

本机状态：

- GitHub 页面可打开，但浏览器**未登录**（页面右侧弹出登录框）；
- 无 `gh` CLI、无 GitHub token、无 npm token；
- 插件目前只有本地目录，没有公开仓库，也没有 npm 包。

因此不能提交一个指向不存在仓库的条目——PR 会被直接拒绝。
