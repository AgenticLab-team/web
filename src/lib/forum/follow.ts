import "server-only";

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { boards, people, subscriptions, tags, users } from "@/lib/db/schema";
import { resolveDisplayName } from "@/lib/users/display-name";

import type { FollowTarget } from "./follow-rules";

/**
 * 关注的读取层。
 *
 * 关注列表**只有本人看得到**。
 *
 * 收口不是靠一个「能不能看」的判断函数，而是靠**签名本身**：
 * 这里每个函数都以 userId 开头，根本没有「看某某关注了谁」这种签名。
 * 没有那个签名，就没有人能在别处不小心把它调出来 ——
 * 而一个要靠调用方记得去问的判断，迟早有一处忘了问。
 *
 * （曾经有个 `canSeeFollowList()` 写在 follow-rules 里，
 *   但没有任何地方调它 —— 它描述的正是这条规矩，却不执行它。已删。）
 */

export function isFollowing(userId: string, target: FollowTarget, targetId: string): boolean {
  return Boolean(
    db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.userId, userId),
          eq(subscriptions.targetType, target),
          eq(subscriptions.targetId, targetId),
          isNull(subscriptions.mutedAt),
        ),
      )
      .get(),
  );
}

export function followCount(userId: string, target: FollowTarget): number {
  return Number(
    db
      .select({ n: sql<number>`count(*)` })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.userId, userId),
          eq(subscriptions.targetType, target),
          isNull(subscriptions.mutedAt),
        ),
      )
      .get()?.n ?? 0,
  );
}

export interface FollowItem {
  id: string;
  target: FollowTarget;
  targetId: string;
  name: string;
  /** 点进去看什么。找不到落点的（比如作者已注销）就是 null */
  href: string | null;
  createdAt: number;
  /** 被关注的东西已经没了 —— 版块删了、人注销了 */
  gone: boolean;
}

/**
 * 我关注的所有东西。
 *
 * ─────────────────────────────────────────
 * 名字要现查，不能存一份
 * ─────────────────────────────────────────
 *
 * 订阅表里只有 target_id。把名字冗余进去看起来省一次 join，
 * 代价是**改名之后关注列表里还是旧名字** —— 而这个站的昵称
 * 本来就随时会变（微信那边同步过来）。一份对不上的名字
 * 比多一次 join 贵得多。
 */
export function listFollows(userId: string): FollowItem[] {
  const rows = db
    .select({
      id: subscriptions.id,
      target: subscriptions.targetType,
      targetId: subscriptions.targetId,
      createdAt: subscriptions.createdAt,
    })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, userId),
        inArray(subscriptions.targetType, ["user", "board", "tag"]),
        isNull(subscriptions.mutedAt),
      ),
    )
    .orderBy(desc(subscriptions.createdAt))
    .all();

  if (rows.length === 0) return [];

  const idsOf = (target: FollowTarget) =>
    rows.filter((r) => r.target === target).map((r) => r.targetId);

  const boardIds = idsOf("board");
  const boardMap = new Map(
    boardIds.length
      ? db
          .select({ id: boards.id, name: boards.name, key: boards.key })
          .from(boards)
          .where(inArray(boards.id, boardIds))
          .all()
          .map((b) => [b.id, b])
      : [],
  );

  const tagIds = idsOf("tag");
  const tagMap = new Map(
    tagIds.length
      ? db
          .select({ id: tags.id, name: tags.name, slug: tags.slug })
          .from(tags)
          .where(inArray(tags.id, tagIds))
          .all()
          .map((t) => [t.id, t])
      : [],
  );

  const userIds = idsOf("user");
  const userRows = userIds.length
    ? db
        .select({
          id: users.id,
          wxId: users.wxId,
          siteNickname: users.siteNickname,
          wxNickname: users.wxNickname,
          status: users.status,
        })
        .from(users)
        .where(inArray(users.id, userIds))
        .all()
    : [];

  const wxIds = userRows.map((u) => u.wxId).filter((v): v is string => Boolean(v));
  const profiles = new Map(
    wxIds.length
      ? db
          .select({ wxId: people.wxId, name: people.displayName })
          .from(people)
          .where(inArray(people.wxId, wxIds))
          .all()
          .map((p) => [p.wxId, p.name])
      : [],
  );
  const userMap = new Map(userRows.map((u) => [u.id, u]));

  return rows.map((row): FollowItem => {
    const base = { id: row.id, target: row.target as FollowTarget, targetId: row.targetId, createdAt: row.createdAt };

    if (row.target === "board") {
      const board = boardMap.get(row.targetId);
      return board
        ? { ...base, name: board.name, href: `/forum/${board.key}`, gone: false }
        : { ...base, name: "这个版块已经没了", href: null, gone: true };
    }

    if (row.target === "tag") {
      const tag = tagMap.get(row.targetId);
      return tag
        ? { ...base, name: `#${tag.name}`, href: `/forum/search?tag=${tag.slug}`, gone: false }
        : { ...base, name: "这个标签已经没了", href: null, gone: true };
    }

    const person = userMap.get(row.targetId);
    if (!person) return { ...base, name: "这个人已经注销", href: null, gone: true };

    const name = resolveDisplayName(
      [person.siteNickname, person.wxNickname, person.wxId ? profiles.get(person.wxId) : null],
      { wxId: person.wxId, fallback: "成员" },
    );
    return {
      ...base,
      name,
      // 成员主页按微信 ID 定位；没绑微信的进不去，给 null 而不是一个 404 链接
      href: person.wxId ? `/members/${encodeURIComponent(person.wxId)}` : null,
      gone: person.status === "deleted",
    };
  });
}
