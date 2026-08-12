import { Package } from "lucide-react";
import Link from "next/link";

/**
 * 帖子上那个「这篇聊的是哪个项目」的标记。
 *
 * ─────────────────────────────────────────
 * 它点进去是**站内**的项目页，不是 GitHub
 * ─────────────────────────────────────────
 *
 * 这一栏存在的全部理由是「同一个项目的讨论散在几十篇帖子里，
 * 谁也串不起来」。直接送去 GitHub 的话，那几十篇仍然串不起来 ——
 * 而且读者已经在读一篇关于它的帖子了，他缺的不是仓库地址。
 *
 * ─────────────────────────────────────────
 * 长得和标签明显不同
 * ─────────────────────────────────────────
 *
 * 带图标、带边框。混在标签那一排里的话它会被当成又一个标签，
 * 而两者的去处完全不同：标签去搜索结果，这个去一个项目的页面。
 */
export function ProjectTag({ repoRef }: { repoRef: string }) {
  return (
    <Link
      href={`/projects/${repoRef}`}
      className="t-caption2 inline-flex min-h-7 items-center gap-1.5 rounded-[var(--radius-pill)] px-2.5 py-1 text-[var(--ink-secondary)] transition-colors hover:bg-[var(--fill)] hairline"
    >
      <Package className="h-3 w-3 shrink-0" strokeWidth={2} aria-hidden />
      <span className="min-w-0 truncate">{repoRef}</span>
    </Link>
  );
}
