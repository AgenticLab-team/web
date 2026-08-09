import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  MAX_FOLDERS,
  MAX_FOLDER_NAME,
  MAX_NOTE_CHARS,
  UNSORTED_NAME,
  checkFolderCount,
  checkFolderName,
  checkNote,
  folderTabs,
  onFolderDeleted,
  tombstone,
} from "@/lib/forum/bookmark-rules";

/**
 * 收藏夹。
 *
 * ─────────────────────────────────────────
 * 收藏一直是只写不读的
 * ─────────────────────────────────────────
 *
 * 帖子页那个书签按钮一直能点、点了会写库、图标也会填实，
 * 而 `listBookmarks` 全站**零调用点** ——
 * 收藏完之后没有任何地方能看到自己收藏了什么。
 *
 * 那比「功能没做」难发现得多：按钮点下去一切正常，
 * 人会以为东西在某个自己还没找到的地方，于是继续收藏。
 *
 * `forum_bookmark_folders` 整张表、`bookmarks.folder_id`、
 * `bookmarks.note` 是同一批建了没接的东西。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

describe("收藏夹名字", () => {
  it("正常的过", () => {
    const r = checkFolderName("待读", []);
    assert.equal(r.ok && r.name, "待读");
  });

  it("空的拒", () => {
    assert.equal(checkFolderName("   ", []).ok, false);
  });

  it("太长的拒", () => {
    assert.equal(checkFolderName("长".repeat(MAX_FOLDER_NAME + 1), []).ok, false);
  });

  it("**「未分组」是保留词** —— 占了它界面上会出现两个同名的东西", () => {
    const r = checkFolderName(UNSORTED_NAME, []);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /没归类/);
  });

  it("重名拒", () => {
    const r = checkFolderName("待读", ["待读"]);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /同名/);
  });

  it("中间的连续空白压成一个 —— 「待 读」和「待  读」看起来一样，重名检查得能认出来", () => {
    assert.equal(checkFolderName("待  读", []).ok && checkFolderName("待  读", ["待 读"]).ok, false);
  });

  it("改名时排掉自己 —— 否则「改了个错字又改回来」会被自己挡住", () => {
    const code = strip(src("lib/forum/bookmark-actions.ts"));
    const fn = code.slice(code.indexOf("function renameFolder"));
    assert.match(fn, /filter\(\(f\) => f\.id !== folderId\)/);
  });
});

describe("数量上限", () => {
  it("没到上限放行", () => {
    assert.equal(checkFolderCount(MAX_FOLDERS - 1).ok, true);
  });

  it("到了就拒", () => {
    assert.equal(checkFolderCount(MAX_FOLDERS).ok, false);
  });

  it("上限定在「一眼扫得完」的量级", () => {
    /*
     * 分类的用处来自一眼扫完。几十个之后找收藏夹本身
     * 就和找收藏一样费劲，那时候该用搜索。
     */
    assert.ok(MAX_FOLDERS >= 8 && MAX_FOLDERS <= 30);
  });
});

describe("备注", () => {
  it("空的存 null，不存空串", () => {
    const r = checkNote("   ");
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.note, null);
  });

  it("太长拒", () => {
    assert.equal(checkNote("长".repeat(MAX_NOTE_CHARS + 1)).ok, false);
  });

  it("**备注显示在标题下面，不藏进菜单** —— 藏起来这个字段等于还是不存在", () => {
    const list = src("components/forum/BookmarkList.tsx");
    assert.match(list, /\{item\.note && editing === null &&/);
  });
});

