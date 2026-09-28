/**
 * 客户端半侧实现（浏览器）—— 唯一真源，由 esbuild 打包进 lib/client.js。
 *
 * ⚠️ 本文件不是发布产物；发布产物是 lib/client.js（由 `npm run build` 生成）。
 *
 * 包管理约定（与平台冻结模块表对齐，越界即浏览器端静默拿不到模块）：
 *   · 只允许 `import ... from 'react'`（及 react-dom 系）
 *   · **不得引入任何第三方依赖**
 *   · 不使用 JSX（保持无额外编译器依赖）
 *
 * ── 本插件的界面契约 ──────────────────────────────────────────────────────
 * 位置：输入区工具行 — `conversation.input.left`（slot 目录原文：'Compact controls
 *       at the left of the composer tool row'）。该槽位在 UI 上的落点是
 *       `.tools` 容器内、"工作区内修改"（`conversation.input.permission`，单占位）
 *       与计划控件之后 —— 即需求所指「“工作区内修改”控件右侧」。
 * 形态：`[📖] AI学习 ▾` 一个按钮 + 一个菜单，菜单顺序固定为四个入口。
 *
 * ── 与斜杠命令的关系（需求硬要求）─────────────────────────────────────────
 * 菜单里的每一项都**只调同一套 RPC**（`/api/dsh-learn-skills`），而 RPC 背后与
 * 宿主命令 `/learn` 是同一个 flows 实现。于是"按钮"与"自然语言/斜杠命令"不会
 * 出现两套规则。
 *
 * ── 问答在哪渲染 ─────────────────────────────────────────────────────
 * 在宿主自带的问答合成器里（`user-questions/request` 瀑布）。本插件只订阅该事件
 * 来显示"正在提问"的状态与取消按钮 —— **不自造问答界面**，因此键盘操作、
 * 无障碍标注、取消交互全部跟随宿主既有实现。
 */

import React from 'react'

import { unwrapEnvelope } from './envelope.mjs'

/** RPC 端点名（不含 /api 前缀）。必须与宿主 rpc.mjs 的 RPC_ENDPOINT 一致。 */
const RPC_ENDPOINT = 'dsh-learn-skills'

/** 菜单项顺序固定，名称与宿主 ENTRIES 逐字一致。 */
const MENU = [
  { id: 'init', label: '初始预设' },
  { id: 'distill', label: '收集提炼' },
  { id: 'upgrade', label: '关联升级' },
  { id: 'audit', label: '沉淀复用' },
]

const h = React.createElement

/** 内联样式（免去 CSS 注入与构建）。颜色走宿主 CSS 变量，主题自适应。 */
const S = {
  root: { position: 'relative', display: 'inline-flex', alignItems: 'center' },
  button: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '3px 8px', fontSize: 12, lineHeight: '18px',
    background: 'transparent', color: 'inherit', cursor: 'pointer',
    border: '1px solid var(--dsh-border, #dcdfe3)', borderRadius: 6,
    maxWidth: 132, whiteSpace: 'nowrap', overflow: 'hidden',
  },
  buttonOpen: { borderColor: 'var(--dsh-accent, #3b6cf0)' },
  buttonBusy: { opacity: 0.75, cursor: 'progress' },
  caret: { fontSize: 9, opacity: 0.7 },
  menu: {
    position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, zIndex: 60,
    minWidth: 220, padding: 4,
    background: 'var(--dsh-surface, #fff)', color: 'inherit',
    border: '1px solid var(--dsh-border, #dcdfe3)', borderRadius: 8,
    boxShadow: '0 6px 24px rgba(0,0,0,.14)',
  },
  item: {
    display: 'block', width: '100%', textAlign: 'left',
    padding: '6px 8px', fontSize: 12, lineHeight: '18px',
    background: 'transparent', color: 'inherit', cursor: 'pointer',
    border: 'none', borderRadius: 6,
  },
  itemDisabled: { opacity: 0.45, cursor: 'not-allowed' },
  itemDesc: { display: 'block', fontSize: 11, opacity: 0.62, marginTop: 1 },
  panel: {
    position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, zIndex: 61,
    // ⚠️ padding 归零：头/体/脚各自带内边距 —— 这样**头与脚才能 sticky 贴边**；
    //    否则 sticky 会停在容器 padding 内侧，正文从缝里透出去（观感很怪）。
    width: 'min(560px, 88vw)', maxHeight: 'min(70vh, 640px)', overflow: 'auto',
    padding: 0, fontSize: 12, lineHeight: 1.65, overscrollBehavior: 'contain',
    background: 'var(--dsh-surface, #fff)', color: 'inherit',
    border: '1px solid var(--dsh-border, #dcdfe3)', borderRadius: 10,
    boxShadow: '0 10px 32px rgba(0,0,0,.18)',
  },
  // ★ 头必须 sticky：正文很长时，操作按钮原来会随滚动**移出视野** ——
  //   真机症状就是「列出一份 md，却找不到"确认创建"」，于是什么都没生成。
  panelHead: {
    display: 'flex', alignItems: 'center', gap: 8,
    position: 'sticky', top: 0, zIndex: 2,
    padding: '10px 12px', marginBottom: 0,
    background: 'var(--dsh-surface, #fff)',
    borderBottom: '1px solid var(--dsh-border, #eef0f2)',
  },
  panelBody: { padding: '10px 12px' },
  // ★ 脚也必须 sticky：主操作**同时**出现在末尾，滚到底直接按，不必回头找。
  panelFoot: {
    display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
    position: 'sticky', bottom: 0, zIndex: 2,
    padding: '8px 12px',
    background: 'var(--dsh-surface, #fff)',
    borderTop: '1px solid var(--dsh-border, #eef0f2)',
  },
  footNote: { fontSize: 11, opacity: 0.6 },
  title: { fontWeight: 600, fontSize: 13 },
  spacer: { flex: 1 },
  small: { fontSize: 11, opacity: 0.66 },
  btn: {
    padding: '3px 10px', fontSize: 12, cursor: 'pointer',
    border: '1px solid var(--dsh-border, #dcdfe3)', borderRadius: 6,
    background: 'transparent', color: 'inherit',
  },
  btnPrimary: {
    padding: '3px 10px', fontSize: 12, cursor: 'pointer', border: '1px solid transparent',
    borderRadius: 6, background: 'var(--dsh-accent, #3b6cf0)', color: '#fff',
  },
  hint: {
    padding: '6px 8px', marginTop: 6, borderRadius: 6,
    background: 'rgba(127,127,127,.10)', fontSize: 11.5,
  },
  warn: {
    padding: '6px 8px', marginTop: 6, borderRadius: 6,
    background: 'rgba(214,140,0,.14)', fontSize: 11.5,
  },
  err: {
    padding: '6px 8px', marginTop: 6, borderRadius: 6,
    background: 'rgba(200,60,60,.14)', fontSize: 11.5,
  },
  pre: {
    margin: '6px 0 0', padding: 8, borderRadius: 6, maxHeight: 260, overflow: 'auto',
    background: 'rgba(127,127,127,.10)', fontSize: 11.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
  },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 11.5, marginTop: 4 },
  th: { textAlign: 'left', padding: '3px 5px', borderBottom: '1px solid var(--dsh-border, #e3e5e8)' },
  td: { padding: '3px 5px', borderBottom: '1px solid var(--dsh-border, #eef0f2)', verticalAlign: 'top' },
  badge: {
    display: 'inline-block', padding: '0 6px', borderRadius: 9, fontSize: 10.5,
    background: 'rgba(127,127,127,.14)', marginLeft: 6,
  },
}

