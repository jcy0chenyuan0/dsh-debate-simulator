/**
 * 辩论模拟 · Web Client（唯一浏览器产物）
 *
 * 契约：debate-sim/docs/CONTRACT.md §2.5 / §3 / §7
 *
 * 说明（为什么只有一个文件）：
 *   DSH 的 client 加载器按包提供一个**原样读取**的浏览器产物
 *   （ClientModuleRegistry 里是 `readFileSync(meta.clientPath)` 直接吐出来），
 *   `require()` 只解析平台 seed 模块表与已注册 factory，不做相对路径解析，
 *   也没有构建步骤。因此 `lib/client/*.js` 不能作为运行时子模块被本文件引用，
 *   全部 UI 逻辑必须落在这一个文件里。本文件因此是自包含的。
 *
 * 硬约束（§7）：
 *   - 入口 `window.__ModuleLoader__.load({ id, factory })`，React 从 require('react') 拿；
 *   - 注册两个位置：`sidebar.panellist`（图标，id: debate-simulator, order: 30）
 *     与 `main`（整页模块，key: debate-simulator），两者同名 id/key 由宿主配对；
 *   - 模块页是主栏整页（height:100%），不使用 fixed / backdrop / 悬浮按钮 / 圆角外框；
 *   - 侧边栏图标纯展示，不轮询；800ms 轮询只发生在 main 模块组件内，卸载即清；
 *   - 颜色只用 --dsw-alias-* 令牌（带 fallback），类名一律 dsd- 前缀；
 *   - 不碰别人的 DOM、不挂 document.body、不用 iframe。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-debate-simulator',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useRef = React.useRef;
    const useCallback = React.useCallback;

    // ───────────────────────────── 常量 ─────────────────────────────

    const API_BASE = '/api/dsh-debate';
    const POLL_MS = 800;

    /**
     * 启动页「自定义赛制」文本域的默认填充（14 环节）。
     *
     * 它只用于**预填**，不是权威默认值：未修改时提交 `customFlow: null`，
     * 由 Host 的 `defaultFlow()` 决定真实赛制，避免前后端赛制漂移。
     */
    /** 权威默认赛制：由 lib/host/flow.js 的 defaultFlow() 输出，逐字段同步（14 环节）。 */
    const DEFAULT_FLOW = [
      {
        "id": "pro-opening",
        "title": "正方一辩开篇立论",
        "kind": "speech",
        "side": "pro",
        "seat": 1,
        "seconds": 180,
        "description": "正方一辩系统阐述本方立场、定义、标准与论证框架。",
        "rule": "开篇立论，输出完整论证链：定义—标准—论点—论据—结论。"
      },
      {
        "id": "con-cross-1",
        "title": "反方二辩质询正方一辩",
        "kind": "cross",
        "side": "con",
        "seat": 2,
        "targetSeat": 1,
        "seconds": 90,
        "singleSide": true,
        "canInterrupt": true,
        "exchanges": 4,
        "description": "反方二辩质询正方一辩，对质询方单边计时 1 分 30 秒；回答方只能作答，质询方可打断。",
        "rule": "只问不答；问题短、指向明确，可打断对方冗长回答。"
      },
      {
        "id": "con-opening",
        "title": "反方一辩开篇立论",
        "kind": "speech",
        "side": "con",
        "seat": 1,
        "seconds": 180,
        "description": "反方一辩系统阐述本方立场与论证框架。",
        "rule": "开篇立论，必须正面回应正方立论的核心前提。"
      },
      {
        "id": "pro-cross-1",
        "title": "正方二辩质询反方一辩",
        "kind": "cross",
        "side": "pro",
        "seat": 2,
        "targetSeat": 1,
        "seconds": 90,
        "singleSide": true,
        "canInterrupt": true,
        "exchanges": 4,
        "description": "正方二辩质询反方一辩，对质询方单边计时 1 分 30 秒；回答方只能作答，质询方可打断。",
        "rule": "只问不答；用对方立论中的定义与论据设问，逼出矛盾。"
      },
      {
        "id": "con-summary-1",
        "title": "反方二辩就质询内容进行小结",
        "kind": "speech",
        "side": "con",
        "seat": 2,
        "seconds": 120,
        "description": "反方二辩总结质询成果，时间 2 分钟。",
        "rule": "小结质询中暴露的对方矛盾，并收束到本方论证。"
      },
      {
        "id": "pro-summary-1",
        "title": "正方二辩就质询内容进行小结",
        "kind": "speech",
        "side": "pro",
        "seat": 2,
        "seconds": 120,
        "description": "正方二辩总结质询成果，时间 2 分钟。",
        "rule": "小结质询中确认的对方让步，并修补本方论证。"
      },
      {
        "id": "fourth-dialogue",
        "title": "正反方四辩对辩",
        "kind": "dialogue",
        "side": "both",
        "seats": [
          4,
          4
        ],
        "seconds": 90,
        "perSide": true,
        "first": "pro",
        "exchanges": 6,
        "description": "双方四辩对辩，各 1 分 30 秒，交替发言，分开计时；正方先行，辩手无权中止对方未完成之言论。",
        "rule": "交替发言，不得打断对方；每轮回应对方上一句并推进己方比较优势。"
      },
      {
        "id": "pro-inquiry",
        "title": "正方三辩盘问",
        "kind": "inquiry",
        "side": "pro",
        "seat": 3,
        "targetExclude": [
          3
        ],
        "seconds": 90,
        "singleSide": true,
        "respondentNoClock": true,
        "canInterrupt": true,
        "exchanges": 4,
        "description": "正方三辩盘问，对盘问方计时 1 分 30 秒；被盘问方可指派除三辩外任一辩手作答，中途不可更换；答辩方只能作答，发言时长不计入总时间。",
        "rule": "盘问方连续设问；被盘问方只能作答，不能反问。"
      },
      {
        "id": "con-inquiry",
        "title": "反方三辩盘问",
        "kind": "inquiry",
        "side": "con",
        "seat": 3,
        "targetExclude": [
          3
        ],
        "seconds": 90,
        "singleSide": true,
        "respondentNoClock": true,
        "canInterrupt": true,
        "exchanges": 4,
        "description": "反方三辩盘问，对盘问方计时 1 分 30 秒；被盘问方可指派除三辩外任一辩手作答，中途不可更换；答辩方只能作答，发言时长不计入总时间。",
        "rule": "盘问方连续设问；被盘问方只能作答，不能反问。"
      },
      {
        "id": "pro-inquiry-summary",
        "title": "正方三辩质询小结",
        "kind": "speech",
        "side": "pro",
        "seat": 3,
        "seconds": 120,
        "description": "正方三辩就盘问内容作小结，时间 2 分钟。",
        "rule": "把盘问中获得的承认整理成本方论证的支点。"
      },
      {
        "id": "con-inquiry-summary",
        "title": "反方三辩质询小结",
        "kind": "speech",
        "side": "con",
        "seat": 3,
        "seconds": 120,
        "description": "反方三辩就盘问内容作小结，时间 2 分钟。",
        "rule": "把盘问中获得的承认整理成本方论证的支点。"
      },
      {
        "id": "free-debate",
        "title": "自由辩论",
        "kind": "free",
        "side": "both",
        "seconds": 180,
        "perSide": true,
        "first": "pro",
        "exchanges": 8,
        "description": "双方各 3 分钟，正方开始；同一方发言次序不限；一方时间用完另一方可继续，也可放弃发言。",
        "rule": "短兵相接，每轮只回应一个点；不得重复已说过的论据。"
      },
      {
        "id": "con-closing",
        "title": "反方四辩总结陈词",
        "kind": "speech",
        "side": "con",
        "seat": 4,
        "seconds": 210,
        "description": "反方四辩总结陈词，时间 3 分 30 秒。",
        "rule": "总结全场交锋，给出比较标准与最终判准，回应对方核心攻击。"
      },
      {
        "id": "pro-closing",
        "title": "正方四辩总结陈词",
        "kind": "speech",
        "side": "pro",
        "seat": 4,
        "seconds": 210,
        "description": "正方四辩总结陈词，时间 3 分 30 秒。",
        "rule": "总结全场交锋，给出比较标准与最终判准，回应对方核心攻击。"
      }
    ];

    const DEFAULT_FLOW_TEXT = JSON.stringify(DEFAULT_FLOW, null, 2);

    // ───────────────────────────── 通用工具 ─────────────────────────────

    function cls() {
      let out = '';
      for (let i = 0; i < arguments.length; i += 1) {
        const value = arguments[i];
        if (!value) continue;
        out += (out ? ' ' : '') + String(value);
      }
      return out;
    }

    function isObject(value) {
      return !!value && typeof value === 'object';
    }

    function asArray(value) {
      return Array.isArray(value) ? value : [];
    }

    function finiteNumber(value, fallback) {
      const num = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(num) ? num : fallback;
    }

    /** 秒 → mm:ss（负数按 0 处理）。 */
    function fmtClock(seconds) {
      const total = Math.max(0, Math.round(finiteNumber(seconds, 0)));
      const mm = Math.floor(total / 60);
      const ss = total % 60;
      return String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
    }

    function fmtBytes(bytes) {
      const n = finiteNumber(bytes, 0);
      if (n <= 0) return '0 B';
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
      return (n / 1024 / 1024).toFixed(1) + ' MB';
    }

    function fmtTime(ts) {
      const n = finiteNumber(ts, 0);
      if (!n) return '';
      const date = new Date(n);
      if (Number.isNaN(date.getTime())) return '';
      const hh = String(date.getHours()).padStart(2, '0');
      const mi = String(date.getMinutes()).padStart(2, '0');
      const ss = String(date.getSeconds()).padStart(2, '0');
      return hh + ':' + mi + ':' + ss;
    }

    function fmtDateTime(ts) {
      const n = finiteNumber(ts, 0);
      if (!n) return '—';
      const date = new Date(n);
      if (Number.isNaN(date.getTime())) return '—';
      return date.toLocaleString();
    }

    function sideLabel(side) {
      if (side === 'pro') return '正方';
      if (side === 'con') return '反方';
      return '双方';
    }

    function modeLabel(mode) {
      if (mode === 'demo') return '演示';
      if (mode === 'mixed') return '混合';
      return 'AI';
    }

    function initialOf(name) {
      const text = String(name || '').trim();
      if (!text) return '辩';
      return text.slice(0, 1).toUpperCase();
    }

    /** 头像底色：优先用 Host 下发的 color，其次用本侧主题令牌。 */
    function avatarColor(agent, side) {
      if (agent && typeof agent.color === 'string' && agent.color) return agent.color;
      return side === 'con'
        ? 'var(--dsw-alias-state-warn-primary, #d98324)'
        : 'var(--dsw-alias-brand-primary, #4d6bfe)';
    }

    // ───────────────────────────── HTTP ─────────────────────────────

    function networkMessage(error) {
      if (error && error.name === 'AbortError') return '请求超时：辩论引擎没有在规定时间内响应，请稍后重试。';
      const raw = error && error.message ? String(error.message) : String(error || '');
      if (/Failed to fetch|NetworkError|Load failed|network error/i.test(raw)) {
        return '网络请求失败：无法连接辩论引擎，请确认 DSH Web 服务正在运行后重试。';
      }
      if (/JSON/i.test(raw)) return raw;
      return raw ? '请求失败：' + raw : '请求失败：未知错误。';
    }

    async function requestJson(path, options) {
      const opts = options || {};
      const canAbort = typeof AbortController === 'function';
      const controller = canAbort ? new AbortController() : null;
      const timeoutMs = finiteNumber(opts.timeoutMs, 15000);
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
      const init = {
        method: opts.method || 'GET',
        headers: {},
        credentials: 'same-origin',
        cache: 'no-store',
      };
      if (opts.body !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(opts.body);
      }
      if (controller) init.signal = controller.signal;
      let response;
      try {
        response = await fetch(path, init);
      } catch (error) {
        throw new Error(networkMessage(error));
      } finally {
        if (timer) clearTimeout(timer);
      }
      let text = '';
      try {
        text = await response.text();
      } catch (error) {
        throw new Error('读取响应失败：' + (error && error.message ? error.message : String(error)));
      }
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch (error) {
          data = null;
        }
      }
      if (!response.ok) {
        const reason = isObject(data) && (data.error || data.message) ? String(data.error || data.message) : '';
        throw new Error(reason
          ? '请求失败（HTTP ' + response.status + '）：' + reason
          : '请求失败（HTTP ' + response.status + '）。');
      }
      if (!isObject(data)) throw new Error('响应格式异常：辩论引擎返回的不是 JSON 对象。');
      if (data.ok === false) throw new Error(data.error ? String(data.error) : '辩论引擎返回了错误结果。');
      return data;
    }

    async function apiState() {
      const data = await requestJson(API_BASE + '/state');
      return isObject(data.state) ? data.state : null;
    }

    async function apiStart(topic, config) {
      const data = await requestJson(API_BASE + '/start', {
        method: 'POST',
        body: { topic, config },
        timeoutMs: 30000,
      });
      return isObject(data.state) ? data.state : null;
    }

    async function apiControl(action) {
      const data = await requestJson(API_BASE + '/control', {
        method: 'POST',
        body: { action },
        timeoutMs: 30000,
      });
      return isObject(data.state) ? data.state : null;
    }

    async function apiRecords(runId) {
      const suffix = runId ? '?runId=' + encodeURIComponent(runId) : '';
      const data = await requestJson(API_BASE + '/records' + suffix, { timeoutMs: 30000 });
      return isObject(data.records) ? data.records : null;
    }

    function fileHref(runId, rel) {
      return API_BASE + '/file?runId=' + encodeURIComponent(runId || '') + '&rel=' + encodeURIComponent(rel || '');
    }

    // ───────────────────────────── Hooks ─────────────────────────────

    /** 本地高频时钟：气泡倒计时按 current.endsAt 自己走，不依赖 800ms 轮询。 */
    function useNow(intervalMs, enabled) {
      const [now, setNow] = useState(() => Date.now());
      useEffect(() => {
        if (!enabled) return undefined;
        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), intervalMs);
        return () => clearInterval(timer);
      }, [intervalMs, enabled]);
      return now;
    }

    /** 800ms 轮询 /state；卸载时清定时器；页面隐藏时跳过请求。 */
    function useDebateState() {
      const [state, setState] = useState(null);
      const [pollError, setPollError] = useState('');
      const [loading, setLoading] = useState(true);
      const alive = useRef(true);

      useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
        };
      }, []);

      const reload = useCallback(async () => {
        try {
          const next = await apiState();
          if (!alive.current) return;
          if (next) setState(next);
          setPollError('');
        } catch (error) {
          if (!alive.current) return;
          setPollError(error && error.message ? error.message : '加载辩论状态失败。');
        } finally {
          if (alive.current) setLoading(false);
        }
      }, []);

      useEffect(() => {
        reload();
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden) return;
          reload();
        }, POLL_MS);
        return () => clearInterval(timer);
      }, [reload]);

      return { state, pollError, loading, reload, applyState: setState };
    }

    // ───────────────────────────── 基础组件 ─────────────────────────────

    function Avatar(props) {
      const size = finiteNumber(props.size, 40);
      const color = props.color || avatarColor(null, props.side);
      const ring = props.speaking
        ? { boxShadow: '0 0 0 2px var(--dsw-alias-brand-primary, #4d6bfe)' }
        : null;
      return h('span', {
        className: cls('dsd-avatar', props.speaking && 'is-speaking'),
        style: Object.assign({ width: size, height: size }, ring),
        'aria-hidden': 'true',
      }, h('svg', {
        viewBox: '0 0 40 40',
        width: size,
        height: size,
        role: 'img',
        'aria-label': props.name ? String(props.name) : '默认头像',
      },
      h('circle', { cx: 20, cy: 20, r: 20, fill: color }),
      h('circle', { cx: 20, cy: 15.5, r: 6.5, fill: 'var(--dsw-alias-label-primary-inverted, #ffffff)', opacity: 0.92 }),
      h('path', {
        d: 'M7.5 35c1.6-6.6 6.6-10 12.5-10s10.9 3.4 12.5 10z',
        fill: 'var(--dsw-alias-label-primary-inverted, #ffffff)',
        opacity: 0.92,
      }),
      h('text', {
        x: 20, y: 37.5, textAnchor: 'middle', fontSize: 6.4,
        fill: color, fontWeight: 700,
      }, initialOf(props.name))));
    }

    function Btn(props) {
      const variant = props.variant;
      const className = props.className;
      const children = props.children;
      const rest = {};
      Object.keys(props).forEach((key) => {
        if (key === 'variant' || key === 'className' || key === 'children') return;
        rest[key] = props[key];
      });
      return h('button', Object.assign({ type: 'button' }, rest, {
        className: cls('dsd-btn', variant && 'dsd-btn-' + variant, className),
      }), children);
    }

    function Banner(props) {
      return h('div', {
        className: cls('dsd-banner', props.tone === 'warn' ? 'dsd-banner-warn' : 'dsd-banner-error'),
        role: 'alert',
      },
      h('span', { className: 'dsd-banner-icon', 'aria-hidden': 'true' }, props.tone === 'warn' ? '⚠️' : '⛔'),
      h('div', { className: 'dsd-banner-body' }, props.children),
      props.onRetry
        ? h(Btn, { variant: 'ghost', onClick: props.onRetry }, '重试')
        : null);
    }

    function Empty(props) {
      return h('div', { className: 'dsd-empty' }, props.children || '暂无数据');
    }

    /**
     * 错误边界：本插件任何渲染异常都收在这里，绝不冒泡到宿主。
     */
    class ErrorBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
        this.handleRetry = this.handleRetry.bind(this);
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      componentDidCatch(error) {
        if (typeof console !== 'undefined' && console.error) {
          console.error('[debate-simulator] client render failed:', error);
        }
      }

      handleRetry() {
        this.setState({ error: null });
      }

      render() {
        if (!this.state.error) return this.props.children;
        return h('div', { className: 'dsd-crash', role: 'alert' },
          h('div', { className: 'dsd-crash-title' }, '辩论模拟界面出错了'),
          h('p', { className: 'dsd-crash-text' },
            '界面在渲染时遇到异常，宿主其他功能不受影响。可以重试，或关闭后重新打开。'),
          h('pre', { className: 'dsd-crash-detail' },
            String(this.state.error && this.state.error.message ? this.state.error.message : this.state.error)),
          h(Btn, { variant: 'primary', onClick: this.handleRetry }, '重试渲染'));
      }
    }

    // ───────────────────────────── 启动页 ─────────────────────────────

    function parsePositiveInt(raw, min, max, label, errors, field) {
      const text = String(raw == null ? '' : raw).trim();
      if (!text) {
        errors[field] = '请填写' + label + '。';
        return null;
      }
      const num = Number(text);
      if (!Number.isFinite(num) || !Number.isInteger(num)) {
        errors[field] = label + '必须是整数。';
        return null;
      }
      if (num < min || num > max) {
        errors[field] = label + '需在 ' + min + '–' + max + ' 之间。';
        return null;
      }
      return num;
    }

    function validateFlowText(text) {
      const trimmed = String(text || '').trim();
      if (!trimmed) return { flow: null, error: '' };
      if (trimmed === DEFAULT_FLOW_TEXT.trim()) return { flow: null, error: '' };
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch (error) {
        return { flow: null, error: '自定义赛制不是合法 JSON：' + (error && error.message ? error.message : String(error)) };
      }
      if (!Array.isArray(parsed)) return { flow: null, error: '自定义赛制必须是 JSON 数组（每个元素是一个环节）。' };
      if (parsed.length < 1 || parsed.length > 60) return { flow: null, error: '自定义赛制需包含 1–60 个环节。' };
      for (let i = 0; i < parsed.length; i += 1) {
        const stage = parsed[i];
        if (!isObject(stage)) return { flow: null, error: '第 ' + (i + 1) + ' 个环节不是对象。' };
        if (!stage.id || typeof stage.id !== 'string') return { flow: null, error: '第 ' + (i + 1) + ' 个环节缺少 id（字符串）。' };
        if (!stage.title || typeof stage.title !== 'string') return { flow: null, error: '第 ' + (i + 1) + ' 个环节缺少 title（中文环节名）。' };
        const seconds = Number(stage.seconds);
        if (!Number.isFinite(seconds) || seconds < 1 || seconds > 1800) {
          return { flow: null, error: '第 ' + (i + 1) + ' 个环节的 seconds 需在 1–1800 之间。' };
        }
      }
      return { flow: parsed, error: '' };
    }

    function LaunchPage(props) {
      const config = isObject(props.state) && isObject(props.state.config) ? props.state.config : {};
      const [topic, setTopic] = useState('');
      const [rounds, setRounds] = useState(() => String(finiteNumber(config.rounds, 3)));
      const [bubble, setBubble] = useState(() => String(finiteNumber(config.bubbleSeconds, 10)));
      const [discussionMin, setDiscussionMin] = useState(() => String(Math.round(finiteNumber(config.discussionSeconds, 180) / 6) / 10));
      const [judges, setJudges] = useState(() => String(finiteNumber(config.judges, 1)));
      const [timeScale, setTimeScale] = useState(() => String(finiteNumber(config.timeScale, 2)));
      const [provider, setProvider] = useState(() => String(config.provider || 'deepseek-account'));
      const [modelName, setModelName] = useState(() => String(config.model || 'deepseek-flash'));
      const [apiBase, setApiBase] = useState(() => String(config.apiBaseUrl || ''));
      const [apiKey, setApiKey] = useState('');
      const [promptJson, setPromptJson] = useState('');
      const [effort, setEffort] = useState(() => String(config.reasoningEffort || 'high'));
      const [trainingSide, setTrainingSide] = useState(() => (config.trainingSide === 'pro' || config.trainingSide === 'con' ? config.trainingSide : 'none'));
      const [simpleMode, setSimpleMode] = useState(() => config.simpleMode === true);
      const [loadFlow, setLoadFlow] = useState(() => config.loadFlow !== false);
      const [flowStages, setFlowStages] = useState(() => DEFAULT_FLOW.map((stage) => ({ ...stage, enabled: true })));
      const [flowText, setFlowText] = useState(DEFAULT_FLOW_TEXT);
      const [showFlow, setShowFlow] = useState(false);
      const [fieldErrors, setFieldErrors] = useState({});
      const seeded = useRef(false);

      // 首次拿到 Host 配置后回填一次表单（之后不再覆盖用户输入）。
      useEffect(() => {
        if (seeded.current || !isObject(props.state) || !isObject(props.state.config)) return;
        const cfg = props.state.config;
        seeded.current = true;
        if (cfg.rounds) setRounds(String(cfg.rounds));
        if (cfg.bubbleSeconds) setBubble(String(cfg.bubbleSeconds));
        if (cfg.discussionSeconds) setDiscussionMin(String(Math.round(cfg.discussionSeconds / 6) / 10));
        if (cfg.judges) setJudges(String(cfg.judges));
        if (cfg.timeScale) setTimeScale(String(cfg.timeScale));
        if (cfg.provider) setProvider(String(cfg.provider));
        if (cfg.model) setModelName(String(cfg.model));
        if (cfg.apiBaseUrl) setApiBase(String(cfg.apiBaseUrl));
        if (cfg.reasoningEffort) setEffort(String(cfg.reasoningEffort));
        if (cfg.trainingSide) setTrainingSide(String(cfg.trainingSide));
      }, [props.state]);

      const selectedStages = flowStages.filter((stage) => stage.enabled)
      const flowSummary = `已选 ${selectedStages.length}/${flowStages.length} 环节，总时长约 ${Math.max(1, Math.round(selectedStages.reduce((sum, stage) => sum + finiteNumber(stage.seconds, 0), 0) / 60))} 分钟`;

      function handleSubmit(event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        const errors = {};
        const topicText = String(topic || '').trim();
        if (!topicText) errors.topic = '请填写辩题。';
        else if (topicText.length > 200) errors.topic = '辩题最多 200 字（当前 ' + topicText.length + ' 字）。';
        const roundsNum = parsePositiveInt(rounds, 1, 12, '轮次', errors, 'rounds');
        const bubbleNum = parsePositiveInt(bubble, 1, 120, '气泡秒数', errors, 'bubble');
        const judgesNum = parsePositiveInt(judges, 1, 3, '评委数', errors, 'judges');
        const scaleNum = parsePositiveInt(timeScale, 1, 60, '节奏（时间缩放）', errors, 'timeScale');
        const minutes = Number(String(discussionMin || '').trim());
        let discussionSeconds = null;
        if (!String(discussionMin || '').trim() || !Number.isFinite(minutes)) {
          errors.discussion = '请填写讨论分钟数。';
        } else if (minutes < 0.5 || minutes > 30) {
          errors.discussion = '讨论时长需在 0.5–30 分钟之间。';
        } else {
          discussionSeconds = Math.round(minutes * 60);
          if (discussionSeconds < 30 || discussionSeconds > 1800) {
            errors.discussion = '讨论时长需在 30–1800 秒之间。';
          }
        }
        let customFlow = null
        if (!simpleMode) {
          if (selectedStages.length === 0) errors.flow = '至少勾选一个环节。'
          else {
            const changed = selectedStages.length !== flowStages.length
              || selectedStages.some((stage) => Number(stage.seconds) !== Number(DEFAULT_FLOW.find((item) => item.id === stage.id)?.seconds))
            if (changed) {
              customFlow = selectedStages.map((stage) => {
                const { enabled, ...rest } = stage
                return { ...rest, seconds: Math.max(1, Math.round(Number(stage.seconds) || rest.seconds || 60)) }
              })
            }
          }
        }
        if (flowText.trim() && flowText.trim() !== DEFAULT_FLOW_TEXT.trim()) {
          const parsed = validateFlowText(flowText)
          if (parsed.error) errors.flow = parsed.error
          else customFlow = parsed.flow
        }
        let parsedPrompts = null
        if (promptJson.trim()) {
          try {
            const value = JSON.parse(promptJson)
            if (!value || typeof value !== 'object' || Array.isArray(value)) errors.prompts = '提示词 JSON 必须是对象。'
            else parsedPrompts = value
          } catch {
            errors.prompts = '提示词 JSON 不是合法 JSON。'
          }
        }
        setFieldErrors(errors);
        if (Object.keys(errors).length > 0) return;
        props.onSubmit({
          topic: topicText,
          config: {
            rounds: roundsNum,
            bubbleSeconds: bubbleNum,
            discussionSeconds,
            judges: judgesNum,
            timeScale: scaleNum,
            provider: String(provider || '').trim() || null,
            model: String(modelName || '').trim() || null,
            apiBaseUrl: String(apiBase || '').trim() || null,
            apiKey: String(apiKey || '').trim() || null,
            prompts: parsedPrompts,
            reasoningEffort: String(effort || '').trim() || null,
            trainingSide: trainingSide === 'pro' || trainingSide === 'con' ? trainingSide : 'none',
            simpleMode,
            loadFlow,
            customFlow,
          },
        });
      }

      const busy = props.busy === 'start';

      return h('form', { className: 'dsd-launch', onSubmit: handleSubmit, noValidate: true },
        h('div', { className: 'dsd-launch-head' },
          h('div', null,
            h('h3', { className: 'dsd-launch-title' }, '开始一场辩论模拟'),
            h('p', { className: 'dsd-launch-sub' }, '管理员将依次调度讨论、8 名辩手串行发言、评委打分与教练总结；每轮结束自动归档。')),
          h('span', { className: 'dsd-grow' }),
          h('span', { className: 'dsd-badge dsd-badge-brand' }, String(rounds) + ' 轮 · ' + String(bubble) + 's 气泡')),

        props.error ? h(Banner, null, props.error) : null,

        h('div', { className: 'dsd-field dsd-field-wide' },
          h('label', { className: 'dsd-field-label', htmlFor: 'dsd-topic' }, '辩题', h('span', { className: 'dsd-required' }, '*')),
          h('textarea', {
            id: 'dsd-topic', className: cls('dsd-textarea', fieldErrors.topic && 'is-invalid'), rows: 2, maxLength: 260,
            placeholder: '例如：人工智能的发展会让人类更幸福还是更痛苦', value: topic,
            onChange: (event) => setTopic(event.target.value),
          }),
          fieldErrors.topic
            ? h('div', { className: 'dsd-field-error' }, fieldErrors.topic)
            : h('div', { className: 'dsd-hint' }, (topic || '').trim().length + ' / 200 字')),

        h('details', { className: 'dsd-menu', open: true },
          h('summary', null, '赛制'),
          h('div', { className: 'dsd-form-grid' },
            h(Field, { id: 'dsd-rounds', label: '轮次', hint: '1–100，默认 3；训练模式达到目标会提前结束', value: rounds, onChange: setRounds, error: fieldErrors.rounds, min: 1, max: 100, step: 1 }),
            h(Field, { id: 'dsd-bubble', label: '气泡秒数', hint: '1–120，每条发言停留时长', value: bubble, onChange: setBubble, error: fieldErrors.bubble, min: 1, max: 120, step: 1 }),
            h(Field, { id: 'dsd-discussion', label: '讨论分钟', hint: '0.5–30 分钟（每方限时）', value: discussionMin, onChange: setDiscussionMin, error: fieldErrors.discussion, min: 0.5, max: 30, step: 0.5 }),
            h(Field, { id: 'dsd-judges', label: '评委数', hint: '1–3 位', value: judges, onChange: setJudges, error: fieldErrors.judges, min: 1, max: 3, step: 1 })),
          h('details', { className: 'dsd-menu' },
            h('summary', null, '自定义赛制（15 项）'),
            h('div', { className: 'dsd-hint' }, flowSummary),
            h('div', { className: 'dsd-flow-list' },
              flowStages.map((stage, index) => h('div', { className: 'dsd-flow-row', key: stage.id },
                h('label', { className: 'dsd-check' },
                  h('input', {
                    type: 'checkbox', checked: stage.enabled,
                    onChange: (event) => setFlowStages((prev) => prev.map((item, i) => (i === index ? { ...item, enabled: event.target.checked } : item))),
                  }),
                  stage.title),
                h('input', {
                  className: 'dsd-flow-time', type: 'number', min: 1, max: 1800, value: stage.seconds,
                  onChange: (event) => setFlowStages((prev) => prev.map((item, i) => (i === index ? { ...item, seconds: event.target.value } : item))),
                }),
                h('span', { className: 'dsd-muted' }, '默认 ' + DEFAULT_FLOW[index].seconds + 's'))),
              h('div', { className: 'dsd-flow-row' },
                h('span', { className: 'dsd-check' }, '节奏（时间缩放）'),
                h('input', { className: 'dsd-flow-time', type: 'number', min: 1, max: 60, value: timeScale, onChange: (event) => setTimeScale(event.target.value) }),
                h('span', { className: 'dsd-muted' }, '默认 2'))))),

        h('details', { className: 'dsd-menu' },
          h('summary', null, '模型'),
          h('div', { className: 'dsd-form-grid' },
            h(Field, { id: 'dsd-provider', label: '模型服务', hint: '默认 deepseek-account', placeholder: 'deepseek-account', value: provider, onChange: setProvider, error: fieldErrors.provider }),
            h(Field, { id: 'dsd-model', label: '模型', hint: '默认 deepseek-flash', placeholder: 'deepseek-flash', value: modelName, onChange: setModelName, error: fieldErrors.model }),
            h('div', { className: 'dsd-field' },
              h('label', { className: 'dsd-field-label', htmlFor: 'dsd-apibase' }, 'API 地址（可选）'),
              h('input', { id: 'dsd-apibase', className: 'dsd-input', type: 'text', value: apiBase, onChange: (event) => setApiBase(event.target.value), placeholder: 'https://api.example.com/v1' }),
              h('div', { className: 'dsd-hint' }, 'OpenAI 兼容 /v1 地址；填了就走自定义接口')),
            h('div', { className: 'dsd-field' },
              h('label', { className: 'dsd-field-label', htmlFor: 'dsd-apikey' }, 'API 密钥（可选）'),
              h('input', { id: 'dsd-apikey', className: 'dsd-input', type: 'password', value: apiKey, onChange: (event) => setApiKey(event.target.value), placeholder: 'sk-...' }),
              h('div', { className: 'dsd-hint' }, '只在本次运行内存中使用，不写入归档')),
            h('div', { className: 'dsd-field' },
              h('label', { className: 'dsd-field-label', htmlFor: 'dsd-effort' }, '思考强度'),
              h('select', { id: 'dsd-effort', className: 'dsd-input', value: effort, onChange: (event) => setEffort(event.target.value) },
                h('option', { value: 'low' }, 'low（快）'),
                h('option', { value: 'medium' }, 'medium'),
                h('option', { value: 'high' }, 'high（默认）')),
              h('div', { className: 'dsd-hint' }, 'deepseek 默认 high'))) ),

        h('details', { className: 'dsd-menu' },
          h('summary', null, '高级'),
          h('div', { className: 'dsd-form-grid' },
            h('div', { className: 'dsd-field' },
              h('label', { className: 'dsd-field-label', htmlFor: 'dsd-training' }, '训练方'),
              h('select', { id: 'dsd-training', className: 'dsd-input', value: trainingSide, onChange: (event) => setTrainingSide(event.target.value) },
                h('option', { value: 'none' }, '无（普通模拟）'),
                h('option', { value: 'pro' }, '正方（达到目标提前结束）'),
                h('option', { value: 'con' }, '反方（达到目标提前结束）')),
              h('div', { className: 'dsd-hint' }, '训练方超过对手即提前结束'))),
          h('textarea', { className: 'dsd-textarea dsd-code', rows: 12, spellCheck: false, value: flowText, onChange: (event) => setFlowText(event.target.value), 'aria-label': '自定义赛制 JSON' }),
          h('div', { className: 'dsd-hint' }, 'JSON 版自定义赛制；留空或默认则用上面的逐环节配置。'),

        h('details', { className: 'dsd-menu' },
          h('summary', null, '提示词'),
          h('div', { className: 'dsd-field' },
            h('label', { className: 'dsd-field-label' }, '提示词 JSON（支持按人微调）'),
            h('textarea', {
              className: 'dsd-textarea dsd-code', rows: 10, spellCheck: false, value: promptJson,
              onChange: (event) => setPromptJson(event.target.value),
              placeholder: '{\n  "debater": "全局辩手补充",\n  "judge": "全局评委补充",\n  "coach": "全局教练补充",\n  "agents": {\n    "pro-1": "正方一辩专属要求",\n    "con-2": "反方二辩专属要求"\n  }\n}',
            }),
            fieldErrors.prompts
              ? h('div', { className: 'dsd-field-error' }, fieldErrors.prompts)
              : h('div', { className: 'dsd-hint' }, '键：debater / judge / coach / agents；agents 下可按 pro-1..pro-4、con-1..con-4 单人微调。')))),

        h('div', { className: 'dsd-launch-actions' },
          h(Btn, { variant: 'primary', type: 'submit', disabled: busy }, busy ? '正在启动…' : '开始辩论'),
          h('span', { className: 'dsd-hint' }, '启动时会先停止上一轮未完成 run。')));

    }

    function Field(props) {
      return h('div', { className: 'dsd-field' },
        h('label', { className: 'dsd-field-label', htmlFor: props.id }, props.label),
        h('input', {
          id: props.id,
          className: cls('dsd-input', props.error && 'is-invalid'),
          type: 'number',
          inputMode: 'numeric',
          min: props.min,
          max: props.max,
          step: props.step,
          value: props.value,
          disabled: props.disabled === true,
          onChange: (event) => props.onChange(event.target.value),
        }),
        props.error
          ? h('div', { className: 'dsd-field-error' }, props.error)
          : h('div', { className: 'dsd-hint' }, props.hint));
    }

    // ───────────────────────────── 辩论台 ─────────────────────────────

    function SpeechBubble(props) {
      const current = props.current;
      if (!isObject(current)) return null;
      const now = finiteNumber(props.now, Date.now());
      const endsAt = finiteNumber(current.endsAt, 0);
      const startedAt = finiteNumber(current.startedAt, 0);
      let remainMs;
      if (endsAt > 0) {
        remainMs = endsAt - now;
      } else {
        remainMs = finiteNumber(current.durationMs, finiteNumber(props.bubbleSeconds, 10) * 1000);
      }
      // 单气泡：只有 current 的发言者渲染，且剩余时间归零即消失。
      if (!(remainMs > 0)) return null;
      const totalMs = finiteNumber(current.durationMs, endsAt > startedAt ? endsAt - startedAt : remainMs) || remainMs;
      const pct = Math.max(0, Math.min(100, Math.round((remainMs / totalMs) * 100)));
      // 逐字显示：文本到达后按时间铺开，避免整段“啪”地出现。
      const fullText = String(current.text || '');
      const revealMs = Math.max(1200, Math.min(7000, fullText.length * 32));
      const revealRatio = startedAt > 0 ? Math.min(1, Math.max(0, (now - startedAt) / revealMs)) : 1;
      const shownText = revealRatio >= 1 ? fullText : fullText.slice(0, Math.ceil(fullText.length * revealRatio));
      const typing = revealRatio < 1;
      return h('div', { className: 'dsd-bubble', role: 'status', 'aria-live': 'polite' },
        isObject(props.stage) && props.stage.title
          ? h('div', { className: 'dsd-bubble-stage' }, props.stage.title)
          : (current.stageTitle ? h('div', { className: 'dsd-bubble-stage' }, current.stageTitle) : null),
        h('p', { className: 'dsd-bubble-text' }, shownText || '…', typing ? h('span', { className: 'dsd-caret' }, '▍') : null),
        h('div', { className: 'dsd-bubble-foot' },
          h('span', { className: 'dsd-bubble-count' }, Math.ceil(remainMs / 1000) + 's'),
          h('div', { className: 'dsd-bubble-bar' },
            h('div', { className: 'dsd-bubble-bar-fill', style: { width: pct + '%' } }))));
    }

    function DebaterCard(props) {
      const debater = props.debater || {};
      const current = props.current;
      const isCurrent = isObject(current) && current.speakerId === debater.id;
      const speaking = isCurrent || !!debater.speaking;
      return h('article', {
        className: cls('dsd-card', props.side === 'con' ? 'dsd-card-con' : 'dsd-card-pro',
          speaking && 'is-speaking', isCurrent && 'is-current'),
        'aria-label': (debater.name || '辩手') + (speaking ? ' 正在发言' : ''),
      },
      h('div', { className: 'dsd-card-top' },
        h(Avatar, { name: debater.name, color: debater.color, side: props.side, size: 40, speaking }),
        h('div', { className: 'dsd-card-meta' },
          h('div', { className: 'dsd-card-name' }, debater.name || (sideLabel(props.side) + '席位')),
          h('div', { className: 'dsd-card-role' },
            sideLabel(props.side)
              + (debater.seat ? ' · ' + debater.seat + ' 辩' : '')
              + (speaking ? ' · 发言中' : (debater.lastText ? ' · 已发言' : ''))))),
      isCurrent
        ? h(SpeechBubble, { current, now: props.now, bubbleSeconds: props.bubbleSeconds, stage: props.stage })
        : (debater.lastText
          ? h('p', { className: 'dsd-card-last' }, debater.lastText)
          : h('p', { className: 'dsd-card-last is-empty' }, '尚未发言')));
    }

    function SideColumn(props) {
      const state = props.state || {};
      const group = isObject(props.side === 'pro' ? state.pro : state.con) ? (props.side === 'pro' ? state.pro : state.con) : {};
      const debaters = asArray(group.debaters);
      const fallback = [1, 2, 3, 4].map((seat) => ({
        id: props.side + '-' + seat,
        name: sideLabel(props.side) + seat + '辩',
        seat,
      }));
      const list = debaters.length > 0 ? debaters : fallback;
      return h('section', { className: cls('dsd-side', props.side === 'pro' ? 'dsd-side-pro' : 'dsd-side-con') },
        h('div', { className: 'dsd-side-head' },
          h('span', { className: 'dsd-side-title' }, sideLabel(props.side)),
          h('span', { className: 'dsd-side-score' }, finiteNumber(group.score, 0)),
          h('span', { className: 'dsd-side-sub' }, debaters.length > 0 ? debaters.length + ' 名辩手' : '等待名单')),
        h('div', { className: 'dsd-cards' },
          list.map((debater, index) => h(DebaterCard, {
            key: debater.id || (props.side + '-' + index),
            debater,
            side: props.side,
            current: state.current,
            now: props.now,
            bubbleSeconds: state.bubbleSeconds,
            stage: state.stage,
          }))));
    }

    function JudgeBar(props) {
      const judges = asArray(props.judges);
      return h('section', { className: 'dsd-judges', 'aria-label': '评委席' },
        h('div', { className: 'dsd-section-head' },
          h('span', { className: 'dsd-section-title' }, '评委席'),
          h('span', { className: 'dsd-muted' }, judges.length > 0 ? judges.length + ' 位评委 · 实时评分与点评' : '等待评委就位')),
        judges.length > 0
          ? h('div', { className: 'dsd-judge-list' },
            judges.map((judge, index) => h('div', { key: judge.id || ('judge-' + index), className: 'dsd-judge' },
              h(Avatar, { name: judge.name, color: judge.color, size: 30 }),
              h('div', { className: 'dsd-judge-body' },
                h('div', { className: 'dsd-judge-top' },
                  h('span', { className: 'dsd-judge-name' }, judge.name || ('评委 ' + (index + 1))),
                  h('span', { className: 'dsd-judge-score' },
                    '正 ' + finiteNumber(judge.scorePro, 0) + ' : ' + finiteNumber(judge.scoreCon, 0) + ' 反')),
                h('p', { className: 'dsd-judge-comment' }, judge.lastComment || '尚未点评')))))
          : h(Empty, null, '评委尚未发言'));
    }

    function DiscussionStrip(props) {
      const state = props.state || {};
      const discussion = isObject(state.discussion) ? state.discussion : {};
      const turns = asArray(discussion.turns);
      if (!discussion.active && turns.length === 0) return null;
      const clock = isObject(state.clock) ? state.clock : {};
      const proTurns = turns.filter((turn) => turn.side !== 'con');
      const conTurns = turns.filter((turn) => turn.side === 'con');
      const column = (side, items) => h('div', { className: 'dsd-discussion-col' },
        h('div', { className: 'dsd-discussion-col-head' },
          h('span', { className: side === 'con' ? 'dsd-con-text' : 'dsd-pro-text' }, sideLabel(side)),
          h('span', { className: 'dsd-muted' }, ' · ' + items.length + ' 条')),
        items.length === 0
          ? h('div', { className: 'dsd-discussion-empty' }, '等待' + sideLabel(side) + '发言…')
          : h('div', { className: 'dsd-discussion-list' },
            items.map((turn, index) => h('div', {
              key: (turn.speakerId || 'turn') + '-' + index,
              className: cls('dsd-discussion-turn', side === 'con' ? 'dsd-turn-con' : 'dsd-turn-pro'),
            },
            h('span', { className: 'dsd-speaker' }, (turn.speakerName || sideLabel(side)) + '：'),
            h('span', { className: 'dsd-turn-text' }, turn.text || '')))));
      return h('section', { className: 'dsd-discussion', 'aria-label': '讨论环节' },
        h('div', { className: 'dsd-section-head' },
          h('span', { className: 'dsd-badge dsd-badge-warn' }, '双方讨论'),
          h('span', { className: 'dsd-muted' },
            discussion.active
              ? '正反同时进行 · 剩余 ' + fmtClock(clock.remaining)
              : '讨论已结束 · 共 ' + turns.length + ' 条（已写入双方讨论记录）')),
        h('div', { className: 'dsd-discussion-cols' },
          column('pro', proTurns),
          column('con', conTurns)));
    }

    function DraftStrip(props) {
      const state = props.state || {};
      const drafts = isObject(state.drafts) ? state.drafts : {};
      const pro = String(drafts.pro || '').trim();
      const con = String(drafts.con || '').trim();
      if (!pro && !con) return null;
      return h('details', { className: 'dsd-draft', open: true },
        h('summary', { className: 'dsd-draft-summary' }, '📝 草稿纸（仅旁观可见 · 实时更新）'),
        h('div', { className: 'dsd-draft-cols' },
          h('div', { className: 'dsd-draft-col' },
            h('div', { className: 'dsd-discussion-col-head dsd-pro-text' }, '正方草稿'),
            h('pre', { className: 'dsd-draft-text' }, pro || '（暂无）')),
          h('div', { className: 'dsd-draft-col' },
            h('div', { className: 'dsd-discussion-col-head dsd-con-text' }, '反方草稿'),
            h('pre', { className: 'dsd-draft-text' }, con || '（暂无）'))));
    }

    function ThoughtStrip(props) {
      const state = props.state || {};
      const thoughts = asArray(state.thoughts);
      if (thoughts.length === 0) return null;
      const latest = thoughts.slice(-4);
      return h('details', { className: 'dsd-draft dsd-thought-panel', open: true },
        h('summary', { className: 'dsd-draft-summary' }, '💭 思考层（不对外发言 · 仅观众可见）'),
        h('div', { className: 'dsd-thought-list' },
          latest.map((item, index) => h('div', { className: 'dsd-thought-row', key: item.id || index },
            h('span', { className: 'dsd-speaker' }, (item.speakerName || '辩手') + '：'),
            h('span', { className: 'dsd-thought-text' }, item.text || '')))));
    }

    function HuddleStrip(props) {
      const state = props.state || {};
      const huddles = isObject(state.huddles) ? state.huddles : {};
      const pro = asArray(huddles.pro);
      const con = asArray(huddles.con);
      if (pro.length === 0 && con.length === 0) return null;
      const column = (side, items) => h('div', { className: 'dsd-discussion-col' },
        h('div', { className: 'dsd-discussion-col-head' },
          h('span', { className: side === 'con' ? 'dsd-con-text' : 'dsd-pro-text' }, sideLabel(side) + '队内'),
          h('span', { className: 'dsd-muted' }, ' · ' + items.length + ' 条')),
        items.length === 0
          ? h('div', { className: 'dsd-discussion-empty' }, '暂无场边讨论')
          : h('div', { className: 'dsd-discussion-list' },
            items.slice(-6).map((item, index) => h('div', {
              key: (item.speakerId || 'h') + '-' + index,
              className: cls('dsd-discussion-turn', side === 'con' ? 'dsd-turn-con' : 'dsd-turn-pro'),
            },
            h('span', { className: 'dsd-speaker' }, (item.speakerName || sideLabel(side)) + '：'),
            h('span', { className: 'dsd-turn-text' }, item.text || '')))));
      return h('section', { className: 'dsd-discussion', 'aria-label': '队内讨论' },
        h('div', { className: 'dsd-section-head' },
          h('span', { className: 'dsd-badge dsd-badge-warn' }, '队内讨论 · 非发言人'),
          h('span', { className: 'dsd-muted' }, '辩论进行中，没在发言的辩手在场边小声商量')),
        h('div', { className: 'dsd-discussion-cols' }, column('pro', pro), column('con', con)));
    }

    function DebateToolbar(props) {
      const state = props.state || {};
      const stage = isObject(state.stage) ? state.stage : null;
      const clock = isObject(state.clock) ? state.clock : {};
      const scoreboard = isObject(state.scoreboard) ? state.scoreboard : {};
      const proScore = finiteNumber(scoreboard.pro, finiteNumber(isObject(state.pro) ? state.pro.score : 0, 0));
      const conScore = finiteNumber(scoreboard.con, finiteNumber(isObject(state.con) ? state.con.score : 0, 0));
      const total = Math.max(1, finiteNumber(clock.total, 1));
      const remain = Math.max(0, finiteNumber(clock.remaining, 0));
      const pct = Math.max(0, Math.min(100, Math.round((remain / total) * 100)));
      const paused = state.phase === 'paused';
      const active = !!state.active;
      const stageCount = Math.max(0, finiteNumber(state.stageCount, 0));
      const stageIndex = Math.max(0, finiteNumber(state.stageIndex, 0));

      return h('div', { className: 'dsd-toolbar' },
        h('div', { className: 'dsd-toolbar-main' },
          h('div', { className: 'dsd-scoreboard', 'aria-label': '计分板' },
            h('div', { className: 'dsd-score-side dsd-score-pro' },
              h('span', { className: 'dsd-score-label' }, '正方'),
              h('strong', { className: 'dsd-score-value' }, proScore)),
            h('span', { className: 'dsd-score-sep' }, ':'),
            h('div', { className: 'dsd-score-side dsd-score-con' },
              h('strong', { className: 'dsd-score-value' }, conScore),
              h('span', { className: 'dsd-score-label' }, '反方'))),
          h('div', { className: 'dsd-toolbar-actions' },
            h(Btn, { onClick: props.onOpenRecords, disabled: !state.runId, title: '查看全部发言记录' }, '📜 记录查看'),
            paused
              ? h(Btn, { variant: 'primary', onClick: () => props.onControl('resume'), disabled: props.busy }, '▶ 继续')
              : h(Btn, { onClick: () => props.onControl('pause'), disabled: props.busy || !active, title: '在下一回合前挂起' }, '⏸ 暂停'),
            h(Btn, { onClick: () => props.onControl('skip'), disabled: props.busy || !active || paused, title: '结束当前气泡等待' }, '⏭ 跳过'),
            h(Btn, { onClick: props.onStopClick, disabled: props.busy || !active, variant: 'danger' },
              props.stopArmed ? '再次点击确认停止' : '⏹ 停止'),
            h(Btn, { onClick: props.onOpenArchive, title: '本轮与历史归档' }, '📦 归档'),
            !active ? h(Btn, { onClick: props.onNewRun, variant: 'primary' }, '＋ 新辩论') : null)),

        h('div', { className: 'dsd-toolbar-sub' },
          h('div', { className: 'dsd-stage-block' },
            h('div', { className: 'dsd-stage-line' },
              h('span', { className: 'dsd-stage-title' }, stage && stage.title ? stage.title : (active ? '准备中…' : '未开始')),
              stageCount > 0 ? h('span', { className: 'dsd-muted' }, '环节 ' + (stageIndex + 1) + ' / ' + stageCount) : null,
              stage && stage.kind ? h('span', { className: 'dsd-muted' }, '· ' + stage.kind) : null,
              stage && stage.singleSide
                ? h('span', { className: 'dsd-muted' }, '· 单边计时（仅' + sideLabel(stage.side) + '）')
                : stage && stage.perSide
                  ? h('span', { className: 'dsd-muted' }, '· 双方分别计时')
                  : null),
            stage && stage.description ? h('div', { className: 'dsd-stage-desc' }, stage.description) : null),
          h('div', { className: 'dsd-timer' },
            h('div', { className: 'dsd-timer-row' },
              h('span', { className: 'dsd-timer-value' }, fmtClock(remain)),
              h('span', { className: 'dsd-timer-total' }, '/ ' + fmtClock(clock.total))),
            h('div', { className: 'dsd-progress', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 },
              h('div', { className: 'dsd-progress-fill', style: { width: pct + '%' } })),
            (finiteNumber(clock.pro, 0) > 0 || finiteNumber(clock.con, 0) > 0)
              ? h('div', { className: 'dsd-timer-sides' },
                h('span', { className: 'dsd-timer-pro' }, '正 ' + fmtClock(clock.pro)),
                h('span', { className: 'dsd-timer-con' }, '反 ' + fmtClock(clock.con)))
              : null)));
    }

    function DebateView(props) {
      const state = props.state || {};
      const [stopArmed, setStopArmed] = useState(false);
      const now = useNow(250, !!state.current);
      const armTimer = useRef(null);

      useEffect(() => () => {
        if (armTimer.current) clearTimeout(armTimer.current);
      }, []);

      function handleStopClick() {
        if (!stopArmed) {
          setStopArmed(true);
          if (armTimer.current) clearTimeout(armTimer.current);
          armTimer.current = setTimeout(() => setStopArmed(false), 4000);
          return;
        }
        setStopArmed(false);
        if (armTimer.current) clearTimeout(armTimer.current);
        props.onControl('stop');
      }

      return h('div', { className: 'dsd-debate' },
        h(DebateToolbar, {
          state,
          busy: props.busy,
          stopArmed,
          onStopClick: handleStopClick,
          onControl: props.onControl,
          onOpenRecords: props.onOpenRecords,
          onOpenArchive: props.onOpenArchive,
          onNewRun: props.onNewRun,
        }),
        state.recovered
          ? h('div', { className: 'dsd-recover' },
            h('span', { className: 'dsd-recover-icon', 'aria-hidden': 'true' }, '♻️'),
            h('div', { className: 'dsd-recover-body' },
              h('div', { className: 'dsd-recover-title' }, '检测到未完成的上一轮'),
              h('div', { className: 'dsd-muted' }, '上次运行中断，状态已保存并暂停。恢复后会从断点继续本轮辩论。')),
            h(Btn, { variant: 'primary', onClick: () => props.onControl('resume-run'), disabled: props.busy }, '恢复上一轮'))
          : null,
        state.error ? h(Banner, { tone: 'warn' }, String(state.error)) : null,        h(DiscussionStrip, { state }),
        h(DraftStrip, { state }),
        h(ThoughtStrip, { state }),
        h(HuddleStrip, { state }),
        h('div', { className: 'dsd-arena' },
          h(SideColumn, { state, side: 'pro', now }),
          h(SideColumn, { state, side: 'con', now })),
        h(JudgeBar, { judges: state.judges }));
    }

    // ───────────────────────────── Modal 基座 ─────────────────────────────

    function Modal(props) {
      return h('div', { className: 'dsd-modal-mask' },
        h('div', {
          className: 'dsd-modal',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': props.title,
          style: props.width ? { maxWidth: props.width } : null,
        },
        h('div', { className: 'dsd-modal-head' },
          h('h3', { className: 'dsd-modal-title' }, props.title),
          h('span', { className: 'dsd-grow' }),
          props.actions || null,
          h('button', {
            type: 'button',
            className: 'dsd-icon-btn',
            'aria-label': '关闭',
            title: '关闭（Esc）',
            onClick: props.onClose,
          }, '✕')),
        h('div', { className: 'dsd-modal-body' }, props.children)));
    }

    // ───────────────────────────── 记录 Modal ─────────────────────────────

    function RecordsModal(props) {
      const [records, setRecords] = useState(null);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState('');
      const [filter, setFilter] = useState('all');

      const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
          const next = await apiRecords(props.runId);
          setRecords(next);
        } catch (err) {
          setError(err && err.message ? err.message : '加载记录失败。');
        } finally {
          setLoading(false);
        }
      }, [props.runId]);

      useEffect(() => {
        load();
      }, [load]);

      return h(Modal, {
        title: '辩论记录',
        onClose: props.onClose,
        width: '980px',
        actions: h('div', { className: 'dsd-filter' },
          ['all', 'pro', 'con'].map((key) => h('button', {
            key,
            type: 'button',
            className: cls('dsd-filter-item', filter === key && 'is-active'),
            'aria-pressed': filter === key,
            onClick: () => setFilter(key),
          }, key === 'all' ? '全部' : sideLabel(key)))),
      },
      loading ? h('div', { className: 'dsd-loading' }, '正在加载记录…') : null,
      error ? h(Banner, { onRetry: load }, error) : null,
      !loading && !error && !records ? h(Empty, null, '本轮还没有记录。') : null,
      !loading && !error && records ? h(RecordsBody, { records, filter }) : null);
    }

    function RecordsBody(props) {
      const records = props.records || {};
      const rounds = asArray(records.rounds);
      const filter = props.filter || 'all';
      const final = isObject(records.final) ? records.final : {};
      if (rounds.length === 0) return h(Empty, null, '暂无历史轮次。');

      const keep = (side) => filter === 'all' || side === filter;

      return h('div', { className: 'dsd-records' },
        h('div', { className: 'dsd-records-head' },
          h('div', { className: 'dsd-records-topic' }, records.topic || '未命名辩题'),
          h('span', { className: 'dsd-badge' }, modeLabel(records.mode)),
          h('span', { className: 'dsd-muted' }, rounds.length + ' 轮记录')),

        rounds.map((round, roundIndex) => {
          const scores = isObject(round.scores) ? round.scores : {};
          const discussion = isObject(round.discussion) ? round.discussion : {};
          const discussionPro = asArray(discussion.pro).filter(() => keep('pro'));
          const discussionCon = asArray(discussion.con).filter(() => keep('con'));
          const stages = asArray(round.stages);
          return h('details', {
            key: 'round-' + (round.round || roundIndex),
            className: 'dsd-rec-round',
            open: roundIndex === rounds.length - 1,
          },
          h('summary', { className: 'dsd-rec-round-summary' },
            h('span', { className: 'dsd-rec-round-title' }, '第 ' + finiteNumber(round.round, roundIndex + 1) + ' 轮'),
            h('span', { className: 'dsd-rec-score' },
              '正方 ' + finiteNumber(scores.pro, 0) + ' : ' + finiteNumber(scores.con, 0) + ' 反方'),
            h('span', { className: 'dsd-muted' }, stages.length + ' 个环节')),
          discussionPro.length > 0 || discussionCon.length > 0
            ? h('div', { className: 'dsd-rec-discussion' },
              h('div', { className: 'dsd-rec-section-title' }, '讨论'),
              h('div', { className: 'dsd-rec-discussion-cols' },
                h(DiscussionColumn, { side: 'pro', items: discussionPro }),
                h(DiscussionColumn, { side: 'con', items: discussionCon })))
            : null,
          h('div', { className: 'dsd-rec-stages' },
            stages.map((stage, stageIndex) => {
              const speeches = asArray(stage.speeches).filter((speech) => keep(speech.side));
              if (speeches.length === 0 && filter !== 'all') return null;
              return h('div', { key: 'stage-' + (stage.stageIndex != null ? stage.stageIndex : stageIndex), className: 'dsd-rec-stage' },
                h('div', { className: 'dsd-rec-stage-head' },
                  h('span', { className: 'dsd-rec-stage-title' }, stage.title || ('环节 ' + (stageIndex + 1))),
                  h('span', { className: 'dsd-badge' }, sideLabel(stage.side)),
                  h('span', { className: 'dsd-muted' }, fmtClock(stage.seconds) + ' · ' + speeches.length + ' 条发言')),
                speeches.length > 0
                  ? speeches.map((speech, speechIndex) => h('div', {
                    key: speech.id || (stageIndex + '-' + speechIndex),
                    className: cls('dsd-rec-speech', speech.side === 'con' ? 'dsd-turn-con' : 'dsd-turn-pro'),
                  },
                  h('span', { className: 'dsd-speaker' },
                    (speech.speakerName || sideLabel(speech.side))
                    + (speech.seat ? '（' + speech.seat + ' 辩）' : '')
                    + ' ' + (fmtTime(speech.at) || '')),
                  speech.thought
                    ? h('p', { className: 'dsd-rec-thought' }, '💭 ' + speech.thought)
                    : null,
                  h('p', { className: 'dsd-rec-text' }, speech.text || '')))
                  : h('div', { className: 'dsd-muted dsd-rec-none' }, '该环节没有「' + sideLabel(filter) + '」的发言'));
            })),
          asArray(round.judgeNotes).length > 0
            ? h('div', { className: 'dsd-rec-judges' },
              h('div', { className: 'dsd-rec-section-title' }, '评委记录'),
              asArray(round.judgeNotes).map((note, noteIndex) => h('div', {
                key: 'note-' + noteIndex,
                className: 'dsd-rec-note',
              },
              h('span', { className: 'dsd-speaker' },
                (note.judgeName || note.judgeId || '评委') + ' · 环节 ' + (finiteNumber(note.stageIndex, 0) + 1)),
              h('span', { className: 'dsd-rec-note-score' }, '正 ' + finiteNumber(note.pro, 0) + ' : ' + finiteNumber(note.con, 0) + ' 反'),
              h('p', { className: 'dsd-rec-text' }, note.comment || ''))))
            : null,
          round.archiveRel
            ? h('div', { className: 'dsd-rec-archive' },
              h('a', {
                className: 'dsd-link',
                href: fileHref(records.runId, round.archiveRel),
                download: true,
              }, '⬇ 下载本轮归档 ZIP'),
              h('span', { className: 'dsd-muted' }, round.archiveRel))
            : null);
        }),

        final.docxRel
          ? h('div', { className: 'dsd-rec-final' },
            h('span', { className: 'dsd-badge dsd-badge-brand' }, '最终产物'),
            h('a', { className: 'dsd-link', href: fileHref(records.runId, final.docxRel), download: true }, '⬇ 下载总结 DOCX'),
            h('span', { className: 'dsd-muted' }, final.docxRel))
          : null);
    }

    function DiscussionColumn(props) {
      const items = asArray(props.items);
      return h('div', { className: cls('dsd-rec-disc-col', props.side === 'con' ? 'dsd-turn-con' : 'dsd-turn-pro') },
        h('div', { className: 'dsd-rec-disc-side' }, sideLabel(props.side)),
        items.length > 0
          ? items.map((turn, index) => h('div', { key: (turn.speakerId || 't') + '-' + index, className: 'dsd-rec-disc-item' },
            h('span', { className: 'dsd-speaker' }, (turn.speakerName || '—') + '：'),
            h('span', null, turn.text || '')))
          : h('div', { className: 'dsd-muted' }, '无'));
    }

    // ───────────────────────────── 归档 Modal ─────────────────────────────

    function ArchiveModal(props) {
      const state = props.state || {};
      const archive = isObject(state.archive) ? state.archive : {};
      const zips = asArray(archive.zips);
      const runId = state.runId || '';
      return h(Modal, {
        title: '归档与下载',
        onClose: props.onClose,
        width: '820px',
      },
      !runId ? h(Empty, null, '当前没有可下载的 run，先开始一场辩论。') : null,
      runId
        ? h('div', { className: 'dsd-archive' },
          h('div', { className: 'dsd-archive-head' },
            h('span', { className: 'dsd-badge' }, 'runId'),
            h('code', { className: 'dsd-code-inline' }, runId)),
          h('div', { className: 'dsd-archive-section-title' }, '每轮归档 ZIP'),
          zips.length > 0
            ? h('div', { className: 'dsd-archive-list' },
              zips.map((zip, index) => h('div', { key: (zip.rel || 'zip') + index, className: 'dsd-archive-row' },
                h('span', { className: 'dsd-archive-name' }, zip.name || ('第 ' + finiteNumber(zip.round, index + 1) + ' 轮归档')),
                h('span', { className: 'dsd-muted' }, fmtBytes(zip.bytes)),
                h('span', { className: 'dsd-muted' }, fmtDateTime(zip.created)),
                h('a', { className: 'dsd-link', href: fileHref(runId, zip.rel), download: true }, '下载'))))
            : h('div', { className: 'dsd-muted dsd-rec-none' }, '本轮结束并打包后，这里会出现每轮 ZIP。'),

          h('div', { className: 'dsd-archive-section-title' }, '最终产物'),
          archive.finalDocx
            ? h('div', { className: 'dsd-archive-row' },
              h('span', { className: 'dsd-archive-name' }, archive.finalDocx.name || '辩论模拟总结.docx'),
              h('span', { className: 'dsd-muted' }, fmtBytes(archive.finalDocx.bytes)),
              h('a', { className: 'dsd-link', href: fileHref(runId, archive.finalDocx.rel), download: true }, '下载 DOCX'))
            : h('div', { className: 'dsd-muted dsd-rec-none' }, '最后一轮结束后生成 Word 总结。'),
          archive.summaryMd
            ? h('div', { className: 'dsd-archive-row' },
              h('span', { className: 'dsd-archive-name' }, archive.summaryMd.name || '全部轮次汇总.md'),
              h('a', { className: 'dsd-link', href: fileHref(runId, archive.summaryMd.rel), download: true }, '下载 Markdown'))
            : null,
          archive.trainingDocx
            ? h('div', { className: 'dsd-archive-row' },
              h('span', { className: 'dsd-archive-name' }, archive.trainingDocx.name || '训练方备赛包.docx'),
              h('span', { className: 'dsd-muted' }, fmtBytes(archive.trainingDocx.bytes)),
              h('a', { className: 'dsd-link', href: fileHref(runId, archive.trainingDocx.rel), download: true }, '下载 DOCX'))
            : null,
          archive.trainingMd
            ? h('div', { className: 'dsd-archive-row' },
              h('span', { className: 'dsd-archive-name' }, archive.trainingMd.name || '训练方备赛包.md'),
              h('a', { className: 'dsd-link', href: fileHref(runId, archive.trainingMd.rel), download: true }, '下载 Markdown'))
            : null,
          h('div', { className: 'dsd-hint dsd-archive-hint' },
            '下载走 /api/dsh-debate/file?runId=&rel=，rel 由 Host 做防穿越校验。'))
        : null);
    }

    // ───────────────────────────── 侧边栏图标 + main 模块页 ─────────────────────────────

    /**
     * 侧边栏图标：纯展示组件（owner props: { size, active }）。
     * 不轮询、不订阅状态、不持有定时器；选中态只影响描边颜色。
     */
    function DebatePanelIcon(props) {
      const size = finiteNumber(props && props.size, 20) || 20;
      const active = !!(props && props.active);
      const color = active
        ? 'var(--dsw-alias-brand-primary, #4d6bfe)'
        : 'var(--dsw-alias-label-secondary, #6b7280)';
      return h('svg', {
        className: cls('dsd-nav-icon', active && 'is-active'),
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        role: 'img',
        'aria-label': '辩论模拟',
        focusable: 'false',
      },
      h('path', { d: 'M12 3.4v15', stroke: color, strokeWidth: 1.6, strokeLinecap: 'round', fill: 'none' }),
      h('path', { d: 'M8.2 20.6h7.6', stroke: color, strokeWidth: 1.6, strokeLinecap: 'round', fill: 'none' }),
      h('path', { d: 'M4.4 6.4h15.2', stroke: color, strokeWidth: 1.6, strokeLinecap: 'round', fill: 'none' }),
      h('path', { d: 'M4.4 6.4 2.1 11.6a3.1 3.1 0 0 0 4.6 0z', stroke: color, strokeWidth: 1.25, strokeLinejoin: 'round', fill: 'none' }),
      h('path', { d: 'M19.6 6.4 17.3 11.6a3.1 3.1 0 0 0 4.6 0z', stroke: color, strokeWidth: 1.25, strokeLinejoin: 'round', fill: 'none' }),
      h('path', { d: 'M9.4 14.1h5.4l2 2.1v-2.1h.6a2 2 0 0 0 2-2v-1.4a2 2 0 0 0-2-2H9.4a2 2 0 0 0-2 2v1.4a2 2 0 0 0 2 2z', stroke: color, strokeWidth: 1.2, strokeLinejoin: 'round', fill: 'none' }));
    }

    /** 模块页顶部标题栏：⚖️ 辩论模拟 / 当前辩题 / 轮次 + 状态（无关闭按钮）。 */
    function PageHeader(props) {
      const state = props.state;
      const hasRun = !!(state && state.runId);
      const topic = state && state.topic ? String(state.topic) : '尚未开始';
      const active = !!(state && state.active);
      const agents = state && isObject(state.agents) ? state.agents : null;
      return h('header', { className: 'dsd-page-head' },
        h('span', { className: 'dsd-logo', 'aria-hidden': 'true' }, '⚖️'),
        h('span', { className: 'dsd-page-title' }, '辩论模拟'),
        h('span', { className: 'dsd-page-sep', 'aria-hidden': 'true' }),
        h('span', { className: 'dsd-page-topic', title: topic }, topic),
        hasRun
          ? h('span', { className: 'dsd-chip' },
            '第 ' + finiteNumber(state.round, 1) + ' / ' + finiteNumber(state.rounds, 1) + ' 轮')
          : null,
        hasRun && state.phaseLabel ? h('span', { className: 'dsd-chip' }, state.phaseLabel) : null,
        hasRun
          ? h('span', { className: cls('dsd-chip', 'dsd-chip-mode-' + (state.mode || 'ai')) }, modeLabel(state.mode))
          : null,
        hasRun && agents && finiteNumber(agents.count, 0) > 0
          ? h('span', { className: 'dsd-chip' },
            '智能体 ' + finiteNumber(agents.alive, 0) + ' / ' + finiteNumber(agents.count, 0))
          : null,
        state && state.recovered
          ? h('span', { className: 'dsd-chip dsd-chip-warn' }, '可恢复')
          : null,
        h('span', { className: 'dsd-grow' }),
        active
          ? h('span', { className: 'dsd-pulse' },
            h('span', { className: 'dsd-dot', 'aria-hidden': 'true' }),
            '进行中')
          : null);
    }

    /**
     * main 模块页：占满 main 区域的主栏整页。
     * 不用 fixed / backdrop / 悬浮按钮 / 圆角外框；轮询只发生在这一层（挂载时 800ms，卸载即清）。
     */
    function DebateModulePage() {
      const [modal, setModal] = useState(null);
      const [wantLaunch, setWantLaunch] = useState(false);
      const [busy, setBusy] = useState('');
      const [actionError, setActionError] = useState('');
      const { state, pollError, loading, reload, applyState } = useDebateState();

      const modalRef = useRef(null);
      modalRef.current = modal;

      // 模块页没有「关闭」语义：Esc 只关内部 Modal（记录 / 归档）。
      useEffect(() => {
        function onKeyDown(event) {
          if (!modalRef.current) return;
          if (event.key !== 'Escape' && event.key !== 'Esc') return;
          setModal(null);
          if (typeof event.stopPropagation === 'function') event.stopPropagation();
        }
        document.addEventListener('keydown', onKeyDown, true);
        return () => document.removeEventListener('keydown', onKeyDown, true);
      }, []);

      // 新 run 出现后自动回到辩论台。
      const runId = state && state.runId ? String(state.runId) : '';
      const previousRunId = useRef('');
      useEffect(() => {
        if (runId && runId !== previousRunId.current) {
          previousRunId.current = runId;
          setWantLaunch(false);
        }
        if (!runId) previousRunId.current = '';
      }, [runId]);

      const runControl = useCallback(async (action) => {
        setBusy(action);
        setActionError('');
        try {
          const next = await apiControl(action);
          if (next) applyState(next);
          await reload();
        } catch (error) {
          setActionError(error && error.message ? error.message : ('操作「' + action + '」失败。'));
        } finally {
          setBusy('');
        }
      }, [applyState, reload]);

      const submitStart = useCallback(async (payload) => {
        setBusy('start');
        setActionError('');
        try {
          const next = await apiStart(payload.topic, payload.config);
          if (next) applyState(next);
          setWantLaunch(false);
          await reload();
        } catch (error) {
          setActionError(error && error.message ? error.message : '启动辩论失败。');
        } finally {
          setBusy('');
        }
      }, [applyState, reload]);

      const showLaunch = !state || !runId || wantLaunch;

      return h('div', { className: 'dsd-page', role: 'region', 'aria-label': '辩论模拟' },
        h('style', null, STYLES),
        h(PageHeader, { state }),
        h('div', { className: 'dsd-page-body' },
          pollError ? h(Banner, { onRetry: reload }, pollError) : null,
          actionError ? h(Banner, null, actionError) : null,
          !state && loading ? h('div', { className: 'dsd-loading' }, '正在连接辩论引擎…') : null,
          !state && !loading && !pollError
            ? h(Empty, null, '辩论引擎暂不可用，请稍后重试。')
            : null,
          state && showLaunch
            ? h(LaunchPage, {
              state,
              busy,
              error: actionError,
              onSubmit: submitStart,
            })
            : null,
          state && !showLaunch
            ? h(DebateView, {
              state,
              busy,
              onControl: runControl,
              onOpenRecords: () => setModal('records'),
              onOpenArchive: () => setModal('archive'),
              onNewRun: () => setWantLaunch(true),
            })
            : null),

        modal === 'records'
          ? h(RecordsModal, { runId, onClose: () => setModal(null) })
          : null,
        modal === 'archive'
          ? h(ArchiveModal, { state: state || {}, onClose: () => setModal(null) })
          : null);
    }

    /** ErrorBoundary 包装后的 main 页：本模块崩溃不影响宿主与侧边栏。 */
    function Root() {
      return h(ErrorBoundary, null, h(DebateModulePage));
    }

    // ───────────────────────────── 样式（全部主题令牌） ─────────────────────────────

    const STYLES = `
.dsd-page{position:relative;height:100%;width:100%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);overflow:hidden;color:var(--dsw-alias-label-primary);font:13px/1.5 -apple-system,"Segoe UI",system-ui,"PingFang SC","Microsoft YaHei",sans-serif}
.dsd-page *,.dsd-page *::before,.dsd-page *::after{box-sizing:border-box}
.dsd-grow{flex:1 1 auto}
.dsd-nav-icon{display:block;flex:0 0 auto}

/* 主栏整页：标题栏 + 内容区（无 fixed / backdrop / 圆角外框） */
.dsd-page-head{flex:0 0 auto;display:flex;align-items:center;gap:9px;min-width:0;padding:12px 18px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.dsd-logo{font-size:16px;line-height:1}
.dsd-page-title{font-size:14px;font-weight:600;white-space:nowrap}
.dsd-page-sep{flex:0 0 auto;width:1px;height:14px;background:var(--dsw-alias-border-l2)}
.dsd-page-topic{min-width:0;max-width:46%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;color:var(--dsw-alias-label-secondary)}
.dsd-page-body{flex:1 1 auto;min-height:0;overflow:auto;padding:14px 18px 20px;display:flex;flex-direction:column;gap:12px}
.dsd-pulse{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-state-error-primary);padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-state-error-primary);white-space:nowrap}
.dsd-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-error-primary);animation:dsd-pulse 1.5s ease-in-out infinite}
@keyframes dsd-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.82)}}
.dsd-icon-btn{pointer-events:auto;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);width:28px;height:28px;border-radius:8px;cursor:pointer;font-size:13px;line-height:1;display:inline-flex;align-items:center;justify-content:center;font-family:inherit}
.dsd-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsd-icon-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}

/* 徽标/文案 */
.dsd-badge{display:inline-flex;align-items:center;padding:1px 8px;border-radius:999px;font-size:11px;line-height:18px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);white-space:nowrap}
.dsd-badge-brand{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dsd-badge-warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.dsd-chip{display:inline-flex;align-items:center;padding:0 7px;height:20px;border-radius:6px;font-size:11px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);white-space:nowrap}
.dsd-chip-warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.dsd-chip-mode-demo{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.dsd-chip-mode-mixed{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}
.dsd-muted{color:var(--dsw-alias-label-tertiary);font-size:11px}
.dsd-hint{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-top:4px}
.dsd-empty{padding:18px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px}
.dsd-loading{padding:26px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px}

/* 按钮 */
.dsd-btn{pointer-events:auto;display:inline-flex;align-items:center;justify-content:center;gap:5px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:6px 11px;font:inherit;font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s}
.dsd-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsd-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsd-btn:disabled{opacity:.45;cursor:not-allowed}
.dsd-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverted)}
.dsd-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);border-color:var(--dsw-alias-button-primary-hover)}
.dsd-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);background:transparent}
.dsd-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
.dsd-btn-ghost{background:transparent}
.dsd-link-btn{pointer-events:auto;border:0;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:12px;cursor:pointer;padding:0}
.dsd-link{color:var(--dsw-alias-link, var(--dsw-alias-brand-primary));font-size:12px;text-decoration:none;white-space:nowrap}
.dsd-link:hover{text-decoration:underline}

/* 横幅 */
.dsd-banner{display:flex;align-items:flex-start;gap:8px;padding:8px 11px;border-radius:9px;font-size:12px;border:1px solid var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-error-primary)}
.dsd-banner-warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-label, var(--dsw-alias-state-warn-primary))}
.dsd-banner-body{flex:1 1 auto;min-width:0;word-break:break-word}
.dsd-banner-icon{line-height:1.4}

/* 启动页 */
.dsd-launch{display:flex;flex-direction:column;gap:14px;max-width:1000px;width:100%;margin:0 auto}
.dsd-launch-head{display:flex;align-items:flex-start;gap:10px}
.dsd-launch-title{margin:0 0 3px;font-size:15px;font-weight:600}
.dsd-launch-sub{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;max-width:680px}
.dsd-field{display:flex;flex-direction:column;min-width:0}
.dsd-field-wide{grid-column:1/-1}
.dsd-field-label{font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:5px;display:flex;align-items:baseline;gap:4px}
.dsd-required{color:var(--dsw-alias-state-error-primary)}
.dsd-input,.dsd-textarea{pointer-events:auto;width:100%;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:7px 9px;outline:none;transition:border-color .15s}
.dsd-textarea{resize:vertical;min-height:56px;line-height:1.55}
.dsd-input:focus,.dsd-textarea:focus{border-color:var(--dsw-alias-brand-primary)}
.dsd-input.is-invalid,.dsd-textarea.is-invalid{border-color:var(--dsw-alias-state-error-primary)}
.dsd-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.5}
.dsd-form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
.dsd-menu{margin:10px 0;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:8px 12px}
.dsd-menu>summary{cursor:pointer;font-size:13px;font-weight:700;color:var(--dsw-alias-label-secondary);padding:2px 0}
.dsd-menu[open]>summary{margin-bottom:8px}
.dsd-prompt-grid{display:grid;grid-template-columns:1fr;gap:10px;margin-top:8px}
.dsd-flow-list{display:flex;flex-direction:column;gap:4px;max-height:360px;overflow:auto;margin-top:6px}
.dsd-flow-row{display:grid;grid-template-columns:1fr 84px 84px;gap:8px;align-items:center;padding:3px 4px;border-radius:6px}
.dsd-flow-row:hover{background:var(--dsw-alias-bg-layer-2)}
.dsd-flow-time{width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);padding:3px 5px;font:inherit;font-size:12px}
.dsd-check{display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;min-width:0;overflow:hidden}
.dsd-field-error{color:var(--dsw-alias-state-error-primary);font-size:11px;margin-top:4px}
.dsd-segment{display:inline-flex;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:2px;background:var(--dsw-alias-bg-layer-1);width:fit-content}
.dsd-segment-item{pointer-events:auto;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:4px 12px;border-radius:6px;cursor:pointer}
.dsd-segment-item.is-active{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverted)}
.dsd-flow-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dsd-launch-actions{display:flex;align-items:center;gap:12px;padding-top:2px}

/* 辩论台 */
.dsd-debate{display:flex;flex-direction:column;gap:12px}
.dsd-toolbar{display:flex;flex-direction:column;gap:10px;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.dsd-toolbar-main{display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap}
.dsd-scoreboard{display:flex;align-items:center;gap:10px;padding:6px 14px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}
.dsd-score-side{display:flex;align-items:baseline;gap:7px}
.dsd-score-label{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsd-score-value{font-size:22px;line-height:1.1;font-variant-numeric:tabular-nums}
.dsd-score-pro .dsd-score-value{color:var(--dsw-alias-brand-primary)}
.dsd-score-con .dsd-score-value{color:var(--dsw-alias-state-warn-primary)}
.dsd-score-sep{color:var(--dsw-alias-label-tertiary);font-size:14px}
.dsd-toolbar-actions{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;flex:1 1 auto}
.dsd-toolbar-sub{display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap;padding-top:8px;border-top:1px dashed var(--dsw-alias-border-l1)}
.dsd-stage-block{flex:1 1 320px;min-width:0}
.dsd-stage-line{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.dsd-stage-title{font-size:13px;font-weight:600}
.dsd-stage-desc{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-top:3px}
.dsd-timer{width:240px;max-width:100%;flex:0 0 auto}
.dsd-timer-row{display:flex;align-items:baseline;gap:6px;justify-content:flex-end}
.dsd-timer-value{font-size:19px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.dsd-timer-total{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dsd-progress{height:4px;border-radius:999px;background:var(--dsw-alias-border-l1);overflow:hidden;margin-top:5px}
.dsd-progress-fill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary);transition:width .5s linear}
.dsd-timer-sides{display:flex;justify-content:space-between;margin-top:4px;font-size:11px;font-variant-numeric:tabular-nums}
.dsd-timer-pro{color:var(--dsw-alias-brand-primary)}
.dsd-timer-con{color:var(--dsw-alias-state-warn-primary)}

/* 恢复横幅 */
.dsd-recover{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-bg-layer-2)}
.dsd-recover-icon{font-size:16px}
.dsd-recover-body{flex:1 1 auto;min-width:0}
.dsd-recover-title{font-size:12px;font-weight:600}

/* 讨论条：左右两栏同时展示双方讨论 */
.dsd-discussion{padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.dsd-section-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px}
.dsd-section-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dsd-discussion-cols{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.dsd-discussion-col{min-width:0;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);padding:6px 8px}
.dsd-discussion-col-head{font-size:11px;font-weight:700;margin-bottom:4px}
.dsd-pro-text{color:var(--dsw-alias-brand-primary)}
.dsd-con-text{color:var(--dsw-alias-state-warn-primary)}
.dsd-discussion-list{display:flex;flex-direction:column;gap:4px;max-height:170px;overflow:auto}
.dsd-discussion-empty{font-size:11px;color:var(--dsw-alias-label-tertiary);padding:4px 2px}
.dsd-discussion-turns{display:flex;flex-direction:column;gap:4px}
.dsd-discussion-turn{padding:5px 8px;border-radius:7px;background:var(--dsw-alias-bg-layer-1);border-left:2px solid var(--dsw-alias-border-l2);font-size:12px}
.dsd-discussion-turn.dsd-turn-pro{border-left-color:var(--dsw-alias-brand-primary)}
.dsd-discussion-turn.dsd-turn-con{border-left-color:var(--dsw-alias-state-warn-primary)}
.dsd-speaker{color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:600;margin-right:4px}
.dsd-draft{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:8px 12px}
.dsd-draft-summary{cursor:pointer;font-size:12px;font-weight:700;color:var(--dsw-alias-label-secondary)}
.dsd-draft-cols{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px}
.dsd-draft-col{min-width:0;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 8px;background:var(--dsw-alias-bg-layer-2)}
.dsd-draft-text{margin:4px 0 0;max-height:140px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Consolas,monospace;font-size:11px;line-height:1.55;color:var(--dsw-alias-label-secondary)}
.dsd-thought-panel{border-style:dashed}
.dsd-thought-list{display:flex;flex-direction:column;gap:3px;margin-top:6px;max-height:110px;overflow:auto}
.dsd-thought-row{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary)}

/* 左右阵营 */
.dsd-arena{display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start}
.dsd-side{display:flex;flex-direction:column;gap:8px;min-width:0}
.dsd-side-head{display:flex;align-items:baseline;gap:8px;padding-bottom:6px;border-bottom:2px solid var(--dsw-alias-border-l1)}
.dsd-side-pro .dsd-side-head{border-bottom-color:var(--dsw-alias-brand-primary)}
.dsd-side-con .dsd-side-head{border-bottom-color:var(--dsw-alias-state-warn-primary)}
.dsd-side-title{font-size:13px;font-weight:600}
.dsd-side-pro .dsd-side-title{color:var(--dsw-alias-brand-primary)}
.dsd-side-con .dsd-side-title{color:var(--dsw-alias-state-warn-primary)}
.dsd-side-score{font-size:16px;font-weight:600;font-variant-numeric:tabular-nums}
.dsd-side-sub{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-left:auto}
.dsd-cards{display:flex;flex-direction:column;gap:8px}
.dsd-card{display:flex;flex-direction:column;gap:7px;padding:9px 10px;border-radius:11px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);transition:border-color .15s,background .15s}
.dsd-card-pro.is-speaking{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}
.dsd-card-con.is-speaking{border-color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-bg-layer-2)}
.dsd-card-top{display:flex;align-items:center;gap:9px;min-width:0}
.dsd-avatar{display:inline-flex;flex:0 0 auto;border-radius:50%;overflow:hidden;background:var(--dsw-alias-bg-layer-3)}
.dsd-card-meta{min-width:0}
.dsd-card-name{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsd-card-role{font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.dsd-card-last{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dsd-card-last.is-empty{color:var(--dsw-alias-label-tertiary);font-style:italic}

/* 气泡（单气泡） */
.dsd-bubble{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-3);padding:8px 10px;display:flex;flex-direction:column;gap:5px}
.dsd-bubble-stage{font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.dsd-caret{display:inline-block;margin-left:1px;color:var(--dsw-alias-brand-primary);animation:dsd-caret 0.8s steps(1) infinite}
@keyframes dsd-caret{0%,49%{opacity:1}50%,100%{opacity:0}}
.dsd-thought{display:flex;gap:6px;align-items:flex-start;padding:5px 7px;border-radius:6px;background:var(--dsw-alias-bg-layer-1);border:1px dashed var(--dsw-alias-border-l2);font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.dsd-thought-label{flex:0 0 auto;font-weight:600;color:var(--dsw-alias-label-tertiary)}
.dsd-thought-text{min-width:0;font-style:italic}
.dsd-bubble-text{margin:0;font-size:12.5px;line-height:1.6;max-height:150px;overflow:auto;white-space:pre-wrap;word-break:break-word}
.dsd-bubble-foot{display:flex;align-items:center;gap:8px}
.dsd-bubble-count{font-size:10.5px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);min-width:26px}
.dsd-bubble-bar{flex:1 1 auto;height:3px;border-radius:999px;background:var(--dsw-alias-border-l1);overflow:hidden}
.dsd-bubble-bar-fill{height:100%;background:var(--dsw-alias-brand-primary);transition:width .25s linear}
.dsd-card-con .dsd-bubble-bar-fill{background:var(--dsw-alias-state-warn-primary)}

/* 评委条 */
.dsd-judges{padding:10px 12px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.dsd-judge-list{display:flex;gap:10px;overflow-x:auto;padding-bottom:2px}
.dsd-judge{display:flex;gap:8px;flex:0 0 auto;min-width:220px;max-width:340px;padding:8px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}
.dsd-judge-body{min-width:0}
.dsd-judge-top{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.dsd-judge-name{font-size:12px;font-weight:600}
.dsd-judge-score{font-size:10.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dsd-judge-comment{margin:3px 0 0;font-size:11.5px;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}

/* Modal */
.dsd-modal-mask{position:absolute;inset:0;pointer-events:auto;background:var(--dsw-alias-bg-mask-1);display:flex;align-items:center;justify-content:center;padding:24px;z-index:5}
.dsd-modal{display:flex;flex-direction:column;width:100%;max-height:82vh;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;overflow:hidden;box-shadow:0 18px 50px var(--dsw-alias-bg-mask-2)}
.dsd-modal-head{display:flex;align-items:center;gap:8px;padding:11px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.dsd-modal-title{margin:0;font-size:13px;font-weight:600}
.dsd-modal-body{flex:1 1 auto;min-height:0;overflow:auto;padding:12px 14px 16px;display:flex;flex-direction:column;gap:10px}
.dsd-filter{display:inline-flex;gap:3px;padding:2px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}
.dsd-filter-item{pointer-events:auto;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;padding:3px 10px;border-radius:6px;cursor:pointer}
.dsd-filter-item.is-active{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverted)}

/* 记录 */
.dsd-records{display:flex;flex-direction:column;gap:10px}
.dsd-records-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsd-records-topic{font-size:13px;font-weight:600}
.dsd-rec-round{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:8px 10px}
.dsd-rec-round-summary{display:flex;align-items:center;gap:10px;cursor:pointer;list-style:none;flex-wrap:wrap}
.dsd-rec-round-summary::-webkit-details-marker{display:none}
.dsd-rec-round-title{font-size:12.5px;font-weight:600}
.dsd-rec-score{font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dsd-rec-section-title{font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary);text-transform:uppercase;letter-spacing:.04em;margin:8px 0 5px}
.dsd-rec-discussion-cols{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.dsd-rec-disc-col{padding:7px 9px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border-left:2px solid var(--dsw-alias-border-l2);font-size:12px;min-width:0}
.dsd-rec-disc-col.dsd-turn-pro{border-left-color:var(--dsw-alias-brand-primary)}
.dsd-rec-disc-col.dsd-turn-con{border-left-color:var(--dsw-alias-state-warn-primary)}
.dsd-rec-disc-side{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);margin-bottom:4px}
.dsd-rec-disc-item{margin:3px 0;word-break:break-word}
.dsd-rec-stages{display:flex;flex-direction:column;gap:8px;margin-top:6px}
.dsd-rec-stage{padding:7px 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.dsd-rec-stage-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:5px}
.dsd-rec-stage-title{font-size:12px;font-weight:600}
.dsd-rec-speech{padding:5px 8px;margin:4px 0;border-radius:7px;background:var(--dsw-alias-bg-layer-1);border-left:2px solid var(--dsw-alias-border-l2);font-size:12px}
.dsd-rec-speech.dsd-turn-pro{border-left-color:var(--dsw-alias-brand-primary)}
.dsd-rec-speech.dsd-turn-con{border-left-color:var(--dsw-alias-state-warn-primary)}
.dsd-rec-text{margin:3px 0 0;line-height:1.55;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary)}
.dsd-rec-thought{margin:3px 0 0;font-size:11px;font-style:italic;line-height:1.5;color:var(--dsw-alias-label-tertiary);border-left:2px dashed var(--dsw-alias-border-l2);padding-left:6px}
.dsd-rec-none{font-size:11px;padding:2px 0}
.dsd-rec-judges{margin-top:6px}
.dsd-rec-note{padding:6px 8px;margin:4px 0;border-radius:7px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);font-size:12px}
.dsd-rec-note-score{font-size:10.5px;color:var(--dsw-alias-label-secondary);margin-left:8px;font-variant-numeric:tabular-nums}
.dsd-rec-archive{margin-top:8px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dsd-rec-final{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding-top:8px;border-top:1px dashed var(--dsw-alias-border-l1)}

/* 归档 */
.dsd-archive{display:flex;flex-direction:column;gap:8px}
.dsd-archive-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsd-code-inline{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;padding:2px 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);word-break:break-all}
.dsd-archive-section-title{font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary);margin-top:6px}
.dsd-archive-list{display:flex;flex-direction:column;gap:6px}
.dsd-archive-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:7px 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.dsd-archive-name{font-size:12px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis}
.dsd-archive-row .dsd-link{margin-left:auto}
.dsd-archive-hint{margin-top:4px}

/* 错误边界 */
.dsd-crash{height:100%;display:flex;flex-direction:column;justify-content:center;gap:8px;max-width:460px;margin:0 auto;padding:20px 22px;color:var(--dsw-alias-label-primary);font:13px/1.5 -apple-system,"Segoe UI",system-ui,"PingFang SC","Microsoft YaHei",sans-serif}
.dsd-crash-title{font-size:13px;font-weight:600;color:var(--dsw-alias-state-error-primary)}
.dsd-crash-text{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsd-crash-detail{margin:0;max-height:120px;overflow:auto;font-size:11px;padding:6px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);white-space:pre-wrap;word-break:break-word}

@media (max-width:880px){
  .dsd-arena{grid-template-columns:1fr}
  .dsd-rec-discussion-cols{grid-template-columns:1fr}
  .dsd-scoreboard{order:3}
}
`;

    // ───────────────────────────── 注册 ─────────────────────────────

    return {
      inject: ['slots'],
      apply(ctx) {
        // 侧边栏模块入口（与「自动化任务」「插件管理」「工具管理」并列）。
        // 图标只负责显示；点击由宿主选到同名 id 的 main key，不自己调 layout。
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'debate-simulator',
          order: 30,
          label: '辩论模拟',
        }, DebatePanelIcon));
        // main 整页模块：key 与上面的 id 一致，宿主据此配对。
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'debate-simulator',
        }, Root));
      },
    };
  },
});
