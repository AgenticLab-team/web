import { Archive, ExternalLink, Star } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Avatar } from "@/components/Avatar";
import { PostList } from "@/components/forum/PostList";
import { PageHeader } from "@/components/shell/PageHeader";
import { Empty, PageNote, Section } from "@/components/ui/primitives";
import { getCurrentUser } from "@/lib/auth/session";
import { buildViewerContext } from "@/lib/forum/context";
import { listPosts } from "@/lib/forum/queries";
import { projectHeader } from "@/lib/github/projects";

export const dynamic = "force-dynamic";

/**
 * 一个项目的页面。
 *
 * ═════════════════════════════════════════
 * 它存在的理由只有一句话
 * ═════════════════════════════════════════
 *
 * 同一个项目的讨论现在散在几十篇帖子里，谁也串不起来。
 * 这一页把它们收在一处 —— 剩下的（简介、star、语言）
 * GitHub 自己说得比我们好，所以这一页不跟它比那些，
 * 顶多顺手带一句，然后把人送过去。
 *
 * ═════════════════════════════════════════
 * 没有站内成员绑过它，这一页照样打得开
 * ═════════════════════════════════════════
 *
 * 有人聊一个跟这个社区毫无关系的上游仓库，这完全正常，
 * 而那恰恰是「站里聊过它的帖子」最有价值的一种情况。
 * 所以「谁在做」那一段没有内容时整段消失，而不是显示一句「暂无」——
 * 后者会把「这个项目不是我们的」说成一种缺失。
 *
 * **一个网络请求都不发**：表头只从两份缓存里拼（成员的仓库快照、
 * 帖子卡片那份事实缓存），拼不出来就少显示一行。
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ owner: string; repo: string }>;
}): Promise<Metadata> {
  const { owner, repo } = await params;
  const header = projectHeader(owner, repo);
  return { title: header ? header.key : "项目" };
}

export default async function ProjectPage({
  params,
}: {
  // 不能用 RouteContext<'/projects/[owner]/[repo]'>：它从构建产物的路由表上取，
  // 而新路由还不在那张表里 —— tsc 报错，而流水线里 tsc 跑在构建之前
  params: Promise<{ owner: string; repo: string }>;
}) {
  const { owner, repo } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=/projects/${owner}/${repo}`);

  /*
   * 认不出来的名字直接 404，**不拿它去拼一条 github.com 的地址**。
   * `projectHeader` 走的是 parseRepoRef，也就是那唯一一处安全边界。
   */
  const header = projectHeader(owner, repo);
  if (!header) notFound();

  const posts = listPosts(buildViewerContext(user), { repoRef: header.key, limit: 20 });
  const entry = header.entry;

  return (
    <>
      <PageHeader title={header.key} subtitle="站里聊过它的" />

      <Section>
        <div className="inset-group">
          <a
            href={header.url}
            target="_blank"
            /* 别人的地址，我们不替他们背书权重 */
            rel="noopener noreferrer nofollow"
            className="inset-row flex min-h-11 items-start gap-2.5 px-4 py-3 transition-colors hover:bg-[var(--fill)]"
          >
            <span className="min-w-0 flex-1">
              <span className="t-subhead flex items-baseline gap-2 font-medium">
                <span className="min-w-0 truncate">{entry?.fullName ?? header.key}</span>
                {entry && entry.stars > 0 && (
                  <span className="tabular t-caption2 flex shrink-0 items-center gap-0.5 text-[var(--ink-quaternary)]">
                    <Star className="h-3 w-3" strokeWidth={2} aria-hidden />
                    {entry.stars}
                  </span>
                )}
                {entry?.archived && (
                  <Archive className="h-3 w-3 shrink-0 text-[var(--ink-quaternary)]" strokeWidth={2} aria-label="已归档" />
                )}
              </span>
              {/*
                * 简介优先用成员那份仓库快照，没有就退回帖子卡片攒下来的
                * 那一句。两份都没有就不显示这一行 —— 绝不为了它去问 GitHub：
                * 那会把一个第三方接口接进每一次打开这一页的路径上。
                */}
              {(entry?.description ?? header.cachedSummary) && (
                <span className="t-caption mt-0.5 block leading-relaxed text-[var(--ink-secondary)]">
                  {entry?.description ?? header.cachedSummary}
                </span>
              )}
              {entry?.language && (
                <span className="t-caption2 mt-1 block text-[var(--ink-quaternary)]">
                  {entry.language}
                </span>
              )}
            </span>
            <ExternalLink
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--ink-quaternary)]"
              strokeWidth={2}
              aria-hidden
            />
          </a>
        </div>
      </Section>

      {/*
        * 「谁在做」。
        *
        * 只列**自己打开了展示开关、而且没隐身**的人（判定在 projects.ts，
        * 不在这一页 —— 放在页面里判的话，下一个页面会判出另一套结果）。
        * 没有人时整段不出现。
        *
        * 这里**没有**「谁提过 PR」那一栏，这是想清楚之后主动没做的：
        * 手上唯一的 PR 数据是 `github_share_prompts`，那是为了给本人
        * 发一条「要不要发帖分享」而攒的，他从没同意过把它变成一份
        * 公开名册；而且它只覆盖最近九十天、还只覆盖没关掉提醒的人 ——
        * 一份注定不全的名单会被读成「只有这几个人参与过」。
        */}
      {header.builders.length > 0 && (
        <Section title="谁在做">
          <div className="inset-group">
            {header.builders.map((b) => (
              <div key={b.userId} className="inset-row flex items-center gap-3 px-4 py-3">
                <Avatar name={b.name} src={b.avatar} paletteIndex={b.paletteIndex} size={32} />
                <span className="min-w-0 flex-1">
                  {b.hasProfile ? (
                    <Link href={`/members/by/${b.userId}`} className="t-subhead font-medium">
                      {b.name}
                    </Link>
                  ) : (
                    <span className="t-subhead font-medium">{b.name}</span>
                  )}
                  <a
                    href={b.githubUrl}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="t-caption2 mt-0.5 block text-[var(--ink-tertiary)]"
                  >
                    @{b.githubLogin}
                  </a>
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section title="站里聊过它的">
        {posts.length > 0 ? (
          <PostList posts={posts} />
        ) : (
          <Empty
            title="还没有帖子关联到这个项目"
            hint="发帖时在「关联项目」那一栏填上 owner/repo，那篇就会出现在这里"
          />
        )}
      </Section>

      <PageNote>
        这一页只显示<strong className="font-medium">你本来就看得到的帖子</strong> ——
        可见性判定和论坛列表走的是同一段代码，关联一个项目不会让任何一篇多露出来
      </PageNote>
    </>
  );
}
