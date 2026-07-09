/**
 * usePageTreeDrag — 跨 PageTree 实例共享的拖拽状态。
 *
 * 为什么必须 module-scope(不是 `<script setup>` 内部):
 *   PageTree 是递归组件,树里每一行都是一个独立实例。拖拽时:
 *     - source 行 A 的 onDragStart 写入 `draggingId = A.id`
 *     - 鼠标移到目标行 B,B 的 onDragOver 读 `draggingId` 决定要不要 preventDefault
 *     - 浏览器**只在 preventDefault 被调时**才触发 drop
 *   如果 dragState 是 per-instance(reactive 在 setup 里创建),B 读到的是自己实例
 *   的 `draggingId = null`,早 return 不 preventDefault → drop 永远不触发。
 *   把 reactive 提到 module 层 → 模块加载时创建一次,所有实例读同一份。
 *
 * 复盘:原代码 line 66-72 的注释已正确描述这个坑,但实现仍然写在 setup 内部,
 * 等于自己识别了 bug 又没修。抽到独立 module 后,作用域清晰可见 + 注释锁死。
 *
 * autoExpandTimer 同样:跨实例的"hover 折叠父节点 N ms 后自动展开"timer 句柄
 * 必须共享,否则 source / target 各自起 timer 互盖,行为不确定。
 */
import { reactive, ref } from 'vue'

export type DropHint = 'before' | 'after' | 'child'

interface DragState {
  /** 当前被拖的 pageId;null = 没在拖。source 行 onDragStart 设,任何 onDrop / onDragEnd 清。 */
  draggingId: string | null
  /** 当前 mouseover 的目标行 + 落点位置(中 1/3 / 上 1/3 / 下 1/3)。drop 事件读这个算 newParentId。 */
  dropTarget: { id: string; position: DropHint } | null
}

// ─── 共享的 reactive + timer ────────────────────────────────────────
// 这两个变量在 module 顶层声明,模块加载时执行一次,所有 PageTree 实例共享。
// 严禁放进任何 <script setup> 块,会退化成 per-instance(原 bug)。
//
// autoExpandTimer 用 ref 不直接用 let:经过 composable 返回再解构后
// `let` 会变成 `const`(JS 解构规则),`ref().value =` 在 consumer 端能正常赋值。
const dragState = reactive<DragState>({
  draggingId: null,
  dropTarget: null,
})
const autoExpandTimer = ref<ReturnType<typeof setTimeout> | null>(null)

/**
 * Composable hook(纯读 module 变量,本身不创建 reactive)。返回的
 * `dragState` / `autoExpandTimer` 是引用,所有调用方共享同一份。
 */
export function usePageTreeDrag(): {
  dragState: typeof dragState
  autoExpandTimer: typeof autoExpandTimer
} {
  return { dragState, autoExpandTimer }
}
