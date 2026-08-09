"use server";

import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { newShareCode } from "@/lib/forum/share-code";
import {
  boards,
  groups,
  messages,
  people,
  postSources,
  posts,
  users,
  visibilityAudit,
} from "@/lib/db/schema";
import { renderMarkdown } from "@/lib/markdown";
import { assertGroupAccess } from "@/lib/queries/visibility";
import { resolveDisplayName } from "@/lib/users/display-name";
import { can } from "@/lib/rbac/can";

import { recountBoardPosts } from "./board-stats";
import { notify } from "./notify";
import { indexPost } from "./search";

/**
 * 群聊一键成帖。
 *
 * 这是连接群聊与论坛的桥，也是整个设计里**最容易出事**的地方 ——
 * 「一键成帖」加上「未登录可看论坛」，一次误操作就能把私密群聊
 * 送上公网，而且不可撤回（已经被抓取了）。
 *
 * 所以这里的每一步都往最保守的方向做：
 *   1. 转出来的帖子**强制锁定在原群可见**，不接受任何 visibility 参数
 *   2. 想提升可见性必须：管理员审核 **且** 所有被引用消息的原作者同意
 *   3. 每一次可见性变更单独留痕，含当时的同意快照
 */

export interface ConvertResult {
  ok: boolean;
  error?: string;
  postId?: string;
}

const fail = (error: string): ConvertResult => ({ ok: false, error });

/** 引用的消息条数上限。整段群聊倒进来就不是「沉淀」而是转储了 */
const MAX_MESSAGES = 60;

export async function convertMessagesToPost(input: {
  convId: string;
  messageIds: string[];
  title: string;
  intro?: string;
}): Promise<ConvertResult> {
  const user = await getCurrentUser();
  if (!user) return fail("请先登录");

  // 只能转自己看得见的群
  if (!assertGroupAccess(user, input.convId)) return fail("群不存在");

  const ids = [...new Set(input.messageIds)].slice(0, MAX_MESSAGES);
  if (ids.length === 0) return fail("至少要选一条消息");

  const rows = db
    .select()
    .from(messages)
    .where(and(eq(messages.convId, input.convId), inArray(messages.id, ids)))
    .all()
    .sort((a, b) => a.ts - b.ts);

  if (rows.length === 0) return fail("选中的消息不存在");
  // 传进来的 id 里混了别的群的消息，直接拒绝而不是悄悄过滤
  if (rows.length !== ids.length) return fail("选中的消息里有不属于这个群的");

  const title = input.title.trim();
  if (title.length < 2) return fail("标题太短了");

  const board = db.select().from(boards).where(eq(boards.key, "archive")).get();
  if (!board) return fail("找不到「群聊沉淀」版块");

  const group = db.select().from(groups).where(eq(groups.convId, input.convId)).get();

  // 把消息渲染成引用块。保留发言人与时间，读的人要能还原上下文
  const names = new Map(
    db
      .select({ wxId: people.wxId, name: people.displayName })
      .from(people)
      .where(inArray(people.wxId, [...new Set(rows.map((r) => r.senderWxId))]))
      .all()
      .map((p) => [p.wxId, p.name]),
  );

  const transcript = rows
    .map((row) => {
      // 转出去的帖子是公开可见的，发言人名字里的 wx_id 必须在这里就滤掉
      const who = resolveDisplayName([names.get(row.senderWxId), row.senderName], {
        wxId: row.senderWxId,
        fallback: "成员",
      });
      const when = new Date(row.ts).toLocaleString("zh-CN", { hour12: false });
      // 引用块里的内容按原样保留，Markdown 消毒在渲染时统一处理
      const body = row.content.split("\n").map((line) => `> ${line}`).join("\n");
      return `**${who}** · ${when}\n\n${body}`;
    })
    .join("\n\n");

  const content = [
    input.intro?.trim(),
    `> 以下内容转自群聊「${group?.name ?? input.convId}」`,
    transcript,
  ]
    .filter(Boolean)
    .join("\n\n");

  const rendered = await renderMarkdown(content);

  const created = db.transaction((tx) => {
    const post = tx
      .insert(posts)
      .values({
        // 转帖也要有短链码 —— 原来只有普通发帖那条路会生成，
        // 于是群聊转出来的帖子分享出去永远是那串 26 位的 ULID
        shareCode: newShareCode(),
        boardId: board.id,
        authorId: user.id,
        title,
        content,
        contentHtml: rendered.html,
        excerpt: rendered.excerpt,
        type: "discussion",
        status: "published",
        // 强制锁定：不接受调用方传入的任何可见性
        visibility: "group",
        visibilityGroupId: input.convId,
        visibilityLocked: true,
      })
      .returning({ id: posts.id })
      .get();

    // 记录来源与每位原作者的同意状态
    const authors = [...new Set(rows.map((r) => r.senderWxId))];
    tx.insert(postSources)
      .values({
        postId: post.id,
        convId: input.convId,
        messageIds: ids,
        convertedBy: user.id,
        consentStatus: "pending",
        consentLog: authors.map((wxId) => ({ wxId, status: "pending" as const })),
      })
      .run();

    // 这里曾是「群聊沉淀显示 0」的根因：转帖入库却从不更新版块计数。
    // 沉淀版的帖子只能从这条路进来，漏掉这一步 = 这个版的计数永远是 0
    recountBoardPosts(board.id, tx);
    tx.update(boards).set({ lastPostAt: Date.now() }).where(eq(boards.id, board.id)).run();

    return post;
  });

  indexPost(created.id, title, content);

  // 通知每一位被引用的人。不通知就等于替他们做了决定
  const authorWxIds = [...new Set(rows.map((r) => r.senderWxId))].filter(
    (wxId) => wxId !== user.wxId,
  );
  const accounts = authorWxIds.length
    ? db.select().from(users).where(inArray(users.wxId, authorWxIds)).all()
    : [];

  for (const account of accounts) {
    notify({
      userId: account.id,
      type: "system",
      groupKey: `convert:${created.id}`,
      title: "你在群里的发言被整理成了帖子",
      body: `${title} · 目前只有本群成员可见`,
      link: `/forum/p/${created.id}`,
      actorId: user.id,
      refType: "post",
      refId: created.id,
    });
  }

  audit({ actorId: user.id }, {
    action: "forum.post.create",
    targetType: "post",
    targetId: created.id,
    targetLabel: title,
    after: { source: "group_chat", convId: input.convId, messages: ids.length },
    reason: "群聊转帖",
  });

  revalidatePath("/forum");
  return { ok: true, postId: created.id };
}

