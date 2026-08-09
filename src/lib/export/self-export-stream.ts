import {
  CONTEXT_AFTER,
  CONTEXT_BEFORE,
  CONTEXT_WINDOW_MS,
  FORUM_BATCH,
  MAX_OWN_MESSAGES,
  MESSAGE_BATCH,
  WINDOW_MAX_MESSAGES,
  createPseudonyms,
  jsonl,
  runsOf,
  type ExportCounts,
  type Pseudonyms,
} from "./self-export-rules";

/**
 * 导出的组装层：把「一页一页取数据」拼成「一行一行的文本」。
 *
 * ─────────────────────────────────────────
 * 为什么数据源是注入进来的
 * ─────────────────────────────────────────
 *
 * 这一层不 import 数据库。取数的那几个函数由调用方传进来
 * （真实实现在 self-export.ts，测试里是假的分页器）。
 *
 * 这不是为了「可测试性」这句空话，而是因为这个功能里**最容易
 * 悄悄坏掉的正是分页**：某天有人图省事把 `.all()` 一把捞出来，
 * 功能照跑，测试全绿，直到某个发过四万条消息的人点了一下导出，
 * 把那台 3.7G 的机器打死。注入之后，「它到底有没有分页」
 * 成了一件可以直接断言的事：假分页器会记下每次被要了多少条。
 *
 * 同理，所有产出都是 **AsyncGenerator<string>** 而不是拼好的大字符串 ——
 * 一个 return string 的函数，无论内部写得多讲究，最后都会把整份内容
 * 在内存里存在一次。
 */

/** 消息的原始形态，字段对齐 messages 表 */
export interface RawMessage {
  id: string;
  convId: string;
  senderWxId: string;
  /** true = 社群机器人自己发的 */
  isSend: boolean;
  type: string;
  content: string;
  ts: number;
  isQuality: boolean;
  hasMedia: boolean;
}

export interface Cursor {
  ts: number;
  id: string;
}

export interface ForumPostRow {
  id: string;
  boardKey: string | null;
  boardName: string | null;
  title: string;
  content: string;
  type: string;
  status: string;
  visibility: string;
  anonymous: boolean;
  pinned: boolean;
  replyCount: number;
  reactionCount: number;
  viewCount: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  tags: string[];
}

export interface ForumReplyRow {
  id: string;
  postId: string;
  parentId: string | null;
  floor: number;
  content: string;
  status: string;
  accepted: boolean;
  anonymous: boolean;
  reactionCount: number;
  createdAt: number;
  deletedAt: number | null;
}

export interface ForumDraftRow {
  id: string;
  targetType: string;
  targetId: string | null;
  boardId: string | null;
  title: string | null;
  content: string;
  updatedAt: number;
}

export interface ForumInteractionRow {
  kind: "bookmark" | "reaction" | "poll_vote";
  targetType: string;
  targetId: string;
  detail: string | null;
  createdAt: number;
  /** 排序与游标用。收藏/表态/投票都是 ULID 主键 */
  id: string;
}

/** 帖子的上下文。看不见就只给一个原因，不给标题 */
export interface PostContext {
  visible: boolean;
  reason: string | null;
  title: string | null;
  excerpt: string | null;
  /**
   * 作者的假名键。用 wx_id 而不是站内 user_id ——
   * 这样论坛里的「p3」和群聊里的「p3」是同一个人，
   * 否则同一个人在两个文件里拿到两个代号，对话就对不上了。
   */
  authorKey: string | null;
  authorIsSelf: boolean;
}

/**
 * 取数接口。**每一个方法都必须是有界的** —— 参数里都有 limit
 * 或者天然只返回一条，没有一个能吐出「全部」。
 */
