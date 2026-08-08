/**
 * 文本处理的纯函数。
 *
 * 单独成文件是为了让分享卡片路由与测试用**同一份实现** ——
 * 在测试里照抄一遍逻辑，测的就只是抄写是否准确，
 * 而不是实现本身对不对。这个项目已经在这上面栽过几次。
 */

const BOUNDARIES = ["。", "，", "、", "；", "：", "！", "？", " ", "·"];

/**
 * 在标点或空格处截断，别把词从中间切开。
 *
 * 「反应 /」这种断在斜杠上的收尾看起来像是渲染出错了。
 * 但断点太靠前时宁可硬切 —— 为了断得好看而丢掉大半内容不值得。
 */
export function truncateAtBoundary(text: string, max: number): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;

  const slice = clean.slice(0, max);
  const cut = Math.max(...BOUNDARIES.map((mark) => slice.lastIndexOf(mark)));
  const kept = cut > max * 0.5 ? slice.slice(0, cut) : slice;

  return `${kept.replace(/[\s/·、，]+$/, "")}…`;
}
