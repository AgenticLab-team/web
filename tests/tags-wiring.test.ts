import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { MAX_TAGS_PER_POST, MAX_TAG_LENGTH, cleanTags, slugify } from "@/lib/forum/tag-rules";
import { stripComments as strip, forumWritePath } from "./_source";

/**
 * 标签体系接线。
 *
 * ─────────────────────────────────────────
 * 服务端全都写好了，而前台没有入口
 * ─────────────────────────────────────────
 *
 * `setPostTags` / `listTags` / `tagsOfPosts` / `postIdsWithTag` / `slugify`
 * 全都在，`boards.require_tags` 也在 —— 而**发帖框里一个标签控件都没有**，
 * 帖子上不显示标签，`postIdsWithTag` 零调用点，
 * `/forum/search?tag=` 这个参数被静默丢弃。
 *
 * 生产库里 51 篇帖子、**0 个标签** —— 不是没人想打标签，是打不了。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

describe("归一化", () => {
  it("**大小写和空格不该造出三个标签**", () => {
    // 不然一年后标签墙上全是同义词，筛选功能等于废了
    assert.equal(slugify("RAG"), "rag");
    assert.equal(slugify("Rag"), "rag");
    assert.equal(slugify("rag"), "rag");
  });

  it("中文照常 —— 这是个中文社区", () => {
    assert.equal(slugify("大模型"), "大模型");
    assert.equal(slugify("部署 / 运维"), "部署-运维");
  });

  it("洗成空的丢掉 —— 它没法当键", () => {
    assert.equal(slugify("😀"), "");
    assert.equal(cleanTags(["😀"]).length, 0);
  });
});

describe("**人写的那个形态要留住**", () => {
  /*
   * schema 里 `name` 和 `slug` 分成两列，正是为了这个。
   * 原来那段存的是 `name: slug` —— 于是输入「RAG」显示成 `rag`、
   * 「Rag 检索」显示成 `rag-检索`。
   */
  it("name 保留原样，slug 归一化", () => {
    assert.deepEqual(cleanTags(["RAG"]), [{ slug: "rag", name: "RAG" }]);
  });

  it("写库时用的是 name 不是 slug", () => {
    assert.match(strip(src("lib/forum/tags-write.ts")), /name: item\.name/);
  });
});

describe("边界", () => {
  it("去重按归一化之后的键", () => {
    assert.equal(cleanTags(["RAG", "rag", "Rag"]).length, 1);
  });

  it("封顶", () => {
    const many = Array.from({ length: MAX_TAGS_PER_POST + 5 }, (_, i) => `t${i}`);
    assert.equal(cleanTags(many).length, MAX_TAGS_PER_POST);
  });

  it("**太长的截断而不是拒绝** —— 一个标签打长了不该让整篇发不出去", () => {
    const long = "长".repeat(MAX_TAG_LENGTH + 20);
    const [tag] = cleanTags([long]);
    assert.equal(tag.name.length, MAX_TAG_LENGTH);
  });

  it("空白和空串直接丢", () => {
    assert.deepEqual(cleanTags(["", "   ", "\n"]), []);
  });
});

