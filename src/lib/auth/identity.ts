import "server-only";

import { eq, ne, or, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

import { normalizeIdentifier, phoneShape, usernameShape } from "./login-name";

/**
 * 「登录框里那一个输入」到底是谁。
 *
 * ─────────────────────────────────────────
 * 四列一起查，靠形状分不开
 * ─────────────────────────────────────────
 *
 * 生产库里的微信 ID 基本都是自设 ID（`a12345678`、`bhjynhnyj`），
 * 和登录名长得一模一样。所以不能先猜类型再查一列 ——
 * 猜错了就是「密码明明是对的，但说错误」。
 *
 * ─────────────────────────────────────────
 * 撞了怎么办：微信 ID 赢
 * ─────────────────────────────────────────
 *
 * 设登录名时会挡掉「已经是别人微信 ID」的字符串，但挡不住
 * **之后**才进群的人恰好用这个字符串当微信 ID。那时候同一个输入
 * 会匹配到两行。
 *
 * 两种处理都安全，选的是「微信 ID 赢」而不是「一起拒」：
 *
 * · 微信 ID 是**验证过的** —— 那个人在群里收过验证码才进得来。
 *   登录名是自己挑的，一个自选标识永远不该盖过一个验证过的标识。
 * · 一起拒的话，一个新人进群会同时把两个人挡在外面，
 *   而其中一个完全无辜、也完全不知道发生了什么。
 *
 * 被盖住的那个人还有手机号、邮箱和自己的微信 ID 三条路能进来，
 * 而且 `shadowedUsernames()` 会把这种情况数出来给后台看。
 */

/** 优先级：越靠前越先认。**微信 ID 排第一，这一条不能改** */
const PRIORITY = ["wxid", "phone", "email", "username"] as const;

export interface ResolvedIdentity {
  userId: string;
  /** 是靠哪一列找到的 —— 记进登录日志，出问题时才看得出走的哪条路 */
  via: (typeof PRIORITY)[number];
}

/**
 * 找人。**找不到就是找不到，不区分原因** ——
 * 区分了就等于送一个「这个字符串是不是社群成员」的查询接口，
 * 而群成员名单是隐私。
 *
 * 调用方拿到 null 之后仍然要照常算一次密码哈希（见 password-login.ts），
 * 否则「查不到」会从响应时间上漏出去。
 */
export function resolveIdentity(raw: string): ResolvedIdentity | null {
  const value = normalizeIdentifier(raw);
  if (!value) return null;

  /*
   * 一次查完四列，而不是查四次。
   *
   * 分四次查的话，「先查到就返回」会让不同的列走出不同的查询次数 ——
   * 一个能测出来的时间差，而它测的正是「你输的是不是一个存在的微信 ID」。
   */
  const rows = db
    .select({
      id: users.id,
      wxId: users.wxId,
      phone: users.phone,
      email: users.email,
      username: users.username,
    })
    .from(users)
    .where(
      or(
        sql`lower(${users.wxId}) = ${value}`,
        eq(users.phone, value),
        sql`lower(${users.email}) = ${value}`,
        sql`lower(${users.username}) = ${value}`,
      ),
    )
    .limit(4)
    .all();

  if (rows.length === 0) return null;

  for (const via of PRIORITY) {
    const hit = rows.find((row) => {
      if (via === "wxid") return row.wxId?.toLowerCase() === value;
      if (via === "phone") return row.phone === value;
      if (via === "email") return row.email?.toLowerCase() === value;
      return row.username?.toLowerCase() === value;
    });
    if (hit) return { userId: hit.id, via };
  }

  return null;
}

export type TakenVerdict = { ok: true; value: string } | { ok: false; reason: string };

/**
 * 设登录名之前的占用检查。
 *
 * 除了「别人已经用了这个登录名」，还要挡「这是别人的微信 ID / 手机号 / 邮箱」——
 * 不挡的话就能主动去占别人的位置，而那正是上面说的撞车。
 */
export function checkUsernameAvailable(userId: string, raw: string): TakenVerdict {
  const shape = usernameShape(raw);
  if (!shape.ok) return { ok: false, reason: shape.reason };

  const taken = db
    .select({ id: users.id })
    .from(users)
    .where(
      sql`${ne(users.id, userId)} AND (
        lower(${users.username}) = ${shape.username}
        OR lower(${users.wxId}) = ${shape.username}
        OR lower(${users.email}) = ${shape.username}
      )`,
    )
    .get();

  // 措辞不区分「被谁占了」—— 说了就等于确认那个微信 ID 在这个社群里
  if (taken) return { ok: false, reason: "这个登录名已经有人用了" };

  return { ok: true, value: shape.username };
}

export function checkPhoneAvailable(userId: string, raw: string): TakenVerdict {
  const shape = phoneShape(raw);
  if (!shape.ok) return { ok: false, reason: shape.reason };

  const taken = db
    .select({ id: users.id })
    .from(users)
    .where(sql`${ne(users.id, userId)} AND ${users.phone} = ${shape.phone}`)
    .get();

  if (taken) return { ok: false, reason: "这个手机号已经绑在另一个账号上了" };

  return { ok: true, value: shape.phone };
}

/**
 * 被后来的微信 ID 盖住的登录名。
 *
 * 这些人的登录名已经不管用了（微信 ID 优先），而他们自己
 * **不会收到任何提示** —— 只会发现「密码突然不对了」。
 * 后台能看到这个数，才有人去告诉他们换一个。
 */
export function shadowedUsernames(): { userId: string; username: string }[] {
  return db
    .select({ userId: users.id, username: users.username })
    .from(users)
    .where(
      sql`${users.username} IS NOT NULL AND EXISTS (
        SELECT 1 FROM users other
        WHERE other.id <> ${users.id} AND lower(other.wx_id) = lower(${users.username})
      )`,
    )
    .all()
    .map((row) => ({ userId: row.userId, username: row.username! }));
}
