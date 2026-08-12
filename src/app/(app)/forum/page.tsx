import { Archive, PenLine, Search } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { PostList } from "@/components/forum/PostList";
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
   * 「值得读的」。
   *
   * 这一段是这一页真正的改动。原来首页只有一条按时间刷的流，
   * 于是「所以开水是什么」和一篇一万字的架构解析并排站着，
   * 一小时后一起被冲走 —— 一个花了四秒写，一个花了一天。
   *
   * 数出来的结果：长文平均 2.3 次浏览，短帖平均 8.2 次。
   * 而 43 篇长文里 33 篇出自同一个人 —— 他每篇拿到两次浏览。
   *
   * 所以给长文一条不按时间冲刷的路（sort: "deep"，衰减按天不按小时）。
   * 摆在「最新讨论」**之前**：摆在后面等于没摆，那个位置在手机上
   * 要划过十五条帖子才到。
   */
  const worthReading = listPosts(viewer, { sort: "deep", longformOnly: true, limit: 6 });

  return (
    <>
      <PageHeader
        title="论坛"
        subtitle="群聊留不住的东西，放在这里"
        action={
          <span className="flex shrink-0 items-center gap-2">
            <Link
              href="/forum/search"
              aria-label="搜索"
              className="inline-flex items-center rounded-[var(--radius-control)] bg-[var(--fill)] p-2 text-[var(--ink-secondary)] transition active:scale-[0.95]"
            >
              <Search className="h-4 w-4" strokeWidth={2} aria-hidden />
            </Link>
            {user ? (
            <Link
              href="/forum/new"
              className="t-subhead flex shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] bg-[var(--accent)] px-3.5 py-2 font-medium text-[var(--accent-ink)] transition active:scale-[0.97]"
            >
              <PenLine className="h-4 w-4" strokeWidth={2} aria-hidden />
              发帖
            </Link>
            ) : null}
          </span>
        }
      />

      {/*
        * 值得读的，摆在版块列表和时间线之前。
        *
        * 一进论坛先看见的是「有人写了这些」，而不是「这里有九个版块」——
        * 版块是给已经知道自己要找什么的人用的，而绝大多数人是来看看有什么。
        */}
      {worthReading.length > 0 && (
        <Section
          title="值得读的"
          action={
            <Link href="/forum/deep" className="t-caption text-[var(--accent)]">
              全部
            </Link>
          }
        >
          <PostList posts={worthReading} showBoard />
        </Section>
      )}

      {/*
        * 版块分组显示。
        *
        * 九个版块平铺是一列九行，扫一眼记不住 —— 分成三堆之后，
        * 「我要发的东西属于哪一类」这个问题先被回答了一半。
        * 分组只在这一层，库里没有这回事（见 board-groups.ts）。
        */}
      <Section title="版块">
        <div className="space-y-4">
          {groupBoards(boards).map(({ group, boards: members }) => (
            <div key={group.key}>
              <p className="t-group-label mb-1.5 px-1">
                {group.label}
                <span className="ml-1.5 font-normal text-[var(--ink-quaternary)]">
                  {group.hint}
                </span>
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

      <Section title="最新讨论">
        <PostList posts={recent} showBoard />
      </Section>
    </>
  );
}
