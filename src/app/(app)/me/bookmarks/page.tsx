import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { BookmarkList } from "@/components/forum/BookmarkList";
import { FolderManager } from "@/components/forum/FolderManager";
import { PageHeader } from "@/components/shell/PageHeader";
import { BackLink, PageNote, Pill, PillRow, Section } from "@/components/ui/primitives";
import { getCurrentUser } from "@/lib/auth/session";
import { bookmarkTabs, listBookmarkItems, listFolders } from "@/lib/forum/bookmark-queries";
import { UNSORTED_NAME } from "@/lib/forum/bookmark-rules";
import { buildViewerContext } from "@/lib/forum/context";

export const metadata: Metadata = { title: "收藏夹" };
export const dynamic = "force-dynamic";

/**
 * 收藏夹。
 *
 * ─────────────────────────────────────────
 * 在这一页存在之前，收藏是只写不读的
 * ─────────────────────────────────────────
 *
 * 帖子页那个书签按钮一直能点、点了会写库、图标也会填实，
 * 而 `listBookmarks` 全站零调用点 —— 收藏完之后
 * **没有任何地方能看到自己收藏了什么**。
 *
 * 那比「功能没做」难发现：按钮点下去一切正常，
 * 人会以为东西在某个自己还没找到的地方，于是接着收藏。
 *
 * `forum_bookmark_folders` 整张表、`bookmarks.folder_id`、
 * `bookmarks.note` 也都是同一批建了没接的东西，这一页把它们接上。
 */
export default async function BookmarksPage({
  searchParams,
}: {
  searchParams: Promise<{ f?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { f } = await searchParams;

  /*
   * 三种状态要分得开：
   *   f 缺省   → 全部
   *   f=none  → 未分组（folder_id IS NULL）
   *   f=<id>  → 某个收藏夹
   *
   * 用空字符串表示「未分组」的话，`?f=` 和没带 f 在服务端读出来
   * 都是 falsy，两种状态会挤成一种。
   */
  const selected: string | null | undefined = f === undefined ? undefined : f === "none" ? null : f;

  const viewer = buildViewerContext(user);
  const folders = listFolders(user.id);
  const { all, tabs } = bookmarkTabs(user.id);

  /*
   * 选中的夹子可能已经不在了 —— 另一个标签页里删掉的，
   * 或者一条被分享出去的链接。退回「全部」，
   * 而不是停在一个永远空着、也说不清为什么空的壳上。
   */
  const current =
    selected === undefined || selected === null || folders.some((x) => x.id === selected)
      ? selected
      : undefined;

  const items = listBookmarkItems(viewer, { folderId: current, limit: 100 });

  return (
    <>
      <BackLink href="/me">我的</BackLink>

      <PageHeader
        title="收藏夹"
        subtitle={all === 0 ? "还没收藏过东西" : `共 ${all} 条`}
      />

      {all > 0 && (
        <PillRow>
          <Pill href="/me/bookmarks" active={current === undefined}>
            全部 {all}
          </Pill>
          {tabs.map((tab) => (
            <Pill
              key={tab.id ?? "none"}
              href={`/me/bookmarks?f=${tab.id ?? "none"}`}
              active={tab.id === null ? current === null : current === tab.id}
            >
              {tab.name} {tab.count}
            </Pill>
          ))}
        </PillRow>
      )}

      <Section>
        <BookmarkList items={items} folders={folders.map((x) => ({ id: x.id, name: x.name }))} />
      </Section>

      <Section title="收藏夹">
        <FolderManager folders={folders} />
        <PageNote>
          「{UNSORTED_NAME}」不是一个收藏夹，是还没归类的那些。
          删掉一个收藏夹只是把里面的收藏挪回未分组，一条都不会丢。
        </PageNote>
      </Section>
    </>
  );
}
