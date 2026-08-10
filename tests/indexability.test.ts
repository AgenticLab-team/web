import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

/**
 * 搜索引擎索引。
 *
 * ─────────────────────────────────────────
 * 这个站对爬虫说什么，之前是别人替它决定的
 * ─────────────────────────────────────────
 *
 * `/robots.txt` 线上返回 200 —— 看起来一切正常，
 * 但那是 **Cloudflare 塞进来的默认内容**，站里根本没有这个文件。
 * 同时**没有任何一页声明 robots meta**。
 *
 * 两件事叠在一起的后果很具体：**榜单上成员的微信昵称、头像
 * 和发言量是可被搜索引擎索引的**。一个人的名字被搜的时候，
 * 这些会一起出来 —— 而他当初只是加了个微信群。
 *
 * ─────────────────────────────────────────
 * 这一档测试盯的是「放行」，不是「拦截」
 * ─────────────────────────────────────────
 *
 * 索引这件事的错误方向是**单向**的：少收录一篇帖子，
 * 没人会因此受伤；多收录一篇，内容就到了公网上收不回来 ——
 * 搜索引擎的缓存不会因为站里删了就消失。
 *
 * 所以下面的断言几乎全部是「**不该出现的没有出现**」。
 */

const SITEMAP = readFileSync(new URL("../src/app/sitemap.ts", import.meta.url), "utf8");

/*
 * 必须在 import 任何用到 env 的模块**之前**设置。
 *
 * `SITE_URL` 特意设成一个真实形状的域名而不是留空：
 * 留空的话 env 会兜底成 `http://localhost:3000`，
 * 于是「地址不能是内网地址」这条断言在测试里恒为假 ——
 * 而它恰恰是短链那次踩过的坑（`request.url` 拿到的是 nginx
 * 转进来的内网地址，线上真的把访客送回了他自己的机器）。
 *
 * 设成 example.test 之后，这条断言测的就是**代码有没有读配置**，
 * 而不是这台机器碰巧配了什么。
 */
