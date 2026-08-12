import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * 结构测试要用的读源码小工具。
 *
 * ─────────────────────────────────────────
 * 为什么不是每个测试文件各写一份
 * ─────────────────────────────────────────
 *
 * 各写一份的时候，每份都是同一行「去掉块注释再去掉行注释」。
 * 而**去掉行注释那一半是错的**，错得还很安静。
 *
 * 一个匹配 `Edg` 后跟斜杠的正则字面量，它的末尾是
 * 「反斜杠、斜杠、斜杠」—— 后两个斜杠连在一起。朴素的行注释剥离
 * 把它们当成注释开头，于是这一行从那儿往后全被吃掉，
 * 包括紧跟其后的那个浏览器名字。
 *
 * 结果是一条针对那个名字的断言，去比对一个**根本不存在的字符串**，
 * 得到「找不到」而不是「报错」。
 *
 * 这不是假想：`describeDevice` 那条顺序断言就是这么红的 ——
 * 而当时代码是对的。一份共用的实现至少让这个坑只需要被填一次。
 */

/**
 * 只在**行首**（前面只有空白）的 `//` 才算注释。
 *
 * 行中间的两个斜杠绝大多数时候是正则字面量或 URL，不是注释。
 * 少剥掉几个行尾注释，比悄悄吃掉半行代码安全得多。
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => (/^\s*\/\//.test(line) ? "" : line))
    .join("\n");
}

const ROOT = new URL("..", import.meta.url).pathname;

/** 读 `src/` 下的一个文件 */
export function readSource(relative: string): string {
  return readFileSync(join(ROOT, "src", relative), "utf8");
}

/** 读 `src/` 下的一个文件并去掉注释 —— 断言「代码里写了什么」时用这个 */
export function readCode(relative: string): string {
  return stripComments(readSource(relative));
}

/** 递归列出目录下的 .ts / .tsx，跳过 node_modules 和点开头的目录 */
export function walkSource(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walkSource(full, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

/** 仓库根目录，拼绝对路径用 */
export const repoRoot = ROOT;

/**
 * 发帖 / 回帖那条路的**全部源码**（动作壳 + 真正实现）。
 *
 * ═════════════════════════════════════════
 * 为什么是两个文件拼起来
 * ═════════════════════════════════════════
 *
 * 开放 API 也要能发帖，而那条路上没有 cookie 会话 —— 调用方是一把令牌。
 * 所以真正的实现搬到了 `write.ts` 并接受「以谁的身份」作为参数，
 * `actions.ts` 里只剩两个取会话的薄壳。
 *
 * 搬家的原因不是整理代码：`"use server"` 文件里**导出的每个 async 函数
 * 都是一个客户端可直接调用的服务端动作**，参数完全由客户端给。
 * 把一个收 `user` 参数的函数放在那种文件里，等于开一个
 * 「以任意人的身份发帖」的接口。
 *
 * 而那些盯着「这条规则还在不在」的守卫不该关心它落在哪个文件里 ——
 * 它们要守的是**这条路上有没有这一步**。所以给它们看两个文件的合集。
 */
export function forumWritePath(): string {
  /*
   * **实现放前面，薄壳放后面。**
   *
   * 有些断言是「从 `export async function createPost` 切到末尾，
   * 然后看这一段里有没有某一步」。壳在前面的话，`indexOf` 找到的是
   * 那个三行的壳 —— 断言会在一段几乎空的代码上跑，而且是**静默通过或
   * 静默失败**，取决于断言的方向。这比顺序本身重要得多。
   */
  return `${readSource("lib/forum/write.ts")}\n${readSource("lib/forum/actions.ts")}`;
}
