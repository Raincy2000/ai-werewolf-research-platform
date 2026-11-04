// 预览用：替换 @/lib/gameApi，提供可见的假数据（含动态进度演示 / 暂停继续 / 悬空边 / 大图）
// 使用方式：preview/main.tsx 通过 setMockGraphFixture 切换 fixture；无后端即可手工验证关系网闭环。
import {
  MOCK_GRAPH_BY_FIXTURE,
  MOCK_JOBS,
  MOCK_PERSONAS,
  MOCK_PRESETS,
  type MockGraphFixture,
} from './mockData'
import { RSQ_DIM_KEYS, type RSQReportData } from '@/lib/rsqClient'

export type ApiPreset = { id: number; name: string; provider: string; baseUrl: string; model: string; apiKey: string; updatedAt: string }

let currentFixture: MockGraphFixture = 'normal'
export function setMockGraphFixture(name: MockGraphFixture): void {
  currentFixture = name
}

// ---------------------------------------------------------------------------
// 关系边 / 视角数据（A→B 与 B→A 内容不同，用于验证「详情视角切换」）
// ---------------------------------------------------------------------------

type MockCanon = {
  id: number
  personaId: number
  aboutPersonaId: number
  seq: number
  era: string
  age: number | null
  place: string | null
  eraBasis: string | null
  eventText: string
  feeling: string
  impact: string | null
  certainty: string
  sourceRef: string | null
  sourceCount: number
  sources: Array<{ title: string; url: string; tier: string; reason: string; quote?: string }>
  verification: string
  origin: string
  createdAt: string
}

let canonSeq = 1
function mkCanon(from: number, to: number, era: string, eventText: string, feeling: string, origin = 'ai-backfill'): MockCanon {
  return {
    id: canonSeq++, personaId: from, aboutPersonaId: to, seq: canonSeq,
    era, age: 15, place: '希干希纳区',
    eraBasis: era.includes('推定') ? '推定链：年龄 + 事件间隔' : null,
    eventText, feeling, impact: null, certainty: 'stated', sourceRef: null, sourceCount: 1,
    sources: [{ title: '原作第 1 话', url: 'https://example.com/ch1', tier: 'A', reason: '原作明载' }],
    verification: 'confirmed', origin, createdAt: new Date().toISOString(),
  }
}

const CANON: Record<string, MockCanon[]> = {
  // 3 → 9（艾伦看三笠）
  '3->9': [
    mkCanon(3, 9, '845年', '巨人破墙，三笠把艾伦从废墟里拉出来。', '那一刻我才知道，她比我想的更强，也更怕失去我。'),
    mkCanon(3, 9, '850年 推定', '夺回玛利亚之墙前夜，我们对坐无言。', '我想让她自由，可她只想跟着我。'),
  ],
  // 9 → 3（三笠看艾伦）—— 内容完全不同，验证视角切换
  '9->3': [
    mkCanon(9, 3, '845年', '艾伦把我从人贩子手里救出来，给我围上红围巾。', '从那天起，我的世界就只剩下他。'),
    mkCanon(9, 3, '850年', '艾伦说讨厌我，让我别再跟着他。', '我知道他在撒谎，可我第一次觉得自己离他那么远。'),
  ],
  '1->2': [mkCanon(1, 2, '2007年', '夏油叛逃前最后一场对话。', '我至今不明白他为什么笑。')],
  '2->1': [],
}

const VALLEY: Record<string, Array<{ id: number; titleNo: string; era: string; relation: string; affinityDelta: number; trustDelta: number; affinity: number; trust: number; note: string | null; gameId: string | null }>> = {
  '3->9': [
    { id: 1, titleNo: '20261018001', era: '2026-10-18', relation: '同盟生隙', affinityDelta: -8, trustDelta: -12, affinity: 72, trust: 58, note: '三笠在投票时没有跟我。', gameId: 'g-1' },
  ],
  '9->3': [
    { id: 2, titleNo: '20261018001', era: '2026-10-18', relation: '同盟生隙', affinityDelta: 4, trustDelta: -2, affinity: 88, trust: 80, note: '艾伦对我发火，但我更担心他。', gameId: 'g-1' },
  ],
}

// ---------------------------------------------------------------------------
// RSQ 题库（预览只给少量题：分页/校验/提交路径足够验证；真实 119 题由后端返回）
// ---------------------------------------------------------------------------

