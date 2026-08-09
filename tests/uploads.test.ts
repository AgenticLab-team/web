import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { isAllowedImageSource } from "@/lib/image-sources";
import {
  ALLOWED_TYPES,
  MAX_FILE_BYTES,
  SINGLE_SHOT_LIMIT,
  checkUpload,
  explainUpstream,
  kindOf,
  markdownFor,
  needsChunking,
  partCount,
  partRange,
  pickUrl,
} from "@/lib/uploads/rules";
import { stripComments as strip } from "./_source";

/**
 * 图床。
 *
 * ─────────────────────────────────────────
 * 这个站到今天为止没有任何上传
 * ─────────────────────────────────────────
 *
 * `img` 早就是放行标签，但没有任何地方能产生一张图 ——
 * 想发图只能自己去别处传好再把链接粘进来。而那正是问题：
 * 那些 `src` 指向的是**别人的服务器**，每个读者打开帖子都会去请求一次。
 * 一张 1×1 的透明图就够把「谁在什么时候读了这篇」连同 IP 送出去。
 *
 * 所以图床和「收口 img 的来源」是同一件事的两半。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

describe("**SVG 不算图片**", () => {
  it("SVG 一律拒绝 —— 它是 image/*，但里面能写脚本", () => {
    /*
     * 一张能执行脚本的「图片」挂在自己域名下就是储存型 XSS。
     * 上游存不存是它的事，我们不产生这样的链接。
     */
    assert.equal(kindOf("image/svg+xml"), null);
    assert.equal(checkUpload({ mime: "image/svg+xml", size: 100 }).ok, false);
  });

  it("用的是白名单而不是 startsWith(\"image/\")", () => {
    // 前者才挡得住 svg，也挡得住以后冒出来的新格式
    assert.equal(kindOf("image/anything-new"), null);
    assert.match(strip(src("lib/uploads/rules.ts")), /ALLOWED_TYPES/);
  });

  it("常见格式都认得", () => {
    for (const mime of ALLOWED_TYPES) assert.notEqual(kindOf(mime), null, mime);
  });

  it("视频和图片分得开 —— 它们插进正文的写法不一样", () => {
    assert.equal(kindOf("image/png"), "image");
    assert.equal(kindOf("video/mp4"), "video");
  });
});

describe("传之前先在本地判一遍", () => {
  it("空文件挡掉", () => {
    assert.equal(checkUpload({ mime: "image/png", size: 0 }).ok, false);
  });

  it("超过上游硬上限的挡掉 —— 分片也救不了", () => {
    const r = checkUpload({ mime: "image/png", size: MAX_FILE_BYTES + 1 });
    assert.equal(r.ok, false);
    // 错误里要带上具体多大，不然人不知道该压到多少
    assert.match(r.ok === false ? r.error : "", /MB/);
  });

  it("正常的通过", () => {
    assert.deepEqual(checkUpload({ mime: "image/jpeg", size: 2_000_000 }), {
      ok: true,
      kind: "image",
    });
  });

  it("**不认识的类型也要说出来是什么** —— 「不支持」三个字没法排查", () => {
    const r = checkUpload({ mime: "application/zip", size: 10 });
    assert.match(r.ok === false ? r.error : "", /application\/zip/);
  });
});

