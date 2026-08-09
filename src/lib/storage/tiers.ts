/**
 * 消息分层保留。纯函数。
 *
 * ─────────────────────────────────────────
 * 「本地是缓存，不是唯一副本」——— 这句话必须被验证，不能被相信
 * ─────────────────────────────────────────
 *
 * 设计文档里写着「上游 NekoBot 才是数据源，冷数据可放心裁剪、需要时回源」。
 * 这个前提如果**不成立**，裁剪就不是裁剪，是永久删除用户的聊天记录。
 *
 * 实测（2026-08）：上游自己也只有约两个月的历史，
 * 因为机器人本身才跑了两个月 —— 也就是说**今天没有任何办法**
 * 证明上游会保留一年前的消息。前提未知，就不能拿它当依据删东西。
 *
 * 所以这里把三件事严格分开，按「删错了能不能救回来」排序：
 *
 *   ① 改层（tier）        —— 只改标记，零风险
 *   ② 退索引（unindex）   —— 正文还在本地，只是搜不到；重建索引即可复原
 *   ③ 丢正文（drop）      —— **不可逆**。必须先归档成文件，或先抽样
 *                            证明上游确实还回得来，两者都没有就拒绝执行
 *
 * 前两件事就能省下大部分空间（FTS 索引占了库的 23%），
 * 第三件事在真正需要之前不该发生。
 */

export interface TierConfig {
  /** 热层：全量正文 + 全量索引 */
  hotDays: number;
  /** 温层：全量正文，仅索引高质量消息 */
  warmDays: number;
  /** 冷层是否只保留高质量消息的正文 */
  coldKeepQualityOnly: boolean;
  /** 丢正文之前必须先归档成文件 */
  archiveBeforeDrop: boolean;
}

export const DEFAULT_TIER_CONFIG: TierConfig = {
  hotDays: 90,
  warmDays: 365,
  coldKeepQualityOnly: true,
  archiveBeforeDrop: true,
};

export type Tier = "hot" | "warm" | "cold";

/**
 * 配置本身要先讲得通 —— 这里只返回**致命**问题，返回非空就不该执行。
 *
 * `warmDays <= hotDays` 会让温层是个空区间：消息从热层直接掉进冷层，
 * 而管理员看到的是两个都填了值的表单，以为有个缓冲带。
 */
export function validateTierConfig(config: TierConfig): string[] {
  const problems: string[] = [];
  if (config.hotDays < 1) problems.push("热层至少保留 1 天");
  if (config.warmDays <= config.hotDays) {
    problems.push(
      `温层天数（${config.warmDays}）必须大于热层（${config.hotDays}）—— 否则消息会从热层直接掉进冷层，中间那层是假的`,
    );
  }
  return problems;
}

/**
 * 讲得通但需要提醒的配置。
 *
 * 关掉归档**不是**非法配置 —— 如果上游确实留着历史，那是个合理选择。
 * 但它必须在运行时被真的验证一次（见 verifyUpstreamRetention），
 * 而不是在这里一刀切禁掉：**被禁掉的分支等于没写过的分支**，
 * 那道抽样检验就永远不会执行，而它看起来还在那儿保护着什么。
 */
export function configWarnings(config: TierConfig): string[] {
  const warnings: string[] = [];
  if (!config.archiveBeforeDrop && config.coldKeepQualityOnly) {
    warnings.push(
      "没开归档：丢正文之前会先抽样验证上游确实回得来，验不过就整步跳过",
    );
  }
  if (config.warmDays > 3650) {
    warnings.push("温层超过十年，实际上等于从不进冷层");
  }
  return warnings;
}

export function tierFor(ts: number, now: number, config: TierConfig): Tier {
  const ageDays = (now - ts) / 86_400_000;
  if (ageDays < config.hotDays) return "hot";
  if (ageDays < config.warmDays) return "warm";
  return "cold";
}

/** 各层的时间边界（毫秒时间戳）。早于 coldBefore 的算冷层 */
export function tierBoundaries(now: number, config: TierConfig) {
  return {
    warmBefore: now - config.hotDays * 86_400_000,
    coldBefore: now - config.warmDays * 86_400_000,
  };
}

export interface MessageFacts {
  tier: Tier;
  indexed: boolean;
  isQuality: boolean;
  /** 正文是否还在（已丢过的不重复处理） */
  hasContent: boolean;
}

export type PruneAction = "none" | "retier" | "unindex" | "drop";

export interface PlannedChange {
  /** 目标层 */
  tier: Tier;
  /** 该不该留在 FTS 索引里 */
  indexed: boolean;
  /** 该不该丢掉正文 */
  dropContent: boolean;
}

/**
 * 一条消息在目标层应该是什么样子。
 *
 * 注意这里返回的是**期望状态**而不是「要做什么」——
 * 期望状态可以反复计算并和现状比对，做多少次结果都一样；
 * 「要做什么」算错一次就没法自查了。
 */
export function desiredState(
  targetTier: Tier,
  facts: Pick<MessageFacts, "isQuality">,
  config: TierConfig,
): PlannedChange {
  if (targetTier === "hot") {
    return { tier: "hot", indexed: true, dropContent: false };
  }
  if (targetTier === "warm") {
    // 温层只索引高质量消息 —— 正文全留着，只是搜不到
    return { tier: "warm", indexed: facts.isQuality, dropContent: false };
  }
  return {
    tier: "cold",
    indexed: facts.isQuality,
    dropContent: config.coldKeepQualityOnly && !facts.isQuality,
  };
}