export interface ExportSource {
  /** 自己一共有多少条消息。用来判断要不要截断 */
  ownMessageCount(): number;
  /**
   * 从最新往回数第 n 条的位置，作为起始游标。
   * 超上限时用它把老消息切掉 —— 留新不留旧，人要的是最近的。
   */
  ownMessageCutoff(skipFromNewest: number): Cursor | null;
  /** 自己的消息，按 (ts,id) 升序，keyset 分页 */
  ownMessagePage(after: Cursor | null, limit: number): RawMessage[];

  /** 段前的上下文，按时间倒序取，调用方负责翻回来 */
  contextBefore(convId: string, before: Cursor, minTs: number, limit: number): RawMessage[];
  /** 段内全部消息（含自己的），按 (ts,id) 升序，闭区间 */
  windowBody(convId: string, from: Cursor, to: Cursor, limit: number): RawMessage[];
  contextAfter(convId: string, after: Cursor, maxTs: number, limit: number): RawMessage[];

  /** 这个群此刻对他可见吗 —— 决定给不给上下文、给不给群名 */
  isVisibleGroup(convId: string): boolean;
  groupName(convId: string): string | null;

  postsPage(afterId: string | null, limit: number): ForumPostRow[];
  repliesPage(afterId: string | null, limit: number): ForumReplyRow[];
  draftsPage(afterId: string | null, limit: number): ForumDraftRow[];
  /*
   * 收藏 / 表态 / 投票分三个方法而不是一个 union ——
   * 三张表各有各的索引，硬拼成一条 SQL 只会让哪个索引都用不上。
   */
  bookmarksPage(afterId: string | null, limit: number): ForumInteractionRow[];
  reactionsPage(afterId: string | null, limit: number): ForumInteractionRow[];
  pollVotesPage(afterId: string | null, limit: number): ForumInteractionRow[];
  /** 回复所在帖子的上下文，含可见性判定 */
  postContext(postId: string): PostContext;
}

export interface StreamOptions {
  withContext: boolean;
  /** 自己的 wx_id。没有绑定微信的账号是 null，群聊部分整体为空 */
  selfWxId: string | null;
}

/* ───────────────────────────────────────────────────────────────
 * 群聊
 * ─────────────────────────────────────────────────────────────── */

interface WindowMessage {
  speaker: string;
  self: boolean;
  role: "own" | "context";
  ts: number;
  type: string;
  text: string;
  hasMedia: boolean;
  quality: boolean;
}

function speakerOf(msg: RawMessage, names: Pseudonyms): string {
  // 机器人不是「一个人」，给它单独的标签，别占用 p1/p2 的号
  if (msg.isSend) return "bot";
  return names.labelFor(msg.senderWxId);
}

function toWindowMessage(
  msg: RawMessage,
  names: Pseudonyms,
  ownIds: Set<string>,
): WindowMessage {
  const speaker = speakerOf(msg, names);
  return {
    speaker,
    self: ownIds.has(msg.id),
    role: ownIds.has(msg.id) ? "own" : "context",
    ts: msg.ts,
    type: msg.type,
    text: msg.content,
    hasMedia: msg.hasMedia,
    quality: msg.isQuality,
  };
}

/**
 * 自己的消息，一页一页地流出来。
 *
 * 超过 MAX_OWN_MESSAGES 时把**起点**往后挪，留下最新的那一批 ——
 * 而不是取完再切。取完再切等于先把超额的部分查出来再扔掉，
 * 白花的是同一台机器的时间。
 */
async function* ownMessages(
  source: ExportSource,
  counts: ExportCounts,
  batch: number,
): AsyncGenerator<RawMessage> {
  const total = source.ownMessageCount();
  let cursor: Cursor | null = null;

  if (total > MAX_OWN_MESSAGES) {
    counts.truncated = true;
    cursor = source.ownMessageCutoff(MAX_OWN_MESSAGES);
  }

  let emitted = 0;
  for (;;) {
    const page: RawMessage[] = source.ownMessagePage(cursor, batch);
    if (page.length === 0) return;
    for (const msg of page) {
      if (emitted >= MAX_OWN_MESSAGES) return;
      emitted += 1;
      yield msg;
    }
    const last = page[page.length - 1];
    cursor = { ts: last.ts, id: last.id };
    if (page.length < batch) return;
  }
}

