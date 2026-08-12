/**
 * 版块的分组。
 *
 * ═════════════════════════════════════════
 * 分组只在显示这一层，库里没有这回事
 * ═════════════════════════════════════════
 *
 * `forum_boards` 上其实有一列 `parent_id`，一行没用过。用它做嵌套
 * 会波及每一条按版块过滤的查询（列表、搜索、权限、统计），
 * 而我们要的只是**九行分成三堆好扫一眼** —— 那是排版问题，不是数据问题。
 *
 * 所以这里是一张纯映射：版块 key → 属于哪一组。没登记的一律进
 * 「其它」，于是站长在后台新建一个版块不会让它从列表上消失。
 * 那一条是这个文件里最重要的行为：**漏登记的后果是排在最后，
 * 不是不见了**。
 */

export interface BoardGroup {
  key: string;
  label: string;
  /** 一句话说清这一组是干嘛的 —— 九个版块里挑一个，光看名字不够 */
  hint: string;
  /** 组内顺序按这个数组来，不按 board.sort */
  boards: string[];
}

export const BOARD_GROUPS: BoardGroup[] = [
  {
    key: "read",
    label: "值得读的",
    hint: "写下来是为了让人读完的东西",
    boards: ["articles", "howto", "showcase"],
  },
  {
    key: "talk",
    label: "聊起来的",
    hint: "有来有回的地方",
    boards: ["qa", "general", "news"],
  },
  {
    key: "house",
    label: "站务与沉淀",
    hint: "关于这个站本身，以及从群里搬下来的",
    boards: ["feedback", "inside", "archive"],
  },
];

/** 没登记的版块落在哪一组 */
export const FALLBACK_GROUP: Omit<BoardGroup, "boards"> = {
  key: "other",
  label: "其它",
  hint: "后来加的",
};

/**
 * 把一串版块分进各组。
 *
 * 泛型收在「有 key 就行」上 —— 这个函数不该知道版块还有别的字段，
 * 它只管排座位。
 */
export function groupBoards<T extends { key: string }>(
  boards: T[],
): { group: Omit<BoardGroup, "boards">; boards: T[] }[] {
  const byKey = new Map(boards.map((b) => [b.key, b]));
  const claimed = new Set<string>();

  const out = BOARD_GROUPS.map((group) => {
    const members: T[] = [];
    for (const key of group.boards) {
      const board = byKey.get(key);
      // 版块可能因为权限对这个人不可见 —— 那就当它不存在，不是留个空位
      if (!board) continue;
      members.push(board);
      claimed.add(key);
    }
    return { group: { key: group.key, label: group.label, hint: group.hint }, boards: members };
  })
    // 一个成员都没有的组不显示 —— 访客看到的「站务与沉淀」是空的
    .filter((section) => section.boards.length > 0);

  /*
   * 没登记的兜底。
   *
   * 这一段是这个文件真正的安全网：站长在后台新建版块时不会想到
   * 来改这里，而没有这一段的话，那个版块会**从论坛首页彻底消失** ——
   * 它还在、还能发帖、搜索还搜得到，就是首页上没有入口。
   * 那种坏法要好几天才有人发现。
   */
  const rest = boards.filter((b) => !claimed.has(b.key));
  if (rest.length > 0) out.push({ group: FALLBACK_GROUP, boards: rest });

  return out;
}