/** 现状和期望的差距 —— 空数组表示这条已经就位 */
export function changesFor(current: MessageFacts, desired: PlannedChange): PruneAction[] {
  const actions: PruneAction[] = [];
  if (current.tier !== desired.tier) actions.push("retier");
  if (current.indexed && !desired.indexed) actions.push("unindex");
  // 已经丢过正文的不重复算 —— 否则预览里的数字会一轮比一轮大
  if (desired.dropContent && current.hasContent) actions.push("drop");
  return actions;
}

/**
 * 只索引有文字的消息 —— 和同步侧保持一致。
 *
 * 图片、表情进索引没有意义，白占体积；而如果这里和同步侧的判断不一致，
 * 裁剪会把同步刚建好的索引删掉，下一轮同步再建回来，两个任务互相拆台。
 */
export const INDEXABLE_TYPES = new Set(["text", "quote"]);

export function isIndexable(type: string, content: string): boolean {
  return INDEXABLE_TYPES.has(type) && content.trim().length > 0;
}

export interface PrunePreview {
  /** 只改标记的条数 */
  retier: number;
  /** 会从搜索里消失的条数 */
  unindex: number;
  /** 会丢掉正文的条数（不可逆） */
  drop: number;
  /** 丢正文能省下的正文字节数（不含索引） */
  dropBytes: number;
  /** 退索引能省下的索引字节数（估算） */
  unindexBytes: number;
  /** 受影响的最早/最晚时间，让人看得出动的是哪一段 */
  oldestTs: number | null;
  newestTs: number | null;
}

export const EMPTY_PREVIEW: PrunePreview = {
  retier: 0,
  unindex: 0,
  drop: 0,
  dropBytes: 0,
  unindexBytes: 0,
  oldestTs: null,
  newestTs: null,
};

/**
 * FTS 索引的体积估算。
 *
 * 实测（27 MB 的库、42k 条消息）：`messages_fts_*` 合计约 6.2 MB，
 * 而被索引正文的总字节数约 4.9 MB —— 索引大概是正文的 1.27 倍。
 * 这是个估算，预览里必须说清楚是「约」，执行后再报实际释放量。
 */
export const FTS_OVERHEAD_RATIO = 1.27;

export function estimateFtsBytes(contentBytes: number): number {
  return Math.round(contentBytes * FTS_OVERHEAD_RATIO);
}

/** 预览里要说人话：「省 12 MB」而不是「12582912」 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

/**
 * 预览是否包含不可逆操作 —— 决定要不要二次确认。
 */
export function isIrreversible(preview: PrunePreview): boolean {
  return preview.drop > 0;
}

/** 什么都不会发生的时候，别让按钮看起来像会做事 */
export function isNoop(preview: PrunePreview): boolean {
  return preview.retier === 0 && preview.unindex === 0 && preview.drop === 0;
}

export const TIER_LABELS: Record<Tier, string> = {
  hot: "热层",
  warm: "温层",
  cold: "冷层",
};

export function describeTier(tier: Tier, config: TierConfig): string {
  if (tier === "hot") return `近 ${config.hotDays} 天 · 全文可搜`;
  if (tier === "warm") return `${config.hotDays}–${config.warmDays} 天 · 正文都在，只有高质量的可搜`;
  return config.coldKeepQualityOnly
    ? `超过 ${config.warmDays} 天 · 只留高质量正文，其余归档`
    : `超过 ${config.warmDays} 天 · 正文全留`;
}

/**
 * 磁盘水位到线时该不该自动裁剪一次。
 *
 * 自动触发**只做可逆的那两步**（改层、退索引）——
 * 永久删掉聊天记录这件事应该有个人按下确认，
 * 而不是某天凌晨三点由一个 cron 悄悄完成。
 *
 * 冷却窗口不是为了省 CPU，是为了不让「自动裁剪」变成一个
 * 每五分钟跑一次、每次都省不下什么、但日志里满是「已裁剪」的仪式。
 */
export const AUTO_PRUNE_COOLDOWN_MS = 6 * 3600_000;

export function shouldAutoPrune(input: {
  diskPct: number;
  prunePct: number;
  lastRunAt: number | null;
  /** 这次真的有事可做吗 —— 没有就别跑，跑了也只是刷日志 */
  hasWork: boolean;
  now: number;
}): { run: boolean; reason: string } {
  if (input.diskPct < input.prunePct) {
    return { run: false, reason: `磁盘 ${input.diskPct}%，没到 ${input.prunePct}% 的自动裁剪线` };
  }
  if (!input.hasWork) {
    return { run: false, reason: "水位到线了，但没有任何消息够得上裁剪 —— 空间不是消息占的" };
  }
  if (input.lastRunAt !== null && input.now - input.lastRunAt < AUTO_PRUNE_COOLDOWN_MS) {
    const hours = Math.round((input.now - input.lastRunAt) / 3600_000);
    return { run: false, reason: `${hours} 小时前刚自动裁过，冷却中` };
  }
  return { run: true, reason: `磁盘 ${input.diskPct}% 已过 ${input.prunePct}% 线，执行可逆裁剪` };
}
