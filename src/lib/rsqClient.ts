/**
 * RSQ（关系自陈问卷）前端纯逻辑。
 *
 * 职责：
 *  - 题库视图模型：按 batteryLevel 拉取的题目分页（模块分组 + 进度 + 校验）；
 *  - 提交载荷组装：1–7 计分题 → raw；开放题 110/111 → feedback；第 120 题 → selfSummary；
 *  - 报告视图适配（审计 P1-22 契约漂移）：后端返回 `dims`（不是 `dimensions`）、
 *    实际 45 维（不是 39）、119 题 + 第 120 题自评；validity 逐字段兜底，旧记录不崩。
 *
 * 无 React / DOM 依赖，可直接 vitest 纯函数测试。
 */

// ---------------------------------------------------------------------------
// 题库 / 答卷视图
// ---------------------------------------------------------------------------

export type RsqBatteryLevel = 'L' | 'M' | 'S'

export interface RsqItemView {
  no: number
  module: string
  dim: string | null
  text: string
  /** 后端口径 "L7" / "likert7" / "ios7" / "open" */
  scale: string
  reverse?: boolean
  pairWith?: number
  negative?: boolean
  validity?: boolean
  dark?: boolean
}

export interface RsqItemsView {
  version: string
  level: RsqBatteryLevel
  items: RsqItemView[]
}

/** 题库总题数（1–119 计分题；第 120 题为自评开放题） */
export const RSQ_SCORED_ITEM_COUNT = 119
/** 第 120 题：一句话自评（开放题） */
export const RSQ_SELF_SUMMARY_NO = 120
/** 维度总数（后端 rsq.ts computeDimensions 实测 45 维） */
export const RSQ_DIMENSION_COUNT = 45

export const RSQ_LEVEL_META: Record<RsqBatteryLevel, { label: string; hint: string }> = {
  L: { label: '完整版', hint: '全部 119 题 + 一句话自评，适合关系历史充分的对象' },
  M: { label: '标准版', hint: '结构 / 情感 / 信任 / 承诺 / 效度核心模块' },
  S: { label: '精简版', hint: '17 道核心题 + 一句话自评，适合泛泛之交' },
}

export function normalizeBatteryLevel(v: unknown): RsqBatteryLevel {
  return v === 'M' || v === 'S' || v === 'L' ? v : 'L'
}

/** 开放题（自由文本）：110/111 选填、120 为一句话自评 */
export function isOpenItem(item: Pick<RsqItemView, 'scale'>): boolean {
  return item.scale === 'open'
}

/** 把后端返回的题目载荷收窄成前端视图（对字段缺失做兜底） */
export function normalizeRsqItems(raw: {
  version?: string | null
  level?: string | null
  items?: Array<{
    no?: number | string
    module?: string
    dim?: string | null
    text?: string
    scale?: string
    reverse?: boolean
    pairWith?: number
    negative?: boolean
    validity?: boolean
    dark?: boolean
  }> | null
}): RsqItemsView {
  const level = normalizeBatteryLevel(raw.level)
  const items = (raw.items ?? [])
    .map((it) => ({
      no: Number(it.no),
      module: typeof it.module === 'string' && it.module ? it.module : '未分组',
      dim: typeof it.dim === 'string' && it.dim ? it.dim : null,
      text: typeof it.text === 'string' ? it.text : '',
      scale: typeof it.scale === 'string' && it.scale ? it.scale : 'L7',
      reverse: it.reverse === true,
      pairWith: typeof it.pairWith === 'number' ? it.pairWith : undefined,
      negative: it.negative === true,
      validity: it.validity === true,
      dark: it.dark === true,
    }))
    .filter((it) => Number.isFinite(it.no) && it.no > 0 && it.text.length > 0)
    .sort((a, b) => a.no - b.no)
  return {
    version: typeof raw.version === 'string' && raw.version ? raw.version : 'unknown',
    level,
    items,
  }
}

