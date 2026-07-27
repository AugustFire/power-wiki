<script setup lang="ts">
/**
 * MovePageDialog — PageTree 「移动」菜单项触发的轻量 modal。
 *
 * 跟 ImportMarkdownModal 共享同一套 `.import-backdrop / .import-dialog /
 * .import-head / .import-foot / .btn` CSS 类(components.css),避免再写一
 * 套对话框样式分叉。
 *
 * 行为契约:
 *   - spaceId 锁定 page.spaceId(同 space 移动);跨 space 走
 *     `pagesStore.movePageToSpace`,不在 P1-4 范围。
 *   - 初始选中当前 parent;移动按钮在选中 = 当前 parent 时 disabled。
 *   - 提交前 walk 上溯检测 cycle(`isAncestor` 内联,与 PageTree.vue:322
 *     同算法,7 行),命中 cycle 拒绝并 toast 报错。
 *   - `pagesStore.movePage` 内部已做 cycle 兜底,这里再加一道是为了少一
 *     次往返 + 即时反馈。
 *   - Esc 关闭、backdrop 关闭、useBodyLock 锁滚动 —— 三处都镜像
 *     ImportMarkdownModal.vue:186-195 的生命周期钩子。
 */
import { computed, ref } from 'vue'
import { usePagesStore } from '@/stores/pages'
import { useUiStore } from '@/stores/ui'
import { useBodyLock } from '@/composables/useBodyLock'
import { useEscape } from '@/composables/useEscape'
import PathPicker from '@/components/editor/PathPicker.vue'

const props = defineProps<{ pageId: string }>()
const emit = defineEmits<{ close: [] }>()

const pagesStore = usePagesStore()
const uiStore = useUiStore()

const dialogOpen = ref(true)

/**
 * 取源页 —— 用 pageId 查 pagesStore,而不是外面塞 PageNode 进来。
 * 1. mount 在 AppShell 顶级,跟 tree 解耦;move 成功后 pages.value
 *    更新会重新触发 computed,拿到 fresh parentId / title。
 * 2. 万一 store 里被清了(deletedAt / 切空间),computed 返 undefined,
 *    template 里 v-if 直接挡住空内容。
 */
const sourcePage = computed(() => pagesStore.getPage(props.pageId))
const chosenParentId = ref<string | null>(sourcePage.value?.parentId ?? null)
const submitting = ref(false)

/**
 * 「移动」按钮启用条件:
 *   - 选了别的父级(非当前)
 *   - 未选到自己或自己的后代(避免 cycle,store 也会兜底再验一次)
 *   - 未在提交中
 *   - sourcePage 还在 store 里(切空间 / 删除导致 stale 时禁用,避免误操作)
 */
const canSubmit = computed(() => {
  if (submitting.value) return false
  const src = sourcePage.value
  if (!src) return false
  if (chosenParentId.value === src.parentId) return false
  if (chosenParentId.value === src.id) return false
  if (chosenParentId.value !== null && isAncestor(src.id, chosenParentId.value)) {
    return false
  }
  return true
})

/**
 * 与 PageTree.vue:322-329 同算法的祖先 walk —— 把 `startId` 沿 parent 链
 * 一路走到根,中途碰到 `ancestorId` 就返回 true。内联一份,避免再 export。
 */
function isAncestor(startId: string, ancestorId: string): boolean {
  let cur = pagesStore.getPage(startId)
  while (cur) {
    if (cur.id === ancestorId) return true
    cur = cur.parentId ? pagesStore.getPage(cur.parentId) : undefined
  }
  return false
}

useBodyLock(dialogOpen)
useEscape(dialogOpen, () => emit('close'))

function close() {
  emit('close')
}

async function submit() {
  if (!canSubmit.value) return
  const src = sourcePage.value
  if (!src) return
  submitting.value = true
  try {
    await pagesStore.movePage(src.id, chosenParentId.value)
    uiStore.notify(`已移动到「${getTitle(chosenParentId.value)}」`, 'success')
    dialogOpen.value = false
    emit('close')
  } catch (err) {
    uiStore.notify(
      err instanceof Error ? err.message : '移动失败',
      'error',
    )
  } finally {
    submitting.value = false
  }
}

function getTitle(id: string | null): string {
  if (id === null) return '空间根级'
  return pagesStore.getPage(id)?.title ?? '(未知页面)'
}
</script>

<template>
  <Teleport to="body">
    <Transition name="import-fade">
      <div v-if="dialogOpen && sourcePage" class="import-backdrop" @click.self="close">
        <div class="import-dialog" role="dialog" aria-labelledby="move-title">
          <header class="import-head">
            <h2 id="move-title" class="import-title">移动页面</h2>
            <button type="button" class="import-close" aria-label="关闭" @click="close">
              <span class="material-symbols-outlined">close</span>
            </button>
          </header>

          <div class="import-body">
            <p class="move-hint">
              将 <strong>{{ sourcePage.title }}</strong> 移动到:
            </p>
            <PathPicker
              :space-id="sourcePage.spaceId"
              :selected-id="chosenParentId"
              @select="(id) => (chosenParentId = id)"
            />
            <p class="move-current">当前位置:{{ getTitle(sourcePage.parentId) }}</p>
          </div>

          <footer class="import-foot">
            <button type="button" class="btn ghost" :disabled="submitting" @click="close">
              取消
            </button>
            <button
              type="button"
              class="btn primary"
              :disabled="!canSubmit"
              @click="submit"
            >
              {{ submitting ? '移动中…' : '移动' }}
            </button>
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* 仅补 move-dialog 特有的几个块;dialog 框 / head / foot / 按钮全靠
   .import-* 共享类,不重写一遍。 */
.move-hint {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--text-2);
}
.move-hint strong {
  color: var(--text-1);
  font-weight: 600;
}
.move-current {
  margin: 12px 0 0;
  font-size: 12px;
  color: var(--text-3);
}
</style>