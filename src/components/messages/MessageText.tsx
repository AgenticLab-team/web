import { Send } from "lucide-react";
import Link from "next/link";

import { parseAttribution } from "@/lib/api-tokens/attribution";

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
  /*
   * ═════════════════════════════════════════
   * 代发消息**单独长一个样**
   * ═════════════════════════════════════════
   *
   * 代发的消息是机器人账号发出去的，同步回来之后正文最后多一行
   * 「本消息由「张三」使用 AgenticLab.sh 代发」。
   *
   * 原样渲染的话，那一行和正文同一个字号同一个颜色 ——
   * 看起来像发消息的人自己打的一句话，而它是系统加的。
   * 而这一行恰恰是**唯一**能让群里的人知道「这话是谁让机器人说的」
   * 的东西，它不该长得像正文。
   *
   * 所以拆开：正文照常渲染（提及照样是活的），署名变成一枚标记。
   *
   * 拆在这里而不是在数据层：库里存的必须是**群里真正看到的那一条**，
   * 那是留痕的意义所在（见 schema/api.ts）。显示归显示。
   */
  const attributed = parseAttribution(content);
  if (attributed) {
    return (
      <>
        <MessageText
          content={attributed.body}
          mentions={mentions}
          currentNames={currentNames}
        />
        <span
          className="t-caption2 mt-1 flex w-fit items-center gap-1 rounded-[var(--radius-control)] px-1.5 py-0.5"
          style={{
            background: "color-mix(in srgb, var(--accent) 10%, transparent)",
            color: "var(--accent)",
          }}
        >
          <Send className="h-3 w-3 shrink-0" strokeWidth={2} aria-hidden />
          {/*
            * 说「由某某代发」而不是照抄那一行。
            * 「使用 AgenticLab.sh」那半句是给**群里**看的（他们不知道
            * 这个站），站内的人已经在这个站里了，重复一遍是噪音。
            */}
          由 {attributed.senderName} 代发
        </span>
      </>
    );
  }

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
