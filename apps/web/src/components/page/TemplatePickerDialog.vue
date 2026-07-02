<script setup lang="ts">
/**
 * TemplatePickerDialog — Stage 8 modal for picking a template to start a
 * new page from.
 *
 * Shows built-ins + space-scoped templates for the active space. Click
 * a row → emits `pick(template)` so the parent (Sidebar trigger) can
 * drive the create-from-template flow: clientId → router.push → POST.
 *
 * Visual: matches the TopSearch backdrop pattern (centered modal, scrim).
 * Skeleton rows on first load (chrome-during-load per B.3). Empty state
 * for spaces that have no templates beyond built-ins.
 */
import { computed, onMounted, watch } from 'vue'
import type { PageTemplate } from '@power-wiki/shared'
import { useTemplates } from '@/composables/useTemplates'
import Skeleton from '@/components/ui/Skeleton.vue'

const props = defineProps<{
  /** Active space id; null = global templates only (admin creating a global template). */
  spaceId: string | null
}>()
const emit = defineEmits<{
  pick: [template: PageTemplate]
  close: []
}>()

const templatesComposable = useTemplates()
const state = computed(() => templatesComposable.state(props.spaceId))

onMounted(async () => {
  await templatesComposable.ensureLoaded(props.spaceId)
})

// If the active space changes while the dialog is open (rare — picker
// is usually invoked from Sidebar with a stable space), reload.
watch(
  () => props.spaceId,
  async (id) => {
    await templatesComposable.ensureLoaded(id)
  },
)

function pick(t: PageTemplate) {
  emit('pick', t)
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}
</script>

<template>
  <div class="tpd-backdrop" @mousedown.self="emit('close')">
    <div class="tpd-modal" role="dialog" aria-label="从模板新建" tabindex="-1" @keydown="onKey">
      <div class="tpd-header">
        <h3 class="tpd-title">从模板新建</h3>
        <button class="icon-btn" type="button" aria-label="关闭" @click="emit('close')">
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>
      <div class="tpd-body">
        <template v-if="state.loading && state.templates.length === 0">
          <div class="tpd-skeleton">
            <Skeleton v-for="i in 5" :key="i" height="56px" radius="var(--radius-md)" />
          </div>
        </template>
        <template v-else-if="state.templates.length === 0">
          <div class="tpd-empty">
            <span class="material-symbols-outlined" style="font-size:32px">inbox</span>
            <p>这个空间还没有模板</p>
            <small>用空白页起一个新页面即可。</small>
          </div>
        </template>
        <template v-else>
          <ul class="tpd-list">
            <li v-for="t in state.templates" :key="t.id">
              <button class="tpd-item" type="button" @click="pick(t)">
                <span class="tpd-icon">
                  <span class="material-symbols-outlined">{{ t.icon || 'description' }}</span>
                </span>
                <span class="tpd-info">
                  <span class="tpd-row">
                    <span class="tpd-name">{{ t.title }}</span>
                    <span v-if="t.spaceId" class="tpd-badge">空间模板</span>
                    <span v-else-if="t.isBuiltIn" class="tpd-badge builtin">内置</span>
                  </span>
                  <span v-if="t.description" class="tpd-desc">{{ t.description }}</span>
                </span>
                <span class="material-symbols-outlined tpd-chev">chevron_right</span>
              </button>
            </li>
          </ul>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tpd-backdrop {
  position: fixed;
  inset: 0;
  /* --scrim-2 (45% opacity), the dialog backdrop tier per tokens.css.
   * The earlier --scrim-1 (32%) is reserved for topbar/floating-panel
   * scrim and visibly bleeds through, so the picker "blends with the
   * background" — match ConfirmDialog which also uses --scrim-2. */
  background: var(--scrim-2);
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 96px;
  /* 1000 to match ConfirmDialog's dialog tier. The earlier 900 lost to
   * NotificationBell portal (9998–10000) on top of a shared space — the
   * bell's popover rendered over the picker. */
  z-index: 1000;
}
.tpd-modal {
  width: 560px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 140px);
  background: var(--bg);
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  outline: none;
}
.tpd-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}
.tpd-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-1);
}
.icon-btn {
  width: 28px;
  height: 28px;
  border: 0;
  background: transparent;
  color: var(--text-3);
  border-radius: var(--radius-sm);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.icon-btn:hover {
  background: var(--bg-subtle);
  color: var(--text-1);
}
.tpd-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}
.tpd-skeleton {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 4px;
}
.tpd-empty {
  text-align: center;
  padding: 40px 16px;
  color: var(--text-3);
}
.tpd-empty p {
  margin: 8px 0 4px;
  font-weight: 600;
}
.tpd-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.tpd-item {
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  padding: 12px 14px;
  border: 0;
  background: transparent;
  border-radius: var(--radius-md);
  cursor: pointer;
  text-align: left;
  font-family: inherit;
  color: var(--text-1);
}
.tpd-item:hover {
  background: var(--bg-subtle);
}
.tpd-icon {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
  color: var(--accent);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.tpd-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.tpd-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tpd-name {
  font-weight: 600;
  font-size: 14px;
}
.tpd-badge {
  font-size: 11px;
  color: var(--text-3);
  background: var(--bg-subtle);
  padding: 1px 6px;
  border-radius: 3px;
  font-weight: 500;
}
.tpd-badge.builtin {
  background: rgba(0, 82, 204, 0.08);
  color: var(--accent);
}
.tpd-desc {
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.tpd-chev {
  color: var(--text-3);
  flex-shrink: 0;
}
</style>