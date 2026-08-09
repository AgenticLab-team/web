/**
 * 异地备份的判定。纯函数。
 *
 * ─────────────────────────────────────────
 * 备份最常见的失败方式是「一直在成功」
 * ─────────────────────────────────────────
 *
 * 每天的任务都跑完了、日志里都是 ✓、页面上写着「已备份」——
 * 直到需要恢复的那天才发现文件是空的、或者根本没上传、
 * 或者上传的是一份两个月前的旧库。
 *
 * 所以这里的判定围绕三个「不能假装」：
 *
 *   ① **没配置就不是「成功 0 个」** —— 那是「异地备份根本没有在做」
 *   ② **上传返回 200 不等于对面有那个文件** —— 要读回来对哈希
 *   ③ **有文件不等于恢复得了** —— 要真的打开一次、数一次行
 */

export interface OffsiteConfig {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
}

export type OffsiteStatus =
  | "unconfigured"
  | "ok"
  | "stale"
  | "never_verified"
  | "failing";

export interface OffsiteState {
  configured: boolean;
  /** 最近一次成功上传的时间 */
  lastUploadAt: number | null;
  /** 最近一次**读回来对过哈希**的时间 */
  lastVerifiedAt: number | null;
  /** 最近一次恢复演练的时间 */
  lastDrillAt: number | null;
  lastError: string | null;
}

/** 多久没有新的异地副本就算过期 */
export const STALE_AFTER_MS = 36 * 3600_000;
/** 多久没做过恢复演练就该提醒 */
export const DRILL_AFTER_MS = 30 * 86_400_000;

export function offsiteStatus(state: OffsiteState, now: number): OffsiteStatus {
  /*
   * 没配置排在最前面，而且不是「成功」。
   * 「上传了 0 个文件，成功」和「异地备份根本没有在做」在日志里
   * 长得一模一样，但后者意味着磁盘挂了数据就全没了。
   */
  if (!state.configured) return "unconfigured";
  if (state.lastError) return "failing";
  if (state.lastUploadAt === null) return "never_verified";
  if (now - state.lastUploadAt > STALE_AFTER_MS) return "stale";
  /*
   * 上传过但从没读回来对过哈希 —— 只能证明「请求没报错」。
   * 对象存储返回 200 之后文件是空的、被截断的、写到了别的桶里，
   * 这些都不会让上传这一步失败。
   */
  if (state.lastVerifiedAt === null) return "never_verified";
  return "ok";
}

export const STATUS_LABELS: Record<OffsiteStatus, string> = {
  unconfigured: "没有异地备份",
  ok: "异地副本正常",
  stale: "异地副本过期",
  never_verified: "上传过但没验证过",
  failing: "异地备份失败",
};

export function statusTone(status: OffsiteStatus): "danger" | "warning" | "success" {
  if (status === "ok") return "success";
  if (status === "stale" || status === "never_verified") return "warning";
  return "danger";
}

export function statusDetail(state: OffsiteState, now: number): string {
  switch (offsiteStatus(state, now)) {
    case "unconfigured":
      return "备份和归档都只存在服务器这一块磁盘上 —— 磁盘挂了两样一起没";
    case "failing":
      return state.lastError ?? "未知错误";
    case "never_verified":
      return state.lastUploadAt === null
        ? "配置好了但一次都没传成功过"
        : "传上去了，但从没读回来对过哈希 —— 只能证明请求没报错";
    case "stale":
      return `最近一份异地副本是 ${Math.round((now - (state.lastUploadAt ?? now)) / 3600_000)} 小时前的`;
    case "ok":
      return needsDrill(state, now)
        ? `副本正常，但已经 ${Math.round((now - (state.lastDrillAt ?? 0)) / 86_400_000)} 天没做过恢复演练`
        : "副本已读回校验";
  }
}

/**
 * 该不该做一次恢复演练。
 *
 * 没演练过的备份只是一堆字节。真正要用的时候才发现打不开，
 * 那时候原库已经没了 —— 演练是**唯一**能提前发现这件事的办法。
 */
export function needsDrill(state: OffsiteState, now: number): boolean {
  if (!state.configured) return false;
  if (state.lastDrillAt === null) return state.lastUploadAt !== null;
  return now - state.lastDrillAt > DRILL_AFTER_MS;
}

export interface RemoteObject {
  key: string;
  size: number;
  etag?: string;
}

export interface LocalFile {
  name: string;
  size: number;
}

/**
 * 哪些本地文件还没有异地副本。
 *
 * 只比名字和大小 —— 大小对不上说明上次传了一半，要重传。
 * 只比名字的话，一个被截断的对象会永远被当成「已经传过了」。
 */
export function missingRemotely(
  local: LocalFile[],
  remote: RemoteObject[],
  prefix: string,
): LocalFile[] {
  const byKey = new Map(remote.map((r) => [r.key, r]));
  return local.filter((f) => {
    const found = byKey.get(`${prefix}${f.name}`);
    return !found || found.size !== f.size;
  });
}

/**
 * 远端该删掉哪些。
 *
 * 保留策略和本地一致，但**永远多留一份**：本地已经轮转掉的那份
 * 在远端再放一阵子没什么成本，而少留一份的代价是某天发现
 * 唯一想要的那个版本刚好在昨天被清掉了。
 */
export function expiredRemotely(
  remote: RemoteObject[],
  keep: { daily: number; weekly: number },
  prefix: string,
): RemoteObject[] {
  const doomed: RemoteObject[] = [];
  for (const [kind, n] of [
    ["daily", keep.daily + 1],
    ["weekly", keep.weekly + 1],
  ] as const) {
    const group = remote
      .filter((r) => r.key.startsWith(`${prefix}agenticlab-${kind}-`))
      .sort((a, b) => b.key.localeCompare(a.key));
    doomed.push(...group.slice(n));
  }
  return doomed;
}

/**
 * 配置齐了没有。
 *
 * 缺一项就整体算没配置 —— 半套配置比没配置更糟：
 * 它会让任务真的跑起来、真的失败，然后失败被当成偶发问题忽略掉。
 */
export function readConfig(env: Record<string, string | undefined>): OffsiteConfig | null {
  const endpoint = env.OFFSITE_S3_ENDPOINT?.trim();
  const bucket = env.OFFSITE_S3_BUCKET?.trim();
  const accessKeyId = env.OFFSITE_S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.OFFSITE_S3_SECRET_ACCESS_KEY?.trim();

  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;

  let prefix = env.OFFSITE_S3_PREFIX?.trim() || "agenticlab/";
  if (prefix && !prefix.endsWith("/")) prefix += "/";

  return {
    endpoint: endpoint.replace(/\/+$/, ""),
    bucket,
    region: env.OFFSITE_S3_REGION?.trim() || "auto",
    accessKeyId,
    secretAccessKey,
    prefix,
  };
}

/** 缺了哪几项 —— 配了一半的时候要说得出缺什么 */
export function missingConfigKeys(env: Record<string, string | undefined>): string[] {
  return [
    "OFFSITE_S3_ENDPOINT",
    "OFFSITE_S3_BUCKET",
    "OFFSITE_S3_ACCESS_KEY_ID",
    "OFFSITE_S3_SECRET_ACCESS_KEY",
  ].filter((k) => !env[k]?.trim());
}