const TMP = mkdtempSync(join(tmpdir(), "al-sitemap-"));
process.env.DB_PATH = join(TMP, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";
process.env.SITE_URL = "https://example.test";

describe("robots.txt", async () => {
  const robotsMod = await import("@/app/robots");
  const { PROTECTED_PREFIXES } = await import("@/lib/auth/routes");

  const result = robotsMod.default();
  const rule = Array.isArray(result.rules) ? result.rules[0] : result.rules;
  const disallow = ([] as string[]).concat(rule.disallow ?? []);

  it("**每一条要登录的路径都在里面** —— 名单是生成的，不是抄的", () => {
    /*
     * 抄一份的话，那张名单变了这里不会变 ——
     * 而 robots.txt 少一条不会让任何东西报错，
     * 只会让搜索引擎把配额花在一堆登录跳转上。
     */
    for (const prefix of PROTECTED_PREFIXES) {
      assert.ok(
        disallow.includes(prefix) || disallow.includes(`${prefix}/`),
        `受保护的 ${prefix} 没写进 robots.txt`,
      );
    }
  });

  it("**真的是生成的** —— 源码里没有手抄的第二份名单", () => {
    /*
     * 上一条测试对「手抄且恰好抄全了」是绿的。
     * 这一条盯的是抄件本身：只要出现了 map(PROTECTED_PREFIXES)
     * 以外的字面量路径，它就会随时间和真名单分叉。
     */
    const src = readFileSync(new URL("../src/app/robots.ts", import.meta.url), "utf8");
    assert.match(src, /\.\.\.PROTECTED_PREFIXES,/);
    for (const prefix of PROTECTED_PREFIXES) {
      // 允许出现在注释里，但不该出现在 disallow 的字面量数组里
      assert.equal(
        new RegExp(`^\\s*"${prefix}/?",`, "m").test(src),
        false,
        `${prefix} 在 robots.ts 里被手抄了一遍`,
      );
    }
  });

  it("**榜单能看，但不收录**", () => {
    /*
     * 「未登录访客还是可以看见大榜单的」这条规矩不动 ——
     * 这里挡的不是访问，是检索。
     */
    assert.ok(disallow.includes("/leaderboard"));
  });

  it("接口不收录", () => {
    assert.ok(disallow.includes("/api/"));
  });

  it("**指向 sitemap** —— 否则新站几乎不会被爬到", () => {
    assert.match(String(result.sitemap), /^https?:\/\/.+\/sitemap\.xml$/);
  });

  it("**地址是配出来的，不能带 localhost**", () => {
    /*
     * robots.txt 和 sitemap 里的地址一旦是内网地址，
     * 爬虫拿到的整张地图都是废的 —— 短链那次就是这么错的。
     */
    const text = JSON.stringify(result);
    assert.equal(text.includes("localhost"), false, "robots 里出现了 localhost");
    assert.match(String(result.sitemap), /^https:\/\/example\.test\//);
  });

  it("**每条「能看但不收录」都写得出为什么**", () => {
    for (const entry of robotsMod.NOT_INDEXED_REASONS) {
      assert.ok(entry.why.length > 20, `${entry.path} 的理由太短，等于没写`);
    }
  });

  it("**首页和论坛没有被顺手挡掉**", () => {
    // 这里最容易犯的错是「宁可多挡」—— 那样整个站就搜不到了
    assert.equal(disallow.includes("/"), false);
    assert.equal(disallow.includes("/forum"), false);
  });

  it("**该被收录的路径没有被前缀误伤**", () => {
    /*
     * robots.txt 的匹配是**纯前缀**的，不是按路径段。
     * 也就是说 `/me` 会同时盖住 `/members`、`/menu`、
     * 任何以这三个字符开头的地址。
     *
     * 上一条只查了「有没有一模一样的一条」—— 那对
     * `Disallow: /` 之外的误伤全是绿的。这一条按真实语义算。
     */
    const blocked = (path: string) => disallow.some((d) => path.startsWith(d));
    for (const path of ["/", "/forum", "/forum/p/01ABC", "/join", "/forum/board/x"]) {
      assert.equal(blocked(path), false, `${path} 被某条 Disallow 前缀误伤了`);
    }
  });

  it("**同一条路径不发两遍** —— 前缀匹配下 `/me/` 是 `/me` 的冗余", () => {
    /*
     * 第一版同时发了 `/me` 和 `/me/`，产物里 12 条变成 24 条。
     * 功能上没错，但读的人会以为这里有什么讲究。
     *
     * 只查「带斜杠的那一份」，不查一般的前缀包含 ——
     * 后者会把 `/me` 盖住 `/members` 也算成冗余，而那两条
     * 是各自独立的路由：只是恰好撞了前缀。真按那个断言删掉
     * `/members`，将来 `/me` 一旦离开名单，`/members`
     * 就在没人察觉的情况下变成可爬的了。
     */
    for (const entry of disallow) {
      if (entry === "/api/") continue; // 目录形态，没有对应的裸前缀
      assert.equal(
        disallow.includes(entry.replace(/\/$/, "")) && entry.endsWith("/"),
        false,
        `「${entry}」和它的裸形态发了两遍`,
      );
    }
  });
});

describe("sitemap 只列真的公开的帖子", async () => {
  const dbm = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  const sitemap = (await import("@/app/sitemap")).default;
  const { eq } = await import("drizzle-orm");

  after(() => rmSync(TMP, { recursive: true, force: true }));

  let seq = 0;
  function post(over: Partial<typeof schema.posts.$inferInsert> = {}) {
    const id = `p${++seq}`;
    dbm.db
      .insert(schema.posts)
      .values({
        id,
        boardId: "b1",
        authorId: "u1",
        title: "标题",
        content: "正文",
        contentHtml: "<p>正文</p>",
        visibility: "public",
        status: "published",
        ...over,
      })
      .run();
    return id;
  }

  const urls = () => sitemap().map((e) => e.url);
  const listed = (id: string) => urls().some((u) => u.endsWith(`/forum/p/${id}`));

  it("公开且已发布的帖子在里面", () => {
    assert.equal(listed(post()), true);
  });

  it("**unlisted 不在** —— 这一档的字面意思就是不要被收录", () => {
    assert.equal(listed(post({ visibility: "unlisted" })), false);
  });

  for (const visibility of ["member", "role", "group", "private"] as const) {
    it(`**${visibility} 不在**`, () => {
      assert.equal(listed(post({ visibility })), false);
    });
  }

  for (const status of ["draft", "hidden", "deleted", "locked"] as const) {
    it(`**${status} 不在**`, () => {
      assert.equal(listed(post({ status })), false);
    });
  }

  it("**软删除的不在** —— 状态没改但 deleted_at 有值", () => {
    assert.equal(listed(post({ deletedAt: Date.now() })), false);
  });

  it("**群聊转帖不在，哪怕可见性被写成了 public**", () => {
    /*
     * 这是最要紧的一条。群聊内容进论坛是受硬约束管的：
     * 原作者同意的是「给社区看」，不是「挂到谷歌上」。
     *
     * 库里这把锁叫 visibility_locked，全站都用它表示「来自群聊」。
     * 只要它还锁着，就说明还没走完审核 + 原作者同意那一步。
     */
    assert.equal(listed(post({ visibilityLocked: true })), false);
  });

  it("**同意提升之后才进来** —— 锁解开了才算原作者点过头", () => {
    const id = post({ visibilityLocked: true });
    assert.equal(listed(id), false);
    dbm.db
      .update(schema.posts)
      .set({ visibilityLocked: false })
      .where(eq(schema.posts.id, id))
      .run();
    assert.equal(listed(id), true);
  });

  it("**判定只有一处实现** —— 这里逐行过 isIndexable，不自己判", () => {
    /*
     * 自己再判一遍的话，两处迟早分叉。而分叉的方向如果是这边更松，
     * 就是把私密内容送进了搜索引擎 —— 那种错误没有任何测试会自己
     * 报出来，是别人搜到了才发现的。
     */
    assert.match(SITEMAP, /isIndexable\(\{/);
    assert.match(SITEMAP, /if \([\s\S]{0,10}!isIndexable/);
  });

  it("首页和论坛入口在里面", () => {
    const all = urls();
    assert.ok(all.some((u) => u.endsWith("/")));
    assert.ok(all.some((u) => u.endsWith("/forum")));
  });

  it("**地址来自配置** —— 内网地址会让整张地图作废", () => {
    assert.equal(urls().some((u) => u.includes("localhost")), false);
    assert.ok(urls().every((u) => u.startsWith("https://example.test/")));
  });

  it("**有上限** —— 爬虫会反复来，不能每次都把整张表读进内存", () => {
    assert.match(SITEMAP, /\.limit\(\d+\)/);
  });

  it("**不会被烤进构建产物** —— 否则新帖要等下次部署才进地图", () => {
    /*
     * sitemap 是一个「默认被缓存」的特殊 Route Handler：
     * 它不碰请求期 API，Next 就会在构建时跑一遍、把结果存下来。
     *
     * 这种错没有任何征兆 —— 地图一直在、格式一直对、测试一直绿，
     * 只是内容停在了上一次构建那一刻。所以只能盯着这个声明。
     */
    assert.match(SITEMAP, /export const revalidate = \d+;/);
  });
});

describe("**隐私页上的承诺必须是真的**", async () => {
  /*
   * 隐私页现在白纸黑字写着「榜单不会被搜索引擎收录」。
   *
   * 那是一句**承诺**，而它成立与否完全取决于 robots.ts 里那张表。
   * 有人哪天顺手删掉一条，页面上的话就变成了假话 ——
   * 而这个站最不能出的错，就是让人照着一个不存在的保护去说话
   * （隐私页自己的开篇就是这么写的）。
   *
   * 所以承诺和实现绑在一起测：页面说不收录的，
   * robots 里必须真的挡着。
   */
  const robotsMod = await import("@/app/robots");
  const result = robotsMod.default();
  const rule = Array.isArray(result.rules) ? result.rules[0] : result.rules;
  const disallow = ([] as string[]).concat(rule.disallow ?? []);
  const blocked = (path: string) => disallow.some((d) => path.startsWith(d));

  const PAGE = readFileSync(
    new URL("../src/app/(app)/me/privacy/page.tsx", import.meta.url),
    "utf8",
  );

  it("承诺还在页面上", () => {
    assert.match(PAGE, /榜单不会被搜索引擎收录/);
  });

  it("**页面说不收录的，robots 里真的挡着**", () => {
    for (const path of ["/leaderboard", "/archive", "/members", "/me"]) {
      assert.equal(blocked(path), true, `隐私页承诺了 ${path} 不收录，robots 里却没挡`);
    }
  });

  it("**页面说会被收录的，robots 里真的没挡** —— 反过来也不能说假话", () => {
    assert.equal(blocked("/forum/p/01ABC"), false);
  });
});

describe("页面上的 robots meta", () => {
  it("**榜单声明 noindex** —— robots.txt 只是君子协定", () => {
    /*
     * robots.txt 挡的是守规矩的爬虫；不守规矩的照样抓页面。
     * meta 是给已经抓到页面的那些看的最后一道。
     *
     * 两处都要有，缺一个都不够。
     */
    const page = readFileSync(
      new URL("../src/app/(app)/leaderboard/page.tsx", import.meta.url),
      "utf8",
    );
    assert.match(page, /robots:\s*\{[^}]*index:\s*false/);
  });

  it("**follow 保留** —— 不收录这一页，不代表要切断它连出去的链接", () => {
    const page = readFileSync(
      new URL("../src/app/(app)/leaderboard/page.tsx", import.meta.url),
      "utf8",
    );
    assert.match(page, /robots:\s*\{[^}]*follow:\s*true/);
  });
});
