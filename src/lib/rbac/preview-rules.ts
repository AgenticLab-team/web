/**
 * 「以某身份预览」的规则。纯函数，不碰数据库、不碰 cookie。
 *
 * ─────────────────────────────────────────
 * 这个功能天生就是一把手枪
 * ─────────────────────────────────────────
 *
 * 「切成别人的视角」在实现上和「变成别人」只差一步，而这一步没走稳
 * 的话会同时给出两个后果，两个都比这个功能本身值钱得多：
 *
 *   1. **提权**：预览一个比自己权限高的人，然后就真的有了那些权限
 *   2. **甩锅**：以别人的身份写数据，审计日志记在被预览的人头上 ——
 *      从此这个站的审计日志一条都不能信了
 *
 * 所以这里定死两条，代码里任何地方都不许绕：
 *
 *   · **权限只减不增**：预览态真正生效的是「他的 ∩ 我的」。
 *     他有而我没有的那些，预览里不给 —— 但要如实告诉我少了哪些，
 *     否则我会拿一个不完整的预览得出错误结论，
 *     那就成了「故障伪装成业务结果」。
 *   · **一个字都不许写**：预览态下所有写操作直接拒绝。
 *
 * ─────────────────────────────────────────
 * 但判定要说真话
 * ─────────────────────────────────────────
 *
 * 有个很容易走反的地方：既然不许写，那把所有写权限在预览里判成
 * 「没有」不就完了？
 *
 * 不行。这个功能存在的理由就是回答「版主到底能不能删别人的帖」。
 * 如果预览里 `forum.post.delete.any` 被判成没有，删除按钮不显示，
 * 管理员看一眼就会得出「版主不能删」—— 而这是错的。
 *
 * 所以要把**判定**和**执行**分开：
 *   · can() 照实回答 → 按钮该出现就出现，视角是真的
 *   · 真去写的时候拦下来 → 告诉他这是预览，没真执行
 *
 * 两半都要有。只做前一半是提权，只做后一半是假视角。
 */

/** 预览态存在这个 cookie 里，与真会话完全分开 —— 崩了也不会把人卡在别人身上 */
export const PREVIEW_COOKIE = "al_preview";

/**
 * 预览最多持续多久。
 *
 * 短。这不是一个「工作模式」，是一次查看 ——
 * 忘了退出的预览态挂一整天，比没有这个功能危险。
 */
export const PREVIEW_TTL_MS = 30 * 60_000;

/** 开启预览需要的权限点 */
export const PREVIEW_PERMISSION = "system.impersonate";

export interface PreviewPlan {
  ok: boolean;
  reason: string;
  /** 预览里真正生效的权限 = 他的 ∩ 我的 */
  effective: string[];
  /**
   * 他有、我没有的那些。
   *
   * **这个字段必须被显示出来。** 它不是调试信息 ——
   * 它是「你看到的这个视角有多不准」的量度。
   */
  withheld: string[];
}

export interface PreviewSubject {
  id: string;
  status: string;
  permissions: Iterable<string>;
}

export interface PreviewViewer {
  id: string;
  permissions: Iterable<string>;
  canImpersonate: boolean;
}

const FAIL = (reason: string): PreviewPlan => ({
  ok: false,
  reason,
  effective: [],
  withheld: [],
});

/**
 * 能不能以这个人的身份预览，以及预览里真正给什么权限。
 */
export function planPreview(viewer: PreviewViewer, subject: PreviewSubject): PreviewPlan {
  if (!viewer.canImpersonate) {
    return FAIL("你没有以他人身份预览的权限");
  }
  if (viewer.id === subject.id) {
    return FAIL("这就是你自己");
  }
  /*
   * 封禁账号不给预览。
   *
   * 不是因为危险，是因为**预览它没有意义又容易误导**：
   * 封禁在 can() 的第一步就短路了，切过去只会看到一片空白，
   * 而那片空白和「权限配错了」长得一模一样。
   */
  if (subject.status === "banned" || subject.status === "deleted") {
    return FAIL("这个账号已被封禁或注销，预览它只会看到一片空白");
  }

  const mine = new Set(viewer.permissions);
  const theirs = [...new Set(subject.permissions)];

  const effective = theirs.filter((p) => mine.has(p));
  const withheld = theirs.filter((p) => !mine.has(p));

  return {
    ok: true,
    reason:
      withheld.length === 0
        ? "他的权限你都有，这个预览是完整的"
        : `他有 ${withheld.length} 项权限你没有，预览里不会生效`,
    effective: effective.sort(),
    withheld: withheld.sort(),
  };
}

/** 预览还有效吗 */
export function previewActive(expiresAt: number, now: number): boolean {
  return expiresAt > now;
}

/** 还剩多少分钟，给横幅上的倒计时用 */
export function minutesLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 60_000));
}

/**
 * 预览态下写操作被拒时的说法。
 *
 * 单独拎出来是为了让它在整站一致 —— 一个人在不同页面点按钮，
 * 得到的应该是同一句解释，而不是各处各写一句。
 */
export const PREVIEW_WRITE_BLOCKED =
  "你正在以他人身份预览，这是只读的。操作没有执行 —— 退出预览后再试。";

/**
 * 预览态里哪些事即使只读也不该做。
 *
 * 目前只有一件：**不能在预览态里再开一个预览**。
 * 套娃之后「我现在到底是谁」就说不清了，而说不清的时候
 * 人会默认自己是自己 —— 那正是出事的那一刻。
 */
export function canNest(): boolean {
  return false;
}
