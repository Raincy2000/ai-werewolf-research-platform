// ============================================================
// 肖像抓取：从人物资料页（维基/百科等）提取代表图并下载为 data URL
// 链条：页面 HTML → og:image / twitter:image / infobox 图 → 下载校验（类型/大小）→ base64
// 全部 best-effort：任何一步失败返回 null（铸魂师/编辑器降级为首字占位图，绝不阻断流程）
// ============================================================

const PAGE_TIMEOUT_MS = 15_000;
const IMG_TIMEOUT_MS = 20_000;
const MAX_PAGE_BYTES = 3_000_000; // 页面 HTML 上限 3MB
const MAX_IMG_BYTES = 800_000; // 图片二进制上限 800KB（data URL 约 1.1MB，库列与载荷可控）
const VALID_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/** 从页面 HTML 提取候选图片 URL（og:image > twitter:image > infobox img），去协议相对/去重 */
export function extractImageCandidates(html: string): string[] {
  const out: string[] = [];
  const push = (u: string | undefined) => {
    if (!u) return;
    let url = u.trim();
    if (url.startsWith("//")) url = `https:${url}`;
    if (!/^https:\/\//i.test(url)) return; // 仅 https（桌面端安全策略）
    if (!out.includes(url)) out.push(url);
  };
  // og:image（两种属性顺序都容忍）
  for (const m of html.matchAll(
    /<meta[^>]+(?:property|name)=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/gi,
  )) {
    push(m[1]);
  }
  for (const m of html.matchAll(
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:image["'][^>]*>/gi,
  )) {
    push(m[1]);
  }
  // twitter:image
  for (const m of html.matchAll(
    /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["'][^>]*>/gi,
  )) {
    push(m[1]);
  }
  // 维基/百科 infobox 内的第一张图片（代表肖像的常见落点）
  const infobox = html.match(/<table[^>]+class=["'][^"']*infobox[^"']*["'][^>]*>([\s\S]{0,20000}?)<\/table>/i);
  if (infobox) {
    const img = infobox[1].match(/<img[^>]+src=["']([^"']+)["'][^>]*>/i);
    if (img) push(img[1]);
  }
  return out.slice(0, 5);
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        // 部分图床（维基等）按 UA 防盗链：以桌面浏览器身份请求
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        accept: "text/html,image/avif,image/webp,image/*,*/*;q=0.8",
      },
      redirect: "follow",
    });
  } finally {
    clearTimeout(timer);
  }
}

/** 下载图片并转 data URL（类型/大小校验；不合格返回 null） */
export async function fetchImageAsDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(url, IMG_TIMEOUT_MS);
    if (!res.ok) return null;
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!VALID_IMAGE_TYPES.has(type)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_IMG_BYTES) return null;
    return `data:${type};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/** 从人物资料页抓取代表肖像（页面 → 候选图 → 逐个尝试） */
export async function fetchPortraitFromPage(pageUrl: string): Promise<string | null> {
  try {
    if (!/^https:\/\//i.test(pageUrl)) return null;
    const res = await fetchWithTimeout(pageUrl, PAGE_TIMEOUT_MS);
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (!/text\/html/i.test(type)) return null;
    const html = (await res.text()).slice(0, MAX_PAGE_BYTES);
    for (const imgUrl of extractImageCandidates(html)) {
      const dataUrl = await fetchImageAsDataUrl(imgUrl);
      if (dataUrl) return dataUrl;
    }
    return null;
  } catch {
    return null;
  }
}
