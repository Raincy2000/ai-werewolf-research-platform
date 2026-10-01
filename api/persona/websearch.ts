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
export async function gatherEvidence(name: string, hint?: string): Promise<EvidencePool> {
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
