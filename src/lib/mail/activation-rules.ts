/**
 * 哪些待核域名可以转正 —— **纯判断，不碰库**。
 *
 * ═════════════════════════════════════════
 * 为什么值得单独一个文件
 * ═════════════════════════════════════════
 *
 * 「只动三个灯全绿的」这句话是这次批量操作的**全部安全性**所在：
 * 一个 MX 没配对的域名转正之后，人可以花 400 分申领上去，
 * 然后收不到任何信 —— 而他要等到拿它去注册某个服务时才发现。
 *
 * 拆出来是为了让这一句能被直接测到：调用方（`admin-actions.ts`）
 * 要过管理员鉴权、要读 cookie，在测试里搭那一套的成本远大于这条规则本身，
 * 而**成本高的那些，最后往往就没测**。
 */

export interface DomainReadiness {
  domain: string;
  /** DNS 体检的结论。`null` 是「还没查过」，不是「查出来是错的」 */
  mxOk: boolean | null;
}

export interface ActivationSplit<T> {
  /** 可以转正 */
  ready: T[];
  /** 还没体检过 —— 不碰，但要告诉人去跑一次体检 */
  unchecked: T[];
  /** 查出来 MX 是错的 —— 更不能碰 */
  bad: T[];
}

/**
 * 把待核域名分成三堆。
 *
 * ⚠️ `null` 和 `false` 必须分开数。
 *
 * 混成一句「跳过了 37 个」的话，人不知道下一步该干什么 ——
 * 而这两堆要做的事完全不同：一堆是「跑一次 `npm run mail-dns`」，
 * 另一堆是「去注册商那边改 DNS」。
 */
export function splitByReadiness<T extends DomainReadiness>(rows: readonly T[]): ActivationSplit<T> {
  return {
    ready: rows.filter((r) => r.mxOk === true),
    unchecked: rows.filter((r) => r.mxOk === null),
    bad: rows.filter((r) => r.mxOk === false),
  };
}

/**
 * 一个域名能不能转成「已启用」。
 *
 * 这里只挡**明确查出来是错的**，不挡「还没查过」——
 * 后者是常态（新加的域名、刚跑过迁移），拦死的话会逼着人
 * 为了改一个备注先去跑一遍体检。
 */
export function refuseActivation(mxOk: boolean | null): string | null {
  if (mxOk === false) {
    return "这个域名的 MX 查出来是错的，先修 DNS —— 现在放出去等于卖一个收不到信的地址";
  }
  return null;
}
