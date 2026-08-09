/**
 * 等级门槛的校验与解释。纯函数，不碰数据库。
 *
 * ─────────────────────────────────────────
 * 门槛写死在代码里
 * ─────────────────────────────────────────
 *
 * `LEVELS` 是 rules.ts 里的一个常量数组。而「一切阈值走配置、
 * 后台可改、改动有历史」是这个站写在 defaults.ts 顶上的规则 ——
 * 等级门槛是全站影响面最大的一组数字，偏偏是硬编码的。
 *
 * ─────────────────────────────────────────
 * 可改之后，校验才是重点
 * ─────────────────────────────────────────
 *
 * 门槛列表有一个不显然的约束：**必须严格递增**。
 * 不递增的话 `levelOf` 会在中间停下（它是顺序扫描、遇到不满足就 break），
 * 结果是「攒得越多等级越低」这种没人会想到去查的行为。
 *
 * 而且 L1 的门槛必须是 0 —— 否则新注册的人算不出等级。
 */

export interface LevelDef {
  level: number;
  requires: number;
  name: string;
}

export const MAX_LEVEL_NAME = 12;

export type LevelsVerdict =
  | { ok: true; levels: LevelDef[] }
  | { ok: false; error: string };

/**
 * 一份门槛表能不能用。
 *
 * 每一条拒绝都要说清楚是**哪一级**出的问题 ——
 * 一句「格式不对」对着十行数字的人没有任何帮助。
 */
export function checkLevels(raw: unknown): LevelsVerdict {
  if (!Array.isArray(raw)) return { ok: false, error: "得是一个数组" };
  if (raw.length < 2) return { ok: false, error: "至少要有两级 —— 只有一级等于没有等级" };
  if (raw.length > 30) return { ok: false, error: "最多 30 级" };

  const levels: LevelDef[] = [];

  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as Record<string, unknown> | null;
    const at = `第 ${i + 1} 行`;

    if (!item || typeof item !== "object") return { ok: false, error: `${at}不是一条记录` };

    const level = Number(item.level);
    const requires = Number(item.requires);
    const name = typeof item.name === "string" ? item.name.trim() : "";

    if (!Number.isInteger(level) || level < 1) {
      return { ok: false, error: `${at}的等级要是 1 以上的整数` };
    }
    if (!Number.isInteger(requires) || requires < 0) {
      return { ok: false, error: `${at}的门槛要是 0 以上的整数` };
    }
    if (!name) return { ok: false, error: `${at}要有名字 —— 等级名会显示给所有人` };
    if (name.length > MAX_LEVEL_NAME) {
      return { ok: false, error: `${at}的名字最多 ${MAX_LEVEL_NAME} 个字` };
    }

    levels.push({ level, requires, name });
  }

  // 等级号必须从 1 开始、连续 —— 跳号会让「下一级」算错
  for (let i = 0; i < levels.length; i++) {
    if (levels[i].level !== i + 1) {
      return { ok: false, error: `等级号要从 1 开始连续排，第 ${i + 1} 行写的是 L${levels[i].level}` };
    }
  }

  if (levels[0].requires !== 0) {
    return { ok: false, error: "L1 的门槛必须是 0 —— 否则刚注册的人算不出等级" };
  }

  /*
   * 严格递增。
   *
   * levelOf 是顺序扫描、遇到不满足就 break 的 —— 门槛不递增时
   * 它会在中间停下，表现是「攒得越多等级反而越低」，
   * 而这种行为没有人会想到去查。
   */
  for (let i = 1; i < levels.length; i++) {
    if (levels[i].requires <= levels[i - 1].requires) {
      return {
        ok: false,
        error: `L${levels[i].level} 的门槛（${levels[i].requires}）不比 L${levels[i - 1].level}（${levels[i - 1].requires}）高 —— 门槛必须一级比一级高`,
      };
    }
  }

  return { ok: true, levels };
}

/**
 * 改门槛之后，谁的等级会变。
 *
 * ─────────────────────────────────────────
 * 改之前要能看到后果
 * ─────────────────────────────────────────
 *
 * 把 L2 从 50 提到 500，是在**给所有 L2 的人降级** ——
 * 而降级会连带把他们挡在某些版块外面。
 *
 * 一个只显示「已保存」的表单不会让人意识到这件事，
 * 所以保存之前先把「多少人升、多少人降」算出来摆在旁边。
 */
export interface LevelShift {
  promoted: number;
  demoted: number;
  unchanged: number;
}

export function previewShift(
  totals: number[],
  before: LevelDef[],
  after: LevelDef[],
): LevelShift {
  const at = (levels: LevelDef[], total: number) => {
    let current = levels[0]?.level ?? 1;
    for (const spec of levels) {
      if (total >= spec.requires) current = spec.level;
      else break;
    }
    return current;
  };

  let promoted = 0;
  let demoted = 0;
  let unchanged = 0;

  for (const total of totals) {
    const a = at(before, total);
    const b = at(after, total);
    if (b > a) promoted++;
    else if (b < a) demoted++;
    else unchanged++;
  }

  return { promoted, demoted, unchanged };
}

/**
 * 等级解锁了什么。
 *
 * ─────────────────────────────────────────
 * 只列真的在管事的
 * ─────────────────────────────────────────
 *
 * 全站按等级卡的只有一处：版块的 `post_min_level`。
 * 编一个「L5 解锁私信、L7 解锁自定义头像」的漂亮列表很容易，
 * 而那些东西**没有任何代码在读** —— 那就是又一个死开关，
 * 只不过这次穿着说明文档的皮。
 *
 * 所以这里从版块配置反查，有什么写什么。
 */
export interface LevelUnlock {
  level: number;
  boards: string[];
}

export function unlocksByLevel(
  boards: { name: string; postMinLevel: number }[],
  levels: LevelDef[],
): LevelUnlock[] {
  return levels.map((spec) => ({
    level: spec.level,
    boards: boards.filter((b) => b.postMinLevel === spec.level).map((b) => b.name),
  }));
}

/** 配置项的 key —— 存成 json，走设置那套现成的历史与回滚 */
export const LEVELS_SETTING_KEY = "points.levels";
