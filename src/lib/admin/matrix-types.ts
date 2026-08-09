/**
 * 矩阵的三态。
 *
 * 单独放一个文件是因为规则层（rbac/matrix-edit.ts）要用它,
 * 而 admin/permissions.ts 是 server-only 的 —— 规则层引它就会
 * 把整个数据库拖进纯函数的测试里。
 */
export type MatrixState = "granted" | "denied" | "none";
