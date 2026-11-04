// ============================================================
// 服务端检索证据池（铸魂师的模型无关联网底座）
// 设计动机：模型原生联网能力各家割裂（Kimi 内置工具 / Anthropic server tool /
// DeepSeek·OpenAI 仅 Responses API / 自定义端点不可预知），这条路线由应用后端自己搜网、
// 把结果作为「证据材料」注入①②③的 prompt——任何模型都能用上真实网页资料。
// 源（全部免费零密钥）：
// - 维基百科 API（zh/en）：人物资料黄金源（摘要 + 代表图 pageimages）
// - DuckDuckGo lite：评论/访谈/分析等二手材料（②深读的养分）
// 铁律：全链 best-effort——任一源失败/为空不报错，证据池可以是空的（退模型内部知识语义）。
// ============================================================

export interface EvidenceSnippet {
  title: string;
  url: string;
  text: string;
  source: "wikipedia-zh" | "wikipedia-en" | "duckduckgo";
}

export interface EvidencePool {
  snippets: EvidenceSnippet[];
  /** 维基代表图等可直接下载的候选肖像（并入①的候选肖像挑选） */
  portraitUrls: { label: string; url: string }[];
}

const FETCH_TIMEOUT_MS = 12_000;
const SNIPPET_TEXT_LIMIT = 300;
const POOL_SNIPPET_LIMIT = 12;

async function fetchText(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        accept: "application/json,text/html,*/*;q=0.8",
      },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 维基百科（search → extracts+pageimages） ----------
interface WikiPageInfo {
  title: string;
  url: string;
  extract: string;
  imageUrl: string | null;
}

async function wikiTopPage(name: string, hint: string | undefined, lang: "zh" | "en"): Promise<WikiPageInfo | null> {
  const q = encodeURIComponent(hint ? `${name} ${hint}` : name);
  const host = lang === "zh" ? "https://zh.wikipedia.org" : "https://en.wikipedia.org";
  const searchJson = await fetchText(
    `${host}/w/api.php?action=query&list=search&srsearch=${q}&format=json&srlimit=3&origin=*`,
  );
  if (!searchJson) return null;
  try {
    const data = JSON.parse(searchJson) as {
      query?: { search?: { title: string }[] };
    };
    const title = data.query?.search?.[0]?.title;
    if (!title) return null;
    const pageJson = await fetchText(
      `${host}/w/api.php?action=query&prop=extracts|pageimages|info&inprop=url&exintro=1&explaintext=1&pithumbsize=400&titles=${encodeURIComponent(title)}&format=json&origin=*`,
    );
    if (!pageJson) return null;
    const pd = JSON.parse(pageJson) as {
      query?: {
        pages?: Record<
          string,
          { title?: string; fullurl?: string; extract?: string; thumbnail?: { source?: string } }
        >;
      };
    };
    const page = Object.values(pd.query?.pages ?? {})[0];
    if (!page?.extract) return null;
    return {
      title: page.title ?? title,
      url: page.fullurl ?? `${host}/wiki/${encodeURIComponent(title)}`,
      extract: page.extract.replace(/\s+/g, " ").trim().slice(0, 1200),
      imageUrl: page.thumbnail?.source ?? null,
    };
  } catch {
    return null;
  }
}

