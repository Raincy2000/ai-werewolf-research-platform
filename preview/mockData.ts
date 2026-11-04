
/** 生成示意头像（SVG data URL）：仅用于预览，真实客户端用 personas.image_data */
const avatarOf = (ch: string, bg: string) =>
  'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0" stop-color="' + bg + '"/><stop offset="1" stop-color="#1a2233"/></linearGradient></defs>' +
    '<rect width="240" height="240" fill="url(#g)"/>' +
    '<circle cx="120" cy="95" r="46" fill="rgba(255,255,255,0.85)"/>' +
    '<ellipse cx="120" cy="196" rx="72" ry="52" fill="rgba(255,255,255,0.85)"/>' +
    '<text x="120" y="228" font-size="26" font-family="sans-serif" text-anchor="middle" fill="#0b1020" font-weight="600">' + ch + '</text>' +
    '</svg>')


// 预览用 mock 数据：真实的关系网形态（三笠↔艾伦爱恨并存等）
export const MOCK_GRAPH = {
  nodes: [
    { id: 3, name: '艾伦·耶格尔', source: 'ai-cast', image: avatarOf('艾伦', '#7a5230') },
    { id: 9, name: '三笠·阿克曼', source: 'ai-cast', image: avatarOf('三笠', '#2b4a6f') },
    { id: 8, name: '阿尔敏·阿诺德', source: 'ai-cast', image: avatarOf('阿尔敏', '#3f6b52') },
    { id: 12, name: '埃尔文·史密斯', source: 'ai-cast', image: avatarOf('埃尔文', '#5a4a7a') },
    { id: 1, name: '五条悟', source: 'ai-cast', image: avatarOf('五条', '#8a6a2a') },
    { id: 2, name: '夏油杰', source: 'ai-cast', image: avatarOf('夏油', '#4a3a5a') },
    { id: 13, name: '利威尔·阿克曼', source: 'ai-cast', image: avatarOf('利威尔', '#2f3a44') },
  ],
  edges: [
    { id: 1, from: 3, to: 9, toName: '三笠·阿克曼', kind: 'beloved', form: 'CS', layer: 'canon', positivity: 100, negativity: 90, trust: 85, involvement: 100, ambivalence: 90, closeness: 95, dependence: 70, reciprocity: 60, powerBalance: -10, formality: 10, commitment: 85, dangling: false },
    { id: 2, from: 3, to: 9, toName: '三笠·阿克曼', kind: 'kin_slayer', form: 'AR', layer: 'canon', positivity: 100, negativity: 95, trust: 40, involvement: 100, ambivalence: 95, closeness: 90, dependence: 50, reciprocity: 20, powerBalance: 20, formality: 0, commitment: 20, dangling: false },
    { id: 3, from: 3, to: 8, toName: '阿尔敏·阿诺德', kind: 'sworn_friend', form: 'CS', layer: 'canon', positivity: 85, negativity: 10, trust: 80, involvement: 85, ambivalence: 10, closeness: 80, dependence: 40, reciprocity: 70, powerBalance: 0, formality: 20, commitment: 75, dangling: false },
    { id: 4, from: 8, to: 3, toName: '艾伦·耶格尔', kind: 'sworn_friend', form: 'CS', layer: 'canon', positivity: 82, negativity: 15, trust: 78, involvement: 82, ambivalence: 15, closeness: 78, dependence: 42, reciprocity: 68, powerBalance: 0, formality: 22, commitment: 72, dangling: false },
    { id: 5, from: 12, to: 3, toName: '艾伦·耶格尔', kind: 'sovereign', form: 'AR', layer: 'canon', positivity: 55, negativity: 20, trust: 65, involvement: 55, ambivalence: 20, closeness: 30, dependence: 60, reciprocity: 35, powerBalance: 55, formality: 75, commitment: 50, dangling: false },
    { id: 6, from: 1, to: 2, toName: '夏油杰', kind: 'beloved', form: 'CS', layer: 'canon', positivity: 90, negativity: 60, trust: 70, involvement: 90, ambivalence: 60, closeness: 88, dependence: 45, reciprocity: 55, powerBalance: 0, formality: 15, commitment: 80, dangling: false },
    { id: 7, from: 2, to: 1, toName: '五条悟', kind: 'nemesis', form: 'EM', layer: 'canon', positivity: 75, negativity: 85, trust: 30, involvement: 85, ambivalence: 75, closeness: 70, dependence: 20, reciprocity: 40, powerBalance: -5, formality: 10, commitment: 35, dangling: false },
    { id: 8, from: 13, to: 9, toName: '三笠·阿克曼', kind: 'kin', form: 'CS', layer: 'canon', positivity: 70, negativity: 5, trust: 75, involvement: 70, ambivalence: 5, closeness: 65, dependence: 30, reciprocity: 50, powerBalance: 30, formality: 40, commitment: 60, dangling: false },
    { id: 9, from: 13, to: 3, toName: '艾伦·耶格尔', kind: 'mentor', form: 'AR', layer: 'canon', positivity: 45, negativity: 55, trust: 50, involvement: 55, ambivalence: 45, closeness: 35, dependence: 25, reciprocity: 45, powerBalance: 45, formality: 60, commitment: 40, dangling: false },
    { id: 10, from: 9, to: 3, toName: '艾伦·耶格尔', kind: 'trading', form: 'EM', layer: 'vale', positivity: 92, negativity: 70, trust: 66, involvement: 92, ambivalence: 70, closeness: 88, dependence: 40, reciprocity: 55, powerBalance: 0, formality: 12, commitment: 78, dangling: false },
    { id: 11, from: 1, to: 13, toName: '利威尔·阿克曼', kind: 'oppose', form: 'EM', layer: 'vale', positivity: 20, negativity: 65, trust: 40, involvement: 65, ambivalence: 20, closeness: 25, dependence: 15, reciprocity: 35, powerBalance: -20, formality: 35, commitment: 25, dangling: false },
    { id: 12, from: 8, to: 12, toName: '埃尔文·史密斯', kind: 'cooperate', form: 'EM', layer: 'vale', positivity: 40, negativity: 30, trust: 55, involvement: 40, ambivalence: 30, closeness: 28, dependence: 55, reciprocity: 30, powerBalance: 60, formality: 70, commitment: 45, dangling: false },
    { id: 13, from: 3, to: 12, toName: '埃尔文·史密斯', kind: 'suppress', form: 'EM', layer: 'vale', positivity: 20, negativity: 55, trust: 42, involvement: 55, ambivalence: 20, closeness: 30, dependence: 25, reciprocity: 30, powerBalance: -40, formality: 50, commitment: 28, dangling: false },
    { id: 14, from: 2, to: 13, toName: '利威尔·阿克曼', kind: 'team', form: 'EM', layer: 'vale', positivity: 45, negativity: 15, trust: 60, involvement: 45, ambivalence: 15, closeness: 38, dependence: 35, reciprocity: 55, powerBalance: 0, formality: 40, commitment: 42, dangling: false },
    { id: 15, from: 3, to: 8, toName: '阿尔敏·阿诺德', kind: 'cooperate', form: 'EM', layer: 'vale', positivity: 62, negativity: 18, trust: 66, involvement: 62, ambivalence: 18, closeness: 52, dependence: 45, reciprocity: 58, powerBalance: 5, formality: 35, commitment: 55, dangling: false },
    { id: 16, from: 1, to: 3, toName: '艾伦·耶格尔', kind: 'acquainted', form: 'EM', layer: 'vale', positivity: 30, negativity: 20, trust: 48, involvement: 30, ambivalence: 20, closeness: 22, dependence: 12, reciprocity: 40, powerBalance: 0, formality: 55, commitment: 20, dangling: false },
  ],
  nodeIds: [3, 9, 8, 12, 1, 2, 13],
}

