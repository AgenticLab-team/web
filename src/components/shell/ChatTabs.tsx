import { Pill, PillRow } from "@/components/ui/primitives";
import { getCurrentUser } from "@/lib/auth/session";
import { featureEnabled } from "@/lib/flags/server";

/**
 * 「群聊」这一个入口下面的几个视图。
 *
 * ─────────────────────────────────────────
 * 为什么它们是一个板块而不是四个
 * ─────────────────────────────────────────
 *
 * 按天回看、检索、资源库、关键词雷达，问的是同一个问题的四种问法：
 * **群里说过的那件事，再找出来。** 数据上也确实是一条流 ——
 * links、keyword_hits、message_windows 全是同步时从 messages 派生的。
 *
 * 之前它们是导航上互不相干的三项加一个**根本不在导航里**的按天回看。
 * 结果是：搜不到就没有下一步了（其实可以按天翻），
 * 而站里数据最多的那一页只能从通知和搜索结果里撞进去。
 *
 * 合成一排标签之后，四种问法互相看得见 —— 这才叫整合，
 * 而不是把四项塞进同一个折叠菜单里。
 *
 * ─────────────────────────────────────────
 * 关掉的视图直接不出现
 * ─────────────────────────────────────────
 *
 * 每个视图各自受自己的开关管（页面那一侧 requireFeature 还会再挡一次）。
 * 按天回看不受任何开关管，所以这一排至少永远有一个 ——
 * 「群聊」这个入口不会变成一个点进去 404 的死链。
 */
export async function ChatTabs({ current }: { current: "archive" | "search" | "links" | "radar" }) {
  const user = await getCurrentUser();

  const tabs = [
    { key: "archive" as const, href: "/archive", label: "按天回看", on: true },
    {
      key: "search" as const,
      href: "/search",
      label: "检索",
      on: featureEnabled("message_search", user),
    },
    {
      key: "links" as const,
      href: "/links",
      label: "链接",
      on: featureEnabled("link_library", user),
    },
    {
      key: "radar" as const,
      href: "/radar",
      label: "雷达",
      on: featureEnabled("keyword_radar", user),
    },
  ].filter((tab) => tab.on);

  // 只剩自己一个的时候不画这一排 —— 一个切不到别处去的切换器是纯噪音
  if (tabs.length < 2) return null;

  return (
    <PillRow wrap>
      {tabs.map((tab) => (
        <Pill key={tab.key} href={tab.href} active={tab.key === current}>
          {tab.label}
        </Pill>
      ))}
    </PillRow>
  );
}
