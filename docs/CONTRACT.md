# 辩论模拟插件 · 模块契约（唯一真源）

本文件是并行开发的接口契约。所有模块必须严格遵守；如需变更，只由 Lead 修改本文件并广播。
包目录：`debate-sim/`。运行时：DSH（Cordis）Host + Web Client 插件。
语言：纯 ESM JavaScript（Node ≥ 22），**无构建步骤、无第三方依赖**。禁止 TypeScript、JSX。
Node 解释器（测试用）：
`C:\Users\j\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`
（下文记为 `$NODE`；bash 中路径需转义空格/反斜杠可用 `"..."`。）

## 0. 产品目标（验收总纲）

用户启动插件后输入辩题 → 进入 GUI → 管理员调度：讨论（每方限时，默认 3 分钟）→ 辩论（8 名辩手 + 评委，串行发言，气泡默认 10 秒）→ 教练总结（`总结.md` + 每方归档目录）→ 管理员打包 ZIP 并清理本轮文件/智能体 → 下一轮 → 最后一轮生成 Word 总结并汇总全部轮次。

硬约束：
1. 发言**严格串行**：上一条气泡展示计时结束前不得开始下一条（引擎单循环 + await）。
2. 权限隔离：辩手上下文不得包含评委记录/计分板；草稿纸只进本方上下文；评委可见全部记录与计分板。
3. 所有产物命名清晰、可追溯；每轮结束后无残留智能体与临时文件（保留 ZIP 与轮次索引）。
4. 支持重复运行、异常清理、轮次状态恢复。
5. GUI：左侧正方、右侧反方、下方评委；默认头像；气泡；顶部计分板 + 记录查看。

## 1. 文件所有权（并行写范围，冲突即违约）

| 归属 | 文件 |
|---|---|
| Lead | `package.json`, `cordis.patch.yml`, `index.js`, `lib/host/flow.js`, `lib/host/archive.js`, `lib/host/routes.js`, `lib/host/tool.js`, `locale/*`, `icon.svg`, `docs/CONTRACT.md`, 集成修复 |
| host-engine | `lib/host/engine.js`, `lib/host/store.js`, `lib/host/docwriter.js`（引擎内文件落盘辅助） |
| agent-sim | `lib/host/personas.js`, `lib/host/llm.js`, `lib/host/contexts.js`, `lib/host/simulate.js` |
| client-ui | `client.js`, `lib/client/*.js` |
| qa | `tests/*.test.mjs`, `README.md`, `docs/USER-GUIDE.md` |

禁止修改他人文件；需要接口变更时在报告中说明，由 Lead 改契约。所有文件为 UTF-8、LF、无 BOM。

## 2. 术语与数据结构

### 2.1 辩手席位
`seat ∈ {1,2,3,4}`；`side ∈ {'pro','con'}`（正方/反方）。
智能体 id：`pro-1..pro-4`、`con-1..con-4`；评委 `judge-1..judge-N`；教练 `coach-pro`/`coach-con`；管理员 `admin`。

### 2.2 赛制 Stage（`lib/host/flow.js` 导出）

```js
/**
 * @typedef {Object} Stage
 * @property {string} id            唯一 slug，如 'pro-opening'
 * @property {string} title         中文环节名
 * @property {'speech'|'cross'|'dialogue'|'inquiry'|'free'} kind
 * @property {'pro'|'con'|'both'} side
 * @property {number} [seat]        主发言/质询方席位（1-4）
 * @property {number} [targetSeat]  被质询方席位；缺省表示可指派
 * @property {number[]} [targetExclude] 不可指派的席位，如 [3]
 * @property {number} seconds       环节秒数；perSide 时表示每方秒数
 * @property {boolean} [perSide]    双方分开计时
 * @property {'pro'|'con'} [first]  双方环节先手
 * @property {number} [exchanges]   交替轮数（cross/dialogue/inquiry/free）
 * @property {string} description   环节规则说明（UI 展示）
 * @property {string} rule          给智能体的规则提醒
 * @property {boolean} [canInterrupt] 质询方可打断
 * @property {boolean} [respondentNoClock] 回答方发言不计时
 */
```

`flow.js` 必须导出：