// ---------------------------------------------------------------------------
// 分页（按模块分组；长模块自动拆页，保证一页不堆 26 题）
// ---------------------------------------------------------------------------

export interface RsqPage {
  /** 页标题（模块名；被拆页时追加「1/2」） */
  title: string
  items: RsqItemView[]
}

export function paginateRsqItems(items: RsqItemView[], pageSize = 10): RsqPage[] {
  const pages: RsqPage[] = []
  const byModule = new Map<string, RsqItemView[]>()
  for (const it of items) {
    const list = byModule.get(it.module) ?? []
    list.push(it)
    byModule.set(it.module, list)
  }
  for (const [title, list] of byModule) {
    const chunks = Math.max(1, Math.ceil(list.length / pageSize))
    for (let i = 0; i < chunks; i += 1) {
      pages.push({
        title: chunks > 1 ? title + '（' + (i + 1) + '/' + chunks + '）' : title,
        items: list.slice(i * pageSize, (i + 1) * pageSize),
      })
    }
  }
  return pages
}

// ---------------------------------------------------------------------------
// 作答状态 / 校验 / 提交载荷
// ---------------------------------------------------------------------------

export interface RsqAnswerState {
  /** 题号 → 1–7 */
  likert: Record<number, number>
  /** 开放题题号 → 文本（110/111/120） */
  open: Record<number, string>
}

export function emptyAnswerState(): RsqAnswerState {
  return { likert: {}, open: {} }
}

/** 必须作答的题号（非开放题；1–7 全答才能提交） */
export function requiredItemNos(items: RsqItemView[]): number[] {
  return items.filter((it) => !isOpenItem(it)).map((it) => it.no)
}

export interface RsqValidation {
  ok: boolean
  /** 未作答的必答题号（升序） */
  missing: number[]
  total: number
  answered: number
}

export function validateRsqAnswers(items: RsqItemView[], answers: RsqAnswerState): RsqValidation {
  const required = requiredItemNos(items)
  const missing: number[] = []
  let answered = 0
  for (const no of required) {
    const v = answers.likert[no]
    if (typeof v === 'number' && v >= 1 && v <= 7) answered += 1
    else missing.push(no)
  }
  return { ok: missing.length === 0, missing, total: required.length, answered }
}

/** 缺失题号 → 需要跳到第几页（0 基）；一题都没有则 0 */
export function pageOfItem(pages: RsqPage[], itemNo: number | undefined): number {
  if (itemNo == null) return 0
  const idx = pages.findIndex((p) => p.items.some((it) => it.no === itemNo))
  return idx < 0 ? 0 : idx
}

export interface RsqSubmitPayload {
  fromPersonaId: number
  toPersonaId: number
  raw: Record<string, number>
  selfSummary: string | null
  feedback: {
    affect: number
    willingness: number
    perceivedDepth: number
    hardestItems: Array<{ itemNo: number | null; reason: string; tag: string }>
    missingDimensions: Array<{ suggestion: string; possibleDimension: string }>
  } | null
  batteryLevel: RsqBatteryLevel
  model: string | null
}

const OPEN_HARDEST_NO = 110
const OPEN_MISSING_NO = 111

function clampLikert(v: number): number {
  return Math.max(1, Math.min(7, Math.round(v)))
}

/**
 * 组装 network.submitRSQ 入参：
 *  - raw 只放 1–7 计分题（开放题不参与计分）；
 *  - 107/108/109 作答体验 → feedback 三个评分；
 *  - 110「最难回答的题」/111「漏掉的方面」→ feedback.hardestItems / missingDimensions；
 *  - 120 → selfSummary（后端截断 36 字，前端先 trim 再截）。
 */
