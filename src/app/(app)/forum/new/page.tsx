import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { ComposeForm } from "@/components/forum/ComposeForm";
import { PageHeader } from "@/components/shell/PageHeader";
import { BackLink, Empty } from "@/components/ui/primitives";
import { requireFeature } from "@/lib/flags/server";
import { prefillOf, promptFor } from "@/lib/github/prompts";
import { getCurrentUser } from "@/lib/auth/session";
import { buildViewerContext } from "@/lib/forum/context";
import { listTags } from "@/lib/forum/tags-queries";
import type { DraftSnapshot } from "@/lib/forum/draft-rules";
import { getDraft } from "@/lib/forum/drafts";
import { listBoards } from "@/lib/forum/queries";
import { can } from "@/lib/rbac/can";

export const metadata: Metadata = { title: "发帖" };
export const dynamic = "force-dynamic";

export default async function NewPostPage({
  searchParams,
}: {
  searchParams: Promise<{ board?: string; prompt?: string }>;
}) {
  const user = await getCurrentUser();
  // 功能开关：关掉之后这一页 404 —— 只藏导航的话，地址栏敲一下照样进得去
  requireFeature("forum", user);
  if (!user) redirect("/login");

  const { board, prompt: promptId } = await searchParams;
  const viewer = buildViewerContext(user);

  /*
   * 从「我的」页那条 GitHub 提示点过来的 —— 把标题和正文预先填好。
   *
   * `promptFor(user.id, id)` 是**双条件**查询：拿别人的提示 id
   * 过来是查不到的。不这么写的话，这个页面就成了一个
   * 「输入 id、返回别人还没公开的新仓库名」的接口。
   *
   * 查不到就当没有这个参数，安静地渲染一张空表单 ——
   * 报错没有意义，用户对这个 id 无能为力。
   */
  const promptRow = promptId ? promptFor(user.id, promptId) : null;
  const prefill = promptRow ? prefillOf(promptRow) : null;

  // 只列出这个人真的能发帖的版块，而不是能看见的版块 ——
  // 让人写完再告诉他发不了是最糟的体验
  const boards = listBoards(viewer).filter(
    (b) =>
      !b.locked &&
      user.level >= b.postMinLevel &&
      can(user, (b.postPermission ?? "forum.post.create") as "forum.post.create", {
        scopeType: "board",
        scopeId: b.id,
      }).allowed,
  );

  if (boards.length === 0) {
    return (
      <>
        <PageHeader title="发帖" />
        <Empty
          title="你还没有可以发帖的版块"
          hint="部分版块有等级门槛，多参与讨论就能解锁"
        />
      </>
    );
  }

  /*
   * 每个能发帖的版块各取一份草稿。
   *
   * 一次取完而不是切版块时再去问 —— 版块数是个位数，
   * 而「切过去才发现那边有草稿」会让人以为草稿刚刚才出现。
   */
  const serverDrafts: Record<string, DraftSnapshot> = {};
  for (const b of boards) {
    const draft = getDraft(user.id, "post", b.key);
    if (draft) serverDrafts[b.key] = draft;
  }

  return (
    <>
      <BackLink href="/forum">论坛</BackLink>

      <PageHeader title="发帖" />

      <ComposeForm
        serverDrafts={serverDrafts}
        boards={boards.map((b) => ({
          key: b.key,
          name: b.name,
          description: b.description,
          maxVisibility: b.maxVisibility,
        }))}
        tagSuggestions={listTags(12).map((t) => ({
          slug: t.slug,
          name: t.name,
          postCount: t.postCount,
        }))}
        requireTagBoards={boards.filter((b) => b.requireTags).map((b) => b.key)}
        anonymousBoards={boards.filter((b) => b.allowAnonymous).map((b) => b.key)}
        defaultBoard={board}
        prefill={prefill}
        githubPromptId={promptRow?.id}
      />
    </>
  );
}
