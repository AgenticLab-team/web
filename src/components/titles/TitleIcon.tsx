import {
  Award,
  Flame,
  Gem,
  MessageCircle,
  Medal,
  PenLine,
  Sprout,
  Tag,
  Target,
  Trophy,
  type LucideIcon,
} from "lucide-react";

/**
 * 称号图标。
 *
 * ─────────────────────────────────────────
 * 为什么不直接渲染 emoji
 * ─────────────────────────────────────────
 *
 * 称号是跟在人名后面显示的，也就是**混在中文正文里**。
 * 而 emoji 在这个位置有三个问题：
 *
 *   · 各平台字形完全不同 —— 同一个 🥇 在 iOS、Android、Windows 上
 *     是三个样子，而这个站的其它图标都是同一套 lucide 线条
 *   · 尺寸和基线不受控，行高会被撑开，一行里有称号的人比别人高一点
 *   · 上不了色 —— 无法跟着称号本身的主题色走
 *
 * ─────────────────────────────────────────
 * 同时认 emoji 和名字，所以不用迁移数据
 * ─────────────────────────────────────────
 *
 * 库里已经有 10 个称号、30 条授予记录，`icon` 字段存的是 emoji。
 * 改数据要写迁移、要考虑改到一半的情况，而这只是个显示问题。
 *
 * 所以这张表**两种都认**：老数据里的 emoji 直接映射到图标，
 * 新称号可以直接写名字。不认识的一律回退到奖章 ——
 * 回退到「什么都不显示」的话，一个配错图标的称号会看起来像没有称号。
 */
const ICONS: Record<string, LucideIcon> = {
  // 名字（新写法）
  sprout: Sprout,
  trophy: Trophy,
  medal: Medal,
  award: Award,
  "pen-line": PenLine,
  flame: Flame,
  gem: Gem,
  target: Target,
  "message-circle": MessageCircle,
  tag: Tag,

  // emoji（库里的老数据）
  "🌱": Sprout,
  "🥇": Trophy,
  "🥈": Medal,
  "🥉": Award,
  "✍️": PenLine,
  "✍": PenLine,
  "🔥": Flame,
  "💎": Gem,
  "🎯": Target,
  "💬": MessageCircle,
  "🏷️": Tag,
  "🏷": Tag,
};

export function TitleIcon({
  icon,
  className = "h-3.5 w-3.5",
}: {
  icon: string | null | undefined;
  className?: string;
}) {
  if (!icon) return null;
  const Icon = ICONS[icon] ?? ICONS[icon.replace(/️/g, "")] ?? Medal;
  return <Icon className={`inline-block shrink-0 ${className}`} strokeWidth={2} aria-hidden />;
}

/** 供测试与后台校验用 —— 认得出的图标名 */
export const TITLE_ICON_KEYS = Object.keys(ICONS);
