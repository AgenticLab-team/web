import { BookOpen, CheckCircle2, MessageSquare, Pin, Sparkles } from "lucide-react";
import Link from "next/link";

import { ANONYMOUS_PALETTE, Avatar } from "@/components/Avatar";
import { Empty } from "@/components/ui/primitives";
import { isLongform, LONGFORM_CHARS, readingLabel } from "@/lib/forum/longform";
import type { PostSummary } from "@/lib/forum/queries";

/**
 * 帖子列表的三种长相。
 *
 * ═════════════════════════════════════════
 * 为什么是三种，而不是一种加几个开关
 * ═════════════════════════════════════════
 *
 * 数出来的事实：长文（≥2000 字）43 篇，平均 2.3 次浏览；
 * 短帖（<300 字）36 篇，平均 8.2 次。一条四个字的水帖拿到的注意力
 * 是一篇一万字文章的三倍半。
 *
 * 排序已经修过一轮（sort: "deep"），但**排序只改变顺序，不改变分量**：
 * 一篇写了一天的东西和一句「所以开水是什么」用同一个 38px 头像、
 * 同一行 17px 标题排在一起，看起来就是同一种东西。
 *
 * 所以这里按内容形态分三种，每一种回答一个不同的问题：
 *
 *   · `PostList`    「这会儿有人在聊什么」—— 时间线，密、快、带头像
 *   · `DeepList`    「有什么值得坐下来读」—— 卡片，大标题、摘要、读多久
 *   · `ArchiveList` 「以前写过的都在哪」—— 索引，一行一篇，按月分堆
 *
 * 三种共用下面这些小函数，尤其是 `avatarIdentity` ——
 * 匿名那条规矩必须只有一个出处。
 */

const TYPE_LABEL: Record<string, string> = {
  question: "问",
  showcase: "展示",
  announcement: "公告",
  poll: "投票",
};

const VISIBILITY_HINT: Record<string, string> = {
  group: "仅本群可见",
  role: "限定身份可见",
  private: "仅自己可见",
  unlisted: "不公开索引",
};

/**
 * 头像用哪个配色种子。
 *
 * 匿名帖走固定的那一档，**不能拿作者 id 当种子** —— 配色是个稳定哈希，
 * 同一个人的两篇匿名帖会撞成同一个颜色，互相串得起来（见 Avatar.tsx）。
 *
 * 抽成一个函数是因为这个文件现在有三种列表：写三遍的话，
 * 「新加一种列表时忘了这件事」只是时间问题，而漏掉之后
 * 页面看起来完全正常 —— 那正是匿名最容易破的地方。
 */
function avatarIdentity(post: PostSummary) {
  return post.anonymous ? { paletteIndex: ANONYMOUS_PALETTE } : { wxId: post.authorId };
}

/** 帖子的落点。三种列表都往这儿去 */
const hrefOf = (post: PostSummary) => `/forum/p/${post.id}`;

/**
 * 时间线。这个站的主流量在这儿：短问题、随手记、一句话新闻。
 *
 * 密度是刻意的 —— 这些东西的价值在于「一屏能扫掉十条」，
 * 给每条都配一张大卡片反而会让人更快地划走。
 */
