import { Avatar } from "@/components/Avatar";
import { PersonLink } from "@/components/PersonLink";
import { Empty } from "@/components/ui/primitives";
import type { ForumBoardEntry } from "@/lib/queries/forum-board";

/**
 * 论坛活跃榜的那张列表。
 *
 * ─────────────────────────────────────────
 * 为什么不复用 LeaderboardList
 * ─────────────────────────────────────────
 *
 * 那张列表的每一行说的是「多少条高质量消息」，而这里是
 * 「几篇帖 + 几条回复」—— 两个数而不是一个。硬塞进同一个组件
 * 要加一堆 `board === "forum" ?` 的分支，而那些分支会让两个榜
 * 将来只要改一个就得同时想另一个。
 *
 * 分成两个组件的代价是头像那一段重复了一次；
 * 合并的代价是每次改动都要在脑子里跑两遍。后者贵得多。
 */
export function ForumBoardList({
  entries,
  highlightWxId,
}: {
  entries: ForumBoardEntry[];
  highlightWxId?: string | null;
}) {
  if (entries.length === 0) {
    return <Empty title="这一段时间还没有人发帖" hint="发一篇或者认真回一条，这里就有名字了" />;
  }

  return (
    <div className="inset-group">
      {entries.map((e) => {
        const me = Boolean(highlightWxId && e.wxId === highlightWxId);
        return (
          <div
            key={e.userId}
            className="inset-row flex items-center gap-3 px-4 py-3"
            style={me ? { background: "color-mix(in srgb, var(--accent) 8%, transparent)" } : undefined}
          >
            {/*
              * 名次用等宽数字，否则第 9 名到第 10 名整列会横跳一格。
              * 前三名染成主色 —— 这是这一列唯一需要一眼看出的东西。
              */}
            <span
              className="tabular t-footnote w-6 shrink-0 text-right font-medium"
              style={{ color: e.rank <= 3 ? "var(--accent)" : "var(--ink-tertiary)" }}
            >
              {e.rank}
            </span>

            <Avatar wxId={e.wxId ?? e.userId} name={e.name} src={e.avatarUrl} size={32} />

            <div className="min-w-0 flex-1">
              <p className="t-subhead truncate font-medium">
                {/* 没有 wxId 的人不给主页链接 —— 点进去会是一个 404 */}
                {e.wxId ? (
                  <PersonLink wxId={e.wxId} name={e.name}>
                    {e.name}
                  </PersonLink>
                ) : (
                  e.name
                )}
              </p>
              <p className="tabular t-caption2 text-[var(--ink-tertiary)]">
                {e.posts} 篇 · {e.replies} 条回复
                {/*
                  * 「收到多少」不参与排序，但它回答的是另一个问题：
                  * 有没有人在读。一个发了十篇没人回的人和一个发了三篇
                  * 每篇都有人接话的人，名次可能一样而处境完全不同。
                  */}
                {e.received > 0 && ` · 收到 ${e.received} 次回应`}
              </p>
            </div>

            <span className="tabular t-footnote shrink-0 text-[var(--ink-secondary)]">{e.score}</span>
          </div>
        );
      })}
    </div>
  );
}
