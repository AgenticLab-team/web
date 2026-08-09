/**
 * 登录名与手机号。纯函数，不碰数据库。
 *
 * ─────────────────────────────────────────
 * 起因：微信 ID 记不住
 * ─────────────────────────────────────────
 *
 * 密码登录一直要求填微信 ID，而真实的微信 ID 长这样：
 * `wxid_examplemember01`。它是系统分配的，绝大多数人从来没见过、
 * 更背不下来 —— 于是「密码兜底」这条路对需要它的人等于不存在。
 *
 * 所以加一个自己起的登录名。手机号和邮箱同样能当登录名用
 * （邮箱那一列早就在库里，一直没接上）。
 *
 * ─────────────────────────────────────────
 * 登录名有两个不显然的坑
 * ─────────────────────────────────────────
 *
 * **一、它不能撞进微信 ID 的空间。**
 *
 * 登录时要按「登录名或微信 ID 或手机号或邮箱」去找人。
 * 如果允许把登录名设成别人的微信 ID，同一个输入就会匹配到两行 ——
 * 而谁先谁后取决于查询的排序，也就是说**可以抢**。
 * 设的时候挡掉（`usernameShape` 管形状，identity.ts 的占用检查管撞人），
 * 查的时候按固定优先级认，**微信 ID 永远排第一** ——
 * 一个自选的标识不该盖过一个验证过的标识。
 *
 * **二、纯数字的登录名会遮住手机号。**
 *
 * 同一个输入框既收登录名也收手机号，一个叫 `13800138000` 的登录名
 * 会和某人的手机号打架。直接不许纯数字。
 *
 * ─────────────────────────────────────────
 * 保留词是给冒充留的门
 * ─────────────────────────────────────────
 *
 * 一个把登录名设成「管理员」「官方」的人，在任何显示登录名的地方
 * 都自带一层可信度。这类冒充不需要任何技术手段，只需要没人挡。
 */

export const MIN_USERNAME = 3;
export const MAX_USERNAME = 20;

/**
 * 保留词。
 *
 * 前缀匹配而不是精确匹配 ——「管理员001」和「管理员」一样好用。
 */
export const RESERVED_USERNAMES = [
  "admin",
  "administrator",
  "root",
  "system",
  "sys",
  "official",
  "staff",
  "support",
  "help",
  "security",
  "api",
  "www",
  "null",
  "undefined",
  "anonymous",
  "guest",
  "bot",
  "agenticlab",
  "管理",
  "管理员",
  "官方",
  "客服",
  "系统",
  "站长",
  "版主",
  "匿名",
  "游客",
];

export type NameVerdict = { ok: true; username: string } | { ok: false; reason: string };

/**
 * 登录名的格式规矩。
 *
 * 允许中文 —— 这个站的人本来就用中文名，只放行 ASCII 等于让
 * 大部分人起不出一个自己记得住的名字，而记得住正是这件事的全部意义。
 */
export function usernameShape(raw: string): NameVerdict {
  const username = raw.trim().toLowerCase();

  if (username.length < MIN_USERNAME) {
    return { ok: false, reason: `登录名至少 ${MIN_USERNAME} 个字符` };
  }
  if (username.length > MAX_USERNAME) {
    return { ok: false, reason: `登录名最多 ${MAX_USERNAME} 个字符` };
  }

  /*
   * 大小写统一存小写。
   *
   * 不统一的话 `Admin` 和 `admin` 是两个账号，而它们在页面上
   * 长得几乎一样 —— 这是最省事的一种冒充。
   */
  if (!/^[a-z0-9_一-龥-]+$/.test(username)) {
    return { ok: false, reason: "只能用中文、字母、数字、下划线和连字符" };
  }
  if (/^[_-]|[_-]$/.test(username)) {
    return { ok: false, reason: "开头和结尾不能是下划线或连字符" };
  }

  /*
   * 纯数字会和手机号抢同一个输入框。
   */
  if (/^\d+$/.test(username)) {
    return { ok: false, reason: "登录名不能全是数字 —— 那样会和手机号混在一起" };
  }

  /*
   * 微信 ID 的形状要留出来。
   *
   * 登录时一个输入框同时找登录名和微信 ID，
   * 放行 `wxid_` 开头的登录名等于允许去占别人的位置。
   */
  if (username.startsWith("wxid_")) {
    return { ok: false, reason: "不能用 wxid_ 开头 —— 那是微信 ID 的形状" };
  }

  const hit = RESERVED_USERNAMES.find((word) => username.startsWith(word));
  if (hit) {
    return { ok: false, reason: `「${hit}」是保留词，换一个` };
  }

  return { ok: true, username };
}