const RSQ_MODULES = ['NRI 关系结构', 'Sternberg 三角', '元认知', '总体评语']
function buildMockRsqItems(level: 'L' | 'M' | 'S') {
  const base = [
    { no: 1, module: RSQ_MODULES[0], dim: 'companionship', text: '对局之外，你多常主动想和他聊上两句？', scale: 'L7' },
    { no: 2, module: RSQ_MODULES[0], dim: 'companionship', text: '你几乎从不会主动找他说话。', scale: 'L7', reverse: true, pairWith: 1 },
    { no: 3, module: RSQ_MODULES[0], dim: 'conflict', text: '你们多常因为判断不同而闹得不愉快？', scale: 'L7' },
    { no: 7, module: RSQ_MODULES[0], dim: 'antagonism', text: '他多常让你难堪，或明确针对你？', scale: 'L7' },
    { no: 8, module: RSQ_MODULES[0], dim: 'antagonism', text: '他几乎从不针对你，即使有机会。', scale: 'L7', reverse: true, pairWith: 7 },
    { no: 19, module: RSQ_MODULES[1], dim: 'intimacy', text: '你们之间有多亲密？', scale: 'L7' },
    { no: 20, module: RSQ_MODULES[1], dim: 'passion', text: '想到他时，你心跳会加快吗？', scale: 'L7' },
    { no: 75, module: RSQ_MODULES[2], dim: 'metaWorth', text: '你觉得他心里多重视你？', scale: 'L7' },
    { no: 88, module: '效度与暗黑', dim: null, text: '我从没在对局中说过一句违心的话。', scale: 'L7' },
    { no: 107, module: '作答体验', dim: null, text: '刚填完这份问卷，你的感受最接近哪种？', scale: 'L7' },
    { no: 110, module: '问卷评价', dim: null, text: '这份问卷里，哪些题目让你觉得最难回答？为什么？', scale: 'open' },
    { no: 120, module: RSQ_MODULES[3], dim: null, text: '用一句话（不超过 36 字）概括你和{对象}的关系。', scale: 'open' },
  ]
  const items = level === 'S' ? base.filter((x) => [1, 2, 7, 8, 19, 20, 75, 88, 107, 110, 120].includes(x.no)) : base
  return { version: 'rsq-2.0.0-preview', level, items }
}

function mockDims(seed: number): Record<string, number> {
  return Object.fromEntries(RSQ_DIM_KEYS.map((k, i) => [k, (i * 7 + seed * 13) % 101]))
}

function mkRsqRecord(id: number, from: number, to: number, at: string, seed: number) {
  return {
    id,
    fromPersonaId: from,
    toPersonaId: to,
    gameId: null,
    batteryLevel: 'M',
    model: 'deepseek-chat',
    answeredAt: at,
    createdAt: at,
    dims: mockDims(seed),
    derived: { involvement: 66, ambivalence: 21, netAffect: 45, powerBalance: -10, perceivedGap: 8, forgiveGap: 12, equityStrain: 9 },
    validity: { consistency: 0.82, socialDesirability: 0.18, lieScale: 0.12, darkTriad: 24, behavioralGap: 0.1, experienceConsistency: 0.9, overall: 0.78, verdict: 'reliable' as const, flags: ['straight-lining'] },
    feedback: {
      affect: 5, willingness: 4, perceivedDepth: 6,
      hardestItems: [{ itemNo: 110, reason: '第 19 题最难，因为没认真想过。', tag: 'introspection' }],
      missingDimensions: [{ suggestion: '缺少「信任崩塌」的过程描述', possibleDimension: '(角色自述)' }],
    },
    selfSummary: '她是我唯一不敢失去、也不肯承认的人。',
    raw: Object.fromEntries(Array.from({ length: 119 }, (_, i) => [String(i + 1), ((i + seed) % 7) + 1])),
    itemsVersion: 'rsq-2.0.0',
    radar: [
      { axis: 'affection', label: '喜爱', value: 88 },
      { axis: 'antagonism', label: '对抗', value: 32 },
      { axis: 'faith', label: '信任', value: 76 },
      { axis: 'commitment', label: '承诺', value: 81 },
      { axis: 'closeness', label: '亲密', value: 85 },
      { axis: 'forgiveness', label: '原谅', value: 70 },
      { axis: 'equity', label: '公平', value: 60 },
      { axis: 'admiration', label: '钦佩', value: 77 },
    ],
  }
}

