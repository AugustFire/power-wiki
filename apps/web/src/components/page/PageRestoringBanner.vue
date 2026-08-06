<!--
  PageRestoringBanner —— M13+ 协同 restore race 收口的「页面正在被人回滚」横幅。

  触发链路(B → server → A):
    B 调 POST /api/pages/:id/versions/:versionId/restore
      → server pageVersions.ts 复用 assertNoActiveLockForWrite(action='restore'),
        发现 A 持锁
      → server 推 stateless `page_locked_during_restore { actorId, pageId }`
      → A 端 usePageLock 处理,设 pageRestoring ref
      → EditView 渲染本组件

  跟 PageDeletingBanner 是兄弟组件 —— 同结构同栈,只是 icon / 文案换成
  「restore / history」语义。两者互斥(同源 server 端闸门,一次只跑一个
  action),不会同时挂。

  UX:
    - 颜色:warning soft(中黄),跟 LockBanner 同色 —— restore 是「时光机」,
      紧迫性介于「锁」和「删除」之间。比 warning 红低一档,比 neutral 蓝
      高一档(全栈统一视觉梯度:warning 黄 = 中等紧迫;danger 红 = 删除 /
      不可逆;neutral = 普通状态)。
    - 文字:`{actorName} 正在尝试回滚此页面到旧版本 · 回滚会拒绝,直到
      你离开编辑器`。「拒绝」二字着 warning 强调色 —— server 端锁闸门
      挡住 restore 是 by design,语义对齐「不是已回滚再 undo」。
    - 按钮:`我知道了,让出` —— 调 caller 注入的 onLeave(EditView 里关
      掉编辑器,usePageLock 释锁 → B 重试 restore 时锁闸门放行)。

  Actor name 解析:usePageLock 已经从 awarenessStates 解析过;caller 把
  actorName / actorColor ref 透传即可。未解析到时 fallback 到 actorId
  直接展示,banner 仍可用。
-->
<script setup lang="ts">
import UserAvatar from '@/components/ui/UserAvatar.vue'

const props = defineProps<{
  /** B(restoror)的展示名 —— 由 caller 从 usePageLock / awarenessStates 拿。 */
  actorName?: string | null
  /** B 的 id fallback —— usePageLock 没解析到 name 时就用这个展示。 */
  actorId: string
  /** B 的头像色,fallback var(--warning)。 */
  actorColor?: string | null
  /** Restore 的目标版本号 —— server pageVersions.ts 推 stateless 时附带,
   *  banner 上挂个「v{N}」让 A 知道对方要回滚到哪一版。caller 从 page_locked
   *  _during_restore 的 payload 拿;未传时省略括号内的版本。 */
  versionNumber?: number | null
}>()

const emit = defineEmits<{
  /** user 主动让出 —— EditView 关编辑器,触发 usePageLock.release()。 */
  leave: []
}>()
</script>

<template>
  <div class="page-restoring-banner" role="status" aria-live="polite">
    <span class="material-symbols-outlined banner-icon" aria-hidden="true">history</span>
    <UserAvatar
      :size="20"
      :color="actorColor ?? 'var(--warning, #F5A623)'"
      :label="actorName ?? actorId"
      :user-id="actorId"
    />
    <span class="banner-text">
      <strong>{{ actorName ?? actorId }}</strong>
      正在尝试回滚此页面<template v-if="versionNumber != null">到 v{{ versionNumber }}</template> ·
      <span class="banner-emphasis">回滚会拒绝,直到你离开编辑器</span>。
    </span>
    <div class="banner-actions">
      <button
        type="button"
        class="btn-leave"
        title="让出编辑锁,允许对方继续回滚"
        @click="emit('leave')"
      >
        <span class="material-symbols-outlined icon-sm">logout</span>
        我知道了,让出
      </button>
    </div>
  </div>
</template>

<style scoped>
/* 与 LockBanner / PageDeletingBanner 同款 flex 节奏 —— 同一组 banner
   视觉权重统一。色板换 warning(中黄),icon 换 history,文案换 restore 语义。 */
.page-restoring-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  margin-bottom: 12px;
  background: var(--warning-soft, #FFF7E6);
  border: 1px solid var(--warning, #F5A623);
  border-radius: 4px;
  color: var(--warning-text, #8A5300);
  font-size: 13px;
  font-weight: 500;
}

.banner-icon {
  font-size: 20px;
  color: var(--warning, #F5A623);
  flex-shrink: 0;
  /* wght 500 跟 LockBanner 的 lock / PageDeletingBanner 的 delete_sweep 同款
     —— 同一组 banner 视觉重量统一。 */
  font-variation-settings: 'FILL' 0, 'wght' 500, 'GRAD' 0, 'opsz' 20;
}

.banner-text {
  flex: 1 1 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.banner-emphasis {
  font-weight: 600;
  /* 跟 warning 同色但稍亮 —— 让「拒绝」二字被一眼抓住,跟 PageDeletingBanner
     的 emphasis 节奏一致(同 word,同强调手法)。 */
  color: var(--warning, #F5A623);
}

.banner-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.btn-leave {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: 0;
  border-radius: 3px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  background: var(--warning, #F5A623);
  color: white;
  transition: background 0.12s ease;
}

.btn-leave:hover {
  background: #E09612;
}
</style>