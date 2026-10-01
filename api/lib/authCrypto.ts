// 账户与数据保全的密码学原语（全部基于 node:crypto，零新增依赖）：
// - 密码：scrypt + 每用户随机盐，存储格式 scrypt:N:r:p:saltB64:hashB64，校验用 timingSafeEqual
// - 会话：token 32 字节随机，库中只存 sha256(token)（泄库不可还原会话）
// - API key：AES-256-GCM 落库加密（格式 v1:ivB64:tagB64:cipherB64），仅服务端内存解密
import crypto from "crypto";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

// ---------- 密码哈希 ----------
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString("base64")}:${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, n, r, p, saltB64, hashB64] = stored.split(":");
    if (scheme !== "scrypt") return false;
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(hashB64, "base64");
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ---------- 会话 token ----------
export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// ---------- API key 落库加密（AES-256-GCM） ----------
let cachedKey: Buffer | null = null;

function dataKey(): Buffer {
  if (cachedKey) return cachedKey;
  // PRESET_SECRET 为 64 位 hex（32 字节）；缺失时从 APP_SECRET/DATABASE_URL 派生兜底并告警
  const secret = process.env.PRESET_SECRET;
  if (secret && /^[0-9a-f]{64}$/i.test(secret)) {
    cachedKey = Buffer.from(secret, "hex");
  } else {
    const material = process.env.APP_SECRET || process.env.DATABASE_URL || "werewolf-dev-fallback";
    cachedKey = crypto.createHash("sha256").update(`preset-key:${material}`).digest();
    if (process.env.NODE_ENV === "production" && !secret) {
      console.warn("[authCrypto] PRESET_SECRET 未配置，正使用派生兜底密钥（请尽快配置独立密钥）");
    }
  }
  return cachedKey;
}

const ENC_PREFIX = "v1";

export function encryptSecret(plain: string): string {
  if (!plain) return "";
  if (plain.startsWith(`${ENC_PREFIX}:`)) return plain; // 幂等：已加密原样返回
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", dataKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decryptSecret(stored: string): string {
  if (!stored) return "";
  if (!stored.startsWith(`${ENC_PREFIX}:`)) return stored; // 兼容未加密的存量明文
  try {
    const [, ivB64, tagB64, encB64] = stored.split(":");
    const decipher = crypto.createDecipheriv("aes-256-gcm", dataKey(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(encB64, "base64")), decipher.final()]).toString("utf8");
  } catch (err) {
    console.error("[authCrypto] 解密失败（密钥不匹配？）:", err);
    return "";
  }
}

export function isEncrypted(stored: string): boolean {
  return stored.startsWith(`${ENC_PREFIX}:`);
}
