// 账户密码学原语测试：scrypt 密码哈希 / 会话 token 哈希 / API key AES-GCM 落库加密
import { describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  generateSessionToken,
  hashPassword,
  hashSessionToken,
  isEncrypted,
  verifyPassword,
} from "./authCrypto";

describe("hashPassword/verifyPassword（scrypt）", () => {
  it("正确密码通过、错误密码拒绝", () => {
    const stored = hashPassword("Houge011519");
    expect(verifyPassword("Houge011519", stored)).toBe(true);
    expect(verifyPassword("wrong-password", stored)).toBe(false);
    expect(verifyPassword("houge011519", stored)).toBe(false); // 大小写敏感
  });

  it("同密码两次哈希不同（随机盐），且格式为 scrypt:N:r:p:salt:hash", () => {
    const a = hashPassword("same-pass-123");
    const b = hashPassword("same-pass-123");
    expect(a).not.toBe(b);
    expect(a.startsWith("scrypt:16384:8:1:")).toBe(true);
    // 明文密码不可从存储串中还原（不含明文）
    expect(a).not.toContain("same-pass-123");
  });

  it("畸形存储串安全返回 false（不抛异常）", () => {
    expect(verifyPassword("x", "garbage")).toBe(false);
    expect(verifyPassword("x", "")).toBe(false);
  });
});

describe("会话 token", () => {
  it("token 随机唯一；sha256 哈希稳定且不含原 token", () => {
    const t1 = generateSessionToken();
    const t2 = generateSessionToken();
    expect(t1).not.toBe(t2);
    const h = hashSessionToken(t1);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken(t1)).toBe(h);
    expect(h).not.toContain(t1);
  });
});

describe("encryptSecret/decryptSecret（AES-256-GCM）", () => {
  it("加密回环还原明文", () => {
    const plain = "sk-1234567890abcdef-very-secret";
    const enc = encryptSecret(plain);
    expect(isEncrypted(enc)).toBe(true);
    expect(enc).not.toContain(plain);
    expect(decryptSecret(enc)).toBe(plain);
  });

  it("同明文两次加密不同（随机 IV）", () => {
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  it("幂等：已加密串不再二次加密；明文存量兼容读出", () => {
    const enc = encryptSecret("k");
    expect(encryptSecret(enc)).toBe(enc);
    expect(decryptSecret("legacy-plain-key")).toBe("legacy-plain-key");
  });

  it("空串原样通过；篡改密文解密返回空（不抛异常）", () => {
    expect(encryptSecret("")).toBe("");
    expect(decryptSecret("")).toBe("");
    expect(decryptSecret("v1:AAAA:BBBB:CCCC")).toBe("");
  });
});
