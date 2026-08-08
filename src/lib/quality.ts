/**
 * 高质量消息判定 —— 积分与排行榜的地基。
 *
 * 上游只给结果不给算法，这条规则是用 scripts/calibrate.ts 反推出来的：
 * 按类型拆开本地数据后穷举组合，{text, quote} 且 length >= quality_min
 * 与上游榜单 10/10 完全吻合（差额恰好等于每人的 quote 条数）。
 *
 * 必须与上游一致 —— 机器人在群里报的排名和网站上的积分不能是两套数字。
 * 改这里之前先重跑 calibrate.ts。
 *
 * 单独成文件是为了能被测试直接引用，不必拖进整个数据库依赖。
 */

export const QUALITY_TYPES: ReadonlySet<string> = new Set(["text", "quote"]);

export interface QualityCandidate {
  type: string;
  length: number;
}

export function isQualityMessage(msg: QualityCandidate, qualityMin: number): boolean {
  return QUALITY_TYPES.has(msg.type) && msg.length >= qualityMin;
}
