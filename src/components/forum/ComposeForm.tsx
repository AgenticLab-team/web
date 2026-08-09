"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { Editor } from "@/components/forum/Editor";
import { useToast } from "@/components/ui/Toast";
import { createPost } from "@/lib/forum/actions";
import { markGithubPromptSharedAction } from "@/lib/github/actions";
import { pickDraft, type DraftSnapshot } from "@/lib/forum/draft-rules";

import { relativeTime } from "./PostList";

import { DraftSync } from "./DraftSync";
import { SchedulePicker } from "./SchedulePicker";
import { clearLocalDraft, readLocalDraft } from "./local-draft";
import { EMPTY_POLL, PollComposer, type PollDraft } from "./PollComposer";
import { useServerDraft } from "./use-server-draft";

export interface BoardOption {
  key: string;
  name: string;
  description: string | null;
  maxVisibility: string;
}

const TYPES = [
  { key: "discussion", label: "讨论" },
  { key: "question", label: "提问" },
  { key: "showcase", label: "展示" },
  { key: "poll", label: "投票" },
] as const;

export function ComposeForm({
  boards,
  defaultBoard,
  serverDrafts = {},
  prefill = null,
  githubPromptId,
}: {
  boards: BoardOption[];
  defaultBoard?: string;
  /** 服务端上已有的草稿，按版块 key 索引 */
  serverDrafts?: Record<string, DraftSnapshot>;
  /**
   * 打开就填好的内容（现在只有「GitHub 有新项目，去分享」那条路会传）。
   *
   * 和上面那份草稿的处理**刚好相反**：草稿是摆出来问一句、不自动填，
   * 而这个直接填进去。区别在于人的意图 —— 打开发帖页的人想写点什么，
   * 三天前的半成品冒出来是打扰；而点「去分享」的人要的就是这一篇，
   * 让他对着空白框重新写一遍，那条提示就只剩下打扰。
   */
  prefill?: { title: string; content: string } | null;
  /** 发出去之后要标成「已分享」的那条提示 */
  githubPromptId?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [boardKey, setBoardKey] = useState(defaultBoard ?? boards[0]?.key ?? "");
  const [type, setType] = useState<(typeof TYPES)[number]["key"]>("discussion");
  const [title, setTitle] = useState(prefill?.title ?? "");
  const [content, setContent] = useState(prefill?.content ?? "");
  /*
   * 投票草稿一直留着，即使切回「讨论」。
   *
   * 切走就清掉的话，人点错一下类型、填好的四个选项全没了 ——
   * 而那种丢失没有任何提示，只能重填。
   */
  const [poll, setPoll] = useState<PollDraft>(EMPTY_POLL);
  /** datetime-local 的本地时间字符串，空表示写完就发 */
  const [scheduleAt, setScheduleAt] = useState("");

  const board = boards.find((b) => b.key === boardKey);

  /*
   * 服务端草稿。
   *
   * scope 用版块 key —— 和本地那份 `new:<boardKey>` 对齐。
   * 换版块就是换一份草稿，这符合直觉：在「问答」写了一半
   * 不该在「展示」里冒出来。
   */
  const serverDraft = serverDrafts[boardKey] ?? null;
  const sync = useServerDraft({
    target: "post",
    scope: boardKey,
    boardId: null,
    title,
    content,
    serverUpdatedAt: serverDraft?.updatedAt ?? null,
  });

  /*
   * 打开时服务器上就有一份 —— 摆出来问一句，不自动填。
   *
   * 自动填的话，人明明是想开一篇新的，却看到三天前写了一半的东西
   * 已经躺在框里，而且不知道怎么回到空白。
   */
  const [offer, setOffer] = useState<DraftSnapshot | null>(null);
  /*
   * 把内容塞回 Editor 里。
   *
   * Editor 自己拿 state 管着文本框，`defaultValue` 只在挂载时读一次 ——
   * 恢复草稿时改它不会有任何效果。所以要一个显式的「换成这个」通道。
   */
  const [restoreInto, setRestoreInto] = useState<string | null>(null);
  const [askedFor, setAskedFor] = useState<string | null>(null);

  useEffect(() => {
    if (askedFor === boardKey) return;
    // 带着预填内容进来的，不再问「要不要接着写那份草稿」——
    // 他要写的就是眼前这一篇，问一句只会让人以为填错了
    if (prefill) return;

    /*
     * 推到下一个任务里再 setState。
     *
     * 一是 effect 体内同步 setState 会触发级联渲染；
     * 二是这里要读 localStorage —— 那是外部系统，服务端渲染时根本没有，
     * 只能等到浏览器里才问得出来。Editor 恢复本地草稿走的是同一条路。
     */
    const timer = setTimeout(() => {
      setAskedFor(boardKey);

      const local = readLocalDraft(`new:${boardKey}`);
      const { pick, ask } = pickDraft({ local, server: serverDraft });
      // 只有「服务器那份该赢」或者「两边差得远、拿不准」时才问
      setOffer(serverDraft && (pick === "server" || ask) ? serverDraft : null);
    }, 0);

    return () => clearTimeout(timer);
  }, [boardKey, serverDraft, askedFor, prefill]);

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const result = await createPost({
        boardKey,
        title,
        content,
        // datetime-local 给的是本地时间字符串，转成毫秒再传
        scheduledAt: scheduleAt ? new Date(scheduleAt).getTime() : undefined,
        // 投票帖的类型由服务端按有没有 poll 定 —— 两处各判一次迟早对不上
        type: type === "poll" ? "discussion" : type,
        poll:
          type === "poll"
            ? {
                question: poll.question,
                options: poll.options,
                multi: poll.multi,
                hideUntilVoted: poll.hideUntilVoted,
                // datetime-local 给的是本地时间字符串，转成毫秒再传
                closesAt: poll.closesAt ? new Date(poll.closesAt).getTime() : undefined,
              }
            : undefined,
      });
      if (!result.ok) {
        // 失败时绝不清空内容 —— 写了两千字被清掉就再也不会有人在这写东西
        setError(result.error ?? "发布失败");
        return;
      }
      /*
       * 「发出去了，但有话要说」—— 新人发外链会被降权，得跟人说一声。
       *
       * 走 toast 而不是留在这一页上：这一页马上就跳走了。
       * ToastProvider 挂在 (app) 布局上，跳过去之后那句话还在。
       * 时间给足 —— 3.2 秒读不完，而这句话正是这条规则的全部意义。
       */
      if (result.note) toast.show({ message: result.note, kind: "info", durationMs: 12_000 });

      /*
       * 是从 GitHub 提示点进来的 —— 把那条提示标成「已分享」，
       * 它就不会再挂在「我的」页上等着过期。
       *
       * 失败了也不管：那条记录早就在库里，**再提示一次是不可能的**
       * （唯一索引挡着）。这一步只影响它还挂不挂着，
       * 不值得为它挡住「发帖成功」这个结果。
       */
      if (githubPromptId && result.postId) {
        void markGithubPromptSharedAction(githubPromptId, result.postId);
      }

      // 发出去了就把两边的草稿都清掉 —— 留着的话下次点发帖会把
      // 已经发表过的内容当草稿恢复出来，而人会以为上次没发成功
      clearLocalDraft(`new:${boardKey}`);
      /*
       * 定时的帖子发完不跳到帖子页 —— 那一页现在只有作者看得到，
       * 跳过去会让人以为已经公开了。跳去「等着发的」列表，
       * 那里能看到几点发、也能改主意。
       */
      router.push(scheduleAt ? "/me/drafts" : `/forum/p/${result.postId}`);
    });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="space-y-4"
    >
      <div className="no-scrollbar -mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
        {boards.map((b) => (
          <button
            key={b.key}
            type="button"
            onClick={() => setBoardKey(b.key)}
            className={`t-footnote shrink-0 rounded-[var(--radius-pill)] px-3 py-1.5 font-medium transition-colors ${
              b.key === boardKey
                ? "bg-[var(--ink)] text-[var(--canvas)]"
                : "bg-[var(--fill)] text-[var(--ink-secondary)]"
            }`}
          >
            {b.name}
          </button>
        ))}
      </div>

      <div className="flex gap-1.5">
        {TYPES.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setType(t.key)}
            className={`t-footnote rounded-[var(--radius-pill)] px-3 py-1.5 transition-colors ${
              t.key === type
                ? "bg-[var(--accent-soft)] font-medium text-[var(--accent)]"
                : "text-[var(--ink-tertiary)] hover:bg-[var(--fill)]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="标题"
        maxLength={120}
        className="t-title3 w-full rounded-[var(--radius-card)] bg-[var(--surface)] px-4 py-3.5 outline-none hairline placeholder:text-[var(--ink-quaternary)]"
      />

      {/*
        * 投票编辑器排在正文**上面**。
        *
        * 选了「投票」之后，人接下来要填的就是选项 ——
        * 放在正文下面的话，写完两千字才发现下面还有一块要填。
        */}
      {type === "poll" && <PollComposer value={poll} onChange={setPoll} />}

      <Editor
        name="content"
        /* defaultValue 只在挂载时读一次 —— 正好是预填要的语义。
           它非空时 Editor 也不会再去恢复本地草稿（见 Editor 里那个 effect），
           所以「点去分享」看到的一定是提示里那一篇，不会被草稿盖掉 */
        defaultValue={prefill?.content ?? ""}
        draftKey={`new:${boardKey}`}
        minHeight={280}
        placeholder="正文…支持 Markdown、代码块、@提及"
        onValueChange={setContent}
        restoreValue={restoreInto}
        onSubmit={submit}
      />

      {/*
        * 服务器上那份先摆出来问一句，不自动填 ——
        * 自动填的话，人明明想开一篇新的，却看到三天前的东西已经在框里，
        * 而且不知道怎么回到空白。
        */}
      {offer && (
        <div className="rounded-[var(--radius-control)] bg-[var(--fill)] p-3">
          <p className="t-subhead font-medium">服务器上还有一份没写完的</p>
          <p className="t-caption mt-0.5 text-[var(--ink-tertiary)]">
            {relativeTime(offer.updatedAt)}存的，可能是在别的设备上写的
          </p>
          <pre className="t-caption mt-2 max-h-24 overflow-auto whitespace-pre-wrap break-words text-[var(--ink-secondary)]">
            {offer.content.slice(0, 200)}
            {offer.content.length > 200 ? "…" : ""}
          </pre>
          <div className="mt-2.5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setTitle(offer.title ?? title);
                setContent(offer.content);
                setRestoreInto(offer.content);
                sync.acceptServer(offer);
                setOffer(null);
              }}
              className="t-caption rounded-[var(--radius-control)] bg-[var(--accent)] px-3 py-1.5 font-medium text-[var(--accent-ink)] transition active:scale-95"
            >
              接着写这一份
            </button>
            {/*
              * 「不用了」只是把这个提示收起来，**不删服务器上那份** ——
              * 一次点击不该销毁一份还看得见内容的草稿。
              * 真要删就在下面清空正文，那时候会走正常的删除路径。
              */}
            <button
              type="button"
              onClick={() => setOffer(null)}
              className="t-caption px-2 py-1.5 text-[var(--ink-tertiary)]"
            >
              不用了
            </button>
          </div>
        </div>
      )}

      <DraftSync
        saving={sync.saving}
        savedAt={sync.savedAt}
        conflict={sync.conflict}
        onUseServer={(snapshot) => {
          setTitle(snapshot.title ?? title);
          setContent(snapshot.content);
          setRestoreInto(snapshot.content);
          sync.acceptServer(snapshot);
        }}
        onKeepMine={sync.keepMine}
      />

      {board && (
        <p className="t-caption px-1 leading-relaxed text-[var(--ink-tertiary)]">
          发到「{board.name}」
          {board.maxVisibility === "group"
            ? " · 该版块内容只有原群成员可见"
            : board.maxVisibility === "member"
              ? " · 该版块内容仅登录成员可见"
              : " · 该版块内容对所有人可见"}
        </p>
      )}

      {error && (
        <p className="t-footnote rounded-[var(--radius-control)] bg-[var(--danger)]/10 px-3 py-2.5 text-[var(--danger)]" role="alert">
          {error}
        </p>
      )}

      <SchedulePicker value={scheduleAt} onChange={setScheduleAt} />

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending || !title.trim() || !content.trim()}
          className="t-body flex-1 rounded-[var(--radius-control)] bg-[var(--accent)] px-6 py-3 font-medium text-[var(--accent-ink)] transition active:scale-[0.98] disabled:opacity-40"
        >
          {pending ? "提交中…" : scheduleAt ? "定时发布" : "发布"}
        </button>
        <button
          type="button"
          onClick={() => router.back()}
          className="t-body rounded-[var(--radius-control)] bg-[var(--fill)] px-5 py-3 transition active:scale-[0.98]"
        >
          取消
        </button>
      </div>
    </form>
  );
}
