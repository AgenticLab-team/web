import Link from "next/link";

import type { MentionView } from "@/lib/messages/interactions";

/**
 * 群消息正文渲染：把 @提及 变成活的。
 *
 * 提及按**落库时记录的位置**切分正文，不在渲染时重新猜 ——
 * 昵称串完全可能在正文里再出现一次（"@jmr jmr人呢"），
 * 按字符串搜索会把普通文字也标成提及。
 *
 * 显示名的规矩：resolved 的提及用**当前**昵称渲染（currentNames 传入），
 * 存下来的字面昵称只是解析时刻的证据。解析不出的（unknown/ambiguous）
 * 原样显示字面昵称并如实标注 —— 绝不挑一个最像的人挂链接。
 */

export interface MessageTextProps {
  content: string;
  mentions?: MentionView[];
  /** resolved 提及的当前显示名，按 wx_id 查好传进来 */
  currentNames?: Map<string, string>;
}

export function MessageText({ content, mentions, currentNames }: MessageTextProps) {
  if (!mentions || mentions.length === 0) {
    return <>{content}</>;
  }

  const parts: React.ReactNode[] = [];
  let cursor = 0;

  for (const mention of mentions) {
    const literal = `@${mention.name}`;
    // 位置对不上正文时整个跳过（正文被裁剪或提及行过期）——
    // 渲染错位的高亮比不高亮更误导
    if (
      mention.position < cursor ||
      !content.startsWith(literal, mention.position)
    ) {
      continue;
    }

    if (mention.position > cursor) {
      parts.push(content.slice(cursor, mention.position));
    }
    cursor = mention.position + literal.length;

    if (mention.status === "resolved" && mention.wxId) {
      const shown = currentNames?.get(mention.wxId) ?? mention.name;
      parts.push(
        <Link
          key={mention.position}
          href={`/members/${encodeURIComponent(mention.wxId)}`}
          className="font-medium text-[var(--accent)] hover:underline"
        >
          @{shown}
        </Link>,
      );
    } else if (mention.status === "all") {
      parts.push(
        <span key={mention.position} className="font-medium text-[var(--accent)]">
          {literal}
        </span>,
      );
    } else {
      parts.push(
        <span
          key={mention.position}
          className="underline decoration-dotted underline-offset-2 text-[var(--ink-secondary)]"
          title={
            mention.status === "ambiguous"
              ? "有多名同名成员，无法确定是谁"
              : "这个名字在这个群里对不上任何人 —— 微信的 @ 是自由文本，可能只是随口写的"
          }
        >
          {literal}
        </span>,
      );
    }
  }

  if (cursor < content.length) {
    parts.push(content.slice(cursor));
  }

  return <>{parts}</>;
}
