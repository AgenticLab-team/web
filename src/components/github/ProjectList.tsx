import { Archive, GitFork, Star } from "lucide-react";
import Link from "next/link";

import { Avatar } from "@/components/Avatar";
import type { ProjectEntry } from "@/lib/github/projects";

/**
 * 项目目录里的一行。
 *
 * ═════════════════════════════════════════
 * 主语是项目，不是人
 * ═════════════════════════════════════════
 *
 * 名字、简介、语言在上面，做它的人在底下一行小字里 ——
 * 因为这一页要回答的是「这个社区在做什么」。反过来（头像在最前、
 * 名字最大）会让它变成第二份成员目录，而成员目录已经有了，
 * 而且那一页在这件事上做得比它好。
 *
 * ═════════════════════════════════════════
 * 一行两个链接，去处不一样
 * ═════════════════════════════════════════
 *
 * 项目名点进去是**站内**的项目页（能看到站里聊过它的帖子），
 * 不是 GitHub。想去 GitHub 的人在项目页上一眼就看得到那个入口，
 * 而反过来 —— 目录直接把人送出站 —— 那些帖子就永远没人看见了，
 * 而它们正是这一页存在的理由。
 */
export function ProjectList({ projects }: { projects: ProjectEntry[] }) {
  if (projects.length === 0) return null;

  return (
    <div className="inset-group">
      {projects.map((p) => (
        <div key={p.key} className="inset-row px-4 py-3">
          <p className="t-subhead flex items-baseline justify-between gap-2">
            <Link
              href={`/projects/${p.key}`}
              className="min-w-0 flex-1 truncate font-medium transition-colors hover:text-[var(--accent)]"
            >
              {p.fullName}
            </Link>
            <span className="tabular t-caption2 flex shrink-0 items-center gap-2 text-[var(--ink-quaternary)]">
              {/*
                * star **一律显示，包括 0**。
                *
                * 别处（个人主页那一栏）是 `> 0` 才显示，那里对：
                * 挂一个 0 只是让人难堪。但这一页不一样 —— star 是
                * 这里的排序键之一，而**缺省和 0 长得一样**：
                * 一整列里有的有数字有的没有，读的人分不清「这个 0」
                * 和「这个没取到」。可比性在这一页比省一行重要。
                */}
              <span className="flex items-center gap-0.5">
                <Star className="h-3 w-3" strokeWidth={2} aria-hidden />
                {p.stars}
              </span>
              {p.isFork && <GitFork className="h-3 w-3" strokeWidth={2} aria-label="fork 来的" />}
              {/*
                * 归档了是这一行最要紧的一件事：它不再更新了。
                * 用图标 + aria-label，不用一个占半行的标签 ——
                * 这一页上归档的项目不少，全都挂一条文字会把版面吃掉。
                */}
              {p.archived && <Archive className="h-3 w-3" strokeWidth={2} aria-label="已归档" />}
            </span>
          </p>

          {/*
            * 作者自己写的那句排在 GitHub 的 description **前面**。
            *
            * description 是写给陌生人看的；这句是这个人对**这个社区**
            * 说的话 —— 「这跟你有什么关系」，而那正是这一页的读者
            * 真正想知道的。用引号和主色标出来，让它一眼看得出
            * 不是抓来的数据，是有人写的。
            */}
          {p.pitch && (
            <p className="t-footnote mt-1 break-words leading-relaxed text-[var(--accent)]">
              「{p.pitch}」
            </p>
          )}

          {p.description && (
            <p className="t-caption mt-0.5 line-clamp-2 break-words leading-relaxed text-[var(--ink-secondary)]">
              {p.description}
            </p>
          )}

          <p className="t-caption2 mt-1.5 flex items-center gap-1.5 text-[var(--ink-quaternary)]">
            {p.language && <span>{p.language}</span>}
            {p.language && <span aria-hidden>·</span>}
            <Avatar
              name={p.builder.name}
              src={p.builder.avatar}
              paletteIndex={p.builder.paletteIndex}
              size={16}
            />
            {/*
              * 没有 wxId 的账号不给链接 —— 点进去是 404，
              * 而一条点了没反应的链接比一段纯文字更让人觉得页面坏了。
              */}
            {p.builder.hasProfile ? (
              <Link
                href={`/members/by/${p.builder.userId}`}
                className="truncate transition-colors hover:text-[var(--ink-secondary)]"
              >
                {p.builder.name}
              </Link>
            ) : (
              <span className="truncate">{p.builder.name}</span>
            )}
          </p>
        </div>
      ))}
    </div>
  );
}
