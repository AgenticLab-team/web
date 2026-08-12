import { paginate, type PageSlice } from "@/lib/pagination";

/**
 * 把逐群的授权行合并成「一个人一张卡」。
 *
 * ═════════════════════════════════════════
 * 合并**不能把差异合掉**
 * ═════════════════════════════════════════
 *
 * 库里存的永远是逐群的具体行（一个群一行、一条审计、单独收回），
 * 那是对的 —— 理由见 actions.ts 里 grantSendManyAction 的注释。
 * 但十二个群十二行铺在屏幕上，看的人根本认不出「这十二行其实是
 * 同一次决定」。
 *
 * 于是这里只做显示层的合并。而合并有一个必须小心的地方：
 * **同一个人的不同群，理由和额度可以是不一样的**。
 *
 *   · 全选一次给出去的十二行，理由和额度完全相同 —— 合成一句就够
 *   · 但站长后来可能单独给某个群调紧到「每天 2 条」
 *
 * 把后者也显示成一句「每天 60 条」是**在界面上说了假话**，
 * 而这类假话最难发现：它看起来很整齐。
 * 所以这里算出 `uniformReason` / `uniformPerDay` —— 只有真的一致时
 * 才给一个合并值，不一致就交给界面逐群列。
 */

export interface FlatGrant {
  convId: string;
  convName: string | null;
  userId: string;
  userName: string | null;
  reason: string | null;
  perMinute: number | null;
  perHour: number | null;
  perDay: number | null;
  createdAt: number;
}

export interface PersonGrants {
  userId: string;
  userName: string;
  groups: {
    convId: string;
    convName: string;
    reason: string | null;
    perDay: number | null;
    createdAt: number;
  }[];
  /** 所有群的理由都一样时给出那一句，否则 null —— 界面据此决定合不合并显示 */
  uniformReason: string | null;
  /** 同上，额度 */
  uniformPerDay: number | null;
  /** 有没有哪个群被单独调过额度。有的话界面要逐群列，不能合成一句 */
  mixed: boolean;
  /** 最近一次授权时间 —— 排序用 */
  latestAt: number;
}

/** 所有元素都相等时返回那个值，否则 undefined */
function unanimous<T>(values: T[]): T | undefined {
  if (values.length === 0) return undefined;
  const [first] = values;
  return values.every((v) => v === first) ? first : undefined;
}

export function mergeGrantsByUser(grants: FlatGrant[]): PersonGrants[] {
  const byUser = new Map<string, FlatGrant[]>();
  for (const g of grants) {
    const list = byUser.get(g.userId);
    if (list) list.push(g);
    else byUser.set(g.userId, [g]);
  }

  const out: PersonGrants[] = [];
  for (const [userId, rows] of byUser) {
    const reason = unanimous(rows.map((r) => r.reason));
    const perDay = unanimous(rows.map((r) => r.perDay));

    out.push({
      userId,
      /*
       * 名字可能有一行是空的（账号刚建、昵称还没同步）。
       * 取第一个非空的，全空才退回 id —— 显示 id 是最后手段，
       * 因为它对人没有任何意义。
       */
      userName: rows.map((r) => r.userName).find((n) => n && n.trim()) ?? userId,
      groups: rows
        .map((r) => ({
          convId: r.convId,
          // 群可能已经不在库里（退群、删掉）—— 那时候至少把 id 显示出来
          convName: r.convName ?? r.convId,
          reason: r.reason,
          perDay: r.perDay,
          createdAt: r.createdAt,
        }))
        .sort((a, b) => a.convName.localeCompare(b.convName, "zh")),
      uniformReason: reason ?? null,
      uniformPerDay: perDay ?? null,
      mixed: reason === undefined || perDay === undefined,
      latestAt: Math.max(...rows.map((r) => r.createdAt)),
    });
  }

  // 最近授权的排前面 —— 站长刚做过的那件事应该在眼皮底下
  return out.sort((a, b) => b.latestAt - a.latestAt);
}

/**
 * 过滤。人名和群名都能搜到。
 *
 * 搜群名要**保留整个人**，不是只留匹配的那几个群 ——
 * 「谁能往这个群发」是站长搜群名时真正要问的问题，
 * 而只留匹配的群会让那张卡看起来像「他只有这一个群」，
 * 于是站长以为可以放心，实际上他还有另外十一个。
 */
export function filterPersonGrants(people: PersonGrants[], query: string): PersonGrants[] {
  const q = query.trim().toLowerCase();
  if (!q) return people;
  return people.filter(
    (p) =>
      p.userName.toLowerCase().includes(q) ||
      p.groups.some((g) => g.convName.toLowerCase().includes(q)) ||
      (p.uniformReason ?? "").toLowerCase().includes(q) ||
      p.groups.some((g) => (g.reason ?? "").toLowerCase().includes(q)),
  );
}

/**
 * 切一页出来。
 *
 * 页码的边界行为（越界往两头夹、`?page=abc` 回第一页、空列表也算
 * 「第 1 页共 1 页」）**不在这里**，在 `lib/pagination.ts` ——
 * 后台十几个列表共用那一套。这里只负责按算好的 offset 切数组。
 *
 * 第一版我在这个文件里另写了一份 `paginate`，而仓库里已经有一份
 * 用在十个后台页面上了。两份分页迟早在边界上分叉，
 * 而分叉出来的那一份通常是漏了某个情况的（多半是空列表）。
 */
export function slicePage<T>(
  items: T[],
  rawPage: unknown,
  perPage: number,
): { items: T[]; slice: PageSlice; total: number } {
  const slice = paginate(rawPage, items.length, perPage);
  return { items: items.slice(slice.offset, slice.offset + slice.perPage), slice, total: items.length };
}