describe("**分片的边界**", () => {
  /*
   * 差一位在这里不会报错：传出去的文件只是少了或多了几个字节，
   * 上游照收，拿到的链接打开是一张坏图 ——
   * 而那时候没有人会怀疑分片算错了。
   */
  it("片数向上取整", () => {
    assert.equal(partCount(100, 30), 4);
    assert.equal(partCount(90, 30), 3);
    assert.equal(partCount(1, 30), 1);
  });

  it("最后一片短，且刚好收在文件末尾", () => {
    assert.deepEqual(partRange(3, 30, 100), [90, 100]);
  });

  it("**每一片首尾相接，不重不漏**", () => {
    for (const [total, size] of [
      [100, 30],
      [1024, 256],
      [1, 1],
      [50 * 1024 * 1024, 5 * 1024 * 1024],
    ] as const) {
      let cursor = 0;
      for (let i = 0; i < partCount(total, size); i++) {
        const [start, end] = partRange(i, size, total);
        assert.equal(start, cursor, `第 ${i} 片的起点接不上`);
        assert.ok(end > start, `第 ${i} 片是空的`);
        cursor = end;
      }
      assert.equal(cursor, total, `${total}/${size} 加起来不等于原文件`);
    }
  });

  it("16MB 以内不分片，超过就分", () => {
    assert.equal(needsChunking(SINGLE_SHOT_LIMIT), false);
    assert.equal(needsChunking(SINGLE_SHOT_LIMIT + 1), true);
  });

  it("**留了余量，不卡着上游那个 18MB**", () => {
    // multipart 的边界和头部本身也占字节，卡着传会偶发失败 ——
    // 而偶发失败比稳定失败难查得多
    assert.ok(SINGLE_SHOT_LIMIT < 18 * 1024 * 1024);
  });
});

describe("上游给回来的链接", () => {
  it("按接口说明用 url，不用 cdn_url", () => {
    /*
     * 自作主张换成 CDN 的话，CDN 出问题那天所有历史帖子里的图
     * 会一起坏掉 —— 而链接已经写进正文了，改不回来。
     */
    const picked = pickUrl({ url: "https://a/1.png", origin_url: "https://b/1.png" });
    assert.equal(picked, "https://a/1.png");
    assert.equal(strip(src("lib/uploads/client.ts")).includes("cdn_url"), false);
  });

  it("url 没有时退回 origin_url", () => {
    assert.equal(pickUrl({ origin_url: "https://b/1.png" }), "https://b/1.png");
  });

  it("**非 https 一律不要** —— http 会在页面上引出混合内容警告", () => {
    assert.equal(pickUrl({ url: "http://a/1.png" }), null);
    assert.equal(pickUrl({ url: "/relative.png" }), null);
    assert.equal(pickUrl({}), null);
  });
});

describe("错误要说下一步该做什么", () => {
  for (const [status, expect] of [
    [429, /等|限速/],
    [502, /再试/],
    [415, /格式/],
    [413, /大/],
  ] as const) {
    it(`${status} 有人话`, () => assert.match(explainUpstream(status), expect));
  }

  it("401 要说清楚这是站点的问题不是用户的", () => {
    assert.match(explainUpstream(401), /配置|不是你/);
  });
});

describe("插进正文的那段 markdown", () => {
  it("图片用 ![]()", () => {
    assert.equal(markdownFor("image", "https://h/a.png", "猫.png"), "![猫.png](https://h/a.png)");
  });

  it("**视频用普通链接** —— `<img src=\"x.mp4\">` 是个破图标", () => {
    assert.equal(markdownFor("video", "https://h/a.mp4", "片段.mp4"), "[片段.mp4](https://h/a.mp4)");
  });

  it("文件名里的方括号要清掉，否则会把 markdown 断开", () => {
    assert.equal(markdownFor("image", "https://h/a.png", "a[1](2).png"), "![a12.png](https://h/a.png)");
  });

  it("文件名是空的也要有 alt —— 读屏软件只念一句「图像」等于没说", () => {
    assert.match(markdownFor("image", "https://h/a.png", ""), /!\[图片\]/);
  });
});

describe("**图片来源白名单**", () => {
  it("自己的图床放行", () => {
    assert.equal(isAllowedImageSource("https://files.mrusercontent.com/a/b.png"), true);
  });

  it("头像那几个域名放行 —— 不放行的话头像会变裂图", () => {
    assert.equal(isAllowedImageSource("https://wx.qlogo.cn/x/y/0"), true);
  });

  it("**别人的服务器不放行** —— 那是一个追踪像素", () => {
    assert.equal(isAllowedImageSource("https://tracker.example.com/1x1.gif"), false);
  });

  it("**后缀骗不过去**", () => {
    // endsWith 式的判断会被这个骗过
    assert.equal(isAllowedImageSource("https://files.mrusercontent.com.evil.net/x.png"), false);
    assert.equal(isAllowedImageSource("https://evil-files.mrusercontent.com/x.png"), false);
  });

  it("http 不放行", () => {
    assert.equal(isAllowedImageSource("http://files.mrusercontent.com/a.png"), false);
  });

  it("站内相对路径放行", () => {
    assert.equal(isAllowedImageSource("/icons/logo.png"), true);
  });

  it("**`//example.com` 不是相对路径** —— 它以 / 开头，但会去请求别人的服务器", () => {
    assert.equal(isAllowedImageSource("//tracker.example.com/1.gif"), false);
  });

  it("data: 不放行 —— 一张几百 KB 的 base64 会整个存进正文", () => {
    assert.equal(isAllowedImageSource("data:image/png;base64,iVBORw0KGgo="), false);
  });

  it("乱七八糟的字符串不放行", () => {
    for (const bad of ["", "javascript:alert(1)", "not a url", "https://"]) {
      assert.equal(isAllowedImageSource(bad), false, bad);
    }
  });
});

