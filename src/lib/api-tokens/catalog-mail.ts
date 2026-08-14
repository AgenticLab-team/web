import type { Endpoint } from "./catalog-types";

/**
 * 一次性邮箱那几条。
 *
 * ─────────────────────────────────────────
 * 它为什么自己一组
 * ─────────────────────────────────────────
 *
 * 按域拆的时候，能挂靠的组是 `me`（「我的东西」）。但一次性邮箱
 * 和「我的」那一组有个实打实的区别：**这里列出来的箱子是
 * 按令牌算的，不是按人算的**（见 GET 那条的说明）。
 *
 * 混进 `me` 里的话，读的人会按那一组的口径去理解它，
 * 然后以为自己在网页上开的箱子也能从 API 拿到 —— 而拿不到。
 * 一组一个口径，是这份目录唯一的排版规则。
 */
export const MAIL_ENDPOINTS: readonly Endpoint[] = [
  {
    method: "POST",
    path: "/api/v1/mail/burners",
    summary: "开一个一次性邮箱（24 小时后销毁）",
    scopes: ["mail:burner"],
    example: `curl -X POST -H "Authorization: Bearer $TOKEN" https://agenticlab.sh/api/v1/mail/burners`,
    note:
      "**不填 local_part 就给你一个随机地址**，这是最常见的用法。" +
      "自选前缀有最短长度限制（默认 10 个字符）—— 短前缀留给正式申领，" +
      "否则有人会用一次性箱反复占着好地址。" +
      "同时在手的箱子数**和你在网页上开的共用一个额度**",
    sampleBody: {},
  },
  {
    method: "GET",
    path: "/api/v1/mail/burners",
    summary: "列出这把令牌开的、还活着的一次性邮箱",
    scopes: ["mail:burner"],
    example: `curl -H "Authorization: Bearer $TOKEN" https://agenticlab.sh/api/v1/mail/burners`,
    note:
      "★ 只列**这把令牌自己开的** —— 你在网页上开的箱子它看不见。" +
      "这样一把令牌泄漏的爆炸半径，就是它自己造出来的那几个地址",
  },
  {
    method: "GET",
    path: "/api/v1/mail/burners/{id}",
    summary: "这个箱子的状态与用量",
    scopes: ["mail:burner"],
    example: `curl -H "Authorization: Bearer $TOKEN" https://agenticlab.sh/api/v1/mail/burners/<id>`,
  },
  {
    method: "DELETE",
    path: "/api/v1/mail/burners/{id}",
    summary: "提前销毁 ——「用完就扔」的那个扔",
    scopes: ["mail:burner"],
    example: `curl -X DELETE -H "Authorization: Bearer $TOKEN" https://agenticlab.sh/api/v1/mail/burners/<id>`,
    note: "**不可逆**：正文一起清掉，地址立刻可以被别人拿去用",
  },
  {
    method: "GET",
    path: "/api/v1/mail/attachments/{id}",
    summary: "下载一个附件",
    scopes: ["mail:burner"],
    example: `curl -H "Authorization: Bearer $TOKEN" -OJ https://agenticlab.sh/api/v1/mail/attachments/<id>`,
    note:
      "附件 id 从读信那条里拿（`attachments[].id`），而且只有 `stored` 为真的取得到 —— " +
      "**附件默认不保存**：要 L4、单个 ≤2M、个人总量 ≤50M，三样缺一就只留文件名和大小。" +
      "返回一律是 `application/octet-stream` 且强制下载，不照抄发件人写的类型 —— " +
      "那是一份陌生人发来的文件，让浏览器按他说的类型处理等于把决定权交给他",
  },
  {
    method: "GET",
    path: "/api/v1/mail/burners/{id}/messages/{message_id}",
    summary: "读一封信的全文",
    scopes: ["mail:burner"],
    example: `curl -H "Authorization: Bearer $TOKEN" https://agenticlab.sh/api/v1/mail/burners/<id>/messages/<message_id>`,
    note:
      "**抽不出验证码时用这条**。列表那条只给摘要和抽好的码 —— " +
      "那是为了让轮询便宜；而 `otp_code` 是 null 的时候（宁可不抽也不猜），" +
      "你得能把整封信拿出来自己看。" +
      "只有 `body_text`：HTML 那一份不留存。" +
      "★ 读一次就**标记已读**",
  },
  {
    method: "GET",
    path: "/api/v1/mail/burners/{id}/messages",
    summary: "这个箱子收到的信，带抽好的验证码",
    scopes: ["mail:burner"],
    example: `curl -H "Authorization: Bearer $TOKEN" "https://agenticlab.sh/api/v1/mail/burners/<id>/messages?since=0"`,
    note:
      "返回体里的 `otp_code` 是**已经抽好的验证码**，不用自己写正则解 HTML 邮件；" +
      "抽不出来时是 null（宁可不抽也不猜错）。" +
      "`?since=<毫秒时间戳>` 做增量拉取",
  },
];