describe("**「未分组」不是一个收藏夹**", () => {
  it("它是 folder_id IS NULL，不建行", () => {
    /*
     * 建一个真的「默认收藏夹」看起来更整齐，代价是那一行能被
     * 改名和删除 —— 删掉之后 folder_id 指向一个不存在的行，
     * 收藏就从所有视图里消失了。
     */
    const q = strip(src("lib/forum/bookmark-queries.ts"));
    assert.match(q, /isNull\(bookmarks\.folderId\)/);

    const actions = strip(src("lib/forum/bookmark-actions.ts"));
    assert.doesNotMatch(actions, new RegExp(`insert\\(bookmarkFolders\\)[\\s\\S]{0,200}${UNSORTED_NAME}`));
  });

  it("排在最后，而且空的时候不显示", () => {
    const empty = folderTabs({ folders: [{ id: "a", name: "待读", count: 2 }], unsortedCount: 0 });
    assert.deepEqual(empty.tabs.map((t) => t.id), ["a"]);

    const some = folderTabs({ folders: [{ id: "a", name: "待读", count: 2 }], unsortedCount: 3 });
    assert.deepEqual(some.tabs.map((t) => t.id), ["a", null]);
    assert.equal(some.tabs.at(-1)?.name, UNSORTED_NAME);
  });

  it("「全部」的数 = 各夹子 + 未分组", () => {
    const r = folderTabs({
      folders: [
        { id: "a", name: "A", count: 2 },
        { id: "b", name: "B", count: 5 },
      ],
      unsortedCount: 3,
    });
    assert.equal(r.all, 10);
  });
});

describe("**删收藏夹不删收藏**", () => {
  it("规则说得死：全挪回未分组，删 0 条", () => {
    /*
     * 「连里面的收藏一起删」会让一次手滑毁掉攒了很久的东西，
     * 而收藏没有回收站。删除一个分类不该毁掉被分类的内容。
     */
    assert.deepEqual(onFolderDeleted(17), { movedToUnsorted: 17, deleted: 0 });
  });

  it("action 里先挪后删，而且在一个事务里", () => {
    const code = strip(src("lib/forum/bookmark-actions.ts"));
    const fn = code.slice(code.indexOf("function deleteFolder"), code.indexOf("function moveBookmark"));
    assert.match(fn, /db\.transaction/);
    const move = fn.indexOf("set({ folderId: null })");
    const del = fn.indexOf("delete(bookmarkFolders)");
    assert.ok(move > 0 && del > 0 && move < del, "删在挪之前");
  });

  it("**界面上提前说清楚里面的收藏不会丢** —— 不说的话没人敢删，那功能等于不存在", () => {
    const m = src("components/forum/FolderManager.tsx");
    assert.match(m, /不会丢/);
    assert.match(m, /挪回/);
  });
});

