<script setup lang="ts">
/**
 * PickPageDialog —— 「选一篇本空间内的页面」轻量 modal。
 *
 * 用途:SpaceEditView 的「空间主页」设置。同一组件结构(MovePageDialog、
 * ImportMarkdownModal)复用 .import-* 共享类,自身只管 PathPicker + 确认
 * 提交 + ESC / 背景关闭。
 *
 * 行为契约:
 *   - spaceId 锁定(选页不能跨空间 —— 主页必须是本空间内的页)。
 *   - 初始选中 props.selectedId(可能为 null)。
 *   - 「确认」按钮在未选 / 选到自身时也允许(没有 move 那种 cycle 概念,
 *     任何页面都能当主页)。
 *   - Esc / 背景点击关闭;useBodyLock 锁滚动 —— 与 MovePageDialog 同款。
 */
import { ref } from 'vue'
import PathPicker from '@/components/editor/PathPicker.vue'
import { useBodyLock } from '@/composables/useBodyLock'
import { useEscape } from '@/composables/useEscape'

const props = defineProps<{
  spaceId: string
  selectedId: string | null
  /** 模态标题,默认「选择页面」。 */
  title?: string
}>()
const emit = defineEmits<{
  close: []
  select: [id: string | null]
}>()

const dialogOpen = ref(true)
const chosenId = ref<string | null>(props.selectedId)

useBodyLock(dialogOpen)
useEscape(dialogOpen, () => emit('close'))

function close() {
  emit('close')
}

function confirm() {
  emit('select', chosenId.value)
}
</script>

<template>
  <Teleport to="body">
    <Transition name="import-fade">
      <div v-if="dialogOpen" class="import-backdrop" @click.self="close">
        <div class="import-dialog" role="dialog" aria-labelledby="pick-title">
          <header class="import-head">
            <h2 id="pick-title" class="import-title">{{ title ?? '选择页面' }}</h2>
            <button type="button" class="import-close" aria-label="关闭" @click="close">
              <span class="material-symbols-outlined">close</span>
            </button>
          </header>

          <div class="import-body">
            <PathPicker
              :space-id="props.spaceId"
              :selected-id="chosenId"
              @select="(id) => (chosenId = id)"
            />
          </div>

          <footer class="import-foot">
            <button type="button" class="btn ghost" @click="close">取消</button>
            <button type="button" class="btn primary" @click="confirm">确认选择</button>
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>