describe("接线", () => {
  it("**发帖时能加标签**", () => {
    // 这就是整件事：以前这里什么都没有
    assert.match(strip(src("components/forum/ComposeForm.tsx")), /<TagInput/);
    assert.match(strip(forumWritePath()), /tags\?: string\[\]/);
  });

  it("**标签和帖子在同一个事务里写**", () => {
    /*
     * 发完帖再调一次写标签，中间失败会留下一篇没有标签的帖子 ——
     * 而作者未必知道该回去补，版块要求必填标签时更是直接自相矛盾。
     */
    const body = strip(forumWritePath());
    const tx = body.slice(body.indexOf("const created = db.transaction"), body.indexOf("indexPost("));
    assert.match(tx, /applyTags\(tx,/);
  });

  it("**`require_tags` 终于有人读了**", () => {
    // 后台能改、显示成开着的，而没有一行代码读它
    assert.match(strip(forumWritePath()), /board\.requireTags/);
  });

  it("必填时的提示要说清楚为什么", () => {
    // 「必须填标签」只是命令；「别人靠它找到你这篇」才是理由
    assert.match(forumWritePath(), /别人靠它找到/);
  });

  it("**帖子上显示标签，而且点得动**", () => {
    const page = strip(src("app/(app)/forum/p/[id]/page.tsx"));
    assert.match(page, /tagsOfPosts\(/);
    assert.match(page, /\/forum\/search\?tag=/);
  });

  it("**`?tag=` 不再被静默丢弃**", () => {
    /*
     * 这个参数一直没人读：关注标签生成的链接、帖子上的标签、
     * 通知里的链接都指向它，而那一页只读 `q` ——
     * 于是每一次点标签，人都落在一个空搜索框上，
     * 看起来像「这个标签下什么都没有」。
     */
    const page = strip(src("app/(app)/forum/search/page.tsx"));
    assert.match(page, /tag\?: string/);
    assert.match(page, /postsWithTag\(/);
  });

  it("**按标签取帖子也要过可见性**", () => {
    /*
     * 标签是横穿版块的：一篇私密帖、一篇只给某个身份组的帖，
     * 都可能挂着同一个标签。不过判定的话，标签页就是一个
     * 绕开所有版块权限的后门 —— 而它看起来只是个筛选。
     */
    const body = strip(src("lib/forum/tags-queries.ts"));
    const fn = body.slice(body.indexOf("export function postsWithTag"));
    assert.match(fn, /canSeePost\(/);
  });

  it("复用 `toVisibilityInfo`，不自己摊一遍字段", () => {
    /*
     * 那个映射里有一处反直觉的对应（fromGroupChat 落在 visibility_locked 上），
     * 自己抄一份必然抄错 —— 而抄错的方向是把群聊转帖当成普通帖，
     * 也就是漏一层保护。
     */
    assert.match(strip(src("lib/forum/tags-queries.ts")), /toVisibilityInfo\(/);
  });

  it("**建议列表要摆出来** —— 归一化解决不了同义词", () => {
    /*
     * 三个人分别敲出「大模型」「LLM」「大语言模型」，
     * 一年后筛选功能等于废了。只能靠让人先看见别人用过什么。
     */
    assert.match(strip(src("components/forum/TagInput.tsx")), /suggestions/);
    assert.match(strip(src("app/(app)/forum/new/page.tsx")), /listTags\(/);
  });

  it("**回车不能把帖子发出去**", () => {
    // 标签框在表单里，回车默认是提交 —— 敲完第一个标签就发了
    assert.match(strip(src("components/forum/TagInput.tsx")), /e\.preventDefault\(\)/);
  });
});

/* ───────────────────────────────────────────────────────────────
 * 真数据库
 * ─────────────────────────────────────────────────────────────── */

const tmp = mkdtempSync(join(tmpdir(), "al-tags-"));
process.env.DB_PATH = join(tmp, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";

let dbm: typeof import("@/lib/db");
let schema: typeof import("@/lib/db/schema");
let write: typeof import("@/lib/forum/tags-write");
let queries: typeof import("@/lib/forum/tags-queries");
let eq: typeof import("drizzle-orm").eq;

before(async () => {
  dbm = await import("@/lib/db");
  schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  write = await import("@/lib/forum/tags-write");
  queries = await import("@/lib/forum/tags-queries");
  ({ eq } = await import("drizzle-orm"));
});

after(() => rmSync(tmp, { recursive: true, force: true }));

const BOARD = "b_1";

const makePost = (id: string, over: Record<string, unknown> = {}) =>
  dbm.db
    .insert(schema.posts)
    .values({
      id,
      boardId: BOARD,
      authorId: "u_a",
      title: `帖子 ${id}`,
      content: "正文",
      contentHtml: "<p>正文</p>",
      status: "published",
      visibility: "public",
      shareCode: id,
      ...over,
    })
    .run();

beforeEach(() => {
  for (const t of [schema.postTags, schema.tags, schema.posts, schema.boards]) {
    dbm.db.delete(t).run();
  }
  dbm.db
    .insert(schema.boards)
    .values({ id: BOARD, key: "general", name: "综合", sort: 1 })
    .run();
});

const viewer = (userId: string | null) =>
  ({ userId, roleIds: [], groupIds: [], canModerate: false }) as unknown as Parameters<
    typeof queries.postsWithTag
  >[0];

describe("真库", () => {
  it("**打上标签之后，按标签找得回来**", () => {
    makePost("p1");
    dbm.db.transaction((tx) => write.applyTags(tx, "p1", cleanTags(["RAG"]), "u_a"));

    const found = queries.postsWithTag(viewer("u_b"), "rag");
    assert.equal(found.length, 1);
    assert.equal(found[0].id, "p1");
  });

  it("显示的是人写的那个形态", () => {
    makePost("p1");
    dbm.db.transaction((tx) => write.applyTags(tx, "p1", cleanTags(["RAG"]), "u_a"));
    const tag = dbm.db.select().from(schema.tags).get();
    assert.equal(tag?.name, "RAG");
    assert.equal(tag?.slug, "rag");
  });

  it("**大小写不同的输入落到同一个标签上**", () => {
    makePost("p1");
    makePost("p2");
    dbm.db.transaction((tx) => write.applyTags(tx, "p1", cleanTags(["RAG"]), "u_a"));
    dbm.db.transaction((tx) => write.applyTags(tx, "p2", cleanTags(["rag"]), "u_a"));

    assert.equal(dbm.db.select().from(schema.tags).all().length, 1);
    assert.equal(queries.postsWithTag(viewer("u_b"), "rag").length, 2);
  });

  it("**私密帖不会从标签页漏出去**", () => {
    makePost("p1", { visibility: "private" });
    dbm.db.transaction((tx) => write.applyTags(tx, "p1", cleanTags(["秘密"]), "u_a"));

    assert.equal(queries.postsWithTag(viewer("u_b"), "秘密").length, 0, "别人看到了私密帖");
    assert.equal(queries.postsWithTag(viewer("u_a"), "秘密").length, 1, "作者自己该看得到");
  });

  it("草稿也不会漏", () => {
    makePost("p1", { status: "draft" });
    dbm.db.transaction((tx) => write.applyTags(tx, "p1", cleanTags(["草"]), "u_a"));
    assert.equal(queries.postsWithTag(viewer("u_b"), "草").length, 0);
  });

  it("**改标签时旧的计数要减回去**", () => {
    makePost("p1");
    dbm.db.transaction((tx) => write.applyTags(tx, "p1", cleanTags(["旧"]), "u_a"));
    dbm.db.transaction((tx) => write.applyTags(tx, "p1", cleanTags(["新"]), "u_a"));

    const rows = Object.fromEntries(
      dbm.db.select().from(schema.tags).all().map((t) => [t.slug, t.postCount]),
    );
    assert.equal(rows["旧"], 0, "旧标签的计数没减回去");
    assert.equal(rows["新"], 1);
  });

  it("计数不会变成负数", () => {
    makePost("p1");
    dbm.db.transaction((tx) => write.applyTags(tx, "p1", cleanTags(["x"]), "u_a"));
    for (let i = 0; i < 3; i++) {
      dbm.db.transaction((tx) => write.applyTags(tx, "p1", [], "u_a"));
    }
    const tag = dbm.db.select().from(schema.tags).where(eq(schema.tags.slug, "x")).get();
    assert.ok((tag?.postCount ?? 0) >= 0);
  });

  it("**只列用过的标签** —— 建了又被清空的不该出现在建议里", () => {
    makePost("p1");
    dbm.db.transaction((tx) => write.applyTags(tx, "p1", cleanTags(["用过"]), "u_a"));
    dbm.db.transaction((tx) => write.applyTags(tx, "p1", [], "u_a"));
    assert.equal(queries.listTags().length, 0);
  });

  it("没有这个标签时返回空，不炸", () => {
    assert.deepEqual(queries.postsWithTag(viewer("u_a"), "不存在"), []);
  });
});
