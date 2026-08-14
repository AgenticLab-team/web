/**
 * 终端客户端的发布清单 —— 纯规则。不碰数据库、不碰文件系统。
 *
 * ═════════════════════════════════════════
 * 没有校验和的自更新等于一条远程执行
 * ═════════════════════════════════════════
 *
 * 自更新做的事是：下载一个文件，然后**用它替换掉正在跑的自己**。
 * 中间任何一环被换掉，下一次启动跑的就是别人的代码。
 *
 * HTTPS 挡住了链路上的人，但它挡不住：
 *   · 一次写错的发布（传了半个文件、传了上一个架构的二进制）
 *   · 对象存储那边被改掉
 *   · 以及最常见的 —— 下载中断，只落了 3 MB
 *
 * 所以 sha256 是**必填字段**，而不是「有就校验一下」。
 * 做成可选的话，忘了填的那次发布会静默地关掉校验。
 */

export interface ReleaseAsset {
  /** `linux-amd64` 这种。和 Go 的 GOOS-GOARCH 一致 */
  platform: string;
  url: string;
  /** 小写 hex，64 位 */
  sha256: string;
  size: number;
}

export interface ReleaseManifest {
  version: string;
  /** 发布时间，毫秒 */
  releasedAt: number;
  assets: ReleaseAsset[];
  /** 这一版改了什么，一两句。终端在更新提示里显示 */
  notes?: string;
  /**
   * **低于这个版本的必须更新**才能继续用。
   *
   * ─────────────────────────────────────────
   * 它只在一种情况下该被填上
   * ─────────────────────────────────────────
   *
   * 老版本会**做错事**，而不只是「少了新功能」——
   * 比如它把令牌写进了世界可读的文件，或者它发的请求
   * 会被服务端误解成另一个意思。
   *
   * 平时留空。填上它等于把所有人赶下线一次，
   * 而那个动作用多了就没人再当回事。
   */
  minSupported?: string;
}

/*
 * ─────────────────────────────────────────
 * 版本比较**不在这一侧**
 * ─────────────────────────────────────────
 *
 * 「有没有新版」是终端自己要回答的问题：它知道自己是哪一版，
 * 而服务端只知道最新是哪一版。
 *
 * 在这里也写一份 `compareVersions` 的话，就成了同一条规则的
 * 两份实现 —— 而它们判得不一样时，症状是「客户端说没更新，
 * 而站长在后台看到大家都在老版本上」，没有人能立刻说出是哪一边错了。
 *
 * Go 那侧的实现在 `tui/internal/update/version.go`，测试跟它在一起。
 */

/**
 * `GOOS-GOARCH` 的白名单。
 *
 * 不在名单上的直接告诉人「这个平台没有预编译的二进制，自己 go build」——
 * 而不是让他下载一个 404 页面然后 `chmod +x` 它。
 */
export const SUPPORTED_PLATFORMS = [
  "linux-amd64",
  "linux-arm64",
  "darwin-amd64",
  "darwin-arm64",
] as const;

export function isSupportedPlatform(value: string): boolean {
  return (SUPPORTED_PLATFORMS as readonly string[]).includes(value);
}

/** 形状对不对。发布清单是配置来的，错一个字段就是所有人更新失败 */
export function validateManifest(raw: unknown): { ok: true; manifest: ReleaseManifest } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "不是一个对象" };
  const m = raw as Record<string, unknown>;
  if (typeof m.version !== "string" || !m.version) return { ok: false, error: "缺 version" };
  if (!Array.isArray(m.assets) || m.assets.length === 0) return { ok: false, error: "assets 是空的" };

  for (const a of m.assets as Record<string, unknown>[]) {
    if (typeof a.platform !== "string" || !isSupportedPlatform(a.platform)) {
      return { ok: false, error: `认不出的平台：${String(a.platform)}` };
    }
    if (typeof a.url !== "string" || !/^https:\/\//.test(a.url)) {
      /*
       * 只收 https。
       *
       * http 的下载地址配合「下完就替换自己」，是一条明文的远程执行 ——
       * 而它在开发机上跑得好好的，因为开发机的网络是可信的。
       */
      return { ok: false, error: `${a.platform} 的地址不是 https` };
    }
    if (typeof a.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(a.sha256)) {
      return { ok: false, error: `${a.platform} 缺 sha256，或者格式不对` };
    }
  }

  return { ok: true, manifest: raw as unknown as ReleaseManifest };
}
