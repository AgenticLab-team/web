import { Reply, TextQuote } from "lucide-react";
import Link from "next/link";

import { Avatar } from "@/components/Avatar";
import { PersonLink } from "@/components/PersonLink";
import { MessageText } from "@/components/messages/MessageText";
import type { PickableMessage } from "@/lib/forum/convert-source";
import { messageAnchor } from "@/lib/messages/archive-rules";
import type { MentionView, ReplyTargetView } from "@/lib/messages/interactions";
import { COMMUNITY_TIMEZONE } from "@/lib/time";

/**
 * 群聊记录里的一条消息。
 *
 * ─────────────────────────────────────────
 * 一条消息原来占三行
 * ─────────────────────────────────────────
 *
 * 原来的排法是：第一行头像+昵称+时间，第二行（有引用时）引用块，
 * 第三行正文。于是一屏只装得下六七条 —— 而这个群一天有几千条。
 * 「翻起来累」不是感觉问题，是**每条消息里有两行是空的**：
 * 昵称那一行右边全是留白，正文那一行左边全是留白。
 *
 * 这里把昵称收进正文的行首（群聊记录本来就是这个读法：
 * 「张三：在的」），时间和操作收进右侧两条窄栏。
 * 短消息因此占一行，长消息自然折行 ——
 * 同一屏从六七条变成二十多条。
 *
 * **一个字段都没删**：头像、昵称、时间、引用块、@ 高亮、
 * 「这是条回复」的标记，全都还在，只是不再各占一行。
 *
 * ─────────────────────────────────────────
 * 右边那两条窄栏是整行高的
 * ─────────────────────────────────────────
 *
 * 行被压到 30px 上下之后，44×44 的 `.tap-target` 伪元素会**盖住
 * 上下相邻行的按钮**——点「引用」十次有三次引到隔壁那条，
 * 而这种错手没人会去报，只会觉得这个站点不准。
 * 所以这里用 `items-stretch` + 固定宽度的整高链接：
 * 触摸面积靠行高撑，横向互不重叠。
 */

/**
 * 时间按社区时区渲染。
 *
 * 这是服务端组件 —— 不写 timeZone 的话用的是**服务器**的时区，
 * 而日期边界（dateKey/startOfDayMs）一直是按东八区切的。
 * 两者不一致时，「这一天」的第一条会显示成前一天晚上的时间。
 */
function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: COMMUNITY_TIMEZONE,
  });
}

export function ArchiveMessage({
  message,
  mentions,
  currentNames,
  replyTarget,
  permalink,
  quoteHref,
  focused = false,
}: {
  message: PickableMessage;
  mentions?: MentionView[];
  currentNames?: Map<string, string>;
  replyTarget?: ReplyTargetView;
  /** 这一条的固定链接。时间戳就是它的入口 —— 长按即可复制分享 */
  permalink: string;
  /** 「引用这一条去整理成帖子」。论坛功能关掉时为 null */
  quoteHref: string | null;
  /** 是不是这次要定位的那一条 */
  focused?: boolean;
}) {
  const body =
    message.type === "text" || message.type === "quote" ? (
      <MessageText
        content={message.content}
        mentions={mentions}
        currentNames={currentNames}
      />
    ) : (
      `[${message.type}]`
    );

  return (
    <div
      id={messageAnchor(message.id)}
      /*
       * scroll-mt 躲开两条吸顶的 chrome（顶栏 + 翻天条）。
       * 不留这个余量的话，浏览器会把这一条正好滚到被压住的位置 ——
       * 「跳过去了但看不见」比没跳更让人困惑。
       */
      className={`inset-row flex scroll-mt-28 items-stretch gap-2 py-1 pl-3 ${
        focused ? "msg-focus" : ""
      }`}
    >
      <PersonLink wxId={message.senderWxId} name={message.senderName} className="shrink-0 pt-0.5">
        <Avatar
          wxId={message.senderWxId}
          name={message.senderName}
          src={message.avatarUrl}
          size={20}
        />
      </PersonLink>

      <div className="min-w-0 flex-1 py-0.5">
        {replyTarget && (
          <div className="mb-0.5 border-l-2 border-[var(--separator)] pl-2">
            <p className="t-caption2 truncate text-[var(--ink-tertiary)]">
              {replyTarget.senderName ?? "成员"}：
              {replyTarget.type === "text" || replyTarget.type === "quote"
                ? replyTarget.content
                : `[${replyTarget.type}]`}
            </p>
          </div>
        )}

        <p className="t-subhead whitespace-pre-wrap break-words leading-snug">
          <Link
            href={`/members/${encodeURIComponent(message.senderWxId)}`}
            className="mr-1.5 font-medium text-[var(--ink-secondary)] hover:text-[var(--accent)]"
          >
            {message.senderName}
          </Link>
          {/* 引用目标解析不出时也要承认这是条回复 —— 上游暂不透传引用关系 */}
          {message.type === "quote" && !replyTarget && (
            <span
              className="mr-1 inline-flex align-[-0.15em] text-[var(--ink-quaternary)]"
              title="这是一条引用回复，但上游未提供被引用的消息"
            >
              <Reply className="h-3 w-3" strokeWidth={2} aria-hidden />
              <span className="sr-only">回复</span>
            </span>
          )}
          {body}
        </p>
      </div>

      <Link
        href={permalink}
        prefetch={false}
        title="这条消息的固定链接"
        className="tabular t-caption2 flex shrink-0 items-start px-1 pt-1 text-[var(--ink-quaternary)] transition-colors hover:text-[var(--accent)]"
      >
        {timeLabel(message.ts)}
      </Link>

      {quoteHref && (
        <Link
          href={quoteHref}
          prefetch={false}
          aria-label={`引用 ${message.senderName} 的这条消息`}
          title="引用这条消息"
          className="flex w-9 shrink-0 items-start justify-center pt-1 text-[var(--ink-quaternary)] transition-colors hover:text-[var(--accent)] active:text-[var(--accent)]"
        >
          <TextQuote className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
        </Link>
      )}
    </div>
  );
}