```js
export const DEFAULT_ROUNDS = 3
export const MAX_ROUNDS = 12
export const DEFAULT_BUBBLE_SECONDS = 10
export const DEFAULT_DISCUSSION_SECONDS = 180
export function defaultFlow(): Stage[]
export function validateFlow(input: unknown): { ok: true, flow: Stage[] } | { ok: false, errors: string[] }
export function planTurns(stage: Stage): TurnPlan[]
// TurnPlan = { side:'pro'|'con', role:'speaker'|'examiner'|'responder'|'free'|'summary',
//             seat:number|null, share:number /* 0..1，本回合消耗该方/该环节计时的比例 */ }
```

默认赛制必须严格按需求 14 环节（顺序、名称、秒数、单边计时、先手）。`validateFlow` 对自定义 JSON 做归一化（补默认值、裁剪 strings、限 1..60 环节、id 去重、seconds 1..1800、exchanges 1..12），错误返回中文原因。

### 2.3 模拟器 Simulator（agent-sim 实现，engine 调用）

`lib/host/simulate.js` 导出：

```js
export function createRoster(): Roster
// Roster = { admin:{id,name,avatar,color}, pro:[Agent], con:[Agent],
//            judges:[Agent], coaches:{pro:Agent, con:Agent} }
// Agent = { id, name, side:'pro'|'con'|'neutral', seat:number|null,
//           role:'debater'|'judge'|'coach'|'admin', avatar, color }
export function createSimulator(options): Simulator
// options = {
//   mode: 'ai'|'demo',            // ai 失败会自动回退 demo
//   llm: object|null,             // ctx.get('llm')，可能为 null
//   model: { provider, model, reasoningEffort? } | null,
//   bubbleSeconds: number,
//   logger: (...args)=>void,
// }
export async function buildContext(agent, runView): ContextBundle
export function assertIsolation(agent, bundle): void  // 违规即 throw
```

`Simulator` 方法（全部 async，必须尊重 `signal`，失败尽量内部回退不抛）：

```js
mode() -> 'ai'|'demo'
async discuss({ topic, side, agents, materials, seconds, signal })
  -> { turns: [{ speakerId, text }], summary }
async speak({ topic, round, stage, speaker, side, transcript, draft, ownSpeeches, signal })
  -> { text, fallback:boolean }
async judge({ topic, round, stage, transcript, scoreboard, signal })
  -> { pro:number, con:number, comment:string, findings:string[], fallback:boolean }
  // pro/con 为 0..100 的评分（绝对值），引擎负责记录与展示
async coach({ topic, side, round, transcript, judgeNotes, scoreboard, priorRounds, signal })
  -> { text, analysis, fallback:boolean }
async adminComment({ topic, round, scoreboard, transcript, issues, signal })
  -> { text, fallback:boolean }
```

权限：`buildContext(agent, runView)` 根据角色过滤。`runView` 含 `topic, round, transcript, drafts, scoreboard, judgeNotes, ownSpeeches, materials`。辩手 bundle 中**不得**出现 `scoreboard`、`judgeNotes`、对方草稿；`assertIsolation` 对辩手检测到这些字段即 throw。评委/教练/管理员可见全部。

### 2.4 引擎 Engine（host-engine 实现，Lead 调用）

`lib/host/engine.js`：

```js
export function createEngine(options): Engine
// options = {
//   baseDir: string,          // 本次运行的根目录（<workspace>/debate-runs）
//   config: object,           // 插件配置默认值（见 §4）
//   createSimulator: (opts)=>Simulator,  // 由 index.js 注入
//   createRoster: ()=>Roster,
//   now?: ()=>number, wait?: (ms, signal)=>Promise<void>,  // 测试注入
//   logger?: (...a)=>void,
// }
```

Engine 方法：

```js
await engine.init()                        // 扫描 baseDir，恢复最近未完成 run（置 paused）
engine.getState(): PublicState             // §2.5，无敏感信息，可 JSON 序列化
engine.listRuns(): RunMeta[]               // 最近 20 个
engine.getRecords(runId?): Records         // §2.6
await engine.start(settings): PublicState  // settings 见 §3.1；有活跃 run 时先 stop 旧 run
await engine.control(action): PublicState  // 'pause'|'resume'|'skip'|'stop'|'resume-run'
await engine.dispose()
engine.baseDir: string
engine.onChange(fn): ()=>void              // 状态变化订阅（routes 可用于 SSE/仅内部用）
```

