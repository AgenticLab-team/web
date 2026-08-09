/**
 * 「要不要给这个账号加个 Passkey」——普通成员那一侧的提醒规则。
 * 纯函数，不碰数据库、也不读时钟（`now` 一律由查询层传进来）。
 *
 * ─────────────────────────────────────────
 * 强制那条线不在这个文件里
 * ─────────────────────────────────────────
 *
 * `passkey-policy.ts` 管的是**管理员必须有 Passkey**：手里有 dangerLevel ≥ 2
 * 的权限、又想用密码登录的人，会被如实挡在门外。那是一条硬规矩，
 * 这里一个字都不改它。
 *
 * 这个文件管的是另一件事 —— 一个**普通成员**没绑 Passkey。
 * 他不该因此被挡在任何地方：站长的硬约束是「只有群成员能登录」，
 * 而把一个真的群成员关在门外的代价，比他少一把备用钥匙大得多。
 * 所以这一侧只有提醒，没有拦截，永远。
 *
 * ─────────────────────────────────────────
 * 一个消不掉的提醒等于一个消不掉的红点
 * ─────────────────────────────────────────
 *
 * 这个项目刚修过一个「通知重复弹出」的 bug，根因是「已读」没有真的落下来。
 * 同一个坑在这里的形态是：提醒状态只存在浏览器的 localStorage 里，
 * 于是换台设备、清一次缓存，那条已经被划掉的提醒就回来了 ——
 * 而用户会认为这个站在骗他。
 *
 * 所以两个出口的状态都**只认服务端**（users 表上的两列，见 schema/users.ts）：
 *
 *   · 「以后再说」 → `passkey_nudge_snoozed_at`，SNOOZE_DAYS 天后可以再提一次
 *   · 「不用了」   → `passkey_nudge_declined_at`，**永远不再提**
 *
 * 只给一个出口是不够的。一个只能「关掉」不能「永远关掉」的提醒，
 * 用户唯一的办法是无视它 —— 而无视一个提醒会训练他无视所有提醒，
 * 包括以后真正重要的那条。
 */

/** 「以后再说」之后隔多久可以再提一次。两周：短到还记得上次，长到不像催 */
export const SNOOZE_DAYS = 14;

/**
 * 提醒之前，这个人至少得用验证码登录过几次。
 *
 * ─────────────────────────────────────────
 * 为什么不是「刚注册完就提醒」
 * ─────────────────────────────────────────
 *
 * 刚绑定成功那一屏（/onboarding）已经摆了一次 Passkey 设置，
 * 而那是最容易被无脑关掉的时刻：用户刚经历完「切到微信、加好友、
 * 填验证码、切回来」，此刻他只想进去看看这个站长什么样。
 *
 * 更根本的原因是**那时候他还没有痛感**。Passkey 在这个站解决的
 * 具体问题是「不用再回微信找猫娘要验证码」—— 而一个只取过一次验证码的人，
 * 不知道这件事要重复多少遍。等他**第二次**为了登录切回微信等码的时候，
 * 这句话才是说给一个正好在受这个罪的人听的。
 *
 * 计数只数「验证码登录成功」这一种。用密码或 Passkey 进来的那几次不算 ——
 * 那几次他没有受这个罪，拿它们凑数会让提醒提早到一个说不通的时刻。
 */
export const MIN_CODE_LOGINS = 2;

/** 登录历史里验证码那条路的 method 值，和 bind/status 路由写进去的那个必须一致 */
export const CODE_LOGIN_METHOD = "bind_code";

export interface NudgeFacts {
  /** 已经有 Passkey 了 —— 这一条压过其它所有条件 */
  hasPasskey: boolean;
  /**
   * 手里有 dangerLevel ≥ 2 的权限。
   * 这种人走的是强制那条线，不走提醒，理由见 nudgeDecision 里的注释。
   */
  privileged: boolean;
  /** 「不用了」是什么时候说的；没说过是 null */
  declinedAt: number | null;
  /** 最近一次「以后再说」是什么时候；没推过是 null */
  snoozedAt: number | null;
  /** 到现在为止用验证码成功登录过几次 */
  codeLoginCount: number;
  /** 由查询层传进来。render 期间不许读时钟（React Compiler） */
  now: number;
  /** 覆盖默认的两周，只给测试用 */
  snoozeDays?: number;
  /** 覆盖默认的次数门槛，只给测试用 */
  minCodeLogins?: number;
}

/**
 * 不提醒的原因。
 *
 * 做成一个封闭集合而不是简单的 boolean，是为了让「为什么没弹」
 * 在测试里和排查时都是一句话就能读出来的事 ——
 * 站长这次报的问题正是「没有弹」，而当时没有任何东西能回答为什么。
 */
export type NudgeSkipReason =
  | "has_passkey"
  | "privileged"
  | "declined"
  | "snoozed"
  | "too_early";

