"use server";

import { getCurrentUser } from "@/lib/auth/session";
import { renderMarkdown } from "@/lib/markdown";

/**
 * 编辑器预览。
 *
 * 走服务端渲染而不是在客户端再实现一份 Markdown ——
 * 两份实现必然分叉，而分叉的结果是「预览好好的，发出来变了样」。
 * 代价是一次往返，用防抖压到可接受。
 *
 * 顺带：客户端拿不到 shiki 与 DOMPurify，硬做也做不出一致的结果。
 */
export async function previewMarkdown(source: string): Promise<{ html: string }> {
  const user = await getCurrentUser();
  // 预览会跑完整的渲染管线，不该对未登录的人开放
  if (!user) return { html: "" };
  if (source.length > 100_000) return { html: "<p>内容过长，无法预览</p>" };

  const { html } = await renderMarkdown(source);
  return { html };
}
