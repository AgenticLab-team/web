import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  SHARE_CODE_LENGTH,
  looksLikeShareCode,
  newShareCode,
} from "@/lib/forum/share-code";

/**
 * 帖子短链。
 *
 * ─────────────────────────────────────────
 * `share_code` 一直在生成，而没有任何地方读
 * ─────────────────────────────────────────
 *
 * 生产库里 56 篇帖子有 52 篇带着一个 8 位的码 ——
 * 而全站没有一处读过它。分享面板分享的是
 * `/forum/p/<26 位 ULID>`，那串东西转进微信里又长又难看。
 *
 * 微信是这个社群的主要传播渠道，链接的长相在那里是有实感的差别。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

describe("**生成的码必须定长**", () => {
  it("每次都是同一个长度", () => {
    /*
     * 原来是 `Math.random().toString(36).slice(2, 10)` ——
     * 通常给 8 位，但随机数落在表示很短的值上时（0.5 → "0.i"）
     * 切出来只有 1 位。概率低，可它一旦发生就是一个又短又容易撞的码，
     * 而且看起来像是坏了。
     */
    for (let i = 0; i < 500; i++) {
      assert.equal(newShareCode().length, SHARE_CODE_LENGTH);
    }
  });

  it("**不含容易看错的字符**", () => {
    /*
     * 短链是要被人念出来、抄下来、在微信里被截断之后凭记忆补全的。
     * 省下 0/O/o 和 1/l/I 换来的是「照着念不会错」。
     */
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) for (const ch of newShareCode()) seen.add(ch);
    for (const bad of ["0", "O", "o", "1", "l", "I"]) {
      assert.equal(seen.has(bad), false, `码里出现了 ${bad}`);
    }
  });

  it("500 次不重样 —— 撞了的话唯一索引会让发帖直接失败", () => {
    const all = new Set(Array.from({ length: 500 }, () => newShareCode()));
    assert.equal(all.size, 500);
  });
});

describe("形状校验", () => {
  it("认得自己生成的", () => {
    for (let i = 0; i < 50; i++) assert.equal(looksLikeShareCode(newShareCode()), true);
  });

  it("长度不对的一律不认", () => {
    assert.equal(looksLikeShareCode("abc"), false);
    assert.equal(looksLikeShareCode("a".repeat(SHARE_CODE_LENGTH + 1)), false);
  });

  it("含表外字符的不认 —— 含 0/1/o/l 的老码也一样", () => {
    assert.equal(looksLikeShareCode("abcdefg0"), false);
    assert.equal(looksLikeShareCode("ABCDEFGH"), false);
    assert.equal(looksLikeShareCode("../../etc"), false);
  });
});

describe("接线", () => {
  it("**两条插帖路径用同一个生成器**", () => {
    /*
     * 群聊转帖那条路以前不生成码 —— 生产库里 4 篇没有。
     * 两处各写一份的话，迟早又有一条路忘了写。
     */
    for (const file of ["lib/forum/actions.ts", "lib/forum/convert.ts"]) {
      assert.match(strip(src(file)), /newShareCode\(\)/, file);
    }
  });

  it("那个会产出短码的写法没了", () => {
    for (const file of ["lib/forum/actions.ts", "lib/forum/convert.ts"]) {
      assert.equal(
        strip(src(file)).includes("Math.random().toString(36)"),
        false,
        `${file} 还在用会产出短码的写法`,
      );
    }
  });

  it("分享面板用短链", () => {
    assert.match(strip(src("app/(app)/forum/p/[id]/page.tsx")), /\/p\/\$\{post\.raw\.shareCode\}/);
  });

  it("**没有码的老帖子退回长地址** —— 比给一个坏链接强", () => {
    const body = strip(src("app/(app)/forum/p/[id]/page.tsx"));
    assert.match(body, /post\.raw\.shareCode\s*\n?\s*\?/);
    assert.match(body, /\/forum\/p\/\$\{post\.id\}/);
  });
});

describe("**短码不是通行证**", () => {
  const route = strip(src("app/p/[code]/route.ts"));

  it("只查 id 然后跳转，不自己判可见性", () => {
    /*
     * 自己再判一遍的话，全站就有了两套可见性逻辑，而两套迟早分叉；
     * 分叉的方向如果是这一条更松，短链就成了绕开权限的后门 ——
     * 而它看起来只是个短地址。
     */
    assert.equal(route.includes("canSeePost"), false, "短链里自己判可见性了");
    assert.equal(route.includes("visibleGroupIds"), false);
    assert.match(route, /status: 302/);
  });

  it("跳到正式地址，由那一页去判", () => {
    assert.match(route, /\/forum\/p\/\$\{row\.id\}/);
  });

  it("**跳相对地址，不许拿 request.url 拼绝对地址**", () => {
    /*
     * 站点在 nginx 后面，Next 收到的 `request.url` 是内网那一个
     * （http://localhost:3000/...）。拿它拼出来的 Location 是
     * `https://localhost:3000/forum/p/...` —— 每一条分享出去的短链
     * 都会把人送到他自己的机器上。
     *
     * 这个 bug 在本地怎么测都测不出来（本地它恰好是对的），
     * 是真的部署上去点了一次才看见的。
     */
    assert.equal(route.includes("request.url"), false, "又拿 request.url 拼绝对地址了");
    assert.equal(route.includes("Response.redirect"), false, "Response.redirect 只收绝对地址");
    assert.match(route, /Location: `\/forum\/p\//);
  });

  it("**认不出来一律 404，不区分「码不对」和「帖子没了」**", () => {
    // 区分开的话，这个接口就成了一个可以拿来枚举短码的东西
    const notFounds = route.match(/status: 404/g) ?? [];
    assert.ok(notFounds.length >= 2, "应该有两条路径都回 404");
  });

  it("**用 302 不用 301** —— 301 会被长期缓存，帖子删了也清不掉", () => {
    assert.match(route, /302/);
    assert.equal(/\b301\b/.test(route), false);
  });

  it("形状先挡一道，省得每个乱敲的路径都查库", () => {
    assert.match(route, /looksLikeShareCode\(code\)/);
  });

  it("**短链不进受保护前缀** —— 公开帖子要能转给没登录的人", () => {
    const routes = readFileSync(new URL("../src/lib/auth/routes.ts", import.meta.url), "utf8");
    const list = routes.slice(routes.indexOf("PROTECTED_PREFIXES"), routes.indexOf("]", routes.indexOf("PROTECTED_PREFIXES")));
    assert.equal(/"\/p"/.test(list), false);
  });

  it("不用 RouteContext —— 新路由不在生成的路由表里，tsc 会先炸", () => {
    assert.equal(route.includes("RouteContext"), false);
  });
});