内部要求：
- 单 async 循环 `runLoop`，`this.running` 保证同一时刻只有一个 loop；每条发言 `await wait(bubbleSeconds*1000)` 后才推进下一条。
- 每条发言写入 `state.speeches`（全量保留到 records；state 只回最近 30 条）。
- `skip` 立即结束当前气泡等待；`pause` 在下一回合前挂起；`stop` 结束本轮并清理临时文件（保留 zip/索引）。
- 持久化 `state.json`（防抖 ≤300ms；阶段边界强制 flush）。启动 `init()` 若发现 `phase` 非 `done` 且非 `idle`，加载后置 `paused=true`、`recovered=true`。
- 每轮产物目录与文件命名见 §5。文件写入失败必须记录到 `state.error` 并继续（不静默）。
- 轮次档案：每轮 zip 后删除 `第XX轮/` 目录；`rounds-index.json` 保存每轮摘要供最终 Word 使用。
- 管理员"删除全部智能体"：每轮 zip 后清空 roster 引用并 `state.agents.alive=0`；下一轮重新创建。

### 2.5 PublicState（Client 唯一依赖；字段缺失即违约）

```js
{
  ok: true,
  version: 1,
  runId: string|null,
  topic: string,
  created: number, updated: number,
  active: boolean,                 // run 存在且未 done
  recovered: boolean,
  phase: 'idle'|'discussion'|'debate'|'summary'|'archive'|'final'|'done'|'paused'|'error',
  phaseLabel: string,              // 中文
  mode: 'ai'|'demo'|'mixed',
  rounds: number, round: number,
  stageIndex: number, stageCount: number,
  stage: null | { id,title,kind,seconds,description,side,rule },
  clock: { total:number, remaining:number, pro:number, con:number },
  bubbleSeconds: number,
  current: null | {
    id, seq, round, stageIndex, stageTitle,
    side:'pro'|'con', speakerId, speakerName, seat, avatar, color,
    text, kind, startedAt, endsAt, durationMs
  },
  discussion: { active:boolean, side:string|null,
    turns:[{side,speakerId,speakerName,text,at}] },
  pro: { score:number, debaters:[DebaterView] },
  con: { score:number, debaters:[DebaterView] },
  // DebaterView = {id,name,seat,avatar,color,lastText,lastAt,speaking}
  judges: [{id,name,avatar,scorePro,scoreCon,lastComment}],
  scoreboard: { pro:number, con:number,
    history:[{round,stageIndex,stageTitle,pro,con,comment,at}] },
  recent: [SpeechSummary],         // 最近 30 条
  archive: { zips:[{round,name,rel,bytes,created}],
             finalDocx:null|{name,rel,bytes},
             summaryMd:null|{name,rel} },
  agents: { count:number, alive:number, note:string },
  error: string|null,
  lastEvent: string,
  config: { rounds,bubbleSeconds,discussionSeconds,judges,timeScale,mode,customFlow:boolean }
}
```

### 2.6 Records

```js
{
  ok:true, runId, topic, mode,
  rounds: [{
    round, scores:{pro,con},
    discussion: { pro:[{speakerId,speakerName,text,at}], con:[...] },
    stages: [{ stageIndex, id, title, side, seconds,
               speeches:[{id,seq,side,speakerId,speakerName,seat,text,at,stageTitle}] }],
    judgeNotes: [{stageIndex,judgeId,judgeName,pro,con,comment,at}],
    archiveRel: string|null,
  }],
  final: { summaryMd:null|string, docxRel:null|string },
  issueLog: [{round,stageIndex,text,at}]
}
```

## 3. HTTP / 工具接口（Lead 实现，Client/工具调用）

全部同源 `fetch`，JSON；路径前缀 `/api/dsh-debate`。

