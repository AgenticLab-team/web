import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readCode, srcRoot, walkSource } from "./_source";

/**
 * 全站 server action 的面。
 *
 * ═════════════════════════════════════════
 * 一个带 `"use server"` 的文件里，**每一个导出的 async 函数
 * 都是客户端可以直接调的**
 * ═════════════════════════════════════════
 *
 * 这一点很容易忘，因为那些函数看起来就是普通的服务端函数：
 * 它们 import 数据库、写审计、发消息，读起来完全不像一个 HTTP 端点。
 * 但打包器会给每一个都生成一个 action id，任何人都能拿着那个 id
 * POST 一份自己编的参数进来。
 *
 * 于是「收一个 `user` 当参数」的函数就是一个后门 ——
 * 调用方传谁进来它就以谁的身份干活。而它在代码里长得
 * **和一个写得很规矩的内部函数一模一样**，review 时几乎看不出来。
 *
 * ─────────────────────────────────────────
 * 为什么要全站扫，而不是在出问题的地方各写一条
 * ─────────────────────────────────────────
 *
 * 因为这个坏法是**下一个文件**引进来的，不是已有的文件。
 * 抽 `createPostAs` 出去的时候我就在防它 —— 但那只防住了那一次。
 * 扫全站才防得住第二次。
 *
 * 真的需要一个收 `user` 的函数时，把它放进一个只 `import "server-only"`
 * 的文件里（比如 `lib/forum/write.ts`），由 action 那层取到当前用户再调它。
 */

/**
 * 「**谁在调**」和「**调谁**」是两回事。
 *
 * ─────────────────────────────────────────
 * 这条区分是这份守卫唯一难的地方
 * ─────────────────────────────────────────
 *
 * 第一版把 `userId:` 也算进来了，于是 `adjustPoints({ userId })`
 * 这种正常的管理操作全被判成后门 —— 那里的 `userId` 是**被操作的人**，
 * 而操作者来自 `requireWritableAdmin()`，一个字节都不由调用方决定。
 *
 * 一份天天误报的守卫，最后的结局一定是被人加一行白名单绕过去，
 * 或者干脆删掉。所以这里只列**表示调用者自己是谁**的那些名字：
 * 它们一旦出现在参数里，就意味着「你说你是谁，你就是谁」。
 */
const ACTOR_PARAMS = ["user:", "user :", "actor:", "currentUser:", "actorId:", "asUser:"];

/** 认「现在是谁在调」的几种写法。`getRealUser` 是其中最严的一种 —— 它连预览态都不认 */
const IDENTITY_CHECK =
  /getCurrentUser\(|getRealUser\(|requireWritableAdmin\(|requireAdmin\(|requireUser\(/;

/** 全站所有 server action 文件 —— 注释已经剥掉，不会被讲解自己的话绊到 */
function actionFiles(): { path: string; code: string }[] {
  return walkSource(srcRoot())
    .map((path) => ({ path, code: readCode(path.slice(srcRoot().length + 1)) }))
    // 指令必须在文件最前面才生效，所以只认开头那一行
    .filter(({ code }) => /^\s*["']use server["']/.test(code));
}

const FILES = actionFiles();

describe("server action 的参数里不能夹带身份", () => {
  it("确实扫到了文件 —— 空扫等于这份测试不存在", () => {
    /*
     * 没有这一条的话，`readCode` 的路径拼错、或者以后目录挪了位置，
     * 都会让下面每一条静悄悄地全绿 —— 一份永远通过的守卫
     * 比没有守卫更糟，因为它会让人以为这里有人看着。
     */
    assert.ok(FILES.length >= 10, `只扫到 ${FILES.length} 个 server action 文件，太少了`);
  });

  for (const { path, code } of FILES) {
    const short = path.slice(srcRoot().length + 1);
    it(short, () => {
      /*
       * 只看**导出**的函数。同一个文件里没导出的辅助函数收 user
       * 是完全正常的 —— 它没有 action id，客户端够不着。
       */
      const exported = [...code.matchAll(/export\s+async\s+function\s+\w+\s*\(([^)]*)\)/g)];
      for (const m of exported) {
        const params = m[1];
        for (const bad of ACTOR_PARAMS) {
          assert.ok(
            !params.includes(bad),
            `${short} 里有导出的 action 收「${bad.trim()}」当参数 —— ` +
              `客户端能直接调它并传任意身份进来。` +
              `把它挪进一个只 import "server-only" 的文件，让 action 自己取当前用户`,
          );
        }
      }
    });
  }
});

describe("**收「操作谁」当参数的 action，必须有一道门**", () => {
  /*
   * `userId` 当**目标**是正常的（管理员给某人加分），
   * 但那前提是**有人在管**：一个只 `getCurrentUser()` 就往下走、
   * 同时又收 `userId` 的 action，等于任何登录用户都能对任何人动手。
   *
   * 所以这里不禁止收 `userId`，只要求这种文件里出现管理员那道门。
   */
  for (const { path, code } of FILES) {
    const short = path.slice(srcRoot().length + 1);
    const takesTarget = [...code.matchAll(/export\s+async\s+function\s+\w+\s*\(([^)]*)\)/g)].some(
      (m) => /\buserId\s*:/.test(m[1]),
    );
    if (!takesTarget) continue;

    it(short, () => {
      assert.match(
        code,
        /requireWritableAdmin\(|requireAdmin\(/,
        `${short} 收 userId 当参数、却没走管理员那道门 —— ` +
          `那样任何登录用户都能拿别人的 id 调它`,
      );
    });
  }
});

describe("每个 server action 自己认当前用户", () => {
  for (const { path, code } of FILES) {
    const short = path.slice(srcRoot().length + 1);
    // 没有导出 async 函数的文件（比如只导出类型）不适用
    if (!/export\s+async\s+function/.test(code)) continue;

    it(short, () => {
      /*
       * 要么自己取当前用户，要么走管理员那道门 ——
       * 两个都没有的话，这个文件里就没有任何东西在回答
       * 「现在是谁在调」这个问题。
       *
       * 这一条比上面那条松：它只要求文件里**出现过**取身份的动作，
       * 不保证每个函数都取了。严格版要真的解析 AST，
       * 而那份复杂度换来的东西，上面那条已经覆盖了大半。
       */
      assert.match(code, IDENTITY_CHECK, `${short} 没有任何一处在认「现在是谁在调」`);
    });
  }
});