export const MOCK_PRESETS = [
  { id: 1, name: 'Kimi 主力', provider: 'kimi', baseUrl: '', model: 'kimi-k3', apiKey: 'x', updatedAt: new Date().toISOString() },
  { id: 2, name: 'DeepSeek 备用', provider: 'deepseek', baseUrl: '', model: 'deepseek-chat', apiKey: 'x', updatedAt: new Date().toISOString() },
]

export const MOCK_PERSONAS = MOCK_GRAPH.nodes.map((n) => ({ id: n.id, name: n.name }))

export const MOCK_JOBS: Record<number, unknown> = {}

// ---------------------------------------------------------------------------
// 预览 fixture：空图 / 悬空边+自环 / 大图（无后端手工验证用）
// ---------------------------------------------------------------------------

export type MockGraphFixture = 'normal' | 'empty' | 'dangling' | 'large'

export type MockGraph = {
  nodes: Array<{ id: number; name: string; source: string; image: string | null }>
  edges: Array<Record<string, unknown>>
  nodeIds: number[]
}

export const MOCK_GRAPH_EMPTY: MockGraph = { nodes: [], edges: [], nodeIds: [] }

/** 悬空边（库外角色）+ 自环：验证侧栏列出与自环小圆环 */
export const MOCK_GRAPH_DANGLING: MockGraph = {
  nodes: [
    { id: 9, name: '三笠·阿克曼', source: 'ai-cast', image: avatarOf('三笠', '#2b4a6f') },
    { id: 3, name: '艾伦·耶格尔', source: 'ai-cast', image: avatarOf('艾伦', '#7a5230') },
  ],
  edges: [
    { id: 1, from: 9, to: 0, toName: '希斯特里亚·雷斯', kind: 'kin', form: 'CS', layer: 'canon', positivity: 60, negativity: 20, trust: 70, involvement: 60, ambivalence: 20, closeness: 50, dependence: 30, reciprocity: 40, powerBalance: 0, formality: 30, commitment: 50, dangling: true },
    { id: 2, from: 9, to: 0, toName: '尤弥尔', kind: 'beloved', form: 'CS', layer: 'canon', positivity: 90, negativity: 30, trust: 80, involvement: 90, ambivalence: 30, closeness: 85, dependence: 40, reciprocity: 50, powerBalance: 0, formality: 10, commitment: 80, dangling: true },
    { id: 3, from: 9, to: 3, toName: '艾伦·耶格尔', kind: 'beloved', form: 'CS', layer: 'canon', positivity: 100, negativity: 90, trust: 85, involvement: 100, ambivalence: 90, closeness: 95, dependence: 70, reciprocity: 60, powerBalance: -10, formality: 10, commitment: 85, dangling: false },
    { id: 4, from: 3, to: 9, toName: '三笠·阿克曼', kind: 'kin_slayer', form: 'AR', layer: 'canon', positivity: 100, negativity: 95, trust: 40, involvement: 100, ambivalence: 95, closeness: 90, dependence: 50, reciprocity: 20, powerBalance: 20, formality: 0, commitment: 20, dangling: false },
    // 自环：验证「自环单独画小圆环」
    { id: 5, from: 3, to: 3, toName: '艾伦·耶格尔', kind: 'unspecified', form: 'CS', layer: 'vale', positivity: 40, negativity: 40, trust: 50, involvement: 40, ambivalence: 40, closeness: 40, dependence: 30, reciprocity: 40, powerBalance: 0, formality: 20, commitment: 40, dangling: false },
  ],
  nodeIds: [9, 3],
}

