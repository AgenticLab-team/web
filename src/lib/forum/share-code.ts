import { randomInt } from "node:crypto";

/**
 * 帖子的短链码。
 *
 * ─────────────────────────────────────────
 * 它一直在生成，而没有任何地方读
 * ─────────────────────────────────────────
 *
 * 每篇帖子创建时都写一个 `share_code`，生产库里 56 篇有 52 篇带着它 ——
 * 而全站没有一处读过它。分享面板分享的是
 * `/forum/p/<26 位 ULID>`，那串东西转进微信里又长又难看。
 *
 * 微信是这个社群的主要传播渠道，链接的长相在那里是有实感的差别。
 *
 * ─────────────────────────────────────────
 * 原来那个生成方式会产出短码
 * ─────────────────────────────────────────
 *
 * `Math.random().toString(36).slice(2, 10)` 通常给 8 位，
 * 但当随机数落在表示很短的值上时（比如 0.5 → `"0.i"`），
 * 切出来只有 1 位。概率低，可它一旦发生就是一个**又短又容易撞**的码，
 * 而且看起来像是坏了。定长生成，不靠运气。
 */

/**
 * 去掉了容易看错的字符：`0 O o` / `1 l I`。
 *
 * 短链是要被人念出来、抄下来、在微信里被截断之后凭记忆补全的东西 ——
 * 省下这几个字符换来的是「照着念不会错」。
 */
const ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";

/** 码长。32^8 ≈ 1.1 万亿，这个体量的站永远撞不上 */
export const SHARE_CODE_LENGTH = 8;

export function newShareCode(): string {
  let out = "";
  for (let i = 0; i < SHARE_CODE_LENGTH; i++) {
    out += ALPHABET[randomInt(ALPHABET.length)];
  }
  return out;
}

/**
 * 这串东西看起来像不像一个短链码。
 *
 * 路由上先用它挡一道，省得每一个乱敲的路径都去查一次库。
 * **不能用它来判断「这个码存在」** —— 形状对不代表有这篇帖子。
 */
export function looksLikeShareCode(value: string): boolean {
  if (value.length !== SHARE_CODE_LENGTH) return false;
  for (const ch of value) if (!ALPHABET.includes(ch)) return false;
  return true;
}