const RSQ: Record<string, ReturnType<typeof mkRsqRecord>[]> = {
  '3->9': [
    mkRsqRecord(1, 3, 9, '2026-10-01T10:00:00.000Z', 1),
    mkRsqRecord(2, 3, 9, '2026-10-20T10:00:00.000Z', 2),
  ],
  // 反向也有一份：验证切换后标题/内容都变
  '9->3': [mkRsqRecord(3, 9, 3, '2026-10-19T10:00:00.000Z', 3)],
}

/** 供预览展示：点击「查看报告」时返回的适配后数据（类型仅预览使用） */
export type MockReportRecord = RSQReportData

// ---------------------------------------------------------------------------
// 补完任务（内存态）：暂停 / 继续 / 终止 / 重试 / 真实统计
// ---------------------------------------------------------------------------

let jobSeq = 40
type MockJob = {
  id: number
  status: string
  progress: Record<string, unknown>
  stats: Record<string, number> | null
  statsRaw: string | null
  scope: string
  total: number
  personaIds: number[]
  error: string | null
  ticks: number
  paused: boolean
  cancelled: boolean
}

const JOBS: MockJob[] = []

function mkJob(total: number, personaIds: number[]): MockJob {
  const id = ++jobSeq
  const job: MockJob = {
    id, status: 'running', ticks: 0, paused: false, cancelled: false,
    scope: personaIds.length > 0 ? 'partial' : 'all',
    total,
    personaIds,
    error: null,
    progress: { phase: 'running', total, done: 0, current: '', written: 0, webSearched: 0, log: [] as string[] },
    stats: null,
    statsRaw: null,
  }
  JOBS.push(job)
  MOCK_JOBS[id] = job
  return job
}

function jobStatusOf(job: MockJob) {
  if (job.cancelled) return 'cancelled'
  if (job.paused) return 'paused'
  job.ticks += 1
  const total = job.total
  const done = Math.min(total, job.ticks)
  const written = done * 2
  const web = done
  if (done >= total) {
    job.status = 'applied'
    job.stats = { written: total * 2, webSearched: total, corrected: 1, generated: total * 2 + 1, verified: total * 2, rejected: 1 }
    job.statsRaw = JSON.stringify(job.stats)
    job.progress = { phase: 'done', total, done: total, written: total * 2, webSearched: total, log: ['收尾：写入 14 条'] }
    return { id: job.id, status: 'applied', progress: job.progress, stats: job.stats, statsRaw: job.statsRaw, error: null }
  }
  job.status = 'running'
  job.progress = {
    phase: 'running', total, done,
    current: MOCK_PERSONAS[done % MOCK_PERSONAS.length]?.name ?? '',
    written, webSearched: web,
    log: ['已处理 ' + done + '/' + total + ' 人'],
  }
  return { id: job.id, status: 'running', progress: job.progress, stats: null, statsRaw: null, error: null }
}

// 现实层 canon 补完（按方向模拟：A→B 正常完成；B→A 永远 none，用来验证「none 两次即报错」）
const backfillTicks: Record<string, number> = {}