export function buildRsqSubmitPayload(input: {
  fromPersonaId: number
  toPersonaId: number
  level: RsqBatteryLevel
  items: RsqItemView[]
  answers: RsqAnswerState
}): RsqSubmitPayload {
  const raw: Record<string, number> = {}
  for (const it of input.items) {
    if (isOpenItem(it)) continue
    const v = input.answers.likert[it.no]
    if (typeof v === 'number' && v >= 1 && v <= 7) raw[String(it.no)] = v
  }
  const open = input.answers.open
  const affect = raw[String(107)]
  const willingness = raw[String(108)]
  const perceivedDepth = raw[String(109)]
  const hardest = (open[OPEN_HARDEST_NO] ?? '').trim()
  const missing = (open[OPEN_MISSING_NO] ?? '').trim()
  const feedback =
    affect != null || willingness != null || perceivedDepth != null || hardest || missing
      ? {
          affect: affect != null ? clampLikert(affect) : 4,
          willingness: willingness != null ? clampLikert(willingness) : 4,
          perceivedDepth: perceivedDepth != null ? clampLikert(perceivedDepth) : 4,
          hardestItems: hardest
            ? [{ itemNo: null, reason: hardest.slice(0, 500), tag: 'free-text' }]
            : [],
          missingDimensions: missing
            ? [{ suggestion: missing.slice(0, 500), possibleDimension: '（角色自述）' }]
            : [],
        }
      : null
  const summary = (open[RSQ_SELF_SUMMARY_NO] ?? '').trim()
  return {
    fromPersonaId: input.fromPersonaId,
    toPersonaId: input.toPersonaId,
    raw,
    selfSummary: summary ? summary.slice(0, 36) : null,
    feedback,
    batteryLevel: input.level,
    model: null,
  }
}

// ---------------------------------------------------------------------------
// 报告视图模型（45 维）
// ---------------------------------------------------------------------------

export type RsqVerdict = 'reliable' | 'questionable' | 'likely-deceptive'

export interface RsqValidityView {
  consistency: number
  socialDesirability: number
  lieScale: number
  darkTriad: number
  behavioralGap: number
  experienceConsistency: number
  overall: number
  /** 旧记录可能没有 verdict → null（UI 显示「未判定」，不崩） */
  verdict: RsqVerdict | null
  flags: string[]
}

export interface RsqFeedbackView {
  affect: number
  willingness: number
  perceivedDepth: number
  hardestItems: Array<{ itemNo: number | null; reason: string; tag: string }>
  missingDimensions: Array<{ suggestion: string; possibleDimension: string }>
}

export interface RadarPoint {
  axis: string
  label: string
  value: number
}

/** 一次 RSQ 的完整前端视图（报告/历史/原始答卷共用） */
export interface RSQReportData {
  id: number
  selfSummary: string | null
  /** 45 个维度分（缺失为 null，报告显示「—」而不是 0） */
  dims: Record<string, number | null>
  derived: Record<string, number>
  validity: RsqValidityView
  /** 原始答案（题号 → 1–7） */
  raw: Record<number, number>
  feedback: RsqFeedbackView | null
  answeredAt: string
  itemsVersion: string
  radar: RadarPoint[]
  batteryLevel: string | null
  model: string | null
}

/** 后端 record（或旧契约）→ 前端视图；新老字段都兜得住 */
export interface RSQRecordLike {
  id?: number | null
  dims?: Record<string, number | null> | null
  /** 旧契约字段名（P1-22 漂移的另一侧） */
  dimensions?: Record<string, number | null> | null
  derived?: Record<string, number | null> | null
  validity?: Partial<Record<keyof RsqValidityView, unknown>> | null
  raw?: Record<string | number, unknown> | null
  feedback?: {
    affect?: unknown
    willingness?: unknown
    perceivedDepth?: unknown
    hardestItems?: unknown
    missingDimensions?: unknown
  } | null
  selfSummary?: string | null
  answeredAt?: string | Date | null
  createdAt?: string | Date | null
  itemsVersion?: string | null
  radar?: Array<{ axis?: unknown; label?: unknown; value?: unknown }> | null
  batteryLevel?: string | null
  model?: string | null
}