describe("**看不到的收藏留墓碑，不能悄悄消失**", () => {
  it("墓碑上不带标题也不带作者", () => {
    /*
     * 收藏那一刻能看，不代表现在还能看。把标题留在那儿
     * 等于给一条已经收回去的内容留了个副本。
     */
    const t = tombstone();
    assert.equal(t.kind, "gone");
    assert.ok(t.text.length > 0);

    const q = strip(src("lib/forum/bookmark-queries.ts"));
    const branch = q.slice(q.indexOf("gone: tombstone()"), q.indexOf("gone: tombstone()") + 300);
    assert.match(branch, /title: null/);
    assert.match(branch, /authorName: null/);
  });

  it("界面渲染墓碑那一行，并给移除的口子", () => {
    const list = src("components/forum/BookmarkList.tsx");
    assert.match(list, /if \(item\.gone\)/);
    assert.match(strip(list), /removeBookmark\(item\.id\)/);
  });

  it("**用 leftJoin** —— innerJoin 会让帖子行被硬删的收藏整条不见", () => {
    const q = strip(src("lib/forum/bookmark-queries.ts"));
    const fn = q.slice(q.indexOf("function listBookmarkItems"));
    assert.match(fn, /leftJoin\(posts/);
    assert.doesNotMatch(fn, /innerJoin/);
  });
});

describe("**收藏不能变成绕过可见性的旁路**", () => {
  it("列表重新过一遍 canSeePost", () => {
    /*
     * 收藏是一条 (user, post) 记录，它不会因为帖子改了可见范围而失效。
     * 直接 join 出来渲染的话：收藏一个公开帖，等作者改成「仅自己可见」，
     * 收藏夹里照样看得见。
     */
    const q = strip(src("lib/forum/bookmark-queries.ts"));
    const fn = q.slice(q.indexOf("function listBookmarkItems"));
    assert.match(fn, /canSeePost\(toVisibilityInfo\(post\), viewer\)/);
  });

  it("匿名帖在收藏夹里也匿名", () => {
    const q = strip(src("lib/forum/bookmark-queries.ts"));
    assert.match(q, /post\.anonymous \? "匿名"/);
  });

  it("没登录直接返回空", () => {
    const q = strip(src("lib/forum/bookmark-queries.ts"));
    const fn = q.slice(q.indexOf("function listBookmarkItems"));
    assert.match(fn.slice(0, 300), /if \(!viewer\.userId\) return \[\]/);
  });
});

describe("**每一条 where 都得带 userId**", () => {
  /*
   * 收藏夹 id 和收藏 id 都是 ULID，会出现在客户端。
   * 只按 id 更新的话，改一下请求里的 id 就能重命名别人的收藏夹、
   * 把别人的收藏挪走。
   */
  const code = strip(src("lib/forum/bookmark-actions.ts"));

  it("按 id 改/删的每一处都同时按 userId 收口", () => {
    const risky = [...code.matchAll(/\.where\(([^;]*?)\)\s*\n?\s*\.run\(\)/g)].map((m) => m[1]);
    assert.ok(risky.length >= 5, `只找到 ${risky.length} 处写入，正则怕是没匹配上`);
    for (const where of risky) {
      assert.match(where, /userId/, `有一处写入没带 userId：${where.slice(0, 120)}`);
    }
  });

  it("**挪动时目标夹子也要验归属** —— 否则能把收藏塞进别人的夹子里", () => {
    const fn = code.slice(code.indexOf("function moveBookmark("), code.indexOf("function moveBookmarkByPost"));
    assert.match(fn, /eq\(bookmarkFolders\.userId, user\.id\)/);
  });

  it("改不到行要报错，不能静默成功", () => {
    // changes === 0 说明那个 id 不是自己的，或者根本不存在
    for (const name of ["moveBookmark(", "setBookmarkNote", "removeBookmark"]) {
      const fn = code.slice(code.indexOf(`function ${name}`));
      assert.match(fn.slice(0, 900), /changes === 0/, `${name} 没检查 changes`);
    }
  });

  it("预览态下不能写", () => {
    for (const name of ["createFolder", "renameFolder", "deleteFolder", "moveBookmark(", "setBookmarkNote", "removeBookmark", "reorderFolders"]) {
      const fn = code.slice(code.indexOf(`function ${name}`));
      assert.match(fn.slice(0, 500), /assertNotPreviewing\(\)/, `${name} 少了 assertNotPreviewing`);
    }
  });
});

describe("接线 —— 这一批的重点就是「真的有人调」", () => {
  it("**收藏夹页面存在，并且真的调了查询层**", () => {
    const page = src("app/(app)/me/bookmarks/page.tsx");
    assert.match(page, /listBookmarkItems\(/);
    assert.match(page, /listFolders\(/);
    assert.match(page, /bookmarkTabs\(/);
  });

  it("**导航里有入口** —— 手机端（更多弹层）和电脑端（侧栏）走的是同一份 nav", () => {
    /*
     * 新功能只在电脑端侧栏加入口，是这个站之前反复犯的错。
     * NAV 是唯一数据源，TabBar 的「更多」和桌面侧栏都从它生成，
     * 加在这里两端同时就有。
     */
    const nav = src("lib/nav.ts");
    assert.match(nav, /key: "bookmarks"/);
    assert.match(nav, /href: "\/me\/bookmarks"/);
    assert.match(nav, /icon: "bookmark"/);
    assert.match(nav, /requiresAuth: true/);

    // 图标名必须在映射表里，否则渲染出一个空位
    assert.match(src("components/shell/icons.tsx"), /bookmark: Bookmark,/);
  });

  it("「我的」页也有一行，带条数", () => {
    const me = src("app/(app)/me/page.tsx");
    assert.match(me, /href="\/me\/bookmarks"/);
    assert.match(me, /bookmarkTabs\(user\.id\)\.all/);
  });

  it("帖子页能直接归类", () => {
    const page = src("app/(app)/forum/p/[id]/page.tsx");
    assert.match(page, /folders=\{myFolders/);
    assert.match(src("components/forum/PostActions.tsx"), /moveBookmarkByPost\(postId, next\)/);
  });

  it("**一个夹子都没有时不显示那个下拉** —— 里面只有「未分组」一个选项", () => {
    assert.match(src("components/forum/PostActions.tsx"), /marked && folders\.length > 0/);
  });

  it("**每个 action 都有调用点** —— 这一批修的就是「写了没人调」", () => {
    const exported = [...src("lib/forum/bookmark-actions.ts").matchAll(/export async function (\w+)/g)].map(
      (m) => m[1],
    );
    assert.ok(exported.length >= 8);

    const callers = [
      "components/forum/BookmarkList.tsx",
      "components/forum/FolderManager.tsx",
      "components/forum/PostActions.tsx",
      "app/(app)/me/bookmarks/page.tsx",
    ]
      .map((f) => src(f))
      .join("\n");

    for (const name of exported) {
      // unsortedRemaining / clearGoneBookmarks 之外的都必须有人调
      if (["unsortedRemaining", "clearGoneBookmarks"].includes(name)) continue;
      assert.ok(callers.includes(name), `${name} 没有任何调用点`);
    }
  });
});

describe("交互", () => {
  it("**归类用原生 select** —— 自绘浮层就是「更多菜单被回复挡住」那个 bug 的形状", () => {
    for (const f of ["components/forum/BookmarkList.tsx", "components/forum/PostActions.tsx"]) {
      assert.match(src(f), /<select/, `${f} 没用原生 select`);
    }
  });

  it("**排序用上下箭头，不用拖拽** —— 拖拽在手机上要和滚动抢手势，读屏下没法用", () => {
    const m = src("components/forum/FolderManager.tsx");
    assert.match(m, /aria-label="往上挪"|label="往上挪"/);
    assert.doesNotMatch(strip(m), /onDragStart|draggable/);
  });

  it("列表里是「移除」不是切换收藏", () => {
    /*
     * 切换语义下误点一下就变成又收藏了一次，那一条会跳回列表最前面
     * （按收藏时间倒序）—— 看起来像它自己动了。
     */
    const list = strip(src("components/forum/BookmarkList.tsx"));
    assert.match(list, /removeBookmark\(/);
    assert.doesNotMatch(list, /toggleBookmark/);
  });

  it("空态说清楚怎么才会有东西", () => {
    assert.match(src("components/forum/BookmarkList.tsx"), /在帖子右上角点收藏/);
  });

  it("规则层不碰数据库", () => {
    const code = src("lib/forum/bookmark-rules.ts");
    for (const forbidden of ["server-only", "@/lib/db", "drizzle-orm"]) {
      assert.equal(code.includes(forbidden), false, `规则层引了 ${forbidden}`);
    }
  });

  it("用 SVG 图标不用 emoji", () => {
    for (const f of ["components/forum/BookmarkList.tsx", "components/forum/FolderManager.tsx"]) {
      assert.match(src(f), /lucide-react/);
      assert.doesNotMatch(strip(src(f)), /[\u{1F300}-\u{1FAFF}]/u);
    }
  });
});

describe("**?f= 的三种状态要分得开**", () => {
  it("缺省 / none / id 是三件事，不能挤成两件", () => {
    /*
     * 用空字符串表示「未分组」的话，`?f=` 和没带 f 在服务端读出来
     * 都是 falsy，两种状态会挤成一种。
     */
    const page = strip(src("app/(app)/me/bookmarks/page.tsx"));
    assert.match(page, /f === undefined \? undefined : f === "none" \? null : f/);
  });

  it("夹子被删掉之后退回全部，不停在一个空壳上", () => {
    const page = strip(src("app/(app)/me/bookmarks/page.tsx"));
    assert.match(page, /folders\.some\(\(x\) => x\.id === selected\)/);
  });
});
