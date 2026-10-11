// ============================================================
// AI 额度耗尽识别（独立纯函数模块：service 层直接依赖，不走 providers——
// 测试普遍 mock 掉整个 providers 模块，纯函数放这里才不会被 mock 吞掉导致 TypeError）
// ============================================================

/** 额度耗尽错误识别（DeepSeek「Insufficient Balance」/HTTP 402、OpenAI insufficient_quota、
 *  中文余额不足/欠费等）：此类故障重试与同池换人都无效——所有座位共享同一账户额度 */
const QUOTA_RE =
  /insufficient[ _]?balance|insufficient[_ ]?quota|余额不足|额度不足|欠费|quota exceeded|payment required|HTTP 402/i;

export function isQuotaErrorText(text: string | null | undefined): boolean {
  return !!text && QUOTA_RE.test(text);
}

/** 调用层故障识别（超时/断网/预算耗尽/5xx/限流）：这类故障的共性是「AI 根本没产出内容」，
 *  区别于「输出非法/无法解析」（模型产出了但格式坏——那是模型行为问题，不算服务中断）。
 *  服务层据此做连续失效熔断：断电/休眠后的连接假死会表现为全座位连续超时（20261011003 实锤）。 */
const OUTAGE_RE =
  /超时|预算耗尽|无响应|fetch failed|ECONN|ETIMEDOUT|EPIPE|socket|网络|HTTP 5\d\d|HTTP 429|调用失败/i;
export function isOutageErrorText(text: string | null | undefined): boolean {
  return !!text && OUTAGE_RE.test(text);
}