export interface ConsentEntry {
  wxId: string;
  status: "pending" | "granted" | "denied";
}

/** 被引用的人表态。只有自己能替自己表态 */
export async function respondToConsent(input: {
  postId: string;
  grant: boolean;
}): Promise<ConvertResult> {
  const user = await getCurrentUser();
  if (!user?.wxId) return fail("请先登录");

  const source = db.select().from(postSources).where(eq(postSources.postId, input.postId)).get();
  if (!source) return fail("这不是群聊转帖");

  const log = (source.consentLog as ConsentEntry[] | null) ?? [];
  const mine = log.find((entry) => entry.wxId === user.wxId);
  if (!mine) return fail("你的发言不在这篇帖子里");

  const updated = log.map((entry) =>
    entry.wxId === user.wxId
      ? { ...entry, status: (input.grant ? "granted" : "denied") as ConsentEntry["status"] }
      : entry,
  );

  /*
   * 只要有一个人拒绝，整体状态就是 denied ——
   * 「多数同意」在这里不成立：被拒绝的那个人的发言依然会被公开。
   */
  const status = updated.some((e) => e.status === "denied")
    ? "denied"
    : updated.every((e) => e.status === "granted")
      ? "granted"
      : "pending";

  db.update(postSources)
    .set({ consentLog: updated, consentStatus: status })
    .where(eq(postSources.id, source.id))
    .run();

  audit({ actorId: user.id }, {
    action: "forum.post.visibility.raise",
    targetType: "post",
    targetId: input.postId,
    after: { consent: input.grant ? "granted" : "denied", overall: status },
    reason: "原作者对公开的表态",
  });

  revalidatePath(`/forum/p/${input.postId}`);
  return { ok: true, postId: input.postId };
}

/**
 * 提升可见性。**这是整个论坛最敏感的操作。**
 * 需要同时满足：管理员权限 + 所有原作者已同意。
 */
export async function raiseVisibility(input: {
  postId: string;
  to: "member" | "public";
  reason: string;
}): Promise<ConvertResult> {
  const user = await getCurrentUser();
  if (!user) return fail("请先登录");

  const reason = input.reason.trim();
  if (!reason) return fail("必须填写理由");

  const post = db.select().from(posts).where(eq(posts.id, input.postId)).get();
  if (!post) return fail("帖子不存在");

  const verdict = can(user, "forum.post.visibility.raise", {
    scopeType: "board",
    scopeId: post.boardId,
  });
  if (!verdict.allowed) return fail(verdict.reason);

  const source = db.select().from(postSources).where(eq(postSources.postId, post.id)).get();
  if (source) {
    const log = (source.consentLog as ConsentEntry[] | null) ?? [];
    const pending = log.filter((e) => e.status !== "granted");
    if (pending.length > 0) {
      return fail(
        `还有 ${pending.length} 位原作者没有同意（${log.filter((e) => e.status === "granted").length}/${log.length}）`,
      );
    }
  }

  const board = db.select().from(boards).where(eq(boards.id, post.boardId)).get();
  // 版块封顶依然生效 —— 「群聊沉淀」版封顶就是 group，这里会直接被拦住
  if (board && board.maxVisibility !== "public" && input.to === "public") {
    return fail(`「${board.name}」版块最高只能到 ${board.maxVisibility}，请先移动版块`);
  }

  db.transaction((tx) => {
    tx.update(posts)
      .set({ visibility: input.to, visibilityLocked: false, visibilityGroupId: null })
      .where(eq(posts.id, post.id))
      .run();

    // 可见性变更单独留痕，含当时的同意快照
    tx.insert(visibilityAudit)
      .values({
        targetType: "post",
        targetId: post.id,
        fromVisibility: post.visibility,
        toVisibility: input.to,
        actorId: user.id,
        reason,
        consentSnapshot: source?.consentLog ?? null,
      })
      .run();
  });

  audit({ actorId: user.id }, {
    action: "forum.post.visibility.raise",
    targetType: "post",
    targetId: post.id,
    targetLabel: post.title,
    before: { visibility: post.visibility },
    after: { visibility: input.to },
    reason,
  });

  revalidatePath(`/forum/p/${post.id}`);
  return { ok: true, postId: post.id };
}
