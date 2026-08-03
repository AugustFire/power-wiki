<script setup lang="ts">
/**
 * SpaceCapabilityDialog — 空间角色权限对照表(只读 modal)。
 *
 * 从 SpaceEditView 抽出来:之前 matrix modal 的开/关由 shell 跟 grants
 * tab header 上的 help 按钮双向管理,现在 help 按钮 + modal 状态完全收敛
 * 到消费者(SpaceGrantsTab);shell 不再持有 matrixHelpOpen。
 *
 * Teleport 到 body + backdrop mousedown.self 关闭,Esc 由 useEscape 在
 * consumer 处理 —— 这里只暴露标准的 open / close 行为。
 */
import { useEscape } from '@/composables/useEscape'
import type { SpaceRole } from '@power-wiki/shared'

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const ROLE_OPTIONS: Array<{ value: SpaceRole; label: string; icon: string; hint: string }> = [
  { value: 'viewer', label: '只读', icon: 'visibility', hint: '可以查看,但不能创建或修改页面' },
  { value: 'editor', label: '编辑', icon: 'edit', hint: '可以创建和编辑页面' },
  { value: 'admin',  label: '管理', icon: 'shield_person', hint: '可以管理成员授权和空间基本信息' },
]

/**
 * 能力矩阵:跟 docs/permissions.md「能力速查」保持一致。改后端
 * permissions.ts 时必须同步这张表,否则对照表与实际权限会脱节。
 */
const CAPABILITY_MATRIX: Array<{
  label: string
  viewer: boolean
  editor: boolean
  admin: boolean
}> = [
  { label: '查看页面与内容', viewer: true, editor: true, admin: true },
  { label: '创建 / 编辑 / 删除页面', viewer: false, editor: true, admin: true },
  { label: '上传附件、编辑标签', viewer: false, editor: true, admin: true },
  { label: '版本快照与恢复', viewer: false, editor: true, admin: true },
  { label: '评论、点赞、关注', viewer: true, editor: true, admin: true },
  { label: '设置页面查看 / 编辑限制', viewer: false, editor: true, admin: true },
  { label: '创建 / 撤销公开分享链接', viewer: false, editor: true, admin: true },
  { label: '管理空间成员与授权', viewer: false, editor: false, admin: true },
  { label: '修改空间名称 / 描述 / 颜色', viewer: false, editor: false, admin: true },
]

useEscape(() => props.open, () => emit('close'))
</script>

