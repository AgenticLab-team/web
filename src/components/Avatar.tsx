/**
 * 头像。
 *
 * 上游只有 /friend-requests 提供头像（实测 24/24 条带 940x940 原图），
 * 排行榜与用户画像的 avatar 字段实测全空。也就是说 1595 名成员里
 * 只有二十几个人拿得到真实头像。
 *
 * 所以占位头像不是「兜底」而是常态，必须做得好看：
 * 昵称首字 + 由 wx_id 决定的稳定配色，同一个人在任何页面颜色都一样。
 */

const PALETTE = [
  { bg: "#0a5c4a", fg: "#e8f5f0" },
  { bg: "#1e3a5f", fg: "#e6eef7" },
  { bg: "#6b2d5c", fg: "#f7e9f2" },
  { bg: "#7c4a1e", fg: "#fbeee0" },
  { bg: "#2d5016", fg: "#eaf3e2" },
  { bg: "#4a3b7c", fg: "#eeeafa" },
  { bg: "#7c1f1f", fg: "#fae8e8" },
  { bg: "#1f5c6b", fg: "#e4f2f5" },
];

/** 稳定哈希：同一个 wx_id 永远得到同一个颜色，跨页面不跳变 */
export function paletteFor(seed: string) {
  return PALETTE[paletteIndexFor(seed)];
}

/**
 * 只取配色下标。
 *
 * 有它是为了让**不该拿到 wx_id 的地方**也能有一致的配色：
 * 成员目录这类页面把下标（0–7）传下来就够了，
 * 而 wx_id 一旦进了组件的 props，就会被序列化进 RSC 载荷、
 * 出现在网页源码里 —— 一个只用来算颜色的值不值得冒这个险。
 */
export function paletteIndexFor(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % PALETTE.length;
}

/** 取首个有意义的字符：中文取首字，英文取首字母，emoji 昵称取整个 emoji */
export function initialOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  // 用 Intl.Segmenter 正确处理 emoji 与组合字符
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter("zh", { granularity: "grapheme" });
    const first = segmenter.segment(trimmed)[Symbol.iterator]().next();
    if (!first.done) return first.value.segment.toUpperCase();
  }
  return trimmed.slice(0, 1).toUpperCase();
}

/**
 * 匿名内容统一用这一档配色。
 *
 * **不能拿作者 id 当种子** —— 配色是个稳定的哈希，
 * 于是同一个人的两篇匿名帖会是同一个颜色（互相串得起来），
 * 而它和他的实名帖也是同一个颜色。
 * 匿名这件事就是从这种地方漏掉的：名字抹了、头像抹了，
 * 剩一个颜色，而颜色不会引起任何人怀疑。
 *
 * 所有匿名内容长得一模一样才是对的 —— 「匿名」就是同一个身份。
 */
export const ANONYMOUS_PALETTE = 0;

interface AvatarProps {
  /** 配色种子。不该拿到 wx_id 的页面改传 paletteIndex */
  wxId?: string;
  /** 已经算好的配色下标，与 wxId 二选一 */
  paletteIndex?: number;
  name: string;
  src?: string | null;
  size?: number;
  className?: string;
}

export function Avatar({
  wxId,
  paletteIndex,
  name,
  src,
  size = 40,
  className = "",
}: AvatarProps) {
  const style = { width: size, height: size } as const;

  if (src) {
    return (
      // 微信头像域名在 next.config 里单独放行；这里不用 next/image，
      // 因为头像是 http 且域名固定，走优化管线没有收益还增加失败面
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={name}
        width={size}
        height={size}
        loading="lazy"
        className={`shrink-0 rounded-full object-cover ${className}`}
        style={style}
      />
    );
  }

  const { bg, fg } = PALETTE[paletteIndex ?? (wxId ? paletteIndexFor(wxId) : 0)];
  return (
    <span
      aria-label={name}
      role="img"
      className={`flex shrink-0 select-none items-center justify-center rounded-full font-medium ${className}`}
      style={{
        ...style,
        background: bg,
        color: fg,
        fontSize: Math.round(size * 0.42),
        lineHeight: 1,
      }}
    >
      {initialOf(name)}
    </span>
  );
}
