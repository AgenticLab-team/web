import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { EditPostForm } from "@/components/forum/EditPostForm";
import { PageHeader } from "@/components/shell/PageHeader";
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
      <Link
        href={`/forum/p/${post.id}`}
        className="t-subhead -ml-1 mt-6 inline-flex items-center gap-0.5 text-[var(--accent)] transition active:opacity-60"
      >
        <ChevronLeft className="h-4 w-4" strokeWidth={2.2} aria-hidden />
        返回帖子
      </Link>

      <PageHeader title="编辑帖子" />

      <EditPostForm postId={post.id} initialTitle={post.title} initialContent={post.content} />
    </>
  );
}
