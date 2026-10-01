// 图书馆文档文本提取：base64 → 纯文本
// - 文本类（txt/md/markdown/log/json/csv）：直接 UTF-8 解码
// - docx：ZIP 容器（word/document.xml），按中央目录解析（EOCD → central directory），
//   兼容流式写入（data descriptor）的条目——本地头 size=0 的条目靠中央目录定位
// - pdf：结构复杂需专用解析器，暂不支持（明确报错而非乱码入库）
import zlib from "node:zlib";

const TEXT_FORMATS = new Set(["txt", "md", "markdown", "log", "json", "csv", "text"]);
// 不设内容上限（AI 已有选择性查阅机制，大书可整本入库）

/**
 * 正规 ZIP 解包（中央目录驱动）：
 * 1) 从文件尾倒查 EOCD（PK\x05\x06）拿到中央目录位置；
 * 2) 中央目录条目（PK\x01\x02）带可靠的压缩大小与本地头偏移——
 *    流式写入（本地头 compSize=0 + 数据描述符）的条目也能正确定位；
 * 3) 按本地头偏移取数据，method 0 直取 / method 8 inflateRaw。
 */
function unzipEntry(buf: Buffer, wantName: string): Buffer | null {
  // 1) EOCD：从尾部 64KB 内倒查签名
  const tailStart = Math.max(0, buf.length - 66_000);
  let eocd = -1;
  for (let i = buf.length - 22; i >= tailStart; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const cdCount = buf.readUInt16LE(eocd + 10);
  let cdOff = buf.readUInt32LE(eocd + 16);

  // 2) 遍历中央目录找目标条目
  for (let n = 0; n < cdCount && cdOff + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(cdOff) !== 0x02014b50) break;
    const method = buf.readUInt16LE(cdOff + 10);
    const compSize = buf.readUInt32LE(cdOff + 20);
    const nameLen = buf.readUInt16LE(cdOff + 28);
    const extraLen = buf.readUInt16LE(cdOff + 30);
    const commentLen = buf.readUInt16LE(cdOff + 32);
    const localOff = buf.readUInt32LE(cdOff + 42);
    const name = buf.subarray(cdOff + 46, cdOff + 46 + nameLen).toString("utf8");
    if (name === wantName) {
      // 3) 本地头：跳过文件名/扩展字段后即是数据
      if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) return null;
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(dataStart, dataStart + compSize);
      if (method === 0) return raw;
      if (method === 8) {
        try {
          return zlib.inflateRawSync(raw);
        } catch {
          return null;
        }
      }
      return null;
    }
    cdOff += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function docxToText(buf: Buffer): string {
  const xml = unzipEntry(buf, "word/document.xml");
  if (!xml) throw new Error("DOCX 解包失败（未找到正文）");
  const text = xml
    .toString("utf8")
    .replace(/<w:p[ >]/g, "\n<w:p ") // 段落换行
    .replace(/<w:br\s*\/>/g, "\n") // 显式换行
    .replace(/<w:tab\s*\/>/g, "\t")
    .replace(/<[^>]+>/g, "") // 去 XML 标签
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) throw new Error("DOCX 正文提取为空（可能是纯图片文档）");
  return text;
}

/** 入口：按格式提取文本；不支持的格式抛中文错误 */
export function extractTextFromUpload(filename: string, base64: string): { format: string; content: string } {
  const format = (filename.split(".").pop() ?? "").toLowerCase();
  const buf = Buffer.from(base64, "base64");
  let content: string;
  if (TEXT_FORMATS.has(format)) {
    content = buf.toString("utf8");
  } else if (format === "docx") {
    content = docxToText(buf);
  } else if (format === "pdf") {
    throw new Error("PDF 暂不支持（排版解析需专用组件）——请另存为 TXT/MD 后上传");
  } else {
    throw new Error(`暂不支持的格式 .${format}（支持：txt/md/markdown/log/json/csv/docx）`);
  }
  content = content.replace(/\r\n/g, "\n").trim();
  if (!content) throw new Error("未提取到文本内容（文件为空或格式异常）");
  return { format, content };
}
