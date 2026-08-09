import type { Metadata } from "next";
import Link from "next/link";

import { PostBulkTable } from "@/components/admin/PostBulkTable";
import { PageHeader } from "@/components/shell/PageHeader";
import { Pagination } from "@/components/ui/Pagination";
import { Empty, Pill } from "@/components/ui/primitives";
import { requireAdmin } from "@/lib/admin/guard";
import { listPostsForAdmin, orphanPosts, postFacets } from "@/lib/admin/posts";
import { BULK_LIMIT } from "@/lib/moderation/bulk-rules";

export const metadata: Metadata = { title: "内容管理" };
export const dynamic = "force-dynamic";

const STATUS_LABELS: Record<string, string> = {
  published: "已发布",
  draft: "草稿",
  locked: "已锁定",
  hidden: "已隐藏",
  deleted: "已删除",
};

/**
 * 内容管理。
 *
 * 与前台列表最大的不同：**这里不做可见性收口**。
 * 管理员本来就要能看到被隐藏和删除的东西 ——
 * 看不到就没法恢复，也没法判断当初删得对不对。
 *
 * 「已删除」是一个刻意保留的筛选项。删掉的东西如果从后台也消失，
 * 那就等于没人能复查一次删除是否正确，而误删是会发生的。
 */
export default async function AdminPostsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; board?: string; status?: string; group?: string; page?: string }>;
}) {
  await requireAdmin("forum.post.delete.any");
  const params = await searchParams;

  const { rows, total, slice } = listPostsForAdmin({
    keyword: params.q,
    boardId: params.board,
    status: params.status,
    fromGroupChat: params.group === "1",
    page: params.page,
  });
  const facets = postFacets();
  const orphans = orphanPosts();

  const href = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams();
    const merged = {
      q: params.q,
      board: params.board,
      status: params.status,
      group: params.group,
      ...patch,
    };
    for (const [k, v] of Object.entries(merged)) if (v) next.set(k, v);
    const qs = next.toString();
    return qs ? `/admin/posts?${qs}` : "/admin/posts";
  };

  return (
    <>
      <PageHeader title="内容管理" subtitle={`${total} 篇帖子`} />

      {orphans.length > 0 && (
        <div
          className="mb-4 rounded-[var(--radius-card)] p-4 hairline"
          style={{ background: "color-mix(in srgb, var(--warning) 9%, var(--surface))" }}
        >
          <p className="t-subhead font-medium" style={{ color: "var(--warning)" }}>
            {orphans.length} 篇帖子的版块已被删除
          </p>
          <p className="t-caption mt-1 leading-relaxed text-[var(--ink-secondary)]">
            这些帖子成了孤儿：查得到、打不开。删版块时本该先把帖子搬走，
            出现这种情况说明有别的路径绕过了那道检查。
            {orphans.slice(0, 3).map((o) => `「${o.title}」`).join("")}
            {orphans.length > 3 && ` 等 ${orphans.length} 篇`}。
          </p>
        </div>
      )}

      <form action="/admin/posts" className="mb-3">
        {params.board && <input type="hidden" name="board" value={params.board} />}
        {params.status && <input type="hidden" name="status" value={params.status} />}
        <input
          name="q"
          defaultValue={params.q}
          placeholder="搜标题或正文"
          className="t-body w-full rounded-[var(--radius-card)] bg-[var(--surface)] px-4 py-3 outline-none hairline placeholder:text-[var(--ink-quaternary)]"
        />
      </form>

      <div className="mb-2 flex flex-wrap gap-1.5">
        <Pill href={href({ status: undefined })} active={!params.status}>
          全部状态
        </Pill>
        {facets.status.map((f) => (
          <Pill key={f.value} href={href({ status: f.value })} active={params.status === f.value}>
            {STATUS_LABELS[f.value] ?? f.value} {f.count}
          </Pill>
        ))}
        {facets.groupDerived > 0 && (
          <Pill href={href({ group: params.group === "1" ? undefined : "1" })} active={params.group === "1"}>
            群聊转帖 {facets.groupDerived}
          </Pill>
        )}
      </div>

      <div className="-mx-4 mb-5 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
        <span className="shrink-0">
          <Pill href={href({ board: undefined })} active={!params.board}>
            全部版块
          </Pill>
        </span>
        {facets.boards.map((b) => (
          <span key={b.id} className="shrink-0">
            <Pill href={href({ board: b.id })} active={params.board === b.id}>
              {b.name} {b.count}
            </Pill>
          </span>
        ))}
      </div>

      {rows.length === 0 ? (
        <Empty title="没有匹配的帖子" hint="换个关键词或筛选条件" />
      ) : (
        <PostBulkTable rows={rows} />
      )}

      <Pagination
        slice={slice}
        total={total}
        noun="篇帖子"
        basePath="/admin/posts"
        params={{ q: params.q, board: params.board, status: params.status, group: params.group }}
      />


      <p className="t-caption mt-4 px-1 pb-4 leading-relaxed text-[var(--ink-tertiary)]">
        批量操作一次最多 {BULK_LIMIT} 条，且**每一条都会独立留处罚记录、独立通知作者** ——
        只记一条汇总日志的话，用户档案上看不到自己那条，申诉时无从查起。
        全选只选当前页，不提供「选中全部搜索结果」：那个功能存在的唯一价值
        就是一次删掉几百条，而那正是最不该一键完成的事。
        单条的精细操作（置顶、移动版块、编辑）在
        <Link href="/forum" className="text-[var(--accent)]">
          帖子页
        </Link>
        里做。
      </p>
    </>
  );
}
