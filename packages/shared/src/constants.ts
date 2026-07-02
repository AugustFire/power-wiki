/**
 * Frontend + backend 共享的运行时常量。
 *
 * 设计原则:能放 shared 的就放 shared,避免前端默认值跟后端默认值漂移(参见
 * 历史上 PageTitleSchema 校验空字符串的 regression — bug 来自后端默认
 * `''`、前端默认 `DEFAULT_TITLE`,同一字段两份定义必然不一致)。
 */

/** 新页 / 没 title 时的回退标题。后端在 INSERT 也用这个,所以任何新建路径
 *  (前端 createPage 乐观占位、服务端 POST /api/pages)都不会违反
 *  `PageTitleSchema.min(1)`。 */
export const DEFAULT_TITLE = '无标题页面'
