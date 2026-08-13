import { Archive, ChevronRight, PenLine, Search } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { DeepList, PostList } from "@/components/forum/PostList";
import { PageHeader } from "@/components/shell/PageHeader";
import { Group, Row, Section } from "@/components/ui/primitives";
import { requireFeature } from "@/lib/flags/server";
import { getCurrentUser } from "@/lib/auth/session";
import { buildViewerContext } from "@/lib/forum/context";
import { groupBoards } from "@/lib/forum/board-groups";
import { listBoards, listPosts } from "@/lib/forum/queries";

export const metadata: Metadata = { title: "论坛" };
export const dynamic = "force-dynamic";

export default async function ForumPage() {
  const user = await getCurrentUser();
  // 功能开关：关掉之后这一页 404 —— 只藏导航的话，地址栏敲一下照样进得去
  requireFeature("forum", user);
  const viewer = buildViewerContext(user);
  const boards = listBoards(viewer);
  const recent = listPosts(viewer, { sort: "recent", limit: 15 });
  /*
   * 「坐下来读」。
   *
   * 这一段是这一页真正的改动。原来首页只有一条按时间刷的流，
   * 于是「所以开水是什么」和一篇一万字的架构解析并排站着，
   * 一小时后一起被冲走 —— 一个花了四秒写，一个花了一天。
   *
   * 数出来的结果：长文平均 2.3 次浏览，短帖平均 8.2 次。
   * 而 43 篇长文里 33 篇出自同一个人 —— 他每篇拿到两次浏览。
   *
   * 所以给长文一条不按时间冲刷的路（sort: "deep"，衰减按天不按小时），
   * 并且**换一种长相**（DeepList）—— 光换顺序不换长相的话，
   * 它还是和水帖一个样式，只是排得靠前一点。
   *
   * 取 5 篇：一张通栏的头条 + 两行各两张。取偶数的话最后一行会剩半张，
   * 旁边空一半，看起来像没加载出来。
   */
  /*
   * 三篇，不是五篇。
   *
   * 站长：「这个论坛现在给长文太大铺面了，最多留三分之一」。
   * 一张卡片大约等于时间线上两行，所以 3 张 ≈ 6 行，
   * 而下面的时间线是 15 行 —— 约 29%，压在三分之一以下。
   *
   * 五张的时候是 40%，而且手机上五张整宽卡片一路堵在时间线前面。
   */
  const worthReading = listPosts(viewer, { sort: "deep", longformOnly: true, limit: 3 });

  return (
    <>
      <PageHeader
        title="论坛"
        subtitle="群聊留不住的东西，放在这里"
        action={
          // 两个 44px 见方的目标，和 iOS 导航栏按钮同一个尺寸 —— 这个站大半的人在微信里点它
          <span className="flex shrink-0 items-center gap-2">
            <Link
              href="/forum/search"
              aria-label="搜索帖子"
              className="inline-flex h-11 w-11 items-center justify-center rounded-[var(--radius-control)] bg-[var(--fill)] text-[var(--ink-secondary)] transition hover:bg-[var(--fill-strong)] active:scale-[0.95]"
            >
              <Search className="h-4 w-4" strokeWidth={2} aria-hidden />
            </Link>
            {user ? (
              <Link
                href="/forum/new"
                className="t-subhead flex h-11 shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] bg-[var(--accent)] px-4 font-medium text-[var(--accent-ink)] transition active:scale-[0.97]"
              >
                <PenLine className="h-4 w-4" strokeWidth={2} aria-hidden />
                发帖
              </Link>
            ) : null}
          </span>
        }
      />

      {/*
        * 摆在最前面。
        *
        * 一进论坛先看见的是「有人写了这些」，而不是「这里有九个版块」——
        * 版块是给已经知道自己要找什么的人用的，而绝大多数人是来看看有什么。
        *
        * 紧挨着下面的时间线也是故意的：卡片和密行并排出现，
        * 「这一栏是要坐下来读的、那一栏是这会儿在聊的」这句话
        * 不用写出来就成立了。
        */}
      {worthReading.length > 0 && (
        <Section
          title="坐下来读"
          action={
            <Link
              href="/forum/deep"
              className="t-caption inline-flex items-center gap-1 text-[var(--accent)] transition active:opacity-60"
            >
              全部
              <ChevronRight className="h-3.5 w-3.5" strokeWidth={2.2} aria-hidden />
            </Link>
          }
        >
          <DeepList posts={worthReading} />
        </Section>
      )}

      <Section title="最新讨论">
        <PostList posts={recent} showBoard />
      </Section>

      {/*
        * 版块摆在时间线之后。
        *
        * 九行版块横在中间的时候，手机上要划过它们才够得着「这会儿在聊什么」——
        * 而目录这种东西是给「我要发一篇讲部署的文章，该发哪儿」的人看的，
        * 那是少数时刻。放在下面它仍然一眼看得到，只是不再挡路。
        *
        * 分成三堆是为了先回答「我要发的东西属于哪一类」——
        * 九个版块平铺是一列九行，扫一眼记不住。分组只发生在这一层，
        * 库里没有这回事（见 board-groups.ts）。
        *
        * 桌面端分两栏：一栏九行在 832px 宽的正文栏里，右边一半是空的。
        * 用 columns 而不是 grid —— 三组的行数不一样，grid 会在某一格
        * 留一个洞，多栏排版会自己把它们摊平。栏数只到 2：
        * 三栏的话每栏只剩 262px，版块的那句说明会被截得只剩两个字。
        */}
      <Section title="版块">
        <div className="sm:columns-2 sm:gap-4">
          {groupBoards(boards).map(({ group, boards: members }) => (
            <div key={group.key} className="mb-4 break-inside-avoid last:mb-0">
              {/*
                * 组名用正常字重的小字，不用 t-group-label ——
                * 那个样式已经归「版块」这个大标题了，两级长得一样等于没分级。
                */}
              <p className="mb-1.5 px-1 leading-snug">
                <span className="t-footnote font-semibold">{group.label}</span>
                <span className="t-caption ml-1.5 text-[var(--ink-tertiary)]">{group.hint}</span>
              </p>
              <Group>
                {members.map((board) => (
                  <Row key={board.id} href={`/forum/${board.key}`}>
                    <div className="min-w-0 flex-1">
                      <p className="t-body leading-tight">{board.name}</p>
                      {board.description && (
                        <p className="t-caption mt-0.5 truncate text-[var(--ink-tertiary)]">
                          {board.description}
                        </p>
                      )}
                    </div>
                    <span className="tabular t-caption shrink-0 text-[var(--ink-tertiary)]">
                      {board.postCount}
                      {/* 光一个数字读屏念出来是「四十七」，不知道是什么的四十七 */}
                      <span className="sr-only"> 篇帖子</span>
                    </span>
                  </Row>
                ))}
              </Group>
            </div>
          ))}
        </div>
      </Section>

      {user && (
        <Section title="从群聊沉淀">
          <Group>
            <Row href="/forum/convert">
              <Archive
                className="h-[1.125rem] w-[1.125rem] shrink-0 text-[var(--accent)]"
                strokeWidth={1.9}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <p className="t-body leading-tight">把群里聊出来的东西整理成帖子</p>
                <p className="t-caption mt-0.5 text-[var(--ink-tertiary)]">
                  只有原群成员可见，公开需每位原作者同意
                </p>
              </div>
            </Row>
          </Group>
        </Section>
      )}
    </>
  );
}