/**
 * messages.jsonl 的每一行。
 *
 * 一行是一个**窗口**（一段连续对话），不是一条消息 —— 理由见
 * self-export-rules.ts 里 runsOf 的注释。
 */
export async function* messageLines(
  source: ExportSource,
  options: StreamOptions,
  counts: ExportCounts,
  names: Pseudonyms = createPseudonyms(options.selfWxId),
  batch: number = MESSAGE_BATCH,
): AsyncGenerator<string> {
  if (!options.selfWxId) return;

  for await (const run of runsOf(ownMessages(source, counts, batch))) {
    counts.windows += 1;

    const ownIds = new Set(run.own.map((m) => m.id));
    const visible = source.isVisibleGroup(run.convId);
    /*
     * 上下文只给他此刻仍看得见的群。
     * 退了的群里自己说过的话照导 —— 那是他的；
     * 但那个群现在的对话他在站内也读不到，导出不该成为例外。
     */
    const wantContext = options.withContext && visible;

    const from: Cursor = { ts: run.startTs, id: run.own[0].id };
    const to: Cursor = { ts: run.endTs, id: run.own[run.own.length - 1].id };

    let messages: RawMessage[];
    let truncated = false;

    if (wantContext) {
      const before = source
        .contextBefore(run.convId, from, run.startTs - CONTEXT_WINDOW_MS, CONTEXT_BEFORE)
        .slice()
        .reverse();
      /*
       * 多要一条，为的是分辨「正好 200 条」和「超过 200 条」。
       *
       * 真超了就**整段中间的上下文都不要**，只留自己那几条 —— 而不是
       * 截前 200 条。截断会把自己的发言也一起截掉，那是在导出「自己的
       * 数据」时把自己的数据弄丢了，比少几条上下文严重得多。
       */
      const body = source.windowBody(run.convId, from, to, WINDOW_MAX_MESSAGES + 1);
      truncated = body.length > WINDOW_MAX_MESSAGES;
      const middle = truncated ? run.own : body;
      const after = source.contextAfter(
        run.convId,
        to,
        run.endTs + CONTEXT_WINDOW_MS,
        CONTEXT_AFTER,
      );
      messages = [...before, ...middle, ...after];
      counts.contextMessages += messages.length - run.own.length;
    } else {
      messages = run.own;
    }

    counts.ownMessages += run.own.length;

    yield jsonl({
      conv: run.convId,
      // 看不见的群不给名字：群列表本身就是隐私，导出不能成为绕过它的口子
      group: visible ? source.groupName(run.convId) : null,
      startTs: messages.length > 0 ? messages[0].ts : run.startTs,
      endTs: messages.length > 0 ? messages[messages.length - 1].ts : run.endTs,
      selfCount: run.own.length,
      truncated,
      messages: messages.map((m) => toWindowMessage(m, names, ownIds)),
    });
  }
}

/* ───────────────────────────────────────────────────────────────
 * 论坛
 * ─────────────────────────────────────────────────────────────── */

/** 分页取到底。抽出来是因为四个论坛文件的取法一模一样 */
async function* pagedById<T extends { id: string }>(
  fetchPage: (afterId: string | null, limit: number) => T[],
  batch: number,
): AsyncGenerator<T> {
  let after: string | null = null;
  for (;;) {
    const page = fetchPage(after, batch);
    if (page.length === 0) return;
    for (const row of page) yield row;
    after = page[page.length - 1].id;
    if (page.length < batch) return;
  }
}

