import { HeaderSkeleton, ListSkeleton, Skeleton } from "@/components/ui/Skeleton";

/**
 * 确认终端登录那一页的骨架。
 *
 * ─────────────────────────────────────────
 * 这一页的加载态尤其不能是「首页形状」
 * ─────────────────────────────────────────
 *
 * 人是**从终端被引导过来的**，手上拿着一串十分钟就过期的码。
 * 这时候闪一屏首页形状的骨架，会让他以为自己点错了地方 ——
 * 而他的下一个动作多半是退回去重来，那要再花掉一两分钟。
 *
 * 所以形状对着真实内容排：一条警告横幅、三行设备信息、几行权限、
 * 最后两个等宽的按钮。
 */
export default function Loading() {
  return (
    <>
      <HeaderSkeleton />
      {/* 顶上那条「如果你现在没在登录，关掉这一页」的警告 */}
      <Skeleton className="mb-4 h-20 w-full rounded-[var(--radius-card)]" />
      <ListSkeleton rows={3} avatar={false} />
      <Skeleton className="mb-2 mt-6 h-4 w-24" />
      <ListSkeleton rows={4} avatar={false} />
      {/* 两个按钮等宽 —— 加载态也不做视觉诱导 */}
      <div className="grid grid-cols-2 gap-3" aria-hidden>
        <Skeleton className="h-11 w-full rounded-[var(--radius-control)]" />
        <Skeleton className="h-11 w-full rounded-[var(--radius-control)]" />
      </div>
    </>
  );
}
