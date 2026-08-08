import type { ACTIVITY_STATUSES, APPLICATION_STATUSES } from "@/lib/db/schema/activities";

/**
 * 活动框架的共享类型。
 *
 * 单独一个文件是为了让**纯逻辑不依赖数据库模块** ——
 * state.ts 与 eligibility.ts 要能在测试里直接 import，
 * 而 schema 会把 drizzle 整个拖进来。
 */

export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

/**
 * 模块要实现的三处差异。
 *
 * 见 MODULES.md 第一节：抽奖、内测名额、周边兑换、线下报名，
 * 骨架完全一样，只有这三处不同 ——
 * 表单长什么样、校验规则是什么、履约怎么做。
 */
export interface ActivityModule<P = Record<string, unknown>> {
  key: string;
  label: string;
  description: string;

  /** 申请表单的字段说明，前端据此渲染 */
  fields: {
    name: string;
    label: string;
    placeholder?: string;
    hint?: string;
    required: boolean;
  }[];

  /**
   * 校验申请内容。
   *
   * **纯同步的那部分**（格式、长度、字符集）与需要联网的那部分
   * （查域名是否已注册）分开：前者立刻给反馈，后者慢且会失败，
   * 不该挡住用户提交。
   */
  validate: (payload: P, config: Record<string, unknown>) => {
    ok: boolean;
    error?: string;
    /** 唯一性判据。同一个值不能被两个人占 */
    normalizedKey?: string;
  };

  /** 异步校验（查外部服务）。返回 null 表示这个模块不需要 */
  checkAvailability?: (
    normalizedKey: string,
    config: Record<string, unknown>,
  ) => Promise<{ available: boolean | "unknown"; detail: string }>;

  /** 给管理员看的一行摘要 */
  describe: (payload: P) => string;
}