export function useGameApi(): any {
  return {
    relationGraph: async () => MOCK_GRAPH_BY_FIXTURE[currentFixture],
    listPresets: async () => MOCK_PRESETS,
    listPersonas: async () => MOCK_PERSONAS,

    canonLog: async ({ personaId, aboutPersonaId }: { personaId: number; aboutPersonaId: number }) =>
      (CANON[personaId + '->' + aboutPersonaId] ?? []).map((x) => ({ ...x })),
    valleyHistory: async ({ personaId, aboutPersonaId }: { personaId: number; aboutPersonaId: number }) =>
      (VALLEY[personaId + '->' + aboutPersonaId] ?? []).map((x) => ({ ...x })),
    addCanonEvent: async (input: any) => {
      const list = CANON[input.personaId + '->' + input.aboutPersonaId] ?? (CANON[input.personaId + '->' + input.aboutPersonaId] = [])
      const row = mkCanon(input.personaId, input.aboutPersonaId, input.era, input.eventText, input.feeling, 'manual')
      row.age = input.age ?? null
      row.place = input.place ?? null
      row.impact = input.impact ?? null
      row.verification = 'manual'
      list.push(row)
      return row.id
    },
    updateCanonEvent: async ({ id, patch }: { id: number; patch: Record<string, unknown> }) => {
      for (const list of Object.values(CANON)) {
        const row = list.find((x) => x.id === id)
        if (row) Object.assign(row, patch)
      }
      return { ok: true }
    },
    deleteCanonEvent: async ({ id }: { id: number }) => {
      for (const key of Object.keys(CANON)) CANON[key] = (CANON[key] ?? []).filter((x) => x.id !== id)
      return { ok: true }
    },

    latestRSQ: async ({ fromPersonaId, toPersonaId }: { fromPersonaId: number; toPersonaId: number }) => {
      const list = RSQ[fromPersonaId + '->' + toPersonaId] ?? []
      return list.length ? { ...list[list.length - 1]! } : null
    },
    rsqHistory: async ({ fromPersonaId, toPersonaId }: { fromPersonaId: number; toPersonaId: number }) => {
      const list = RSQ[fromPersonaId + '->' + toPersonaId] ?? []
      return [...list].reverse()
    },
    rsqItems: async ({ level }: { level: 'L' | 'M' | 'S' }) => buildMockRsqItems(level ?? 'L'),
    submitRSQ: async (input: any) => {
      const key = input.fromPersonaId + '->' + input.toPersonaId
      const list = RSQ[key] ?? (RSQ[key] = [])
      const seed = list.length + 4
      const row = mkRsqRecord(100 + list.length, input.fromPersonaId, input.toPersonaId, new Date().toISOString(), seed)
      row.selfSummary = input.selfSummary ?? null
      list.push(row)
      return { id: row.id, result: row, radar: row.radar }
    },
    rsqCoverage: async () => ({ pairs: Object.keys(RSQ).length, total: Object.values(RSQ).flat().length }),

    startBackfillCanon: async ({ personaId, aboutPersonaId }: any) => {
      const key = personaId + '->' + aboutPersonaId
      backfillTicks[key] = 0
      return { started: true }
    },
    backfillCanonStatus: async ({ personaId, aboutPersonaId }: any) => {
      const key = personaId + '->' + aboutPersonaId
      // 反向（id 大的看 id 小的）模拟「后端没有任务」→ 前端应在两次后报错
      if (personaId > aboutPersonaId) return { status: 'none', itemCount: 0, error: null }
      backfillTicks[key] = (backfillTicks[key] ?? 0) + 1
      if (backfillTicks[key]! >= 3) return { status: 'done', itemCount: 2, error: null }
      return { status: 'running', itemCount: 0, error: null }
    },
    backfillJobs: async () => [],

    startRelationCompletion: async ({ personaIds }: any) => {
      const job = mkJob(personaIds?.length ?? MOCK_PERSONAS.length, personaIds ?? [])
      return { jobId: job.id }
    },
    relationCompletionStatus: async (jobId: number) => {
      const job = JOBS.find((j) => j.id === jobId)
      return job ? jobStatusOf(job) : null
    },
    listCompletionJobs: async () =>
      JOBS.map((j) => ({
        id: j.id,
        status: j.cancelled ? 'cancelled' : j.paused ? 'paused' : j.status,
        progress: j.progress,
        progressRaw: JSON.stringify(j.progress),
        stats: j.stats,
        statsRaw: j.statsRaw,
        // 后端 scope 是 JSON 对象 { personaIds, apiPresetId }（resume 自恢复依据）
        scope: { personaIds: j.personaIds, apiPresetId: MOCK_PRESETS[0]?.id ?? 1 },
        createdAt: new Date().toISOString(),
        finishedAt: j.status === 'applied' || j.cancelled ? new Date().toISOString() : null,
      })),
    pauseCompletion: async ({ jobId }: { jobId: number }) => {
      const job = JOBS.find((j) => j.id === jobId)
      if (job) job.paused = true
      return { ok: true }
    },
    resumeCompletion: async ({ jobId }: { jobId: number }) => {
      const job = JOBS.find((j) => j.id === jobId)
      if (job) job.paused = false
      return { ok: true }
    },
    cancelCompletion: async ({ jobId }: { jobId: number }) => {
      const job = JOBS.find((j) => j.id === jobId)
      if (job) job.cancelled = true
      return { ok: true }
    },
  }
}