describe("接线", () => {
  it("规则层是纯的", () => {
    for (const file of ["lib/uploads/rules.ts", "lib/image-sources.ts"]) {
      const body = src(file);
      for (const forbidden of ["server-only", "@/lib/db", "drizzle-orm"]) {
        assert.equal(body.includes(forbidden), false, `${file} 引了 ${forbidden}`);
      }
    }
  });

  it("**上传要登录，而且取的是真身**", () => {
    /*
     * getCurrentUser() 在预览态下返回被预览的那个人 ——
     * 管理员预览时传的图会记在别人名下。
     * 这个坑这个项目已经踩到过三次。
     */
    const route = strip(src("app/api/uploads/route.ts"));
    assert.match(route, /getRealUser\(\)/);
    assert.equal(route.includes("getCurrentUser"), false);
  });

  it("超配额回 429 并带 Retry-After", () => {
    const route = strip(src("app/api/uploads/route.ts"));
    assert.match(route, /status: 429/);
    assert.match(route, /"Retry-After"/);
  });

  it("**每次上传都记一行** —— 那条链接会被转发出去，而它不带身份信息", () => {
    assert.match(strip(src("app/api/uploads/route.ts")), /recordUpload\(/);
  });

  it("**不落盘** —— 服务器只有 3.7G 内存", () => {
    const client = strip(src("lib/uploads/client.ts"));
    for (const forbidden of ["writeFile", "createWriteStream", "arrayBuffer()"]) {
      assert.equal(client.includes(forbidden), false, `客户端用了 ${forbidden}`);
    }
  });

  it("**上游请求必须有超时** —— 卡住的上传会把并发占满，表现成「网站突然很卡」", () => {
    assert.match(strip(src("lib/uploads/client.ts")), /AbortSignal\.timeout/);
  });

  it("没配 key 时不伪造认证头 —— 上游明确要求", () => {
    const client = strip(src("lib/uploads/client.ts"));
    assert.match(client, /env\.uploads\.apiKey \?/);
  });

  it("站外图片降级成链接，不是删掉", () => {
    // 删掉会让人以为帖子坏了，链接把「要不要访问那台服务器」还给读者
    const md = strip(src("lib/markdown.ts"));
    assert.match(md, /isAllowedImageSource\(src\)/);
    assert.match(md, /createElement\("a"\)/);
  });

  it("降级出来的链接也要带 noopener / nofollow", () => {
    assert.match(strip(src("lib/markdown.ts")), /noopener noreferrer nofollow ugc/);
  });

  it("**粘贴里没有文件时不许拦下这次粘贴** —— 那会让粘贴文字失效", () => {
    const editor = strip(src("components/forum/Editor.tsx"));
    assert.match(editor, /if \(files\.length === 0\) return;[\s\S]{0,80}preventDefault/);
  });

  it("**dragover 必须 preventDefault** —— 否则浏览器会用这个文件替换整个页面", () => {
    // 那样一篇没保存的正文就没了
    assert.match(strip(src("components/forum/Editor.tsx")), /onDragOver[\s\S]{0,400}preventDefault/);
  });

  it("失败时把占位删掉，不留在正文里", () => {
    // 留着的话人会把 `![上传中 …]()` 发出去，在帖子里渲染成破图标
    assert.match(strip(src("components/forum/use-upload.ts")), /replaceToken\(token, ""\)/);
  });

  it("**替换占位按文本找，不按下标**", () => {
    /*
     * 等待的几秒里人可能又敲了几十个字，当初记下的下标
     * 早就指向别的地方了 —— 按下标替换会把一句话从中间劈开。
     */
    const hook = strip(src("components/forum/use-upload.ts"));
    assert.match(hook, /current\.replace\(token/);
    assert.match(hook, /includes\(token\)/);
  });
});

/* ───────────────────────────────────────────────────────────────
 * 真数据库：配额
 * ─────────────────────────────────────────────────────────────── */

const tmp = mkdtempSync(join(tmpdir(), "al-uploads-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

let dbm: typeof import("@/lib/db");
let schema: typeof import("@/lib/db/schema");
let q: typeof import("@/lib/uploads/queries");

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  q = await import("@/lib/uploads/queries");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  dbm.db.delete(schema.uploads).run();
});

const NOW = 1_786_000_000_000;

const put = (userId: string, at: number, url = `https://files.mrusercontent.com/${at}.png`) =>
  dbm.db
    .insert(schema.uploads)
    .values({
      userId,
      url,
      kind: "image",
      mime: "image/png",
      bytes: 10,
      createdAt: at,
    })
    .run();

describe("配额（真库）", () => {
  it("没传过的人当然可以传", () => {
    const v = q.checkQuota("u_a", NOW);
    assert.equal(v.allowed, true);
    assert.equal(v.remaining, q.USER_QUOTA);
  });

  it("**按人算，不是全站一条队列**", () => {
    /*
     * 上游是按 IP 限的，而我们从服务器代传 —— 全站共用一个出口 IP。
     * 不在自己这一侧按人限住的话，一个人连传满就能让所有人
     * 在接下来十分钟里一张都发不出去。
     */
    for (let i = 0; i < q.USER_QUOTA; i++) put("u_a", NOW - 1000 * i);
    assert.equal(q.checkQuota("u_a", NOW).allowed, false);
    assert.equal(q.checkQuota("u_b", NOW).allowed, true, "别人被连坐了");
  });

  it("窗口之外的不算数", () => {
    for (let i = 0; i < q.USER_QUOTA; i++) put("u_a", NOW - q.USER_WINDOW_MS - 1000);
    assert.equal(q.checkQuota("u_a", NOW).allowed, true);
  });

  it("**「还要等多久」从最早那一次算起，不是从现在算十分钟**", () => {
    /*
     * 差别不小：一个刚好撞上限的人，实际可能再等十几秒就行了。
     * 告诉他「等十分钟」会让他直接放弃。
     */
    const oldest = NOW - q.USER_WINDOW_MS + 30_000; // 还有 30 秒到期
    put("u_a", oldest);
    for (let i = 1; i < q.USER_QUOTA; i++) put("u_a", NOW - 1000);

    const v = q.checkQuota("u_a", NOW);
    assert.equal(v.allowed, false);
    assert.ok(v.retryAfterSeconds <= 31, `说要等 ${v.retryAfterSeconds} 秒，实际只要 30`);
    assert.ok(v.retryAfterSeconds >= 1);
  });

  it("剩余次数是真的在减", () => {
    put("u_a", NOW - 1000);
    assert.equal(q.checkQuota("u_a", NOW).remaining, q.USER_QUOTA - 1);
  });

  it("**查得出一条链接是谁传的** —— 转帖的人和上传的人往往不是同一个", () => {
    put("u_a", NOW - 5000, "https://files.mrusercontent.com/x.png");
    assert.equal(q.uploaderOf("https://files.mrusercontent.com/x.png")?.userId, "u_a");
    assert.equal(q.uploaderOf("https://files.mrusercontent.com/nope.png"), undefined);
  });

  it("我最近传的按时间倒序", () => {
    put("u_a", NOW - 3000, "https://files.mrusercontent.com/old.png");
    put("u_a", NOW - 1000, "https://files.mrusercontent.com/new.png");
    assert.equal(q.myRecentUploads("u_a")[0].url, "https://files.mrusercontent.com/new.png");
  });
});
