import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { EditPostForm } from "@/components/forum/EditPostForm";
import { PageHeader } from "@/components/shell/PageHeader";
import { BackLink } from "@/components/ui/primitives";
import { getCurrentUser } from "@/lib/auth/session";
import { buildViewerContext } from "@/lib/forum/context";
import { postCapabilities } from "@/lib/forum/manage";
import { getPost } from "@/lib/forum/queries";

export const metadata: Metadata = { title: "编辑帖子" };
export const dynamic = "force-dynamic";

export default async function EditPostPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const viewer = buildViewerContext(user);
  const post = getPost(viewer, id);
  // 没权限编辑与帖子不存在给同样的 404 —— 403 会泄露「这个帖子存在」
  if (!post) notFound();
  if (!postCapabilities(user, post.raw).edit) notFound();

  return (
    <>
      <BackLink href={`/forum/p/${post.id}`}>返回帖子</BackLink>

      <PageHeader title="编辑帖子" />

      <EditPostForm postId={post.id} initialTitle={post.title} initialContent={post.content} />
    </>
  );
}
