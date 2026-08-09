import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

/**
 * 接线检查：帖子管理的每个 server action 都必须真的被界面调到。
 *
 * 这个项目反复出现同一种坑：**声明了但没人调用的代码**。
 * moderatePost 写完到接上界面之间隔了好几周 —— 功能"存在"，
 * 但用户按不到它，等于不存在。这类断线编译器和类型都查不出来，
 * 所以用最笨的办法锁住：读源码，断言调用点在。
 *
 * 断言故意写得**具体到文件**：只查「全仓库里有人调它」的话，
 * 挪一次代码就可能把调用点挪丢而测试还绿着。
 */

const ROOT = new URL("..", import.meta.url).pathname;

function src(path: string): string {
  // 注释里提到函数名不算接线 —— 去掉注释再断言
  return readFileSync(join(ROOT, path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*/g, "");
}

const postPage = src("src/app/(app)/forum/p/[id]/page.tsx");
const menu = src("src/components/forum/PostManageMenu.tsx");

describe("帖子页把管理菜单接上了", () => {
  it("页面渲染 PostManageMenu，能力集来自 postCapabilities", () => {
    assert.match(postPage, /<PostManageMenu\b/);
    assert.match(postPage, /postCapabilities\(/);
  });

  it("菜单调的是真实的 server action，不是自己另写一套", () => {
    assert.match(menu, /moderatePost\(/);
    assert.match(menu, /movePost\(/);
    assert.match(menu, /deleteMyPost\(/);
    // 自删的撤销窗口必须能真的恢复
    assert.match(menu, /restoreMyPost\(/);
  });

  it("自删不弹确认框，走撤销窗口", () => {
    // HIG：可撤销优于二次确认。confirm() 一旦出现就是倒退
    assert.doesNotMatch(menu, /\bconfirm\(/);
    assert.match(menu, /undo:/);
  });

  it("版主的删除与锁定必须填理由才能提交", () => {
    assert.match(menu, /!reason\.trim\(\)/);
  });
});

describe("编辑入口", () => {
  it("编辑页存在、校验能力、渲染表单", () => {
    const page = src("src/app/(app)/forum/p/[id]/edit/page.tsx");
    assert.match(page, /postCapabilities\(/);
    assert.match(page, /<EditPostForm\b/);
    // 没权限与不存在同样 404，不泄露存在性
    assert.match(page, /notFound\(\)/);
  });

  it("表单调 editPost，并带修改说明", () => {
    const form = src("src/components/forum/EditPostForm.tsx");
    assert.match(form, /editPost\(/);
    assert.match(form, /changeNote/);
  });

  it("菜单里有编辑入口指向编辑页", () => {
    assert.match(menu, /\/edit/);
  });
});

describe("引用回复接线", () => {
  it("帖子页包了 QuoteProvider，并渲染引用按钮", () => {
    assert.match(postPage, /<QuoteProvider>/);
    assert.match(postPage, /<QuoteButton\b/);
  });

  it("回复框把 quotedReplyId 传给 createReply，发送后清引用", () => {
    const form = src("src/components/forum/ReplyForm.tsx");
    assert.match(form, /quotedReplyId:\s*quote/);
    assert.match(form, /clearQuote\(\)/);
  });

  it("滑动手势与可见按钮都能发起引用", () => {
    assert.match(src("src/components/forum/ReplyRow.tsx"), /setQuote\(/);
    assert.match(src("src/components/forum/QuoteButton.tsx"), /setQuote\(/);
  });
});

describe("阅读进度接线", () => {
  it("markReadFloor 终于有人调了", () => {
    // 这个 action 在 actions.ts 里躺了很久 —— 声明了但没人调用
    assert.match(src("src/components/forum/ResumeReading.tsx"), /markReadFloor\(/);
    assert.match(postPage, /<ResumeReading\b/);
  });
});

describe("只看楼主", () => {
  it("走 URL 参数而不是客户端状态，分享链接能带上视图", () => {
    assert.match(postPage, /only=op/);
    assert.match(postPage, /authorId === post\.authorId/);
  });
});

describe("action 层守住的两道闸", () => {
  it("版主动作在服务端重新判权限（can 在核心实现里）", () => {
    const core = src("src/lib/forum/manage.ts");
    assert.match(core, /can\(actor,\s*"forum\.post\.move"/);
    assert.match(core, /can\(actor,\s*"forum\.post\.delete\.own"/);
    // 核心实现里不允许出现按角色字符串的判断
    assert.doesNotMatch(core, /role\s*===/);
  });

  it("写 action 拦预览态 —— 否则审计会记在被预览的人头上", () => {
    const actions = src("src/lib/forum/moderation.ts");
    assert.match(actions, /assertNotPreviewing/);
  });
});
