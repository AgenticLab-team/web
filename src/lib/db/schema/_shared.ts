import { integer, text } from "drizzle-orm/sqlite-core";
import { ulid } from "ulid";

/** ULID 主键：单调递增可排序、无冲突、不暴露数量 */
export function ulidPk() {
  return text("id")
    .primaryKey()
    .$defaultFn(() => ulid());
}

/** 毫秒时间戳，与上游 create_time 格式一致 */
export function now(column: string) {
  return integer(column)
    .notNull()
    .$defaultFn(() => Date.now());
}

export const newId = () => ulid();
