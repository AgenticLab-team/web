import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { ENDPOINTS, NOT_POSSIBLE } from "@/lib/api-tokens/catalog";
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

describe("在线测试真的能填参数", () => {
  const console_ = readCode("components/api/ApiConsole.tsx");

  it("**路径里有几个占位符就给几个框**", () => {
    /*
     * 第一版只认得 `{conv_id}` 一种，于是 `/posts/{id}/replies`
     * 发出去的 URL 里原样带着 `{id}` 这五个字符 —— 服务端拿到的
     * 帖子 id 就叫「{id}」，回一句 404，而人看不出哪里错了：
     * 他填了令牌、选了端点、写了请求体，三样都对。
     */
    assert.match(console_, /matchAll\(\/\\\{\(\\w\+\)\\\}\/g\)/);
    assert.equal(/\{conv_id\}/.test(console_), false, "不该再有写死的 conv_id");
  });

  it("**每条 POST 都带一份能直接按下去的请求体**", () => {
    /*
     * 原来所有 POST 共用 `{"text":"…"}` —— 对发消息是对的，
     * 对发帖是错的（要 board / title / content），点下去拿到 400，
     * 而人多半会以为是令牌的问题。
     */
    for (const e of ENDPOINTS.filter((x) => x.method === "POST")) {
      assert.ok(e.sampleBody, `${e.path} 缺 sampleBody`);
    }
  });

  it("端点用「方法+路径」认，不是只用路径", () => {
    /*
     * 同一个路径上 GET 和 POST 是两条端点（读群公告 / 改群公告）。
     * 只按路径找会永远选中头一条 —— 于是选「改群公告」发出去的是 GET。
     */
    const paths = ENDPOINTS.map((e) => e.path);
    assert.ok(new Set(paths).size < paths.length, "现在没有同路径不同方法的端点了？那这条可以删");
    assert.match(console_, /\$\{e\.method\}\s+\$\{e\.path\}/);
  });

  it("参数没填齐就不让发", () => {
    // 发出去只会拿到一句看不懂的 404
    assert.match(console_, /missing\.length\s*>\s*0/);
  });
});

describe("群列表这条路", () => {
  it("**存在一条能拿到 conv_id 的接口**", () => {
    /*
     * 别的群接口全都要 conv_id，而在这条之前没有任何办法拿到它 ——
     * 文档里写着一个示例值，谁也不知道自己的是什么。
     */
    const list = ENDPOINTS.find((e) => e.path === "/api/v1/groups" && e.method === "GET");
    assert.ok(list, "没有列群的接口，那 conv_id 从哪来？");
  });

  it("它只给自己在的群 —— 群列表属于隐私", () => {
    const route = readCode("app/api/v1/groups/route.ts");
    assert.match(route, /visibleGroupsFor\(/);
    // 不能是「列出所有群再过滤」
    assert.equal(/listGroupsForAdmin|allGroups/.test(route), false);
  });
});

describe("群公告", () => {
  it("**它不在「做不到的」那一栏里了**", () => {
    /*
     * 上游后来加了读写公告的接口。一份说「做不到」而其实做得到的文档
     * 比没有文档更糟：它让人根本不去试。
     */
    assert.equal(
      NOT_POSSIBLE.some((n) => n.what.includes("群公告")),
      false,
      "上游已经能改公告了，这一栏得改",
    );
    assert.ok(ENDPOINTS.some((e) => e.path.endsWith("/announcement") && e.method === "POST"));
  });

  it("改公告和发消息共用同一套：授权、限流、署名", () => {
    /*
     * 另写一份的话，迟早有一份忘了加署名 ——
     * 而公告是一千六百人打开群就看见的那段字。
     */
    const a = readCode("lib/api-tokens/announce.ts");
    assert.match(a, /sendGrantFor\(/);
    assert.match(a, /sendAllowance\(/);
    assert.match(a, /withAttribution\(/);
    assert.match(a, /recordSend\(/);
  });

  it("**被覆盖掉的原公告要记下来** —— 微信里没有历史版本", () => {
    const a = readCode("lib/api-tokens/announce.ts");
    assert.match(a, /previous/);
    assert.match(a, /被覆盖的原公告/);
  });

  it("空字符串不算「清空」—— 更可能是没填的表单", () => {
    const a = readCode("lib/api-tokens/announce.ts");
    assert.match(a, /公告不能为空/);
  });
});

describe("逐群授权的表单", () => {
  const grant = readCode("components/api/GrantManager.tsx");
  const actions = readCode("lib/api-tokens/actions.ts");

  it("**能一次给多个群** —— 原来一次只能给一个，「给他所有群」要点十二遍", () => {
    assert.match(grant, /grantSendManyAction/);
    assert.match(actions, /export async function grantSendManyAction/);
  });

  it("**「全选」存的是逐群的具体行，不是一条通配**", () => {
    /*
     * 通配会让授权自己长大：三个月后多一个群，它会被一起给出去，
     * 而那件事没有人做过决定、审计日志里也没有对应的一行。
     */
    const fn = actions.slice(actions.indexOf("grantSendManyAction"));
    assert.match(fn.slice(0, 1600), /for \(const convId of convIds\)/);
    assert.equal(/wildcard|"\*"|ALL_GROUPS/.test(fn.slice(0, 1600)), false);
  });

  it("**一个群一条审计** —— 收回是逐群的，审计也必须逐群", () => {
    /*
     * 一条写着「批量授权 12 个群」的记录，答不出
     * 「这个群他是什么时候拿到权限的」。
     */
    const fn = actions.slice(actions.indexOf("grantSendManyAction"));
    const loop = fn.slice(fn.indexOf("for (const convId of convIds)"), fn.indexOf("revalidatePath"));
    assert.match(loop, /audit\(/);
    assert.match(loop, /group\.send_grant/);
  });

  it("界面上说清楚全选不含以后新加的群", () => {
    // 不写的话，站长会合理地以为「全选」包含以后的群
    assert.match(grant, /以后新加的群/);
  });

  it("选人有搜索框 —— 一百多个人下拉框里翻不动", () => {
    assert.match(grant, /personQuery/);
  });

  it("**筛完之后提交的是屏幕上那个人**", () => {
    /*
     * 这是这个表单唯一可能把权限给错人的地方：筛选会改变列表，
     * 而选中的 id 可能已经不在结果里 —— 那时候屏幕上写着 A，
     * 提交的却是 B。所以有 effectiveId，而且提交用的就是它。
     */
    assert.match(grant, /effectiveId/);
    assert.match(grant, /userId:\s*effectiveId/);
    assert.equal(
      /userId:\s*userId\.trim\(\)/.test(grant),
      false,
      "提交的应该是 effectiveId，不是那个可能已经被筛掉的 userId",
    );
  });

  it("一个群都没选就不让提交", () => {
    assert.match(grant, /picked\.size === 0/);
    assert.match(actions, /至少选一个群/);
  });

  it("去重 —— 这个函数客户端可以直接调，重复会记出两条一样的审计", () => {
    assert.match(actions, /new Set\(input\.convIds/);
  });
});