/** 大图：36 人 × 约 110 条边，验证绘制/命中/性能不卡死 */
export const MOCK_GRAPH_LARGE: MockGraph = (() => {
  const N = 36
  const names = Array.from({ length: N }, (_, i) => '角色' + String(i + 1).padStart(2, '0'))
  const nodes = names.map((name, i) => ({
    id: i + 1,
    name,
    source: 'ai-cast',
    image: avatarOf(name.slice(0, 2), ['#7a5230', '#2b4a6f', '#3f6b52', '#5a4a7a', '#8a6a2a', '#4a3a5a'][i % 6]!),
  }))
  const kinds = ['kin', 'beloved', 'sworn_friend', 'comrade', 'peer', 'mentor', 'rival', 'nemesis', 'creditor']
  const edges: Array<Record<string, unknown>> = []
  let id = 1
  for (let i = 0; i < N; i += 1) {
    const deg = 2 + (i % 5)
    for (let k = 0; k < deg; k += 1) {
      const to = ((i * 7 + k * 11 + 3) % N) + 1
      if (to === i) continue
      const inv = 20 + ((i * 13 + k * 17) % 80)
      edges.push({
        id: id++,
        from: i + 1,
        to,
        toName: names[to - 1],
        kind: kinds[(i + k) % kinds.length],
        form: k % 2 ? 'CS' : 'AR',
        layer: (i + k) % 3 === 0 ? 'vale' : 'canon',
        positivity: inv,
        negativity: 100 - inv,
        trust: (inv + 30) % 100,
        involvement: inv,
        ambivalence: 100 - inv,
        closeness: (inv + 15) % 100,
        dependence: (inv + 40) % 100,
        reciprocity: (inv + 5) % 100,
        powerBalance: (i % 7) * 10 - 30,
        formality: (k * 20) % 100,
        commitment: (inv + 10) % 100,
        dangling: false,
      })
    }
  }
  return { nodes, edges, nodeIds: nodes.map((n) => n.id) }
})()

export const MOCK_GRAPH_BY_FIXTURE: Record<MockGraphFixture, MockGraph> = {
  normal: MOCK_GRAPH,
  empty: MOCK_GRAPH_EMPTY,
  dangling: MOCK_GRAPH_DANGLING,
  large: MOCK_GRAPH_LARGE,
}