function finiteNumber(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function toIso(v: string | Date | null | undefined): string {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString()
  if (typeof v === 'string' && v) return v
  return ''
}

const VERDICTS: RsqVerdict[] = ['reliable', 'questionable', 'likely-deceptive']

function toVerdict(v: unknown): RsqVerdict | null {
  return VERDICTS.includes(v as RsqVerdict) ? (v as RsqVerdict) : null
}

/** 45 维：键固定、顺序固定；旧记录缺某个维度时值为 null（显示「—」） */
export const RSQ_DIM_KEYS = [
  'companionship', 'conflict', 'instrumentalAid', 'antagonism', 'emotionalSupport',
  'nurturance', 'relativePower', 'intimateDisclosure', 'reliableAlliance', 'affection',
  'admiration', 'reassuranceOfWorth', 'satisfactionNRI', 'intimacy', 'passion',
  'commitmentTLS', 'attachmentAnxiety', 'attachmentAvoidance', 'predictability', 'dependability',
  'faith', 'satisfactionIMS', 'alternatives', 'investment', 'commitment',
  'conflictReasoning', 'conflictVerbal', 'conflictAvoidance', 'closeness', 'metaWorth',
  'metaAbility', 'metaDefensiveness', 'metaDisclosure', 'metaCertainty', 'metaMismatch',
  'jealousy', 'ipcAgency', 'ipcAffiliation', 'equityBalance', 'indebtedness',
  'grievance', 'forgiveness', 'revenge', 'avoidance', 'benevolence',
] as const

/** 维度分组（按量表来源；共 45 维 = 审计实测口径） */
export const RSQ_DIM_GROUPS: Array<{ title: string; keys: Array<[string, string]> }> = [
  {
    title: 'NRI · 关系结构',
    keys: [
      ['companionship', '陪伴'], ['conflict', '冲突'], ['instrumentalAid', '工具帮助'],
      ['antagonism', '对抗'], ['emotionalSupport', '情感支持'], ['nurturance', '照料'],
      ['relativePower', '相对权力'], ['intimateDisclosure', '亲密披露'],
      ['reliableAlliance', '可靠同盟'], ['affection', '喜爱'], ['admiration', '钦佩'],
      ['reassuranceOfWorth', '价值肯定'], ['satisfactionNRI', '满意(NRI)'],
    ],
  },
  { title: 'Sternberg · 三角', keys: [['intimacy', '亲密'], ['passion', '投入热度'], ['commitmentTLS', '承诺(TLS)']] },
  { title: 'ECR-R · 依恋', keys: [['attachmentAnxiety', '依恋焦虑'], ['attachmentAvoidance', '依恋回避']] },
  { title: 'Rempel · 信任', keys: [['predictability', '可预测性'], ['dependability', '可靠性'], ['faith', '信念']] },
  {
    title: 'IMS · 投资模型',
    keys: [['satisfactionIMS', '满意(IMS)'], ['alternatives', '替代品'], ['investment', '投资'], ['commitment', '承诺']],
  },
  {
    title: 'CTS2 · 冲突应对',
    keys: [['conflictReasoning', '讲道理'], ['conflictVerbal', '言语施压'], ['conflictAvoidance', '回避']],
  },
  { title: 'IOS · 亲密', keys: [['closeness', '亲密(IOS)']] },
  {
    title: '元认知',
    keys: [
      ['metaWorth', '他重视我'], ['metaAbility', '他评我能力'], ['metaDefensiveness', '他防着我'],
      ['metaDisclosure', '他交底牌'], ['metaCertainty', '判断确定'], ['metaMismatch', '定位错位'],
    ],
  },
  { title: '嫉妒', keys: [['jealousy', '嫉妒']] },
  { title: '人际环 IPC', keys: [['ipcAgency', '主导性'], ['ipcAffiliation', '亲和性']] },
  {
    title: '公平 Equity',
    keys: [['equityBalance', '公平平衡'], ['indebtedness', '我欠他'], ['grievance', '他欠我']],
  },
  {
    title: '原谅 Forgiveness',
    keys: [['forgiveness', '宽恕'], ['revenge', '报复心'], ['avoidance', '回避'], ['benevolence', '善意']],
  },
]

/** 派生指标中文化（旧 UI 直接显示英文字段名） */
export const RSQ_DERIVED_LABELS: Record<string, string> = {
  involvement: '卷入度',
  ambivalence: '矛盾度',
  netAffect: '净情感',
  powerBalance: '权力平衡',
  perceivedGap: '认知落差',
  forgiveGap: '宽恕落差',
  equityStrain: '公平张力',
}

export const RSQ_VERDICT_LABEL: Record<RsqVerdict, string> = {
  reliable: '可信',
  questionable: '存疑',
  'likely-deceptive': '疑似伪装',
}

export const RSQ_FLAG_LABELS: Record<string, string> = {
  'dark-desirability-conflict': '暗黑-赞许冲突',
  'polished-deceiver': '精致伪装',
  'extreme-response': '极端作答',
  'straight-lining': '直线作答',
  'comfortable-deceiver': '舒适区伪装',
  'honest-discomfort': '诚实的不适',
  'reluctant-but-valuable': '勉强但有价值',
}

function normalizeFeedback(raw: RSQRecordLike['feedback']): RsqFeedbackView | null {
  if (!raw || typeof raw !== 'object') return null
  const hardest = Array.isArray(raw.hardestItems)
    ? (raw.hardestItems as Array<Record<string, unknown>>).map((h) => ({
        itemNo: typeof h.itemNo === 'number' ? h.itemNo : null,
        reason: typeof h.reason === 'string' ? h.reason : '',
        tag: typeof h.tag === 'string' ? h.tag : '',
      }))
    : []
  const missing = Array.isArray(raw.missingDimensions)
    ? (raw.missingDimensions as Array<Record<string, unknown>>).map((m) => ({
        suggestion: typeof m.suggestion === 'string' ? m.suggestion : '',
        possibleDimension: typeof m.possibleDimension === 'string' ? m.possibleDimension : '',
      }))
    : []
  return {
    affect: finiteNumber(raw.affect, 4),
    willingness: finiteNumber(raw.willingness, 4),
    perceivedDepth: finiteNumber(raw.perceivedDepth, 4),
    hardestItems: hardest.filter((h) => h.reason.length > 0),
    missingDimensions: missing.filter((m) => m.suggestion.length > 0),
  }
}

/** 原始答卷归一：JSON 里键是字符串；非法值丢弃；旧记录可能把 120 题混在 raw 里 */
export function normalizeRawAnswers(raw: RSQRecordLike['raw']): Record<number, number> {
  const out: Record<number, number> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [k, v] of Object.entries(raw)) {
    const no = Number(k)
    if (!Number.isFinite(no) || no <= 0) continue
    const n = typeof v === 'number' ? v : Number(v)
    if (!Number.isFinite(n) || n < 1 || n > 7) continue
    out[no] = n
  }
  return out
}