/** 书本图标（内联 SVG，跟随 currentColor 与字号）。 */
function BookIcon() {
  return h('svg', { viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': 'true', focusable: 'false' },
    h('path', {
      fill: 'currentColor',
      d: 'M3.5 1.8h6.2c.9 0 1.6.7 1.6 1.6v9.8c0 .4-.3.6-.6.6H4.1c-.6 0-1.1-.5-1.1-1.1V2.9c0-.6.5-1.1 1.1-1.1Zm.6 1.1v8.9h6.1V3.5c0-.3-.2-.6-.6-.6H4.1Zm7.9 1.2c.4.2.7.6.7 1.1v8.3c0 .4-.3.6-.6.6H6.2a1.6 1.6 0 0 1-1-.3v-1.2c.2.1.4.1.6.1h6z',
    }),
    h('path', { fill: 'currentColor', opacity: 0.5, d: 'M5.2 4.6h3.6v1H5.2zm0 2h3.6v1H5.2zm0 2h2.6v1H5.2z' }),
  )
}

// 信封摊平已抽成纯函数模块（`./envelope.mjs`）——理由写在那份文件的头部：
// 它是客户端唯一会被"真机行为"证伪的逻辑，而本文件依赖 React、在 node 里测不了。
// ⚠️ 曾经的实现是个**空壳**（注释说要拆，代码却只 `return result`）：失败一律显示
//    「执行失败」、成功则各面板读到空值。这是实测教训，不要再合并回来。

/** 极简 markdown → React 节点（够体检报告用；不引第三方库）。 */
function renderMarkdown(text) {
  const lines = String(text ?? '').split('\n')
  const nodes = []
  let list = null
  let code = null
  const flushList = () => {
    if (list !== null) {
      nodes.push(h('ul', { key: `ul-${nodes.length}`, style: { margin: '4px 0', paddingLeft: 18 } },
        list.map((item, index) => h('li', { key: index }, inline(item)))))
      list = null
    }
  }
  const flushCode = () => {
    if (code !== null) {
      nodes.push(h('pre', { key: `pre-${nodes.length}`, style: S.pre }, code.join('\n')))
      code = null
    }
  }
  for (const raw of lines) {
    const line = raw.replace(/\s+$/u, '')
    if (line.startsWith('```')) {
      if (code === null) { flushList(); code = [] } else flushCode()
      continue
    }
    if (code !== null) { code.push(line); continue }
    if (/^\s*[-*]\s+/u.test(line)) {
      if (list === null) list = []
      list.push(line.replace(/^\s*[-*]\s+/u, ''))
      continue
    }
    flushList()
    if (/^#{1,6}\s/u.test(line)) {
      const level = (line.match(/^#+/u) ?? ['#'])[0].length
      nodes.push(h(`h${String(Math.min(level + 2, 6))}`, {
        key: `h-${nodes.length}`,
        style: { fontSize: level <= 2 ? 13 : 12.5, margin: '8px 0 4px', fontWeight: 600 },
      }, line.replace(/^#+\s*/u, '')))
      continue
    }
    if (/^\s*\|/u.test(line)) {
      const cells = line.split('|').slice(1, -1).map(cell => cell.trim())
      if (cells.every(cell => /^:?-{2,}:?$/u.test(cell))) continue
      nodes.push(h('div', { key: `row-${nodes.length}`, style: { display: 'flex', gap: 8, fontSize: 11.5 } },
        cells.map((cell, index) => h('span', { key: index, style: { flex: 1 } }, inline(cell)))))
      continue
    }
    if (line.trim() === '---') {
      nodes.push(h('hr', { key: `hr-${nodes.length}`, style: { border: 'none', borderTop: '1px solid var(--dsh-border, #e3e5e8)', margin: '8px 0' } }))
      continue
    }
    if (line.trim() === '') continue
    nodes.push(h('div', { key: `p-${nodes.length}`, style: { margin: '3px 0' } }, inline(line)))
  }
  flushList()
  flushCode()
  return nodes
}

/** 行内 `code` 与 **粗体** 的最小处理。 */
function inline(text) {
  const parts = String(text).split(/(`[^`]+`|\*\*[^*]+\*\*)/u)
  return parts.map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return h('code', { key: index, style: { padding: '0 3px', borderRadius: 3, background: 'rgba(127,127,127,.14)' } }, part.slice(1, -1))
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return h('strong', { key: index }, part.slice(2, -2))
    }
    return part
  })
}

/**
 * 主组件。
 *
 * 状态机刻意做得很浅（idle / menu / busy / preview / review / report / done），
 * 因为"重复点击产生并发写入"的防线不在状态机里，而在宿主：SessionStore 的
 * 单流程锁会拒绝第二次运行，这里只是把那个结果如实显示出来。
 */
function LearnMenu(props) {
  const useState = React.useState
  const useEffect = React.useEffect
  const useRef = React.useRef
  const rpc = props.rpc
  const useSession = props.useSession
  const sessionId = props.sessionId

  const s0 = useState(false); const open = s0[0]; const setOpen = s0[1]
  const s1 = useState(null); const status = s1[0]; const setStatus = s1[1]
  const s2 = useState('idle'); const view = s2[0]; const setView = s2[1]
  const s3 = useState(null); const payload = s3[0]; const setPayload = s3[1]
  const s4 = useState(null); const error = s4[0]; const setError = s4[1]
  const s5 = useState(null); const progress = s5[0]; const setProgress = s5[1]
  const abortRef = useRef(null)
  const rootRef = useRef(null)

  const running = view === 'busy'
  const workspaceBound = status?.ok === true && status.workspaceBound === true
  const session = useSession(state => state)

  // 状态总览：打开菜单时拉一次（保持轻量：不做轮询）。
  const refresh = React.useCallback(() => {
    return rpc('status', { sessionId }).then(result => {
      setStatus(result)
      return result
    }).catch(cause => {
      setStatus({ ok: false, code: cause.code ?? 'error', message: cause.message })
      return undefined
    })
  }, [rpc, sessionId])

  useEffect(() => { if (open) void refresh() }, [open, refresh])

  // 点外部关闭（与宿主自身的菜单行为一致）。
  useEffect(() => {
    if (!open) return undefined
    const onDown = event => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => { document.removeEventListener('mousedown', onDown) }
  }, [open])

  // 键盘可达性：Escape 关面板；菜单项是原生 button，Tab/Enter 天然可用。
  useEffect(() => {
    const onKey = event => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [])

  // 宿主提问期间显示"正在等你回答"（问题本身由宿主合成器渲染，本插件不自造界面）。
  useEffect(() => {
    if (view !== 'busy') return undefined
    setProgress(current => current ?? '正在准备…')
    return undefined
  }, [view])

  /** 起一个流程。取消句柄存进 ref，面板上的「取消」按钮用它。 */
  const start = (entry, extra = {}) => {
    setOpen(false)
    setError(null)
    setPayload(null)
    setView('busy')
    setProgress(progressTextFor(entry))
    const controller = new AbortController()
    abortRef.current = controller
    const method = entry === 'init' ? 'init' : entry === 'upgrade' ? 'upgrade' : entry
    rpc(method, { sessionId, ...extra }, controller.signal)
      .then(result => {
        abortRef.current = null
        if (result?.ok === false) {
          // 未绑定工作区 / 写门禁关闭 / 流程已在跑 —— 全部走可读的失败面板，不是静默。
          setView('failed')
          setPayload(result)
          return
        }
        setPayload(result)
        if (entry === 'init') setView(result.stage === 'created' ? 'created' : 'preview')
        else if (entry === 'upgrade') setView(result.stage === 'written' ? 'written' : 'review')
        else if (entry === 'audit') setView('report')
        else setView('done')
      })
      .catch(cause => {
        abortRef.current = null
        setError(cause)
        setView('failed')
      })
  }

  /**
   * 重新回答七题。
   *
   * 为什么要这个显式出口：宿主侧现在**默认复用**上一轮的答案（七题答完但没创建时，
   * 重进「初始预设」直接回到预览、不再把人问一遍）。想让用户重答，必须明确要求 ——
   * 否则"重复的问题"换了对象：从"不问"变成"想问也问不到"。
   */
  const restart = () => start('init', { restart: true })

  const cancel = () => {
    if (abortRef.current !== null) abortRef.current.abort()
    void rpc('cancel', { flow: view === 'review' ? 'upgrade' : 'init' }).catch(() => undefined)
    setView('failed')
    setPayload({
      ok: false,
      code: 'FLOW_CANCELLED',
      message: '已取消。已完成的步骤保留在工作区状态里；未开始的写入不会执行。',
    })
  }

  const confirmCreate = () => {
    setView('busy')
    setProgress('正在创建预设与工作区框架…')
    rpc('initConfirm', { sessionId })
      .then(result => {
        if (result?.ok === false) { setView('failed'); setPayload(result); return }
        setPayload(result)
        setView('created')
      })
      .catch(cause => { setError(cause); setView('failed') })
  }

  const confirmWrite = () => {
    setView('busy')
    setProgress('正在写入已确认的变更…')
    rpc('upgradeConfirm', { sessionId, batchId: payload?.batches?.[0] })
      .then(result => {
        if (result?.ok === false) { setView('failed'); setPayload(result); return }
        setPayload(result)
        setView('written')
      })
      .catch(cause => { setError(cause); setView('failed') })
  }

  /**
   * 把刚生成的预设 bundle 装进 profile（「界面一键」）。
   *
   * ★ 这一次点击**就是审批动作**：安装会在 Host 进程执行新代码。按钮文案与下方
   *   警示都会写明这一点 —— 不做"点了才知道"的暗动作。
   * ★ 成功/失败都**如实回显**：新装的 bundle 声明进不了当前名册，需要重启一次；
   *   把这一步说反，用户就会得到"装了却选不到"的二次误判。
   */
  const install = () => {
    if (payload?.installed !== undefined) return
    setPayload(current => ({ ...current, installing: true }))
    rpc('installPreset', { sessionId, presetId: payload?.preset?.presetId })
      .then(result => {
        setPayload(current => ({ ...current, installing: false, installed: result }))
      })
      .catch(cause => {
        setPayload(current => ({
          ...current,
          installing: false,
          installed: { ok: false, message: `安装请求失败：${String(cause?.message ?? cause)}` },
        }))
      })
  }

  const saveReport = () => {
    setView('busy')
    setProgress('正在保存报告与基线…')
    rpc('auditSave', {
      sessionId,
      report: payload?.report ?? '',
      baselineCandidate: payload?.baselineCandidate ?? {},
    }).then(result => {
      if (result?.ok === false) { setView('failed'); setPayload(result); return }
      setPayload({ ...payload, saved: result })
      setView('report')
    }).catch(cause => { setError(cause); setView('failed') })
  }

  return h('div', { ref: rootRef, style: S.root },
    h('button', {
      type: 'button',
      style: { ...S.button, ...(open ? S.buttonOpen : {}), ...(running ? S.buttonBusy : {}) },
      'aria-label': 'AI学习',
      'aria-haspopup': 'menu',
      'aria-expanded': open,
      onClick: () => { setOpen(!open); setView('idle'); setError(null) },
    },
    h(BookIcon),
    h('span', null, 'AI学习'),
    h('span', { style: S.caret, 'aria-hidden': 'true' }, '▾')),

    open ? renderMenu({
      status, workspaceBound, running, onPick: start,
    }) : null,
    !open && view !== 'idle' ? renderPanel({
      view, payload, error, progress, status,
      onClose: () => { setView('idle'); setError(null); setPayload(null) },
      onCancel: cancel, onConfirmCreate: confirmCreate, onConfirmWrite: confirmWrite,
      onInstall: install,
      onSaveReport: saveReport, onRestart: restart, session,
    }) : null,
  )
}

function progressTextFor(entry) {
  switch (entry) {
    case 'init': return '正在进行七轮问答 —— 请在会话输入区回答（问题由宿主渲染）。'
    case 'distill': return '正在固定消息范围并生成候选 —— 随后会请你逐批裁决。'
    case 'upgrade': return '正在比对既有知识 —— 随后会给出变更清单请你确认。'
    case 'audit': return '正在只读扫描工作区 —— 不会修改任何文件。'
    default: return '正在处理…'
  }
}

/** 菜单：四个入口，顺序固定。 */
function renderMenu(props) {
  const { status, workspaceBound, running } = props
  return h('div', { style: S.menu, role: 'menu', 'aria-label': 'AI学习入口' },
    MENU.map((item, index) => {
      const disabled = running
      return h('button', {
        key: item.id,
        type: 'button',
        role: 'menuitem',
        style: { ...S.item, ...(disabled ? S.itemDisabled : {}) },
        disabled,
        onClick: () => { if (!disabled) props.onPick(item.id) },
      },
      `${index + 1}. ${item.label}`,
      h('span', { style: S.itemDesc }, descriptionOf(item.id)))
    }),
    h('div', { style: { ...S.small, padding: '6px 8px 2px' } },
      status === undefined || status === null
        ? '正在读取工作区状态…'
        : status.ok === false
          ? status.message
          : workspaceBound
            ? `工作区：${status.workspace}｜${status.initialized ? '已初始化' : '未初始化（首次可先点「初始预设」）'}`
            + `${status.pendingBatches?.length > 0 ? `｜待处理批次 ${status.pendingBatches.length}` : ''}`
            + `${status.baselineAvailable ? '｜有体检基线' : '｜无体检基线'}`
            : '未绑定工作区'),
    !workspaceBound && status?.ok === false
      ? h('div', { style: S.hint }, '先点击输入区的「选择工作区」绑定一个目录，再回来打开本菜单。')
      : null,
  )
}

function descriptionOf(id) {
  switch (id) {
    case 'init': return '七轮问答确定画像，生成预设与工作区框架'
    case 'distill': return '从当前会话产出候选，逐条由你裁决'
    case 'upgrade': return '与既有节点比对后，经你确认写入'
    case 'audit': return '只读体检 + 变化对比 + 复用建议'
    default: return ''
  }
}

/** 面板：所有状态（进行中 / 预览 / 变更清单 / 报告 / 结果 / 失败）复用同一个外壳。 */
function renderPanel(props) {
  const { view, payload, error, progress, onClose } = props
  const title = {
    busy: 'AI学习',
    preview: '画像与拟建内容（尚未创建）',
    created: '已创建',
    review: '变更清单（尚未写入）',
    written: '写入结果',
    report: '知识体系体检报告',
    done: '候选已生成',
    failed: 'AI学习',
  }[view] ?? 'AI学习'

  // ★ 末尾常驻操作栏：主操作在头、尾**各放一份**。
  //   为什么必须这样：正文很长时，只在头部放按钮 = 用户滚下读完就再也够不着
  //   —— 真机症状「列出一份 md，最后面没有提交按钮，无法点击生成」（实测）。
  const footActions = []
  if (view === 'preview') {
    footActions.push(h('button', { key: 'f-primary', type: 'button', style: S.btnPrimary, onClick: props.onConfirmCreate }, '确认创建'))
    footActions.push(h('button', { key: 'f-close', type: 'button', style: S.btn, onClick: onClose }, '返回修改'))
    // 只有在"复用了上一轮答案"时才给「重新回答」—— 那时用户确实可能想重答。
    if (payload?.reused === true) {
      footActions.push(h('button', { key: 'f-restart', type: 'button', style: S.btn, onClick: props.onRestart }, '重新回答'))
    }
    footActions.push(h('span', { key: 'f-note', style: S.footNote }, '确认后才会写入；此刻还没有创建任何文件。'))
  } else if (view === 'review') {
    footActions.push(h('button', { key: 'f-primary', type: 'button', style: S.btnPrimary, onClick: props.onConfirmWrite }, '确认写入'))
    footActions.push(h('button', { key: 'f-close', type: 'button', style: S.btn, onClick: onClose }, '暂不写入'))
    footActions.push(h('span', { key: 'f-note', style: S.footNote }, '确认后才会写入；此刻磁盘未改动。'))
  } else if (view === 'report' && payload?.saved === undefined) {
    footActions.push(h('button', { key: 'f-primary', type: 'button', style: S.btnPrimary, onClick: props.onSaveReport }, '保存报告与对比基线'))
    footActions.push(h('button', { key: 'f-close', type: 'button', style: S.btn, onClick: onClose }, '关闭'))
  } else if (view === 'created' && payload?.preset?.ok === true) {
    // 「界面一键」的主操作：把预设装进 profile。已装/安装中都不再给按钮。
    if (installedNote(payload) !== null) {
      footActions.push(h('span', { key: 'f-install-note', style: S.footNote }, installedNote(payload)))
    } else {
      footActions.push(installButton(payload, props.onInstall))
    }
    footActions.push(h('button', { key: 'f-close', type: 'button', style: S.btn, onClick: onClose }, '关闭'))
  } else {
    footActions.push(h('button', { key: 'f-close', type: 'button', style: S.btn, onClick: onClose }, '关闭'))
  }

  return h('div', { style: S.panel, role: 'dialog', 'aria-label': title },
    h('div', { style: S.panelHead },
      h('span', { style: S.title }, title),
      view === 'busy' ? h('span', { style: { ...S.small, marginLeft: 6 } }, '进行中…') : null,
      h('span', { style: S.spacer }),
      view === 'busy' ? h('button', { type: 'button', style: S.btn, onClick: props.onCancel }, '取消') : null,
      view === 'preview' ? h('button', { type: 'button', style: S.btnPrimary, onClick: props.onConfirmCreate }, '确认创建') : null,
      view === 'preview' ? h('button', { type: 'button', style: S.btn, onClick: onClose }, '返回修改') : null,
      view === 'review' ? h('button', { type: 'button', style: S.btnPrimary, onClick: props.onConfirmWrite }, '确认写入') : null,
      view === 'review' ? h('button', { type: 'button', style: S.btn, onClick: onClose }, '暂不写入') : null,
      view === 'report' && payload?.saved === undefined
        ? h('button', { type: 'button', style: S.btn, onClick: props.onSaveReport }, '保存报告与对比基线')
        : null,
      !['busy'].includes(view) && view !== 'preview' && view !== 'review'
        && !(view === 'created' && payload?.preset?.ok === true && installedNote(payload) === null)
        ? h('button', { type: 'button', style: S.btn, onClick: onClose }, '关闭')
        : null,
      view === 'created' && payload?.preset?.ok === true && installedNote(payload) === null
        ? installButton(payload, props.onInstall)
        : null,
    ),

    h('div', { style: S.panelBody },
      view === 'busy' ? h('div', { style: S.hint }, progress ?? '正在处理…') : null,
      error !== null && error !== undefined
        ? h('div', { style: S.err }, `${error.message}${error.code === undefined ? '' : `（${error.code}）`}`)
        : null,
      payload !== undefined && payload !== null ? renderBody(view, payload) : null,
    ),

    h('div', { style: S.panelFoot }, ...footActions),
  )
}

function renderBody(view, payload) {
  if (payload?.ok === false) {
    return h('div', null,
      h('div', { style: S.err }, payload.message ?? '执行失败'),
      payload.code === 'NO_WORKSPACE' ? h('div', { style: S.hint }, '未绑定工作区：请先在输入区选择或新建工作区。') : null,
    )
  }
  if (view === 'preview') return renderPreview(payload)
  if (view === 'created') return renderCreated(payload)
  if (view === 'review') return renderReview(payload)
  if (view === 'written') return renderWritten(payload)
  if (view === 'report') return h('div', null, renderMarkdown(payload.report ?? ''))
  if (view === 'done') return renderDistill(payload)
  return h('pre', { style: S.pre }, JSON.stringify(payload, null, 2))
}

function renderPreview(payload) {
  const preview = payload.preview ?? {}
  const topics = Array.isArray(preview.topicMap?.directions) ? preview.topicMap.directions : []
  return h('div', null,
    h('div', null, ...renderMarkdown((preview.summary ?? []).map(line => `- ${line}`).join('\n'))),
    h('div', { style: { marginTop: 8, fontWeight: 600 } }, '预设定位'),
    h('div', { style: S.small }, preview.positioning ?? ''),
    h('div', { style: { marginTop: 8, fontWeight: 600 } }, '主题地图草案（AI 推导 · 确认后写入框架）'),
    topics.length === 0
      ? h('div', { style: S.small }, '本次没有生成主题地图（模型不可用或输出不合格式）—— '
        + '框架会保持骨架，之后可用「收集提炼 / 关联升级」逐步建起来。')
      : h('div', null, ...topics.flatMap(entry => [
        h('div', { style: { marginTop: 4, fontWeight: 600 } }, entry.direction),
        ...renderMarkdown(entry.items.map(item => `- ${item}`).join('\n')),
      ])),
    topics.length > 0
      ? h('div', { style: S.small },
        '这是**草案**：它是"往哪走 + 起手问题"，不是结论，也不是你的知识节点。'
        + '不合意就先「返回修改」重来；节点仍由你自己的会话提炼。')
      : null,
    h('div', { style: { marginTop: 8, fontWeight: 600 } }, '知识框架草案'),
    ...renderMarkdown((preview.frameworkDraft ?? []).map(item => `- \`${item.path}\` —— ${item.title}：${item.note}`).join('\n')),
    h('div', { style: { marginTop: 8, fontWeight: 600 } }, '拟创建 / 修改的路径'),
    h('table', { style: S.table },
      h('thead', null, h('tr', null,
        h('th', { style: S.th }, '路径'),
        h('th', { style: S.th }, '操作'),
        h('th', { style: S.th }, '说明'))),
      h('tbody', null, (preview.paths ?? []).map((item, index) => h('tr', { key: index },
        h('td', { style: S.td }, h('code', null, item.path)),
        h('td', { style: S.td }, item.kind),
        h('td', { style: S.td }, item.note))))),
    h('div', { style: S.warn }, '已有文件不会被覆盖：已存在且内容不同的文件会被标为「冲突」并跳过，等你决定。'),
  )
}

/**
 * 「安装预设」按钮 —— 这一次点击就是审批动作。
 *
 * ⚠️ 文案必须写明"会在宿主进程执行新代码"：安装 bundle 的官方入口为此强制
 *   `danger-full-access` 审批。本插件把审批做在**人的点击**上，不替人越权，
 *   也不做"点了才知道"的暗动作。安装中禁用，避免重复提交。
 */
function installButton(payload, onInstall) {
  const busy = payload?.installing === true
  return h('button', {
    key: 'f-install',
    type: 'button',
    style: { ...S.btnPrimary, ...(busy ? S.itemDisabled : {}) },
    disabled: busy,
    title: '安装会在宿主进程执行新代码（装完需要重启一次）',    onClick: () => { if (!busy) onInstall() },
  }, busy ? '正在安装…' : '安装预设（装完需重启一次）')
}

/** 安装结果一行话（已装过就有值；没装过返回 null ⇒ 由调用方给按钮）。 */
function installedNote(payload) {
  const installed = payload?.installed
  if (installed === undefined || installed === null) return null
  if (installed.ok === true) {
    return installed.needsRestart === false
      ? '已装入 profile，当前进程已生效 —— 新建会话即可选到该预设。'
      : '已装入 profile —— 请重启 DSH，然后新建会话即可选到该预设。'
  }
  return `未安装：${installed.message ?? installed.code ?? '原因未明'}`
}

function renderCreated(payload) {
  const verification = payload.verification ?? {}
  const installed = payload.installed
  return h('div', null,
    h('div', { style: payload.preset?.ok === false ? S.err : S.hint }, payload.message ?? ''),
    h('div', { style: { marginTop: 8 } },
      `工作区框架：新建 ${payload.scaffold?.created ?? 0} 项、跳过 ${payload.scaffold?.skipped ?? 0} 项、冲突 ${payload.scaffold?.conflicts ?? 0} 项`),
    h('div', null, `预设：${payload.preset?.ok === true ? `已创建（${payload.preset.directory}）` : `未创建 —— ${payload.preset?.message ?? ''}`}`),
    h('div', null, `结构自证：${verification.structurallyValid === true ? '通过' : '未通过'}（文件 ${verification.found?.length ?? 0} 个，插件行 ${verification.rows ?? 0} 条）`),
    verification.note !== undefined ? h('div', { style: S.small }, verification.note) : null,

    // ── 安装状态：装好之前，"新会话能选到它"这句话不成立 ──────────────────
    payload.preset?.ok === true
      ? h('div', { style: { marginTop: 8, fontWeight: 600 } }, '安装到宿主名册')
      : null,
    payload.preset?.ok === true
      ? h('div', { style: S.small },
        '只写盘**不算**预设存在：宿主的名册不扫描目录，只认 profile bundle 里的一行声明。'
        + '点下面的「安装预设」把这一步做掉 —— 会自动算好 yaml 路径与 profile，你不需要知道预设 id。')
      : null,
    installed?.ok === true
      ? h('div', { style: S.hint },
        `已安装：${installed.bundle ?? ''}（${installed.application ?? 'restart-required'}）`)
      : null,
    installed?.ok === true && installed.nextStep !== undefined
      ? h('div', { style: S.warn }, `下一步：${installed.nextStep}`)
      : null,
    installed !== undefined && installed !== null && installed.ok === false
      ? h('div', { style: S.err },
        `${installed.message ?? '未安装'}`,
        installed.command !== undefined
          ? h('div', { style: { marginTop: 4 } }, h('code', null, installed.command))
          : null)
      : null,

    h('div', { style: S.warn }, '预设在一个进程内按 standing scope 挂载一次，**不会**在当前会话即时生效 —— 安装后请重启并新建会话，再选择该预设。'),
    h('div', { style: S.small }, '⚠️ 不要删也不要移动那个 bundle 目录：宿主重启时按预设 id 解析，定义缺失的会话会被拒绝恢复。'),
  )
}

function renderReview(payload) {
  const changes = payload.changes ?? []
  return h('div', null,
    h('div', { style: S.small }, payload.message ?? ''),
    h('table', { style: S.table },
      h('thead', null, h('tr', null,
        h('th', { style: S.th }, '目标路径'), h('th', { style: S.th }, '操作'),
        h('th', { style: S.th }, '关系'), h('th', { style: S.th }, '理由'))),
      h('tbody', null, changes.map((change, index) => h('tr', { key: index },
        h('td', { style: S.td }, h('code', null, change.path)),
        h('td', { style: S.td }, change.operation),
        h('td', { style: S.td }, change.relation),
        h('td', { style: S.td }, change.reason))))),
    payload.duplicateCount > 0 ? h('div', { style: S.hint }, `另有 ${payload.duplicateCount} 条与既有节点重复，已跳过（不写、不递增版本）。`) : null,
    payload.requiresBehaviorRuleApproval === true
      ? h('div', { style: S.warn }, '清单含**行为规则**变更（预设提示词 / AGENTS.md / 技能）：按默认配置（allowBehaviorRules: false）不会执行，须显式放行后再来。')
      : null,
  )
}

function renderWritten(payload) {
  return h('div', null,
    h('div', { style: payload.failed?.length > 0 ? S.warn : S.hint }, payload.message ?? ''),
    h('div', { style: S.small }, `变更批次：${payload.batchId ?? '—'}（可用 /learn rollback ${payload.batchId ?? '<批次>'} 回滚）`),
    h('table', { style: S.table },
      h('thead', null, h('tr', null,
        h('th', { style: S.th }, '路径'), h('th', { style: S.th }, '动作'), h('th', { style: S.th }, '版本'))),
      h('tbody', null, (payload.done ?? []).map((item, index) => h('tr', { key: index },
        h('td', { style: S.td }, h('code', null, item.relative)),
        h('td', { style: S.td }, item.action),
        h('td', { style: S.td }, item.version ?? '—'))))),
    (payload.failed ?? []).length > 0
      ? h('div', { style: S.err }, `未完成 ${payload.failed.length} 项：${payload.failed.map(item => item.relative).join('、')}`)
      : null,
  )
}

/**
 * 语义增强摘要一行话（方案 B-1）—— 空 = 本次没做语义增强。
 *
 * ★ 为什么必须显示：语义增强默认关闭，且可能因模型失败/超预算而"部分生效"。
 *   不显示这一行，用户就无法判断"这条候选的语义建议到底有没有"。
 */
function semanticNote(semantic) {
  if (semantic === undefined || semantic === null || semantic.enabled !== true) return null
  const divergences = (semantic.typeDivergence ?? 0) + (semantic.relationsDivergence ?? 0)
  return '语义增强：已启用'
    + `（${semantic.calls ?? 0} 次调用／${semantic.suggested ?? 0} 条建议）`
    + `${divergences > 0 ? `｜**两轨不一致 ${divergences} 处**，已在表中标出` : '｜与基线判定一致'}`
    + `${semantic.stopped === true ? '｜⚠️ 未跑完（达到预算或调用失败），部分候选无语义建议' : ''}`
}

/**
 * 类型单元格：基线轨 + 语义轨（冲突时并排显示）。
 *
 * ★ 显示纪律：**基线永远在前、语义永远标注为"模型"** —— 因为语义轨不可复现，
 *   不能让人误以为它是"系统判定"。另外用集合比较（而非数量比较）判关系分歧，
 *   否则"两条候选换了顺序"也会被误报成冲突。
 */
function typeCell(candidate) {
  if (candidate.typeDivergence !== true) return candidate.type
  return h('span', { style: S.warn },
    `${candidate.type ?? '（无）'} ← 模型：${candidate.typeSemantic ?? '（无）'}`,
    candidate.typeWhy !== undefined
      ? h('span', { style: S.small }, `（依据：${candidate.typeWhy}）`)
      : null)
}

/** 关系：位置列与"依据/关系"列共用一段文本（不影响列数）。 */
function relationText(candidate) {
  const semantic = Array.isArray(candidate.relationsSemantic) ? candidate.relationsSemantic : []
  if (candidate.relationsDivergence !== true || semantic.length === 0) {
    return { pos: candidate.relations?.[0]?.id ?? '—', why: null }
  }
  const reasons = semantic
    .map(item => `${item.id}：${item.relation}${item.why === undefined ? '' : `（${item.why}）`}`)
    .join('；')
  return { pos: candidate.relations?.[0]?.id ?? '—', why: `模型：${reasons}` }
}

function renderDistill(payload) {
  const candidates = payload.candidates ?? []
  const note = semanticNote(payload.semantic)
  return h('div', null,
    h('div', { style: S.hint }, payload.message ?? ''),
    h('div', { style: S.small },
      `批次 ${payload.batchId}｜范围 ${payload.range?.from ?? '?'}–${payload.range?.to ?? '?'}｜`
      + `${payload.complete === true ? '完整历史' : '部分上下文'}｜保留 ${payload.kept ?? 0} / 排除 ${payload.excluded ?? 0}`),
    note !== null ? h('div', { style: S.small }, note) : null,
    (payload.limitations ?? []).length > 0
      ? h('div', { style: S.warn }, `范围限制：${(payload.limitations ?? []).join('；')}`)
      : null,
    h('table', { style: S.table },
      h('thead', null, h('tr', null,
        h('th', { style: S.th }, '候选'), h('th', { style: S.th }, '类型（基线／模型）'),
        h('th', { style: S.th }, '决定'), h('th', { style: S.th }, '验证'),
        h('th', { style: S.th }, '关联'), h('th', { style: S.th }, '依据／关系'))),
      h('tbody', null, candidates.map((candidate, index) => {
        const relation = relationText(candidate)
        return h('tr', { key: index },
          h('td', { style: S.td }, h('code', null, candidate.id), ' ', candidate.title),
          h('td', { style: S.td }, typeCell(candidate)),
          h('td', { style: S.td }, candidate.decision),
          h('td', { style: S.td }, candidate.verification),
          h('td', { style: S.td }, relation.pos),
          h('td', { style: S.td }, relation.why ?? '—'))
      }))),
    h('div', { style: S.small }, '「用户认可」与「已事实验证」是两个字段；点保留不会把一条内容变成已证实。'),
    note !== null
      ? h('div', { style: S.small },
        '类型列与关联列：**基线轨**（关键词/词面算法，可复现）与**模型建议**（不可复现）'
        + '不一致时会并排显示并标注「模型」——最终判定仍由你裁决。')
      : null,
  )
}

// ── 模块契约：{ name, inject, apply } ──────────────────────────────────
export const name = 'learn-skills-client'

/**
 * ⚠️ 这里的 `connection` 是**菜单必需的**（RPC 调它）。
 *    `connection` 只存在于 web 平面，因此本半侧只跑在 web 页面里，写死是安全且必需的。
 *    `slots` 是槽位注册表 —— `conversation.input.left` 由 composer 声明。
 */
export const inject = ['slots', 'connection']

export function apply(ctx) {
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'dsh-learn-skills',
    order: 100,
    label: () => 'AI学习',
    // session 作用域槽位：inject 工厂的形参是框架解析出的 sessionId（见 ui-slots 的
    // InjectParams 矩阵）；rpc 的统一入口在这里注入，组件不直接碰传输层。
    inject: (sessionId) => ({
      rpc: (method, payload, signal) => ctx.connection
        .rpc.call('/api', RPC_ENDPOINT, { method, payload: payload ?? {} }, signal)
        .then(result => unwrapEnvelope(result)),
    }),
  }, LearnMenu))
}