export type PhoneVerdict = { ok: true; phone: string } | { ok: false; reason: string };

/**
 * 手机号。
 *
 * ─────────────────────────────────────────
 * 它**没有经过验证**
 * ─────────────────────────────────────────
 *
 * 这个站没有短信通道，填进来的号码没有任何一步证明它属于填的人。
 * 所以手机号在这里的地位和登录名完全一样 —— 一个自己挑的字符串，
 * 只是恰好比较好记。
 *
 * 由此有两条必须守住的线：
 *
 * · **不能用它找回账号**。一个未验证的号码如果能重置密码，
 *   那就是「填上别人的号码然后接管账号」。
 * · **任何地方都不显示它**，也不能拿它搜人。它是真实世界的身份，
 *   而这个站的其他标识（微信 ID、昵称）至少还在群里公开过。
 *
 * `phone_verified_at` 这一列留着，等真有短信通道时才有东西可写。
 * 在那之前它永远是 null —— 一个永远为 null 的列比一个假装验证过的布尔安全。
 */
export function phoneShape(raw: string): PhoneVerdict {
  // 空格、连字符是人手打的，去掉再看
  const phone = raw.trim().replace(/[\s-]/g, "");

  if (!phone) return { ok: false, reason: "手机号是空的" };
  if (!/^1[3-9]\d{9}$/.test(phone)) {
    return { ok: false, reason: "填 11 位中国大陆手机号" };
  }
  return { ok: true, phone };
}

/**
 * 登录框里那一个输入到底是什么。
 *
 * 只用来决定查哪几列 —— **判断错了也不会放行任何人**，
 * 密码那一关照旧。所以这里怎么猜都是安全的。
 *
 * 生产库里 80 个账号的微信 ID 基本都是自设 ID（`a27740925`、
 * `bhjynhnyj` 这种），长得和登录名一模一样 —— 靠形状根本分不开，
 * 所以查询是四列一起查，这个函数只用来决定输入框的提示文案。
 */
export type IdentifierKind = "phone" | "email" | "wxid" | "username";

export function identifierKind(raw: string): IdentifierKind {
  const value = raw.trim();
  if (/^\d{11}$/.test(value)) return "phone";
  if (value.includes("@")) return "email";
  if (value.startsWith("wxid_")) return "wxid";
  return "username";
}

/**
 * 登录框里输入的东西怎么归一化。
 *
 * **必须和存进去时用的是同一套规则**，否则「设的时候存了小写、
 * 登录时按原样查」会变成「设完就登不上」——
 * 而那种 bug 只有设了大写名字的人会遇到，报上来的时候基本无从复现。
 *
 * 微信 ID 和邮箱也一起转小写，查询那边用 `lower(列)` 对上 ——
 * 手打自己的微信 ID 时大写一个字母就说「密码错误」，
 * 是那种永远不会被报告、只会让人默默放弃的问题。
 */
export function normalizeIdentifier(raw: string): string {
  const value = raw.trim();

  /*
   * 先去分隔符再判断是不是手机号。
   *
   * 反过来的话，`138 0013-8000` 过不了 `^\d{11}$`，会被当成登录名
   * 原样拿去查 —— 而人手打手机号带空格是常态（复制过来的更是）。
   * 只在去掉之后是纯数字时才认，`dev-tools` 这种登录名不受影响。
   */
  const compact = value.replace(/[\s-]/g, "");
  if (/^\d+$/.test(compact)) return compact;

  return value.toLowerCase();
}

/**
 * 登录输入框上写什么。
 *
 * 四种都收，读屏和错误文案里就得四种都念出来（`IDENTIFIER_LABEL`）；
 * 而输入框本身宽度有限，占位符用短的那条 —— 一句被截断成
 * 「登录名 / 手机号 / 邮…」的提示，比只写「登录名」更让人犹豫。
 */
export const IDENTIFIER_LABEL = "登录名 / 手机号 / 邮箱 / 微信 ID";
export const IDENTIFIER_PLACEHOLDER = "登录名或微信 ID";
