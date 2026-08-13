/**
 * 首页上的「你可以做一件事」提示 —— 谁先谁后，以及**一次只出一个**。
 *
 * ═════════════════════════════════════════
 * 三张卡片摞在一起，首页就不是首页了
 * ═════════════════════════════════════════
 *
 * 现在有三件事想提醒人：加 Passkey、装到桌面/主屏、开设备推送。
 * 三张卡片一起摆出来，头一屏就全是「你还没做这个」——
 * 而人打开首页是来看社区发生了什么的。
 *
 * 更糟的是它们会互相稀释：三条提示同时在，每一条都变成背景噪音，
 * 结果是三件事一件都不会做。**一次只出一个**，比三个一起出的
 * 完成率高，而且不惹人烦。
 *
 * ═════════════════════════════════════════
 * 顺序不是按重要性排的，是按依赖排的
 * ═════════════════════════════════════════
 *
 * iOS 上**只有加到主屏的网站才收得到推送**（系统限制）。
 * 所以在 iOS 上，「装到主屏」必须排在「开推送」前面 ——
 * 反过来提示的话，人点了「开启推送」会撞上一个做不到的按钮，
 * 而那一次失败会让他再也不试第二回。
 *
 * 别的平台上推送不依赖安装，「装到桌面」纯粹是方便，排最后。
 *
 * Passkey 排第一：它是唯一一件**关系到还能不能进来**的事。
 *
 * ═════════════════════════════════════════
 * 做完一件之后，当场不再出下一件
 * ═════════════════════════════════════════
 *
 * 刚点掉一张卡片，下一张立刻顶上来 —— 那是打地鼠，
 * 是让人学会一见到这块区域就直接划过去最快的办法。
 *
 * 所以任何一次表态（做了 / 以后再说 / 不用了）之后，
 * 整个提示位安静 `QUIET_AFTER_ACTION_MS`，下次再说。
 */

export type NudgeKind = "passkey" | "install" | "push" | "github";

/** 表过态之后，整个提示位安静多久 */
export const QUIET_AFTER_ACTION_MS = 3 * 86_400_000;

export interface NudgeInputs {
  /** 服务端算好的：这个账号该不该提示加 Passkey */
  passkeyEligible: boolean;
  /**
   * 服务端算好的：这个账号该不该提示绑 GitHub。
   *
   * （站点配了 GitHub OAuth **且**这个人还没绑。没配的话整件事不存在。）
   */
  githubEligible: boolean;
  /** 这台设备能装吗（有 beforeinstallprompt，或是 iOS Safari 且还没装） */
  canInstall: boolean;
  /** 已经装到桌面/主屏了 */
  installed: boolean;
  /** 这台设备能开推送吗（浏览器支持 + 站点配好了 + 没被拒绝） */
  canPush: boolean;
  /** 这台设备已经订阅了 */
  pushSubscribed: boolean;
  /** iOS：推送必须先装到主屏 */
  iosNeedsInstall: boolean;
  /** 这台设备上被单独关掉的那几种 */
  dismissed: readonly NudgeKind[];
  /** 上一次在这块区域表态是什么时候（这台设备） */
  lastActionAt: number | null;
  now: number;
}

/**
 * 该出哪一个。`null` = 一个都不出。
 *
 * **只返回一个** —— 调用方拿到什么就渲染什么，
 * 不给它「要不要再多显示一个」的余地。
 */
export function pickNudge(input: NudgeInputs): NudgeKind | null {
  // 刚表过态，安静一会儿
  if (
    input.lastActionAt !== null &&
    input.now - input.lastActionAt < QUIET_AFTER_ACTION_MS
  ) {
    return null;
  }

  const off = new Set(input.dismissed);

  /*
   * ① Passkey —— 唯一关系到「还进不进得来」的一件。
   *    它的「不用了 / 以后再说」记在账号上（换设备也记得），
   *    所以这里只看服务端算出来的那个布尔。
   */
  if (input.passkeyEligible && !off.has("passkey")) return "passkey";

  /*
   * ② iOS 上想收推送必须先装到主屏 —— 这一条排在推送前面，
   *    否则人会点到一个在这台设备上做不到的按钮。
   */
  if (input.iosNeedsInstall && input.canInstall && !input.installed && !off.has("install")) {
    return "install";
  }

  // ③ 开推送
  if (input.canPush && !input.pushSubscribed && !off.has("push")) return "push";

  /*
   * ④ 装到桌面 —— 别的平台上它不解锁任何东西，纯粹是方便，
   *    所以排在最后。已经能收推送的人也还是可以装。
   */
  if (input.canInstall && !input.installed && !off.has("install")) return "install";

  /*
   * ⑤ 绑 GitHub —— **排在最后**。
   *
   * 前面四件都是「这台设备上还差一步」：不做的话会丢账号、
   * 收不到通知。绑 GitHub 一件都不属于，它是纯粹的锦上添花。
   *
   * 排最后还有一个更实际的理由：它是这几件里**唯一一件
   * 会把人送出站**的（跳去 github.com 授权）。一个刚打开首页的人
   * 被推去第三方网站，回来时已经忘了本来要干什么。
   * 所以让它等到别的都处理完、这块区域反正也要空着的时候再出现。
   */
  if (input.githubEligible && !off.has("github")) return "github";

  return null;
}
