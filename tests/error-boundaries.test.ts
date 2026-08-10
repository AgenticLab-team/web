import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { readCode, readSource, repoRoot } from "./_source";

/**
 * 出错与找不到时的那几屏。
 *
 * ─────────────────────────────────────────
 * 在这之前这三层一个都没有
 * ─────────────────────────────────────────
 *
 * 敲错地址得到的是 Next 自带的
 * 「404: This page could not be found.」—— 黑白、英文、没有出口；
 * 页面渲染抛异常得到的是
 * "Application error: a client-side exception has occurred"，
 * 连刷新按钮都没有。
 *
 * 而这个站的主力访问环境是**微信内置浏览器**：没有地址栏、
 * 没有刷新按钮、没有开发者工具。撞上那两屏的人只能退出去，
 * 而且多半不会再点第二次。
 *
 * ─────────────────────────────────────────
 * 最要紧的一条不是好看，是**别泄露**
 * ─────────────────────────────────────────
 *
 * 帖子页对「不存在」和「你看不了」给的是同一个 notFound()，
 * 因为 403 等于告诉对方「这个帖子存在」—— 对私密内容来说，
 * 存在性本身就是信息。
 *
 * 那么这一页的**文案**也必须两种都盖得住：写「已被删除」等于
 * 承认它存在过，写「你没有权限」同样泄露。收口做在查询层、
 * 却在文案上漏出去，是这类泄露最常见的形态。
 */

const exists = (p: string) => existsSync(join(repoRoot, p));

describe("三层兜底都在", () => {
  it("**404 页**", () => {
    assert.ok(exists("src/app/not-found.tsx"), "没有全局 404 页，用户看到的是 Next 的英文默认页");
  });

  it("**页面出错的兜底**", () => {
    assert.ok(exists("src/app/error.tsx"));
  });

  it("**根布局自己出错的兜底** —— error.tsx 挂在它里面，它炸了那个跟着炸", () => {
    assert.ok(exists("src/app/global-error.tsx"));
  });
});

describe("**帖子找不到那一页不能泄露存在性**", () => {
  /*
   * 用 readCode（剥掉注释）而不是原文。
   *
   * 第一版拿原文查「有没有出现『已被删除』」，结果被**自己解释
   * 为什么不能这么写的那段注释**判红 —— 和 RAG 那边撞的是同一个坑：
   * 断言「界面上写了什么」时必须先去注释，否则解释得越清楚越容易测红。
   */
  const src = readCode("app/(app)/forum/p/[id]/not-found.tsx");

  it("**提到删除时必须是并列的可能性，不能是断言**", () => {
    /*
     * 第一版的规则是「文案里不许出现『删』字」—— 太粗了。
     *
     * 真正泄露的是**断言**：「这个帖子已被删除」告诉对方
     * 你手上这条链接曾经是真的。而「可能被删掉了，也可能只对特定成员
     * 开放」把两条路并列摆着，一条都没承认 —— 那反而是最好的写法，
     * 既诚实又不泄露。
     *
     * 所以规则改成：出现删除类措辞时，必须同时出现「可能」和另一条分支。
     */
    if (/删/.test(src)) {
      assert.match(src, /可能[^。]{0,12}删/, "把删除写成了断言，而不是一种可能");
      assert.match(src, /也可能/, "只给了「被删了」这一条路，等于承认它存在过");
    }
  });

  it("**不把「你看不了」单独说出来**", () => {
    // 「你没有权限」独立成句同样是在说「它存在」
    for (const leak of ["没有权限", "无权访问", "权限不足"]) {
      assert.equal(src.includes(leak), false, `文案里出现了「${leak}」`);
    }
  });

  it("**说的是两种都成立的那句话**", () => {
    assert.match(src, /不在这里/);
    // 而且明确告诉人「看不出是哪一种」是故意的 —— 否则会被当成 bug
    assert.match(src, /看不出是哪一种/);
  });

  it("**给了一条出路** —— 从微信点进来的人需要知道下一步", () => {
    assert.match(src, /href="\/forum"/);
    assert.match(src, /href="\/search"/);
  });
});

describe("404 页", () => {
  const src = readSource("app/not-found.tsx");

  it("**是中文的**", () => {
    assert.match(src, /这个地址没有东西/);
  });

  it("**只放所有人都能去的出口** —— 这一页可能出现在访客路径上", () => {
    /*
     * 在 404 上渲染一整套导航，等于把还没资格看到的入口摆出来。
     * 群聊、后台、我的都要判权限，所以一个都不放。
     */
    for (const gated of ['href="/admin', 'href="/me', 'href="/archive', 'href="/links']) {
      assert.equal(src.includes(gated), false, `404 页上出现了要权限的入口：${gated}`);
    }
    assert.match(src, /href="\/"/);
    assert.match(src, /href="\/forum"/);
  });

  it("**不放「返回上一页」** —— 来的人多半是从站外点进来的", () => {
    // 退回去等于把人送出这个网站
    const code = readCode("app/not-found.tsx");
    assert.equal(code.includes("history.back"), false);
    assert.equal(code.includes("router.back"), false);
  });
});

describe("出错兜底", () => {
  const code = readCode("app/error.tsx");
  const src = readSource("app/error.tsx");

  it("**有「再试一次」** —— 这类错误相当一部分是一次性的", () => {
    /*
     * reset() 只重新渲染这一段，不刷新整页。数据库刚好被写锁住、
     * 上游超时这类问题重试一下就过去了 ——
     * 这个按钮能让那一批人根本不必知道刚才出过事。
     */
    assert.match(code, /onClick=\{reset\}/);
    assert.match(src, /再试一次/);
  });

  it("**不把 error.message 显示出来** —— 里面可能带着表名和 SQL 片段", () => {
    /*
     * 对普通成员既看不懂也帮不上忙，对别有用心的人是一份免费情报。
     */
    assert.equal(code.includes("{error.message}"), false, "把异常信息渲染给用户了");
  });

  it("**显示 digest** —— 报错的人念出它就够查了", () => {
    assert.match(code, /error\.digest/);
  });

  it("**回首页用整页跳转** —— 出错的可能正是路由这一层", () => {
    assert.match(code, /<a\s+href="\/"/);
  });

  it("是客户端组件 —— reset 是回调，没有 'use client' 整层都挂不上", () => {
    assert.match(src, /^"use client";/);
  });
});

describe("根布局兜底", () => {
  const src = readSource("app/global-error.tsx");
  const code = readCode("app/global-error.tsx");

  it("**自带 html / body** —— 它替换的是整个文档", () => {
    assert.match(code, /<html lang="zh-CN">/);
    assert.match(code, /<body/);
  });

  it("**样式全部内联** —— globals.css 是根布局引进来的，而根布局正是坏掉的那个", () => {
    assert.equal(code.includes("className="), false, "用了 class，而此刻样式表多半没加载");
    assert.match(code, /style=\{\{/);
  });

  it("**也是中文的**", () => {
    assert.match(src, /站点没能加载/);
  });
});