export async function* postLines(
  source: ExportSource,
  counts: ExportCounts,
  batch: number = FORUM_BATCH,
): AsyncGenerator<string> {
  for await (const post of pagedById((a, l) => source.postsPage(a, l), batch)) {
    counts.posts += 1;
    yield jsonl({
      id: post.id,
      board: post.boardKey,
      boardName: post.boardName,
      title: post.title,
      // 存 markdown 原文而不是渲染后的 HTML：HTML 是派生物，
      // 体积大好几倍，而且拿去训练要先把标签再剥一遍
      content: post.content,
      type: post.type,
      status: post.status,
      visibility: post.visibility,
      anonymous: post.anonymous,
      pinned: post.pinned,
      tags: post.tags,
      replyCount: post.replyCount,
      reactionCount: post.reactionCount,
      viewCount: post.viewCount,
      createdAt: post.createdAt,
      updatedAt: post.updatedAt,
      deletedAt: post.deletedAt,
    });
  }
}

export async function* replyLines(
  source: ExportSource,
  options: StreamOptions,
  counts: ExportCounts,
  names: Pseudonyms,
  batch: number = FORUM_BATCH,
): AsyncGenerator<string> {
  /*
   * 同一个帖子下往往有自己好几条回复，逐条回查是白查。
   * 缓存按批清空 —— 一直留着的话，一个在几千个帖子里回过话的人
   * 会把整张帖子表慢慢搬进内存。
   */
  let cache = new Map<string, PostContext>();
  let seen = 0;

  for await (const reply of pagedById((a, l) => source.repliesPage(a, l), batch)) {
    counts.replies += 1;
    seen += 1;
    if (seen % batch === 0) cache = new Map();

    let ctx = cache.get(reply.postId);
    if (!ctx) {
      ctx = source.postContext(reply.postId);
      cache.set(reply.postId, ctx);
    }

    /*
     * 帖子标题和摘要是**别人写的**。只在他此刻仍看得见那个帖子时才给，
     * 否则如实写明为什么没有 —— 悄悄留空会让人以为原帖是空的。
     */
    const context =
      options.withContext && ctx.visible
        ? {
            title: ctx.title,
            excerpt: ctx.excerpt,
            author: ctx.authorIsSelf ? "self" : names.labelFor(ctx.authorKey),
          }
        : null;

    yield jsonl({
      id: reply.id,
      postId: reply.postId,
      parentId: reply.parentId,
      floor: reply.floor,
      content: reply.content,
      status: reply.status,
      accepted: reply.accepted,
      anonymous: reply.anonymous,
      reactionCount: reply.reactionCount,
      createdAt: reply.createdAt,
      deletedAt: reply.deletedAt,
      context,
      contextReason: context ? null : (ctx.reason ?? "未包含上下文"),
    });
  }
}

export async function* draftLines(
  source: ExportSource,
  counts: ExportCounts,
  batch: number = FORUM_BATCH,
): AsyncGenerator<string> {
  for await (const draft of pagedById((a, l) => source.draftsPage(a, l), batch)) {
    counts.drafts += 1;
    yield jsonl({
      id: draft.id,
      targetType: draft.targetType,
      targetId: draft.targetId,
      boardId: draft.boardId,
      title: draft.title,
      content: draft.content,
      updatedAt: draft.updatedAt,
    });
  }
}

export async function* interactionLines(
  source: ExportSource,
  counts: ExportCounts,
  batch: number = FORUM_BATCH,
): AsyncGenerator<string> {
  const pages = [
    (a: string | null, l: number) => source.bookmarksPage(a, l),
    (a: string | null, l: number) => source.reactionsPage(a, l),
    (a: string | null, l: number) => source.pollVotesPage(a, l),
  ];

  for (const fetchPage of pages) {
    for await (const row of pagedById(fetchPage, batch)) {
      counts.interactions += 1;
      yield jsonl({
        kind: row.kind,
        targetType: row.targetType,
        targetId: row.targetId,
        detail: row.detail,
        createdAt: row.createdAt,
      });
    }
  }
}