/** 计分题作答数（不含 120 自评；显示「原始答卷（N 题）」用） */
export function scoredAnswerCount(raw: Record<number, number>): number {
  return Object.keys(raw).filter((k) => Number(k) <= RSQ_SCORED_ITEM_COUNT).length
}

function normalizeRadar(
  raw: RSQRecordLike['radar'],
  dims: Record<string, number | null>,
): RadarPoint[] {
  if (Array.isArray(raw) && raw.length > 0) {
    return raw.map((p) => ({
      axis: typeof p.axis === 'string' ? p.axis : '',
      label: typeof p.label === 'string' ? p.label : typeof p.axis === 'string' ? p.axis : '',
      value: Math.max(0, Math.min(100, finiteNumber(p.value))),
    }))
  }
  // 旧记录没有 radar：用核心维度兜底出 8 轴（缺失按中性 50，避免整图塌陷）
  const neutral = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 50)
  const equity = neutral(dims.equityBalance)
  return [
    { axis: 'affection', label: '喜爱', value: neutral(dims.affection) },
    { axis: 'antagonism', label: '对抗', value: neutral(dims.antagonism) },
    { axis: 'faith', label: '信任', value: neutral(dims.faith) },
    { axis: 'commitment', label: '承诺', value: neutral(dims.commitment ?? dims.commitmentTLS) },
    { axis: 'closeness', label: '亲密', value: neutral(dims.closeness) },
    { axis: 'forgiveness', label: '原谅', value: neutral(dims.forgiveness) },
    { axis: 'equity', label: '公平', value: Math.max(0, Math.min(100, 100 - Math.abs(equity - 50) * 2)) },
    { axis: 'admiration', label: '钦佩', value: neutral(dims.admiration) },
  ]
}

