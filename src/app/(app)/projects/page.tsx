import { FolderGit2 } from "lucide-react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { ProjectList } from "@/components/github/ProjectList";
import { PageHeader } from "@/components/shell/PageHeader";
import Link from "next/link";

import { buttonClass, Callout, Empty, PageNote, Pill, PillRow, Section } from "@/components/ui/primitives";
import { connectionOf } from "@/lib/github/link";
import { getCurrentUser } from "@/lib/auth/session";
import { githubEnabled } from "@/lib/github/secret";
import { resolveProjectSort } from "@/lib/github/project-rules";
import { projectDirectory } from "@/lib/github/projects";

export const metadata: Metadata = { title: "项目" };
export const dynamic = "force-dynamic";

const SORTS = [
  { key: "active", label: "最近有动静" },
  { key: "stars", label: "star 最多" },
  { key: "new", label: "最新建的" },
] as const;

/**
 * 项目目录。
 *
 * ═════════════════════════════════════════
 * 它为什么要登录才能看
 * ═════════════════════════════════════════
 *
 * 这一页把「站内某个人」和「某个 GitHub 账号」摆在同一行上。
 * 那些仓库本来就在 GitHub 上公开着，但**「这个微信群里的谁 = 这个
 * GitHub 账号」这条对应关系不是**——它是这个站拼出来的。
 *
 * 拦在 `PROTECTED_PREFIXES` 里（proxy 那一层，渲染之前），
 * 和成员目录同一道门。页面里再 redirect 一次只是兜底：
 * 光靠页面的话，爬虫拿到的是 200 加一个已经渲染过的壳（见 LESSONS）。
 *
 * 完整口径（三道门，一道都不能省）写在 `lib/github/projects.ts` 头上。
 *
 * ═════════════════════════════════════════
 * 说得出自己有多空
 * ═════════════════════════════════════════
 *
 * 和成员目录同一条规矩：这一页只收录**自己打开了展示开关**的人的项目，
 * 所以它注定比「这个社区做过的东西」少。少是事实，
 * 把它显示成多才是问题 —— 所以底下直说收录了几个、来自几个人。
 */
export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ lang?: string; sort?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/projects");

  const { lang, sort: sortParam } = await searchParams;
  const sort = resolveProjectSort(sortParam);
  const dir = projectDirectory({ language: lang, sort });

  /** 换筛选条件时把其余条件带上 —— 丢掉的话每点一次都要重填 */
  const href = (patch: { lang?: string; sort?: string }) => {
    const next = new URLSearchParams();
    const merged = { lang, sort: sort === "active" ? undefined : sort, ...patch };
    for (const [key, value] of Object.entries(merged)) {
      if (value) next.set(key, value);
    }
    const qs = next.toString();
    return qs ? `/projects?${qs}` : "/projects";
  };

  return (
    <>
      <PageHeader title="项目" subtitle="社区成员自己在做的东西" />

      {/*
        * 没绑的人在这一页上要能一步接上。
        *
        * 这是全站**最该出现这个入口**的地方：他正在看别人的项目，
        * 「我的怎么不在这儿」是此刻自然会冒出来的问题 ——
        * 而以前的答案要他自己走到「我的 → 安全」里去找。
        *
        * 用 Callout 而不是空状态：这一页对他不是空的，
        * 他是来看别人的东西的，这条只是顺带告诉他还能做一件事。
        */}
      {githubEnabled() && user && !connectionOf(user.id) && (
        <Callout tone="accent" className="mb-4">
          <p className="t-subhead font-medium">你的项目还没有在这里</p>
          <p className="t-caption mt-0.5 leading-relaxed text-[var(--ink-secondary)]">
            接上 GitHub，你的公开项目会自动出现在这一页和你的个人主页。
            申请的权限是<strong>空的</strong> —— 只读公开信息，碰不到私有仓库，
            也发不了任何东西。
          </p>
          <Link
            href="/api/auth/github/start?return=/projects"
            className={`${buttonClass("primary", "sm")} mt-2`}
          >
            连接 GitHub
          </Link>
        </Callout>
      )}

      {/*
        * 站里没配 GitHub 的时候要说清楚是**站的**问题，不是「没人做项目」。
        * 不说的话这一页看起来就是一个冷清的社区，
        * 而真实情况是绑定入口根本没渲染出来过（见 DONE.md 那一条）。
        */}
      {!githubEnabled() ? (
        <Empty
          title="这个站还没有配置 GitHub"
          hint="绑定入口没有开，所以还没有人能把自己的项目摆上来 —— 这一页是空的，不是社区里没有人在做东西"
        />
      ) : dir.total === 0 ? (
        <Empty
          title="还没有人把自己的项目摆上来"
          hint="绑定 GitHub 之后，在「我的 → 账号安全」里打开「在主页展示」，你的公开仓库就会出现在这里"
        />
      ) : (
        <>
          <PillRow>
            {SORTS.map((s) => (
              <Pill key={s.key} active={sort === s.key} href={href({ sort: s.key })}>
                {s.label}
              </Pill>
            ))}
          </PillRow>

          {/*
            * 语言筛选条**按项目数排**，不按字母排 —— 理由写在
            * project-rules.languageFacets 上。只有一种语言时整排不出现：
            * 一个永远只有一个选项的筛选器只是在占地方。
            */}
          {dir.facets.length > 1 && (
            <PillRow wrap>
              <Pill active={!lang} href={href({ lang: undefined })}>
                全部语言
              </Pill>
              {dir.facets.map((f) => (
                <Pill key={f.language} active={lang === f.language} href={href({ lang: f.language })}>
                  {f.language} {f.count}
                </Pill>
              ))}
            </PillRow>
          )}

          <Section>
            {dir.projects.length > 0 ? (
              <ProjectList projects={dir.projects} />
            ) : (
              <Empty title={`没有 ${lang} 的项目`} hint="换一个语言，或者看全部" />
            )}
          </Section>

          <PageNote>
            <FolderGit2 className="mr-1 inline h-3.5 w-3.5 align-[-2px]" aria-hidden />
            收录了 {dir.total} 个项目，来自 {dir.builders} 个人。
            {/* JSX 里的 **粗体** 会渲染成字面上的星号 —— 要用 strong */}
            只有<strong className="font-medium">自己打开了「在主页展示 GitHub」</strong>
            的成员才会出现在这里 —— 所以这一页比这个社区实际做过的东西少，
            而少是事实，把它显示成多才是问题
          </PageNote>
        </>
      )}
    </>
  );
}