// ---------- DuckDuckGo lite（评论/访谈/分析等二手材料） ----------
/** DDG lite 结果页解析（纯函数）：链接在 uddg 跳转参数里编码，摘要在 result-snippet 单元格 */
export function parseDdgHtml(html: string, limit: number): EvidenceSnippet[] {
  const out: EvidenceSnippet[] = [];
  const linkRe = /<a[^>]+href="\/\/duckduckgo\.com\/l\/\?uddg=([^"&]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<td[^>]+class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;
  const links: { url: string; title: string }[] = [];
  for (const m of html.matchAll(linkRe)) {
    try {
      const url = decodeURIComponent(m[1] ?? "");
      if (!/^https:\/\//i.test(url)) continue;
      links.push({ url, title: (m[2] ?? "").replace(/<[^>]+>/g, "").trim() });
    } catch {
      /* 单条解析失败跳过 */
    }
  }
  const snippets: string[] = [];
  for (const m of html.matchAll(snippetRe)) {
    snippets.push((m[1] ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());
  }
  for (let i = 0; i < Math.min(links.length, limit); i++) {
    out.push({
      title: links[i]!.title.slice(0, 80),
      url: links[i]!.url,
      text: (snippets[i] ?? "").slice(0, SNIPPET_TEXT_LIMIT),
      source: "duckduckgo",
    });
  }
  return out;
}

async function ddgSearch(query: string, limit: number): Promise<EvidenceSnippet[]> {
  const html = await fetchText(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`);
  if (!html) return [];
  return parseDdgHtml(html, limit);
}

/**
 * 汇聚人物证据池（全并行、单源失败不影响其余）：
 * 维基 zh/en 摘要与代表图 + DDG 多查询片段（性格分析/评价访谈/结局终态——支持时代锚定）
 */
export async function gatherEvidence(
  name: string,
  hint?: string,
  /** DeepSeek API（有则优先用原生 Search；这是所有联网流程的统一底座）*/
  ds?: { baseUrl: string; apiKey: string },
): Promise<EvidencePool> {
  // ===== 首选：DeepSeek 原生 Search（实测 300ms 级、可拿正文）=====
  // 维基/DDG 在中文网络环境常不可达；Bing 对长查询分词退化。
  if (ds?.apiKey) {
    const base = hint?.trim() ? name + " " + hint.trim() : name;
    // 除了原作剧情，还要覆盖：官方设定集 / 公式书 / 官方授权游戏剧情
    // （用户定调：灰原雄的「蒸汽咒法」只在官方认可的游戏里出现，也必须能检索到）
    const qs = [
      base,
      base + " 人际关系",
      base + " 剧情 关键事件",
      base + " 官方设定集 公式书 术式",
      base + " 官方游戏 剧情 设定",
    ];
    const collected: EvidenceSnippet[] = [];
    for (const q of qs) {
      const items = await deepseekSearch(q.slice(0, 128), {
        baseUrl: ds.baseUrl,
        apiKey: ds.apiKey,
        count: 6,
        needContent: true,
        oriQuestion: name.slice(0, 128),
      });
      for (const it of items) {
        collected.push({
          title: it.siteName ? "[" + it.siteName + "] " + it.title : it.title,
          url: it.url,
          text: (it.content || it.summary || "").slice(0, 1500),
          source: "duckduckgo",
        });
      }
    }
    // URL 去重
    const seen = new Set<string>();
    const uniq = collected.filter((x) => (seen.has(x.url) ? false : (seen.add(x.url), true)));
    if (uniq.length > 0) {
      return { snippets: uniq.slice(0, POOL_SNIPPET_LIMIT), portraitUrls: [] };
    }
  }

  const queries = [
    hint?.trim() ? `${name} ${hint.trim()}` : name,
    `${name} 性格 分析`,
    `${name} 评价 访谈`,
    `${name} 结局`,
  ];
  const [wikiZh, wikiEn, ...ddgResults] = await Promise.all([
    wikiTopPage(name, hint, "zh"),
    wikiTopPage(name, hint, "en"),
    ...queries.map((q) => ddgSearch(q, 3)),
  ]);

  const snippets: EvidenceSnippet[] = [];
  if (wikiZh) {
    snippets.push({ title: `维基百科·${wikiZh.title}`, url: wikiZh.url, text: wikiZh.extract, source: "wikipedia-zh" });
  }
  if (wikiEn) {
    snippets.push({ title: `Wikipedia·${wikiEn.title}`, url: wikiEn.url, text: wikiEn.extract, source: "wikipedia-en" });
  }
  for (const list of ddgResults) snippets.push(...list);

  const portraitUrls: { label: string; url: string }[] = [];
  if (wikiZh?.imageUrl) portraitUrls.push({ label: `维基百科代表图（${wikiZh.title}）`, url: wikiZh.imageUrl });
  if (wikiEn?.imageUrl && wikiEn.imageUrl !== wikiZh?.imageUrl) {
    portraitUrls.push({ label: `Wikipedia 代表图（${wikiEn.title}）`, url: wikiEn.imageUrl });
  }

  return { snippets: snippets.slice(0, POOL_SNIPPET_LIMIT), portraitUrls };
}

/** 证据池 → prompt 注入文本（分角色压缩：①全部；②偏评论向；③事实锚点） */
export function formatEvidence(pool: EvidencePool, mode: "full" | "review" | "anchor"): string {
  if (pool.snippets.length === 0) return "";
  const isReview = mode === "review";
  const picked = isReview
    ? pool.snippets.filter((s) => s.source === "duckduckgo").slice(0, 8)
    : pool.snippets;
  const limit = mode === "anchor" ? 150 : mode === "review" ? 250 : 300;
  const lines = picked.map(
    (s, i) => `${i + 1}. [${s.title}](${s.url})\n   ${s.text.slice(0, limit)}`,
  );
  if (lines.length === 0 && isReview) {
    // 评论向为空时退回全量（有总比没有强）
    return formatEvidence(pool, "anchor");
  }
  return lines.join("\n").slice(0, mode === "anchor" ? 1500 : 2500);
}

// ============================================================
// 事件级检索（现实层补完的事实核查用）
//
// 与 gatherEvidence 的区别：那个是「了解一个人物」，这个是「核实一件事是否真有其事」。
// 因此查询模板不同：必须带上作品名（防止同名角色串台），且围绕事件关键词。
// ============================================================

/** 来源档位：A 原作(不可达) / B 官方 / C 百科 / D 同人二创(排除) */
export type SourceTier = "A" | "B" | "C" | "D";

/** 官方站点特征（主机名片段）*/
const OFFICIAL_HOSTS = ["shingeki.tv", "kodansha.co.jp", "shueisha.co.jp", "jump.jp"];
const WIKI_HOSTS = ["moegirl.org.cn", "wikipedia.org", "fandom.com", "anidb.net", "bangumi.tv", "anime-planet.com"];
/** 同人/二创站点（一律排除）*/
const FAN_HOSTS = [
  "lofter.com", "archiveofourown.org", "fanfiction.net", "tieba.baidu.com",
  "bilibili.com/read", "douban.com/note", "weibo.com",
  "pixiv.net", "ao3.org", "syosetu.com",
];

/** 正文里出现这些词 → 判定为二创/私设 */
const FAN_KEYWORDS = ["同人", "二创", "平行宇宙", "if线", "私设", "架空", "脑补", "同人文", "fanfic"];

/** 根据 URL 与正文判定来源档位 */
export function classifySource(url: string, text: string): { tier: SourceTier; reason: string } {
  const u = String(url || '').toLowerCase();
  const t = String(text || '').slice(0, 400);
  if (FAN_HOSTS.some((h) => u.includes(h))) return { tier: "D", reason: "同人站点" };
  if (FAN_KEYWORDS.some((k) => t.includes(k))) return { tier: "D", reason: "正文含二创标记" };
  if (OFFICIAL_HOSTS.some((h) => u.includes(h))) return { tier: "B", reason: "官方站点" };
  if (WIKI_HOSTS.some((h) => u.includes(h))) return { tier: "C", reason: "百科/数据库" };
  return { tier: "C", reason: "通用网页" };
}

export interface EventEvidence {
  snippets: EvidenceSnippet[];
  /** 检索用到的查询串（可审计）*/
  queries: string[];
}

/**
 * 检索某个事件的佐证材料。
 * @param work      作品名（必须带上，防止同名角色串台）
 * @param character 人物名
 * @param event     事件描述
 */
export async function searchEventEvidence(
  work: string,
  character: string,
  event: string,
  /** DeepSeek API 配置（有则优先用原生 Search，实测 300ms 级直击原作剧情）*/
  ds?: { baseUrl: string; apiKey: string },
): Promise<EventEvidence> {
  const w = cleanWorkName(work);
  const c = String(character || '').trim();
  const e = cleanQuery(event);
  const base = [w, c].filter(Boolean).join(" ");

  // ===== 首选：DeepSeek 原生 Search =====
  if (ds?.apiKey) {
    const q = [w, c, e].filter(Boolean).join(" ").slice(0, 128);
    const items = await deepseekSearch(q, {
      baseUrl: ds.baseUrl,
      apiKey: ds.apiKey,
      count: 8,
      needContent: true,
      oriQuestion: (w + " " + c).slice(0, 128),
    });
    if (items.length > 0) {
      const snips = deepseekToSnippets(items, 8);
      return {
        queries: [q],
        snippets: snips.map((x) => ({
          title: x.title,
          url: x.url,
          text: x.text,
          source: "wikipedia-zh" as const,
        })),
      };
    }
  }

  // ★ 查询策略：越具体的事件，越要短查询词 + 引号精确匹配。
  //   实测：过长的查询串会让 Bing 退化到"作品介绍"而非"事件细节"。
  const queries = [
    base + " " + e,
    c + " " + e,
    base + " 剧情 " + e,
  ].filter((q) => q.trim().length > 2);

  // 并行：Bing 三路 + 萌娘实体确认 + 维基兜底（若能连上）
  const [bing1, bing2, bing3, moegirlTitles, wikiZh] = await Promise.all([
    bingSearch(queries[0]!, 5),
    bingSearch(queries[1]!, 4),
    bingSearch(queries[2]!, 3),
    moegirlLookup(c),
    wikiTopPage(c, w || undefined, "zh").catch(() => null),
  ]);

  const snippets: EvidenceSnippet[] = [];
  for (const list of [bing1, bing2, bing3]) snippets.push(...list);
  if (wikiZh) {
    snippets.push({ title: "维基百科·" + wikiZh.title, url: wikiZh.url, text: wikiZh.extract, source: "wikipedia-zh" });
  }
  // 萌娘条目名作为"实体存在"的证据（不含正文，但能确认角色归属）
  if (moegirlTitles.length > 0) {
    snippets.push({
      title: "萌娘百科条目：" + moegirlTitles.slice(0, 3).join(" / "),
      url: "https://zh.moegirl.org.cn/" + encodeURIComponent(moegirlTitles[0]!),
      text: "该角色在萌娘百科中存在：" + moegirlTitles.slice(0, 3).join("、"),
      source: "wikipedia-zh",
    });
  }

  // URL 去重
  const seen = new Set<string>();
  const uniq = snippets.filter((x) => (seen.has(x.url) ? false : (seen.add(x.url), true)));

  return { snippets: uniq.slice(0, 14), queries };
}

/**
 * 清洗作品名：人格卡的 originSource 常是一长串
 * （"谏山创漫画《进击的巨人》及 WIT STUDIO／MAPPA 改编动画"），
 * 直接进检索串会污染查询。优先取《》里的书名。
 */
export function cleanWorkName(work: string): string {
  const raw = String(work || "").trim();
  if (!raw) return "";
  const bracket = raw.match(/《([^》]+)》/);
  if (bracket?.[1]) return bracket[1].trim();
  // 退化为：取第一个分隔符前的部分
  const cut = raw.split(/[及和与·、,，(（]/)[0]?.trim() ?? raw;
  return cut.slice(0, 20);
}

/** 清洗事件描述：去掉第一人称外壳，留下可用于检索的关键词 */
export function cleanQuery(event: string): string {
  let q = String(event || "").trim();
  // 去掉"他/她/我/你"等代词与常见虚词，留下实词
  q = q.replace(/[我你他她它]/g, " ");
  q = q.replace(/[的地得了吗呢吧啊]/g, " ");
  q = q.replace(/[，。！？、；：""''（）【】]/g, " ");
  q = q.replace(/\s+/g, " ").trim();
  return q.slice(0, 40);
}

// ============================================================
// ★ 国内可达的检索源（2026-10 实测）：
//   · 维基百科 zh/en  → 超时
//   · DuckDuckGo      → 超时
//   · 百度百科        → 403
//   · 萌娘百科        → opensearch 可用，正文被 Cloudflare 拦
//   · Bing (cn.bing.com) → ✅ 可用，含摘要
// 故：中文环境下 Bing 是唯一能稳定拿到「内容」的源，萌娘百科只作实体校验。
// ============================================================

const BING_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Bing 网页搜索（解析 b_algo 块）*/
export async function bingSearch(query: string, limit = 5): Promise<EvidenceSnippet[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(
      "https://cn.bing.com/search?q=" + encodeURIComponent(query) + "&setlang=zh-CN&count=" + limit,
      {
        signal: ctrl.signal,
        headers: { "user-agent": BING_UA, "accept-language": "zh-CN,zh;q=0.9" },
      },
    );
    if (!res.ok) return [];
    const html = await res.text();
    const out: EvidenceSnippet[] = [];
    const blockRe = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/g;
    let m: RegExpExecArray | null;
    while ((m = blockRe.exec(html)) && out.length < limit) {
      const block = m[1]!;
      const a = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      if (!a) continue;
      const url = a[1]!;
      const title = a[2]!.replace(/<[^>]+>/g, "").trim();
      const p = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
      const text = (p ? p[1]! : "").replace(/<[^>]+>/g, "").replace(/&[a-z#0-9]+;/gi, " ").trim();
      if (!title || !url) continue;
      out.push({ title, url, text: text.slice(0, 400), source: "duckduckgo" });
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// ★ DeepSeek 原生 Search / Fetch API（2026-10 实测可用，381ms 返回）
//   POST /v1/tools/search  { query, count, need_content, ori_question, localization }
//   POST /v1/tools/fetch   { url }
//   返回 results[]: { title, url, summary, content, site_name, authority, rerank_score, date }
//   支持查询操作符：site: / -site: / -term / "phrase" / lang:zh / after: / before:
// ============================================================

export interface DeepSeekSearchItem {
  title: string;
  url: string;
  summary: string;
  content: string;
  siteName: string;
  authority: number;
  rerankScore: number;
  date: string;
}

export interface DeepSeekSearchOpts {
  baseUrl: string;
  apiKey: string;
  count?: number;
  needContent?: boolean;
  oriQuestion?: string;
}

/** 调 DeepSeek 自研搜索（失败返回空数组，不抛）*/
export async function deepseekSearch(query: string, opts: DeepSeekSearchOpts): Promise<DeepSeekSearchItem[]> {
  const root = String(opts.baseUrl || "").replace(/\/+$/, "").replace(/\/v1$/, "");
  if (!root || !opts.apiKey) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25_000);
  try {
    const res = await fetch(root + "/v1/tools/search", {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json", authorization: "Bearer " + opts.apiKey },
      body: JSON.stringify({
        query: String(query || "").slice(0, 128),
        count: Math.max(1, Math.min(50, opts.count ?? 8)),
        need_content: opts.needContent !== false,
        ...(opts.oriQuestion ? { ori_question: opts.oriQuestion.slice(0, 128) } : {}),
      }),
    });
    if (!res.ok) return [];
    const j = (await res.json()) as { results?: Record<string, unknown>[] };
    if (!Array.isArray(j.results)) return [];
    return j.results.map((r) => ({
      title: String(r.title ?? ""),
      url: String(r.url ?? ""),
      summary: String(r.summary ?? ""),
      content: String(r.content ?? ""),
      siteName: String(r.site_name ?? ""),
      authority: Number(r.authority ?? 0),
      rerankScore: Number(r.rerank_score ?? 0),
      date: String(r.date ?? ""),
    }));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** 把 DeepSeek 搜索结果转成统一 EvidenceSnippet（附档位）*/
export function deepseekToSnippets(
  items: DeepSeekSearchItem[],
  limit = 10,
): Array<EvidenceSnippet & { tier: SourceTier; authority: number }> {
  return items.slice(0, limit).map((it) => ({
    title: it.siteName ? "[" + it.siteName + "] " + it.title : it.title,
    url: it.url,
    text: (it.content || it.summary || "").slice(0, 1500),
    source: "duckduckgo" as const,
    tier: classifyByAuthority(it),
    authority: it.authority,
  }));
}

/** 按站点与权威度判定档位 */
function classifyByAuthority(it: DeepSeekSearchItem): SourceTier {
  const host = it.url.toLowerCase();
  // 同人/二创站点
  if (FAN_HOSTS.some((h) => host.includes(h))) return "D";
  // 官方
  if (OFFICIAL_HOSTS.some((h) => host.includes(h))) return "B";
  // 百科类
  if (WIKI_HOSTS.some((h) => host.includes(h))) return "C";
  // DeepSeek 给的权威度：>=3 视作接近官方/大站
  if (it.authority >= 3) return "B";
  return "C";
}

// ============================================================
// 统一联网策略：按「存档里选的那个 API」决定怎么联网
//
// 各家能力不同，不能写死某一家：
//   kimi       → 内置 $web_search 工具循环（模型自己搜，质量最好）
//   anthropic  → server tool web_search
//   deepseek   → Responses 端点**没有** web_search，但有独立 /v1/tools/search
//   openai     → Responses 原生 web_search
//   其他/自定义 → 只能本地检索（Bing + 萌娘百科）兜底
// ============================================================

export type WebMode = "builtin" | "searchapi" | "none";

/** 判定某 provider 的联网方式 */
export function webModeOf(provider: string): WebMode {
  const p = String(provider || "").toLowerCase();
  if (p === "kimi" || p === "anthropic") return "builtin";
  if (p === "openai") return "builtin";
  // deepseek 的 Responses 端点实测无 web_search，必须走独立 Search API
  if (p === "deepseek") return "searchapi";
  return "none";
}

export interface ApiCfg { provider: string; baseUrl: string; apiKey: string }

export interface WebContext {
  /** 联网方式 */
  mode: WebMode;
  /** 传给 callWithWebSearch 的 web 参数：只有 builtin 才让模型自己搜 */
  useBuiltin: boolean;
  /** 需要注入 prompt 的外部材料（builtin 模式为空——模型会自己搜） */
  evidence: string;
  /** 人类可读的说明 */
  note: string;
}

/**
 * 为一次 AI 调用准备联网上下文。
 *
 * 关键设计：**不写死某一家**——按传入的 API 配置决定策略。
 * API 自己能联网就别喂二手材料（模型直连网页更准）；不能联网才补。
 */
export async function prepareWebContext(
  cfg: ApiCfg,
  name: string,
  hint?: string,
  opts?: { wantEvidence?: boolean },
): Promise<WebContext> {
  const mode = webModeOf(cfg.provider);

  if (mode === "builtin") {
    // 模型自带联网：不注入本地材料，让它直接搜
    return {
      mode,
      useBuiltin: true,
      evidence: "",
      note: cfg.provider + " 内置联网",
    };
  }

  // searchapi：用 DeepSeek 原生 Search 拿材料
  if (mode === "searchapi" && opts?.wantEvidence !== false) {
    const base = hint?.trim() ? name + " " + hint.trim() : name;
    const qs = [
      base,
      base + " 人际关系",
      base + " 剧情 关键事件",
      base + " 官方设定集 公式书",
      base + " 官方游戏 剧情",
    ];
    const chunks: string[] = [];
    for (const q of qs) {
      const items = await deepseekSearch(q.slice(0, 128), {
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        count: 6,
        needContent: true,
        oriQuestion: name.slice(0, 128),
      });
      for (const it of items) {
        const body = (it.content || it.summary || "").replace(/\s+/g, " ").trim();
        if (body.length < 40) continue;
        chunks.push("· [" + (it.siteName || "") + "] " + it.title.slice(0, 80) + "\n  " + body.slice(0, 700));
      }
    }
    // URL 级去重靠 title+首段，粗粒度够用
    const seen = new Set<string>();
    const uniq = chunks.filter((c) => (seen.has(c.slice(0, 60)) ? false : (seen.add(c.slice(0, 60)), true)));
    return {
      mode,
      useBuiltin: false,
      evidence: uniq.slice(0, 12).join("\n"),
      note: "DeepSeek Search API · " + uniq.length + " 段材料",
    };
  }

  // none：本地兜底（Bing + 萌娘），或直接空
  let local = "";
  try {
    const items = await bingSearch([name, hint].filter(Boolean).join(" ").slice(0, 120), 5);
    local = items.map((x) => "- " + x.title + "：" + x.text.slice(0, 200)).join("\n");
  } catch { local = ""; }
  return {
    mode,
    useBuiltin: false,
    evidence: local,
    note: local ? "本地检索兜底" : "无联网可用",
  };
}
/** 萌娘百科实体校验：只取 opensearch 的条目名（正文被 Cloudflare 拦）*/
export async function moegirlLookup(name: string): Promise<string[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(
      "https://zh.moegirl.org.cn/api.php?action=opensearch&search=" + encodeURIComponent(name) + "&limit=5&format=json",
      {
        signal: ctrl.signal,
        headers: { "user-agent": BING_UA, accept: "application/json", referer: "https://zh.moegirl.org.cn/" },
      },
    );
    if (!res.ok) return [];
    const j = (await res.json()) as unknown;
    if (!Array.isArray(j) || !Array.isArray(j[1])) return [];
    return (j[1] as unknown[]).map((x) => String(x)).filter(Boolean);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