/**
 * 后端 record → 报告视图（P1-22 适配器）。
 * 兼容：`dims` / 旧 `dimensions`；有效度字段缺失/非数字；raw 键为字符串；无 radar 的旧记录。
 */
export function toReportData(record: RSQRecordLike, fallbackId = 0): RSQReportData {
  const sourceDims = record.dims ?? record.dimensions ?? {}
  const dims: Record<string, number | null> = {}
  for (const key of RSQ_DIM_KEYS) {
    const v = (sourceDims as Record<string, unknown>)[key]
    dims[key] = typeof v === 'number' && Number.isFinite(v) ? v : null
  }
  const derived: Record<string, number> = {}
  for (const [k, v] of Object.entries(record.derived ?? {})) {
    derived[k] = finiteNumber(v)
  }
  const rawValidity = record.validity ?? {}
  const validity: RsqValidityView = {
    consistency: finiteNumber(rawValidity.consistency),
    socialDesirability: finiteNumber(rawValidity.socialDesirability),
    lieScale: finiteNumber(rawValidity.lieScale),
    darkTriad: finiteNumber(rawValidity.darkTriad),
    behavioralGap: finiteNumber(rawValidity.behavioralGap),
    experienceConsistency: finiteNumber(rawValidity.experienceConsistency),
    overall: finiteNumber(rawValidity.overall),
    verdict: toVerdict(rawValidity.verdict),
    flags: Array.isArray(rawValidity.flags)
      ? (rawValidity.flags as unknown[]).filter((f): f is string => typeof f === 'string')
      : [],
  }
  const raw = normalizeRawAnswers(record.raw)
  return {
    id: typeof record.id === 'number' && Number.isFinite(record.id) ? record.id : fallbackId,
    selfSummary: typeof record.selfSummary === 'string' && record.selfSummary.trim() ? record.selfSummary : null,
    dims,
    derived,
    validity,
    raw,
    feedback: normalizeFeedback(record.feedback),
    answeredAt: toIso(record.answeredAt ?? record.createdAt),
    itemsVersion: typeof record.itemsVersion === 'string' && record.itemsVersion ? record.itemsVersion : 'unknown',
    radar: normalizeRadar(record.radar, dims),
    batteryLevel: typeof record.batteryLevel === 'string' ? record.batteryLevel : null,
    model: typeof record.model === 'string' ? record.model : null,
  }
}

/** 历史记录批量适配（保持传入顺序，供 RSQReportDialog 使用） */
export function toReportDataList(records: readonly unknown[] | null | undefined): RSQReportData[] {
  return (records ?? []).map((r, i) => toReportData(r as RSQRecordLike, -1 - i))
}

/** 格式化作答时间（报告头部） */
export function formatAnsweredAt(iso: string): string {
  if (!iso) return '（时间未知）'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
