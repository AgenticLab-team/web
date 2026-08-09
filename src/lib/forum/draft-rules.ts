/**
 * 服务端草稿。纯函数，不碰数据库。
 *
 * ─────────────────────────────────────────
 * 表建了，一行代码没读过
 * ─────────────────────────────────────────
 *
 * `forum_drafts` 整张表在 schema 之外**零引用**。
 * 现在的草稿全在 localStorage 里 —— 每 3 秒存一次，
 * 只在同一个浏览器、同一台设备上找得回来。
 *
 * 而这个站大部分人是在**微信内置浏览器**里打开的，
 * 那里的页面随时会被系统回收。切出去回个消息再回来，
 * 写了一半的帖子就没了 —— 换个设备更是从零开始。
 *
 * ─────────────────────────────────────────
 * 两台设备一份草稿，这才是真正难的地方
 * ─────────────────────────────────────────
 *
 * 表上是 `unique(user, target_type, target_id)`：一个目标只有一份草稿。
 * 直接「谁存得晚谁赢」的话，手机上放着的一个旧版本，
 * 会在下一次定时保存时把电脑上刚写完的两千字**悄悄覆盖掉** ——
 * 没有任何提示，而且没有任何办法找回。
 *
 * 所以保存要带上「我这份是基于服务器哪个版本的」。
 * 服务器上的更新，就拒绝这次保存并把服务器那份原样退回来，
 * 由人来决定用哪一份。宁可多问一句，也不能默默吞掉。
 */

export const MAX_DRAFT_CHARS = 50_000;

/** 每隔多久往服务端存一次。本地是 3 秒，服务端不必那么密 */
export const SERVER_SAVE_INTERVAL_MS = 10_000;

export type DraftTarget = "post" | "reply";

/**
 * 草稿的键。
 *
 * `target_id` 上有唯一索引，而 **SQLite 的唯一索引不约束 NULL** ——
 * 两行 `(user, "post", NULL)` 是合法的。所以这里永远给出一个
 * 非空字符串：新帖用版块 key，回复用帖子 id。
 * 少了这一条，同一个人会攒出一堆互相看不见的「新帖草稿」。
 */
export function draftKey(input: {
  target: DraftTarget;
  /** 新帖是版块 key，回复是帖子 id，编辑已有内容是那条内容的 id */
  scope: string;
}): string {
  return input.scope.trim() || "_";
}

export type SaveVerdict =
  | { ok: true; content: string; title: string | null }
  | { ok: false; reason: string }
  /** 空内容 = 删掉这份草稿，而不是存一行空的 */
  | { ok: true; discard: true };

export function checkDraft(input: { title?: string | null; content: string }): SaveVerdict {
  const content = input.content;
  const title = input.title?.trim() || null;

  /*
   * 空的就删掉，不存空行。
   *
   * 存了的话，「有一份草稿」的提示会为一份空草稿亮起来 ——
   * 而点开之后什么都没有，比没有提示更让人困惑。
   */
  if (!content.trim() && !title) return { ok: true, discard: true };

  if (content.length > MAX_DRAFT_CHARS) {
    return { ok: false, reason: `草稿太长了（上限 ${MAX_DRAFT_CHARS} 字）` };
  }
  return { ok: true, content, title };
}

export type ConflictVerdict =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * 这次保存会不会盖掉更新的东西。
 *
 * `base` 是客户端手上那份草稿的 `updatedAt`（没有就是 0）。
 * 服务器上那份比它新，说明**另一台设备在这之间写过**。
 *
 * 注意用的是 `>` 不是 `>=`：两次保存落在同一毫秒时不算冲突，
 * 否则同一个页面连着存两次就会开始自己跟自己打架。
 */
export function checkConflict(input: {
  serverUpdatedAt: number | null;
  base: number;
}): ConflictVerdict {
  if (input.serverUpdatedAt === null) return { ok: true };
  if (input.serverUpdatedAt > input.base) {
    return {
      ok: false,
      reason: "另一台设备上有更新的草稿 —— 先看看那一份，别直接盖掉",
    };
  }
  return { ok: true };
}

export interface DraftSnapshot {
  content: string;
  title: string | null;
  updatedAt: number;
}

export type Pick = "local" | "server" | "neither";

/**
 * 本地和服务端各有一份，打开编辑器时用哪一份。
 *
 * ─────────────────────────────────────────
 * 谁新用谁，一样新用本地
 * ─────────────────────────────────────────
 *
 * 本地那份是每 3 秒存的，服务端 10 秒 —— 同一台设备上连着写，
 * 本地几乎总是更新或持平。所以并列时选本地：
 * 它更可能包含最后那几个字。
 *
 * 两份差得远的时候**不自动选**，交给人 —— 这正是
 * 「在电脑上写了一半，又在手机上开了同一个编辑器」的情形，
 * 自动挑一份就一定会丢掉另一份。
 */
export const DIVERGED_MS = 60_000;

export function pickDraft(input: {
  local: DraftSnapshot | null;
  server: DraftSnapshot | null;
}): { pick: Pick; ask: boolean } {
  const { local, server } = input;

  if (!local && !server) return { pick: "neither", ask: false };
  if (!server) return { pick: "local", ask: false };
  if (!local) return { pick: "server", ask: false };

  // 内容一样就没什么可问的，随便用哪份
  if (local.content === server.content && local.title === server.title) {
    return { pick: "local", ask: false };
  }

  const gap = Math.abs(local.updatedAt - server.updatedAt);
  if (gap > DIVERGED_MS) {
    // 差得远 —— 两边是两次不同的书写，让人自己选
    return { pick: local.updatedAt >= server.updatedAt ? "local" : "server", ask: true };
  }

  return { pick: local.updatedAt >= server.updatedAt ? "local" : "server", ask: false };
}

/** 草稿只有本人看得到 —— 它是还没发表的东西，连管理员也不该翻 */
export function canReadDraft(viewerId: string | null, ownerId: string): boolean {
  return viewerId !== null && viewerId === ownerId;
}