<template>
  <Teleport to="body">
    <Transition name="se-matrix-modal">
      <div
        v-if="open"
        class="se-matrix-modal-backdrop"
        role="presentation"
        @mousedown.self="emit('close')"
      >
        <div
          class="se-matrix-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="se-matrix-modal-title"
        >
          <header class="se-matrix-modal-head">
            <span class="material-symbols-outlined se-matrix-modal-icon">shield_lock</span>
            <div class="se-matrix-modal-head-text">
              <h3 id="se-matrix-modal-title" class="se-matrix-modal-title">空间角色权限对照</h3>
              <p class="se-matrix-modal-sub">授予某角色后,该成员在本空间能做什么</p>
            </div>
            <button type="button" class="se-matrix-modal-close" aria-label="关闭" @click="emit('close')">
              <span class="material-symbols-outlined">close</span>
            </button>
          </header>
          <div class="se-matrix-modal-body">
            <table class="se-matrix">
              <thead>
                <tr>
                  <th class="se-matrix-cap-head" scope="col">能力</th>
                  <th
                    v-for="opt in ROLE_OPTIONS"
                    :key="opt.value"
                    class="se-matrix-role-head"
                    scope="col"
                  >
                    <span class="material-symbols-outlined se-matrix-role-icon">{{ opt.icon }}</span>
                    <span>{{ opt.label }}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in CAPABILITY_MATRIX" :key="row.label">
                  <td class="se-matrix-cap">{{ row.label }}</td>
                  <td class="se-matrix-cell">
                    <span v-if="row.viewer" class="se-matrix-yes" title="可以">
                      <span class="material-symbols-outlined">check</span>
                    </span>
                    <span v-else class="se-matrix-no" title="不可以">—</span>
                  </td>
                  <td class="se-matrix-cell">
                    <span v-if="row.editor" class="se-matrix-yes" title="可以">
                      <span class="material-symbols-outlined">check</span>
                    </span>
                    <span v-else class="se-matrix-no" title="不可以">—</span>
                  </td>
                  <td class="se-matrix-cell">
                    <span v-if="row.admin" class="se-matrix-yes" title="可以">
                      <span class="material-symbols-outlined">check</span>
                    </span>
                    <span v-else class="se-matrix-no" title="不可以">—</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <footer class="se-matrix-modal-foot">
            <span class="material-symbols-outlined se-matrix-foot-icon">info</span>
            <span>
              删除空间、查看审计日志、管理用户组仅限<strong>全局管理员</strong>;页面作者对自己创建的页面始终拥有完整权限,不受空间角色限制。
            </span>
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.se-matrix-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(9, 30, 66, 0.5);
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.se-matrix-modal {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 4px);
  box-shadow: 0 12px 32px rgba(9, 30, 66, 0.18),
              0 4px 12px rgba(9, 30, 66, 0.12);
  width: 100%;
  max-width: 680px;
  max-height: calc(100vh - 48px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.se-matrix-modal-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 20px 24px 18px;
  border-bottom: 1px solid var(--border);
  background: var(--accent-softer, #F4F8FF);
  flex-shrink: 0;
}
.se-matrix-modal-icon {
  font-size: 26px;
  color: var(--accent);
  flex-shrink: 0;
  line-height: 1.1;
}
.se-matrix-modal-head-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.se-matrix-modal-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-1);
  line-height: 1.3;
}
.se-matrix-modal-sub {
  margin: 0;
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.45;
}
.se-matrix-modal-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  margin: -4px -4px 0 0;
  background: transparent;
  border: 0;
  border-radius: 50%;
  color: var(--text-3);
  cursor: pointer;
  flex-shrink: 0;
  transition: background var(--duration-fast) var(--ease-out),
              color var(--duration-fast) var(--ease-out);
}
.se-matrix-modal-close .material-symbols-outlined { font-size: 20px; }
.se-matrix-modal-close:hover {
  background: var(--bg);
  color: var(--text-1);
}
.se-matrix-modal-body {
  padding: 8px 24px 12px;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}
.se-matrix-modal-foot {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 14px 24px 16px;
  border-top: 1px solid var(--border);
  background: var(--bg-canvas);
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.55;
  flex-shrink: 0;
}
.se-matrix-foot-icon {
  font-size: 14px;
  color: var(--text-3);
  flex-shrink: 0;
  margin-top: 2px;
}
.se-matrix-modal-foot strong { font-weight: 600; color: var(--text-2); }

.se-matrix {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  margin: 0;
}
.se-matrix th,
.se-matrix td {
  padding: 10px 10px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
.se-matrix tbody tr:last-child td { border-bottom: 0; }
.se-matrix tbody tr {
  transition: background var(--duration-fast) var(--ease-out);
}
.se-matrix tbody tr:hover { background: var(--bg-canvas); }

.se-matrix-cap-head {
  text-align: left;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding-bottom: 12px;
}
.se-matrix-role-head {
  text-align: center;
  font-weight: 600;
  color: var(--text-2);
  white-space: nowrap;
  padding: 9px 10px;
}
.se-matrix-role-icon {
  font-size: 16px;
  color: var(--accent);
  vertical-align: -3px;
  margin-right: 4px;
}
.se-matrix-cap { color: var(--text-1); font-weight: 500; }
.se-matrix-cell { text-align: center; }
.se-matrix-yes {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--success-text) 14%, transparent);
  color: var(--success-text);
}
.se-matrix-yes .material-symbols-outlined {
  font-size: 14px;
  font-weight: 700;
}
.se-matrix-no {
  color: var(--text-3);
  user-select: none;
  font-size: 14px;
}

.se-matrix-modal-enter-active,
.se-matrix-modal-leave-active {
  transition: opacity 180ms var(--ease-out);
}
.se-matrix-modal-enter-active .se-matrix-modal,
.se-matrix-modal-leave-active .se-matrix-modal {
  transition: transform 180ms var(--ease-out),
              opacity 180ms var(--ease-out);
}
.se-matrix-modal-enter-from,
.se-matrix-modal-leave-to {
  opacity: 0;
}
.se-matrix-modal-enter-from .se-matrix-modal,
.se-matrix-modal-leave-to .se-matrix-modal {
  opacity: 0;
  transform: translateY(8px) scale(0.98);
}
</style>
