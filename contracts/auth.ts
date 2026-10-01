// 账户相关的跨端共享合约（前后端共用）

// 默认头像：灰色抽象半身像（极简 SVG，data URL 直接入库/直出 <img src>）
const DEFAULT_AVATAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><circle cx="48" cy="48" r="48" fill="#d4d4d8"/><circle cx="48" cy="37" r="16" fill="#a1a1aa"/><path d="M14 96c3.5-20.5 16.5-31 34-31s30.5 10.5 34 31z" fill="#a1a1aa"/></svg>`;

export const DEFAULT_AVATAR = `data:image/svg+xml,${encodeURIComponent(DEFAULT_AVATAR_SVG)}`;

export interface SafeUser {
  id: string;
  email: string;
  username: string;
  avatar: string;
  createdAt: string;
}

// 云端同步的设置快照：大厅工作配置 + 分析师配置（结构由前端定义，服务端透传透存）
export interface SyncedSettings {
  lobby?: unknown;
  analyst?: unknown;
}

/** 注册时未填用户名的默认命名：用户-随机6位数字 */
export function defaultUsername(): string {
  const n = Math.floor(100000 + Math.random() * 900000);
  return `用户-${n}`;
}
