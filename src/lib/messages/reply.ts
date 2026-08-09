/**
 * 引用回复（quote）目标的提取 —— 纯函数，不碰数据库。
 *
 * ## 上游现状（实测 2026-08-08，改动前请重新探测）
 *
 * `type === "quote"` 能确定「这是一条回复」，但**被回复的是哪一条，
 * 上游 /v1/messages 目前不给**：
 *   - 没有专门字段：生产上游连拉 200 条 quote 消息，所有 item 的键
 *     都只有标准 11 个（msg_svr_id / conv_id / ... / time），最新一条也一样
 *   - content 里也没有 XML：微信原始数据里引用关系在 <refermsg> 的
 *     <svrid> 里，但上游已把 content 归一化成纯回复文本
 *     （本地 5,440 条历史 quote 无一含 "<"，与上游实时抽样一致）
 *   - 隐藏端点（/messages/{id} 及各种猜测形态）全部 404，
 *     openapi 无扩展参数，key 的 scopes 也没有更高档位
 *
 * 所以这个解析器今天对上游数据**只会返回 null** —— 这是如实的结果，
 * 不做任何时间邻近之类的猜测：把别人的话安错回复对象比不显示更糟。
 *
 * 保留 <refermsg> 解析的原因：引用关系在微信侧就存在这一种载体，
 * 上游哪天开始透传原文（已向站长反馈），同步与回填脚本立即能用，
 * 不需要再改代码。
 */

/**
 * 从消息正文里提取被引用消息的 msg_svr_id。
 *
 * 认两种真实存在的形态：
 *   - <refermsg>...<svrid>123</svrid>...</refermsg>（微信 appmsg 原文）
 *   - <refermsg ... svrid="123">（属性形态，部分抓包工具会转成这样）
 * 只在 <refermsg> 块内找 svrid —— 消息本身的 svrid 也可能出现在 XML 里，
 * 全局搜会把消息自己当成被引用的目标。
 */
export function extractReplyTarget(content: string): string | null {
  const start = content.indexOf("<refermsg");
  if (start === -1) return null;

  const end = content.indexOf("</refermsg>", start);
  const block = end === -1 ? content.slice(start) : content.slice(start, end);

  const tag = block.match(/<svrid>\s*(\d+)\s*<\/svrid>/);
  if (tag) return tag[1];

  const attr = block.match(/\bsvrid="(\d+)"/);
  if (attr) return attr[1];

  return null;
}