export type NudgeDecision = { show: true } | { show: false; reason: NudgeSkipReason };

/**
 * 现在要不要摆这条提醒。
 *
 * 判断顺序是有意的，每一条都比它下面那条更「不容商量」：
 */
export function nudgeDecision(facts: NudgeFacts): NudgeDecision {
  /*
   * ① 已经绑了的人**绝对**不能再看到它。
   *
   * 放在第一条，而不是和别的条件并列写在一个大 if 里 ——
   * 并列的话，哪天有人往后面加了一个「但是如果 XX 就还是提醒」，
   * 这条最硬的规矩就被绕过去了，而症状是一个已经照做了的人
   * 被继续催着做同一件事。那是最快教会用户无视提醒的做法。
   */
  if (facts.hasPasskey) return { show: false, reason: "has_passkey" };

  /*
   * ② 有危险级权限的人不走这条提醒。
   *
   * 不是因为他不需要 Passkey —— 恰恰相反，他是最需要的那个。
   * 而是因为**他那一侧已经有一条不可关闭的线**：/me/security 顶上
   * 那行红字（selfLoginStatus 的 danger/caution）、密码登录直接被拒、
   * 以及后台设置页上那份 lockoutRisk 名单。
   *
   * 在这里再提醒一遍的坏处很具体：这张卡片带着一个「不用了」按钮，
   * 而对这个账号来说这件事**不是可选的**。给他一个能关掉的出口，
   * 等于告诉他这事可以商量。
   *
   * 反过来也要成立，而且是这一整条规则的前提：普通成员点过「不用了」
   * 之后**哪天被授了危险权限，强制那条线照常生效** ——
   * 那条线读的是权限和凭证，从来不读这两列。
   */
  if (facts.privileged) return { show: false, reason: "privileged" };

  /*
   * ③ 说过「不用了」就是永远。
   *
   * 不设过期、不设「但是过半年再问一次」。一个说好了不再出现、
   * 半年后又出现的东西，比一开始就没有承诺过更伤信任。
   * 他随时可以自己去 /me/security 加，那一页永远都在。
   */
  if (facts.declinedAt !== null) return { show: false, reason: "declined" };

  // ④ 「以后再说」——数着日子，到点了才可以再提一次
  const snoozeMs = (facts.snoozeDays ?? SNOOZE_DAYS) * 86_400_000;
  if (facts.snoozedAt !== null && facts.now - facts.snoozedAt < snoozeMs) {
    return { show: false, reason: "snoozed" };
  }

  // ⑤ 还没受够验证码的罪 —— 理由见 MIN_CODE_LOGINS
  if (facts.codeLoginCount < (facts.minCodeLogins ?? MIN_CODE_LOGINS)) {
    return { show: false, reason: "too_early" };
  }

  return { show: true };
}

export interface NudgeCopy {
  title: string;
  body: string;
}

/**
 * 提醒说什么。
 *
 * ─────────────────────────────────────────
 * 「为了安全」是废话
 * ─────────────────────────────────────────
 *
 * 这个站的登录方式是「微信群验证码 + 可选的密码」。所以这句话必须
 * 落到**这个人身上具体少受哪份罪 / 具体哪天会出事**，
 * 而不是一句放到任何网站上都成立的套话。套话的下场是被当成装饰，
 * 而被当成装饰的提醒不如没有。
 *
 * 两种人处境不同，说法也就不该一样：
 *
 *   · 没设密码的人 —— 他只有验证码这一条路，而这条路依赖群猫娘
 *     没被风控。他要听的是「你现在只有一条路，而它会断」。
 *   · 设了密码的人 —— 他不至于被卡在门外，说「你会进不来」就是吓唬人，
 *     而被吓唬过一次的人下次不会再信。他要听的是 Passkey
 *     **多**给了什么：不用敲长密码，以及它认域名、钓不走。
 */
export function nudgeCopy(input: { hasPassword: boolean }): NudgeCopy {
  if (!input.hasPassword) {
    return {
      title: "加个 Passkey，下次登录不用再回微信取验证码",
      body:
        "你现在只有验证码这一条路：每次换设备登录，都得切回微信、等群猫娘把码发过来。" +
        "猫娘被风控的那几天，这条路是断的。" +
        "Passkey 是指纹或面容按一下就进，钥匙只存在你这台设备上，我们拿不到也复制不走。",
    };
  }

  return {
    title: "加个 Passkey，比敲密码快，也骗不走",
    body:
      "你已经设了密码，所以不至于被卡在门外。Passkey 补的是另外两件事：" +
      "换台设备时不用再一个字一个字敲一遍长密码；" +
      "以及它是认域名的 —— 一个仿冒的登录页骗得走密码，骗不走 Passkey。",
  };
}
