/**
 * 收藏夹的规则。纯函数，不碰数据库。
 *
 * ─────────────────────────────────────────
 * 收藏一直是**只写不读**的
 * ─────────────────────────────────────────
 *
 * 帖子页有收藏按钮，点了会写库、图标也会填实。
 * 而 `listBookmarks` 全站零调用点 —— 收藏完之后，
 * **没有任何一个地方能看到自己收藏了什么**。
 *
 * 这比「功能没做」难发现得多：按钮点下去一切正常，
 * 人会以为东西存在某个自己还没找到的地方，于是继续收藏。
 * `forum_bookmark_folders` 整张表、`bookmarks.folder_id`、
 * `bookmarks.note` 也都是同一批没接上的东西。
 *
 * ─────────────────────────────────────────
 * 「未分组」不是一个文件夹
 * ─────────────────────────────────────────
 *
 * 它是 `folder_id IS NULL`，不建行。
 *
 * 建一个真的「默认收藏夹」看起来更整齐，代价是每个用户第一次
 * 收藏时都要先隐式建行、而且那一行能被改名和删除 ——
 * 删掉之后 folder_id 指向一个不存在的行，收藏就从所有视图里消失了。
 * 用 NULL 表示「没归类」，删文件夹只是把里面的收藏挪回 NULL，
 * 任何情况下都丢不了。
 */

export const MAX_FOLDERS = 20;
export const MAX_FOLDER_NAME = 16;
export const MAX_NOTE_CHARS = 200;

/** 「未分组」是保留词：占了它之后，界面上会出现两个同名的东西 */
export const UNSORTED_NAME = "未分组";

export type NameVerdict = { ok: true; name: string } | { ok: false; reason: string };

export function checkFolderName(raw: string, existing: string[]): NameVerdict {
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name) return { ok: false, reason: "得给收藏夹起个名字" };
  if (name.length > MAX_FOLDER_NAME) {
    return { ok: false, reason: `名字最多 ${MAX_FOLDER_NAME} 个字` };
  }
  if (name === UNSORTED_NAME) {
    return { ok: false, reason: `「${UNSORTED_NAME}」是没归类的那一格，换一个名字` };
  }
  if (existing.some((e) => e.trim() === name)) {
    return { ok: false, reason: "已经有同名的收藏夹了" };
  }
  return { ok: true, name };
}

export type CountVerdict = { ok: true } | { ok: false; reason: string };

export function checkFolderCount(current: number): CountVerdict {
  /*
   * 上限是为了让「收藏夹」还起得到分类的作用。
   *
   * 分类的用处来自「一眼扫完」；到了几十个之后，找收藏夹本身
   * 就和找收藏一样费劲，那时候该用的是搜索，不是再建一个夹子。
   */
  if (current >= MAX_FOLDERS) {
    return { ok: false, reason: `最多 ${MAX_FOLDERS} 个收藏夹 —— 再多就该用搜索找了` };
  }
  return { ok: true };
}

export function checkNote(raw: string): { ok: true; note: string | null } | { ok: false; reason: string } {
  const note = raw.trim();
  if (!note) return { ok: true, note: null };
  if (note.length > MAX_NOTE_CHARS) {
    return { ok: false, reason: `备注最多 ${MAX_NOTE_CHARS} 个字` };
  }
  return { ok: true, note };
}

export interface FolderTab {
  /** null = 未分组 */
  id: string | null;
  name: string;
  count: number;
}

/**
 * 侧栏那一列。
 *
 * 「全部」永远在最前面，「未分组」永远在最后 ——
 * 中间是用户自己排的。**空的未分组不显示**：
 * 每个人一开始都有一个 0 条的「未分组」，摆在那儿只是噪声。
 */
export function folderTabs(input: {
  folders: { id: string; name: string; count: number }[];
  unsortedCount: number;
}): { all: number; tabs: FolderTab[] } {
  const all = input.unsortedCount + input.folders.reduce((s, f) => s + f.count, 0);
  const tabs: FolderTab[] = input.folders.map((f) => ({ id: f.id, name: f.name, count: f.count }));
  if (input.unsortedCount > 0) {
    tabs.push({ id: null, name: UNSORTED_NAME, count: input.unsortedCount });
  }
  return { all, tabs };
}

/**
 * 删掉一个收藏夹之后，里面的收藏怎么办。
 *
 * 只有一个答案：挪回未分组。
 *
 * 「连里面的收藏一起删」会让一次手滑删掉几十条攒了很久的东西，
 * 而收藏本身没有回收站。删除一个**分类**不该毁掉被分类的**内容** ——
 * 这个函数存在就是为了把这句话钉在测试里。
 */
export function onFolderDeleted(count: number): { movedToUnsorted: number; deleted: 0 } {
  return { movedToUnsorted: count, deleted: 0 };
}

/**
 * 收藏的帖子后来看不见了，怎么显示。
 *
 * ─────────────────────────────────────────
 * 不能悄悄消失
 * ─────────────────────────────────────────
 *
 * 帖子可能被删、也可能被作者改成「仅自己可见」。
 * 直接从列表里滤掉的话，收藏夹会莫名其妙少几条 ——
 * 而人只会觉得是这个站把自己的东西弄丢了。
 *
 * 所以留一行墓碑，说明发生过什么，并给一个移除的口子。
 * 墓碑上**不显示标题和作者**：收藏那一刻能看，不代表现在还能看，
 * 把标题留在那儿等于给一条已经收回去的内容留了个副本。
 */
export interface Tombstone {
  kind: "gone";
  text: string;
}

export function tombstone(): Tombstone {
  return {
    kind: "gone",
    text: "这条内容你现在看不到了 —— 可能被删除，也可能改了可见范围",
  };
}