export function PostList({ posts, showBoard = false }: { posts: PostSummary[]; showBoard?: boolean }) {
  if (posts.length === 0) {
    return <Empty title="这里还没有帖子" hint="成为第一个开话题的人" />;
  }

  return (
    <div className="inset-group">
      <ul className="stagger">
        {posts.map((post, i) => (
          <li key={post.id} style={{ "--i": i } as React.CSSProperties}>
            <Link
              href={hrefOf(post)}
              className="inset-row flex gap-3 px-4 py-3.5 transition-colors hover:bg-[var(--fill)]"
            >
              <Avatar
                {...avatarIdentity(post)}
                name={post.authorName}
                src={post.authorAvatar}
                size={38}
                className="mt-0.5"
              />

              <div className="min-w-0 flex-1">
                <div className="flex items-start gap-1.5">
                  {post.pinned && (
                    <Pin
                      className="mt-1 h-3.5 w-3.5 shrink-0 text-[var(--accent)]"
                      strokeWidth={2.2}
                      aria-label="置顶"
                    />
                  )}
                  {TYPE_LABEL[post.type] && (
                    <span className="t-caption mt-0.5 shrink-0 rounded-[var(--radius-chip)] bg-[var(--fill)] px-1.5 py-0.5 font-medium text-[var(--ink-secondary)]">
                      {TYPE_LABEL[post.type]}
                    </span>
                  )}
                  <h3 className="t-body min-w-0 flex-1 leading-snug">{post.title}</h3>
                  {post.solved && (
                    <CheckCircle2
                      className="mt-0.5 h-4 w-4 shrink-0 text-[var(--success)]"
                      strokeWidth={2}
                      aria-label="已解决"
                    />
                  )}
                  {post.featured && (
                    <Sparkles
                      className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warning)]"
                      strokeWidth={2}
                      aria-label="精华"
                    />
                  )}
                </div>

                {post.excerpt && (
                  <p className="t-footnote mt-1 line-clamp-2 leading-relaxed text-[var(--ink-secondary)]">
                    {post.excerpt}
                  </p>
                )}

                <div className="tabular t-caption mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[var(--ink-tertiary)]">
                  <span>{post.authorName}</span>
                  <span aria-hidden>·</span>
                  <span>{relativeTime(post.lastReplyAt ?? post.createdAt)}</span>
                  {showBoard && (
                    <>
                      <span aria-hidden>·</span>
                      <span>{post.boardName}</span>
                    </>
                  )}
                  {/*
                    * 「读完要多久」只给长文标。
                    *
                    * 每条都标的话，「1 分钟」会出现在九成的帖子上，
                    * 于是它变成噪音，长文那条也就跟着没人看见了 ——
                    * 而这个标记存在的全部意义正是**让长文看起来不一样**。
                    *
                    * 它同时是一句预告：点进去是一篇文章，不是一句话。
                    * 没有这句预告的人在地铁上点开一万三千字，会直接退出去。
                    */}
                  {isLongform(post.charCount) && (
                    <>
                      <span aria-hidden>·</span>
                      <span className="flex items-center gap-0.5 text-[var(--ink-secondary)]">
                        <BookOpen className="h-3 w-3" strokeWidth={2} aria-hidden />
                        {readingLabel(post.charCount)}
                      </span>
                    </>
                  )}
                  {VISIBILITY_HINT[post.visibility] && (
                    <>
                      <span aria-hidden>·</span>
                      {/* 受限内容要明示，作者才知道谁看得到 */}
                      <span className="text-[var(--warning)]">
                        {VISIBILITY_HINT[post.visibility]}
                      </span>
                    </>
                  )}
                </div>
              </div>

              {post.replyCount > 0 && (
                <span className="tabular t-caption mt-1 flex shrink-0 items-center gap-1 text-[var(--ink-tertiary)]">
                  <MessageSquare className="h-3.5 w-3.5" strokeWidth={1.9} aria-hidden />
                  {post.replyCount}
                  <span className="sr-only">条回复</span>
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 值得坐下来读的那些。
 *
 * ─────────────────────────────────────────
 * 差别要在**扫过去的那一眼**里就成立
 * ─────────────────────────────────────────
 *
 * 不是加一个「长文」小标签就完事 —— 标签是要读了才知道的信息，
 * 而人在列表上根本不读，只是扫。所以差别做在四个不需要阅读的维度上：
 *
 *   · **一条占的面积**。卡片而不是行；第一篇占满整行。
 *     面积是唯一一种不用识字就能感觉到的分量。
 *   · **标题的字号**。t-title2 / t-headline，比时间线上的 t-body 大一档。
 *   · **摘要有三行**。时间线上是两行的附注，这里是「先尝一口」。
 *   · **右上角那个时长**。每张卡片同一个位置都写着「这要花你多久」，
 *     重复出现之后它本身就成了一种视觉标记：这一栏里的东西都要花时间。
 *
 * 克制的地方同样重要：不用彩色底、不加边框、不做悬浮抬升。
 * 这一栏要显得「重」，不是要显得「吵」—— 吵起来就压住了它下面的时间线，
 * 而那条时间线才是这个站每天真正在发生的事。
 */
export function DeepList({ posts }: { posts: PostSummary[] }) {
  if (posts.length === 0) {
    return (
      <Empty
        title="还没有这样的帖子"
        hint={`正文超过 ${LONGFORM_CHARS} 字的、或者被标为精华的，都会出现在这里`}
      />
    );
  }

  const [lead, ...rest] = posts;

  return (
    <div className="stagger grid gap-2.5 sm:grid-cols-2">
      <DeepCard post={lead} lead index={0} className="sm:col-span-2" />
      {rest.map((post, i) => (
        <DeepCard
          key={post.id}
          post={post}
          index={i + 1}
          /* 只剩一张的话让它铺满 —— 半张卡片旁边空一半，看起来像没加载出来 */
          className={rest.length === 1 ? "sm:col-span-2" : ""}
        />
      ))}
    </div>
  );
}

function DeepCard({
  post,
  index,
  lead = false,
  className = "",
}: {
  post: PostSummary;
  index: number;
  lead?: boolean;
  className?: string;
}) {
  return (
    <Link
      href={hrefOf(post)}
      style={{ "--i": index } as React.CSSProperties}
      className={`flex flex-col rounded-[var(--radius-card)] bg-[var(--surface)] p-4 transition-colors hairline hover:bg-[var(--fill)] sm:p-5 ${className}`}
    >
      {/* 眉头这一行回答「这是哪儿来的、要花多久」，两个都是决定点不点开的信息 */}
      <div className="t-caption flex items-center gap-1.5 text-[var(--ink-tertiary)]">
        {post.pinned && (
          <Pin className="h-3 w-3 shrink-0 text-[var(--accent)]" strokeWidth={2.2} aria-label="置顶" />
        )}
        <span className="truncate">{post.boardName}</span>
        {post.featured && (
          <span className="flex shrink-0 items-center gap-0.5 text-[var(--warning)]">
            <Sparkles className="h-3 w-3" strokeWidth={2} aria-hidden />
            精华
          </span>
        )}
        {isLongform(post.charCount) && (
          <span className="tabular ml-auto flex shrink-0 items-center gap-1 text-[var(--ink-secondary)]">
            <BookOpen className="h-3 w-3" strokeWidth={2} aria-hidden />
            {readingLabel(post.charCount)}
          </span>
        )}
      </div>

      {/*
        * 头条 22px、其余 17px。时间线上的标题是 17px 的 t-body ——
        * 也就是说这一栏里最小的一张卡片，标题也已经比水帖粗一档
        * （t-headline 是 600 字重），而头条整整大出一个台阶。
        */}
      <h3 className={`${lead ? "t-title2" : "t-headline"} mt-2 leading-snug`}>{post.title}</h3>

      {post.excerpt && (
        <p
          className={`t-footnote mt-1.5 leading-relaxed text-[var(--ink-secondary)] ${
            lead ? "line-clamp-3" : "line-clamp-2"
          }`}
        >
          {post.excerpt}
        </p>
      )}

      {/* mt-auto：一行里两张卡片高矮不一时，署名仍然对齐在底边 */}
      <div className="tabular t-caption mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 pt-3.5 text-[var(--ink-tertiary)]">
        <Avatar
          {...avatarIdentity(post)}
          name={post.authorName}
          src={post.authorAvatar}
          size={20}
        />
        <span className="text-[var(--ink-secondary)]">{post.authorName}</span>
        <span aria-hidden>·</span>
        <span>{relativeTime(post.createdAt)}</span>
        {post.replyCount > 0 && (
          <>
            <span aria-hidden>·</span>
            <span className="flex items-center gap-1">
              <MessageSquare className="h-3 w-3" strokeWidth={1.9} aria-hidden />
              {post.replyCount}
              <span className="sr-only">条回复</span>
            </span>
          </>
        )}
        {VISIBILITY_HINT[post.visibility] && (
          <>
            <span aria-hidden>·</span>
            {/* 受限内容要明示，作者才知道谁看得到 */}
            <span className="text-[var(--warning)]">{VISIBILITY_HINT[post.visibility]}</span>
          </>
        )}
      </div>
    </Link>
  );
}

/**
 * 旧文索引。
 *
 * ─────────────────────────────────────────
 * 它是一份目录，不是又一条流
 * ─────────────────────────────────────────
 *
 * 「更早的」那一栏有三十篇，全用卡片摆出来的话要划十屏，
 * 而人到这一栏来的动作是**找**，不是逛 —— 找的时候摘要和头像都是干扰，
 * 只有标题、写在哪个版块、读多久这三样有用。
 *
 * 按月分堆是这一栏唯一的结构。没有它，三十行标题是一堵墙；
 * 有了它，人至少知道自己划到了哪一年的哪一段。
 */
export function ArchiveList({ posts }: { posts: PostSummary[] }) {
  if (posts.length === 0) return null;

  /*
   * 相邻同月的归一堆。传进来的必须已经按时间倒序 ——
   * 顺序乱掉的话这里会分出两个同名的堆，而那看起来就是个 bug。
   */
  const months: { label: string; posts: PostSummary[] }[] = [];
  for (const post of posts) {
    const label = monthLabel(post.createdAt);
    const last = months[months.length - 1];
    if (last && last.label === label) last.posts.push(post);
    else months.push({ label, posts: [post] });
  }

  return (
    <div className="space-y-4">
      {months.map(({ label, posts: batch }) => (
        <div key={label}>
          <p className="t-caption mb-1.5 px-1 text-[var(--ink-tertiary)]">{label}</p>
          <div className="inset-group">
            <ul>
              {batch.map((post) => (
                <li key={post.id}>
                  <Link
                    href={hrefOf(post)}
                    className="inset-row flex items-start gap-3 px-4 py-3 transition-colors hover:bg-[var(--fill)]"
                  >
                    {post.featured && (
                      <Sparkles
                        className="mt-1 h-3.5 w-3.5 shrink-0 text-[var(--warning)]"
                        strokeWidth={2}
                        aria-label="精华"
                      />
                    )}
                    <span className="t-subhead min-w-0 flex-1 leading-snug">{post.title}</span>
                    {/* 版块名在窄屏上让位给标题 —— 这一栏里标题是唯一找得着东西的线索 */}
                    <span className="t-caption hidden shrink-0 text-[var(--ink-tertiary)] sm:inline">
                      {post.boardName}
                    </span>
                    {isLongform(post.charCount) && (
                      <span className="tabular t-caption shrink-0 text-[var(--ink-tertiary)]">
                        {readingLabel(post.charCount)}
                      </span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ))}
    </div>
  );
}

/** 「3 月」/「2025 年 11 月」—— 今年的省掉年份，一列里九成是今年，写出来只是噪音 */
function monthLabel(ts: number): string {
  const date = new Date(ts);
  const month = date.getMonth() + 1;
  return date.getFullYear() === new Date().getFullYear()
    ? `${month} 月`
    : `${date.getFullYear()} 年 ${month} 月`;
}

/** 相对时间。一周以上就给具体日期，「37 天前」没人算得出是哪天 */
export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  const date = new Date(ts);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString("zh-CN", {
    year: sameYear ? undefined : "numeric",
    month: "numeric",
    day: "numeric",
  });
}
