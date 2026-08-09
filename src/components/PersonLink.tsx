import Link from "next/link";

/**
 * 把头像和名字变成能点进主页的东西。
 *
 * ─────────────────────────────────────────
 * 之前几乎哪儿都点不动
 * ─────────────────────────────────────────
 *
 * 成员目录整页的人都不可点 —— 一个点不进去的通讯录。
 * 榜单、搜索结果、论坛列表也一样：头像和昵称就在那里，
 * 看起来像能点，点下去什么都不发生。
 * 只有群聊存档那一页给昵称加了链接，而它旁边的头像没有。
 *
 * ─────────────────────────────────────────
 * 三种情况不给链接
 * ─────────────────────────────────────────
 *
 * · **匿名**。匿名帖的作者点进去就是本人，那等于没有匿名。
 * · **没有微信 ID**。主页按微信 ID 定位，没绑过的人没有落点 ——
 *   给一个必然 404 的链接，比不给更糟。
 * · **就是自己**（可选）。有些地方（「这是你」那一行）指回自己没意义。
 *
 * 这三种都退化成一个普通 `<span>`：**长得完全一样，只是不能点**。
 * 不做灰化处理 —— 那会让「这个人比较特殊」的错觉出现在一整页人身上。
 */
export function PersonLink({
  wxId,
  href,
  name,
  className = "",
  children,
}: {
  /** 微信 ID。没有就不给链接 */
  wxId?: string | null;
  /**
   * 直接给落点，绕过 wxId。
   *
   * 成员目录用这个：它**刻意不把 wx_id 放进返回结构**
   * （列的是所有同群的人，包括从没说过话的），
   * 所以走 `/members/by/<账号 id>` 那条中转。
   */
  href?: string | null;
  /** 无障碍标签用 —— 一个只包着头像的链接，读屏念不出来是谁 */
  name: string;
  className?: string;
  children: React.ReactNode;
}) {
  const target = href ?? (wxId ? `/members/${encodeURIComponent(wxId)}` : null);
  if (!target) return <span className={className}>{children}</span>;

  return (
    <Link
      href={target}
      aria-label={`${name} 的主页`}
      className={`transition active:opacity-60 ${className}`}
    >
      {children}
    </Link>
  );
}