### 3.1 `POST /api/dsh-debate/start`
请求体：
```js
{ topic: string,                    // 必填，1..200 字
  config?: {
    rounds?: number,                // 1..12，默认 3
    bubbleSeconds?: number,         // 1..120，默认 10
    discussionSeconds?: number,     // 30..1800，默认 180
    judges?: number,                // 1..3，默认 1
    timeScale?: number,             // 1..60，默认 2；仅压缩讨论阶段墙钟
    mode?: 'ai'|'demo',             // 默认 'ai'
    customFlow?: Stage[]|null       // 自定义赛制；null/缺省用 defaultFlow()
  } }
```
响应 `{ ok:true, state:PublicState }`；参数错误 `{ ok:false, error }`，HTTP 400。

### 3.2 `GET /api/dsh-debate/state` → `{ok:true,state}`
### 3.3 `GET /api/dsh-debate/records?runId=` → `{ok:true,records}`
### 3.4 `POST /api/dsh-debate/control`
`{ action:'pause'|'resume'|'skip'|'stop'|'resume-run' }` → `{ok:true,state}`。
### 3.5 `GET /api/dsh-debate/runs` → `{ok:true,runs:[RunMeta]}`
### 3.6 `GET /api/dsh-debate/file?runId=&rel=` → 文件字节（正确 Content-Type；`rel` 必须经 `safeJoin` 防穿越）；不存在 404。
### 3.7 `GET /api/dsh-debate/health` → `{ok:true, version, baseDir, active}`

工具 `debate_simulation`（Lead 在 `lib/host/tool.js` 注册）：
```js
{ action:'start'|'status'|'pause'|'resume'|'skip'|'stop'|'records',
  topic?:string, config?:object }
```
`start` 使用 `ctx.workingDirectory.ensure(agent)` 作为 baseDir 父级；未给 topic 返回错误提示。
工具结果必须含 `runId/phase/round/scoreboard/stage` 摘要与产物绝对路径提示。

## 4. 插件配置默认值

```js
export const DEFAULT_CONFIG = {
  runsDir: '',                // '' = <defaultDirectory>/debate-runs
  rounds: 3,
  bubbleSeconds: 10,
  discussionSeconds: 180,
  judges: 1,
  timeScale: 2,
  mode: 'ai',
  llmTimeoutMs: 90000,
  maxRounds: 12,
}
```
`index.js` 读取 `config` 合并默认值。不导出 Config（避免依赖 schemastery）。

## 5. 磁盘产物（引擎负责）

```
<baseDir>/<runId>/
  run.json                  {runId,topic,config,created,version}
  state.json                PublicState 超集（可恢复）
  rounds-index.json         [RoundRecord]
  第01轮/正方/草稿纸.md
  第01轮/正方/讨论记录.md
  第01轮/正方/发言记录.md
  第01轮/正方/分析材料.md
  第01轮/正方/总结.md
  第01轮/反方/...（同构）
  第01轮/评委/评委记录.md
  第01轮/评委/计分板.md
  第01轮/管理员评论.md
  第01轮_辩论归档.zip       （管理员评论 + 正方/ + 反方/ + README.txt）
  辩论模拟总结_<slug>.docx    （最后一轮生成）
  全部轮次汇总.md             （最后一轮生成）
```

`runId = YYYYMMDD-HHmmss-<topic slug>`。ZIP 名称固定 `第NN轮_辩论归档.zip`（NN 两位）。
每轮结束删除 `第XX轮/` 目录；保留 zip、`rounds-index.json`、`state.json`。

## 6. ZIP / DOCX（Lead 在 `archive.js` 提供，engine 调用）

```js
export function crc32(buf: Uint8Array): number
export function createZip(entries: Array<{name:string,data:Buffer|string}>): Buffer
export async function writeZipFile(filePath, entries): Promise<{bytes:number}>
export function buildDocx(model: DocxModel): Buffer
// DocxModel = { title, subtitle?, sections: Array<{
//   heading?:string, paragraphs?:string[], bullets?:string[],
//   table?:{ headers:string[], rows:string[][] } }>, footer? }
export async function writeDocxFile(filePath, model): Promise<{bytes:number}>
export function slugify(input:string, fallback?:string): string
export async function ensureDir(dir): Promise<void>
export async function writeTextFile(filePath, text): Promise<void>
export async function writeJsonFile(filePath, value): Promise<void>
export async function removeDir(dir): Promise<void>
export function listFilesRecursive(dir): Promise<Array<{abs:string,rel:string,size:number}>>
export function safeJoin(baseDir:string, rel:string): string|null
export function formatBytes(n:number): string
```
ZIP 采用 store（不压缩）、UTF-8 文件名（通用标志位 0x0800）、CRC32 正确、可被 Windows 资源管理器/7-Zip 打开。DOCX 为最小合法 OOXML（`[Content_Types].xml`、`_rels/.rels`、`word/document.xml`、`word/styles.xml`、`docProps/core.xml`、`docProps/app.xml`），正文支持标题/段落/项目符号/表格。两者必须有单测。

