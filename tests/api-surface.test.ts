import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { ENDPOINTS } from "@/lib/api-tokens/catalog";
import { SCOPE_KEYS } from "@/lib/api-tokens/rules";
import { readCode } from "./_source";

/**
 * 开放 API 的面。
 *
 * ═════════════════════════════════════════
 * 这份测试真正在守的是「别写第二份实现」
 * ═════════════════════════════════════════
 *
 * 发帖、回帖、读消息在网页上都已经有一整套规则：版块权限、等级门槛、
 * 匿名判定、必填标签、敏感词、频率限制、可见性收口、隐私开关。
 *
 * API 那条路上另写一份「简化版」是这里唯一真正危险的做法 ——
 * 两份规则迟早分叉，而**分叉的方向永远是 API 那份更宽松**：
 * 写的人当时想的是「先跑通」，而不是「把十条规则一条条抄过来」。
 */

const routeDir = new URL("../src/app/api/v1/", import.meta.url).pathname;

function routeFiles(dir = routeDir): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}${e.name}${e.isDirectory() ? "/" : ""}`;
    if (e.isDirectory()) out.push(...routeFiles(full));
    else if (e.name === "route.ts") out.push(full);
  }
  return out;
}

describe("**每个端点都先鉴权**", () => {
  for (const file of routeFiles()) {
    const short = file.slice(file.indexOf("/api/v1/"));
    it(short, () => {
      const body = readFileSync(file, "utf8");
      assert.match(body, /await authenticate\(request,/, "没有过 authenticate");
      /*
       * 而且必须**先**鉴权再干活 —— 反过来的话，未授权的请求
       * 也会触发一次查询甚至一次写入。
       */
      const authAt = body.indexOf("await authenticate(request,");
      const firstWork = Math.min(
        ...[body.indexOf("await request.json()"), body.indexOf("new URL(request.url)")].filter(
          (i) => i > 0,
        ),
        Number.MAX_SAFE_INTEGER,
      );
      if (firstWork < Number.MAX_SAFE_INTEGER) {
        assert.ok(authAt < firstWork, "先干活后鉴权了");
      }
    });
  }
});

describe("**写操作不许另写一份规则**", () => {
  it("发帖调 createPostAs，不是自己插库", () => {
    const body = readCode("app/api/v1/posts/route.ts");
    assert.match(body, /createPostAs\(auth\.caller\.user,/);
    assert.equal(body.includes("db.insert(posts)"), false, "API 自己插帖子了");
  });

  it("回帖调 createReplyAs", () => {
    const body = readCode("app/api/v1/posts/[id]/replies/route.ts");
    assert.match(body, /createReplyAs\(auth\.caller\.user,/);
    assert.equal(body.includes("db.insert(replies)"), false, "API 自己插回复了");
  });

  it("**发群消息只有 sendToGroup 一条路**", () => {
    const body = readCode("app/api/v1/groups/[convId]/messages/route.ts");
    assert.match(body, /sendToGroup\(/);
    // 直接调上游就绕过了授权、限流、署名和留痕
    assert.equal(body.includes("nekobot.sendText"), false, "API 直接调上游了");
  });

  it("**读消息走 searchMessages** —— 隐私开关和可见性都在里面", () => {
    const body = readCode("app/api/v1/groups/[convId]/messages/route.ts");
    assert.match(body, /searchMessages\(/);
    assert.equal(body.includes("sqlite.prepare"), false, "API 自己写了一条 SQL");
  });

  it("**读帖子走 getPost / listPosts**", () => {
    assert.match(readCode("app/api/v1/posts/[id]/route.ts"), /getPost\(viewer,/);
    assert.match(readCode("app/api/v1/posts/route.ts"), /listPosts\(/);
  });
});

describe("**真正的实现不能待在 `\"use server\"` 文件里**", () => {
  it("write.ts 不是动作文件", () => {
    /*
     * `"use server"` 文件里导出的每个 async 函数都是客户端可直接调用的
     * 服务端动作，参数完全由客户端给。把一个收 `user` 参数的函数放进去，
     * 等于开一个「以任意人的身份发帖」的接口。
     */
    /*
     * 读**剥掉注释**的版本 —— 解释这条规矩的注释里必然写着
     * `"use server"` 这几个字，按原文搜的话第一个红的是它自己。
     * （这个仓库这一节里已经踩到第三次了。）
     */
    const body = readCode("lib/forum/write.ts");
    assert.equal(body.includes('"use server"'), false, "write.ts 变成动作文件了");
    assert.match(body, /import "server-only"/);
  });

  it("actions.ts 里那两个只是取会话的薄壳", () => {
    const body = readCode("lib/forum/actions.ts");
    assert.match(body, /return createPostAs\(user, input\)/);
    assert.match(body, /return createReplyAs\(user, input\)/);
  });
});

describe("文档和实现对得上", () => {
  it("**目录里每个 scope 都是真的存在的**", () => {
    for (const e of ENDPOINTS) {
      for (const s of e.scopes) {
        assert.ok(SCOPE_KEYS.includes(s), `${e.path} 要一个不存在的 scope：${s}`);
      }
    }
  });

  it("**目录里每个路径都真的有一个路由文件**", () => {
    /*
     * 文档写了但没实现，是比没写更坏的一种：
     * 人照着调，拿回 404，然后怀疑是自己写错了。
     */
    const files = routeFiles().map((f) => f.slice(f.indexOf("/api/v1/")));
    for (const e of ENDPOINTS) {
      const expected =
        e.path.replace("/api/v1/", "").replace(/\{conv_id\}/g, "[convId]").replace(/\{id\}/g, "[id]") +
        "/route.ts";
      assert.ok(
        files.some((f) => f === `/api/v1/${expected}`),
        `${e.path} 在文档里，但找不到 ${expected}`,
      );
    }
  });

  it("**每个路由文件也都在文档里** —— 藏着的端点没有人能审", () => {
    for (const file of routeFiles()) {
      const short = file
        .slice(file.indexOf("/api/v1/"))
        .replace("/route.ts", "")
        .replace(/\[convId\]/g, "{conv_id}")
        .replace(/\[id\]/g, "{id}");
      assert.ok(
        ENDPOINTS.some((e) => e.path === short),
        `${short} 有实现但没进文档`,
      );
    }
  });
});