## 7. Client UI（client-ui 实现）

入口 `client.js` 必须是：
```js
window.__ModuleLoader__.load({
  id: '@local/dsh-debate-simulator',
  factory(require) { const React = require('react'); ...; return { inject:['slots'], apply(ctx){...} } }
})
```
注册：`ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name:'sidebar.panellist', id:'debate-simulator', order:30, label:'辩论模拟' }, Icon))` 与 `ctx.slots.inject('main', () => ctx.slots.register({ name:'main', key:'debate-simulator' }, Page))`。
`sidebar.panellist` 图标组件接收 `{size, active}`；`main` 是主栏整页组件，不再使用 `shell.overlay`。
`shell.overlay` 是 click-through 层：外层容器 `pointer-events:none`，可交互元素显式 `pointer-events:auto`。

UI 功能清单：
1. 右下角悬浮按钮已废弃；入口为侧边栏模块（用户要求与「自动化任务」「插件管理」「工具管理」并列）。
2. 点击侧边栏「辩论模拟」进入 `main` 主栏整页（不是弹层）。
3. 无活跃 run → 启动页：辩题、轮次、气泡秒数、讨论分钟、评委数、节奏、AI/演示、自定义赛制（JSON 文本域，默认填充 14 环节）。开始后 POST start，进入辩论页。
4. 辩论页：页头（⚖️ 辩论模拟/当前辩题/轮次/阶段 + 模式徽标 + 进行中红点，无关闭按钮）；工具栏（计分板 + 记录查看 + 暂停/继续/跳过/停止/归档/新辩论）；中部左正方右反方各 4 个默认头像卡（SVG 头像），当前发言者高亮并显示气泡（单个气泡展示由后端 current.endsAt 驱动）；底部评委条（头像 + 最新点评 + 实时分数）。
5. 记录查看：Modal，按轮次/环节分组展示全部发言（GET records），可按正/反筛选。
6. 归档区：列出每轮 ZIP 与最终 DOCX 下载链接（`/file?runId&rel`）。
7. 恢复：`state.recovered=true` 时显示「恢复上一轮」按钮（control resume-run）。
8. 轮询 `/state` 800ms；错误横幅；不阻塞宿主 UI。
9. 所有请求失败要有中文提示；组件崩溃不得影响宿主（错误边界）。

样式：只用 `--dsw-alias-*` 令牌（可带 fallback），类名前缀 `dsd-`；禁止读取其他插件 DOM；禁止 document.body 追加；禁止 iframe。

## 8. 测试与验收（qa 实现）

- `node --test` 全绿（本机 Node v24 不接受 `node --test tests/` 目录形式）。
- `flow`：14 环节数量/顺序/秒数；`validateFlow` 拒绝脏数据；`planTurns` 每类环节回合数正确。
- `archive`：zip 可由 `python zipfile` 校验（如可用）与自写解包校验；docx 用 python-docx 打开并读段落。
- `contexts`：辩手 bundle 无 scoreboard/judgeNotes/对方 draft；评委有。
- `engine`：demo 模式 + customFlow 2 环节 + bubbleSeconds 0.05 跑完一轮；断言发言时间区间两两不重叠；轮后目录删除、zip 存在、agents.alive=0；重启 `createEngine().init()` 能加载 paused 状态。
- `routes` 可用注入的假 engine 做纯单元测试（不启动 webServer）。

## 9. 交付报告要求

每个成员结束时报告：改动文件清单、运行过的命令与结果、遗留问题/假设。不得声称未验证的 GUI 效果。
