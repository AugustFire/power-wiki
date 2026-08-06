<!--
  PageDeletingBanner —— M13+ 协同删除 race 收口的「页面正在被人删」横幅。

  触发链路(B → server → A):
    B 调 DELETE /api/pages/:id (软删) 或 ?purge=true (硬删)
      → server pages.ts:assertNoActiveLockForDelete 发现 A 持锁
      → server 推 stateless `page_locked_during_delete { actorId, pageId }`
      → A 端 usePageLock 处理,设 pageDeleting ref
      → EditView 渲染本组件

  UX:
    - 颜色:danger soft(中红),比 LockBanner 的 warning 更紧迫一点 —— 删除
      是不可逆动作,A 必须给出明确的「让出 / 不让出」决策路径。
    - 文字:`{actorName} 正在尝试删除此页面 · 删除会拒绝,直到你离开编辑器`。
      强调「拒绝」(是 server 端用锁闸门挡了删除 + 推 stateless)而非「删了会被回滚」
      —— 跟 Confluence 的语感对齐(被拒绝删除 ≠ 已删除再回滚)。
    - 按钮:`我知道了,让出` —— 调 caller 注入的 onLeave(EditView 里关掉编辑器,
      锁随之释放 → B 重试 DELETE 成功)。**不**做 5min 倒计时:锁 TTL 在
      usePageLock 内部不对外暴露,且用户盯着倒计时也未必会行动,徒增噪音。

  Actor name 解析:usePageLock 已经从 awarenessStates 解析过 holderName;
  caller 把那个 ref 透传即可。未解析到时 fallback 到「有人」,UI 仍可用。
-->
<script setup lang="ts">
import UserAvatar from '@/components/ui/UserAvatar.vue'

const props = defineProps<{
  /** B 的展示名 —— 由 caller 从 usePageLock / awarenessStates 拿。 */
  actorName?: string | null
  /** B 的 id fallback —— usePageLock 没解析到 name 时就用这个展示。 */
  actorId: string
  /** B 的头像色,fallback var(--danger)。 */
  actorColor?: string | null
}>()

const emit = defineEmits<{
  /** user 主动让出 —— EditView 关编辑器,触发 usePageLock.release()。 */
  leave: []
}>()
</script>

<template>
  <div class="page-deleting-banner" role="status" aria-live="polite">
    <span class="material-symbols-outlined banner-icon" aria-hidden="true">delete_sweep</span>
    <UserAvatar
      :size="20"
      :color="actorColor ?? 'var(--danger, #FF5630)'"
      :label="actorName ?? actorId"
      :user-id="actorId"
    />
    <span class="banner-text">
      <strong>{{ actorName ?? actorId }}</strong>
      正在尝试删除此页面 ·
      <span class="banner-emphasis">删除会拒绝,直到你离开编辑器</span>。
    </span>
    <div class="banner-actions">
      <button
        type="button"
        class="btn-leave"
        title="让出编辑锁,允许对方继续删除"
        @click="emit('leave')"
      >
        <span class="material-symbols-outlined icon-sm">logout</span>
        我知道了,让出
      </button>
    </div>
  </div>
</template>

<style scoped>
/* 与 LockBanner 同款 flex 节奏:icon + avatar + text + actions,gap 10px。
   唯一差别是色板换 danger,文案换删除语义。 */
.page-deleting-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  margin-bottom: 12px;
  background: var(--danger-soft, #FFEBE6);
  border: 1px solid var(--danger, #FF5630);
  border-radius: 4px;
  color: var(--danger-text, #BF2600);
  font-size: 13px;
  font-weight: 500;
}

/* icon 比 LockBanner 的 lock 再大一档(20 vs 18)—— 删除的紧迫性比锁高。 */
.banner-icon {
  font-size: 20px;
  color: var(--danger, #FF5630);
  flex-shrink: 0;
  /* wght 500 跟 LockBanner 的 lock 一致 —— 同一组 banner 视觉重量统一。 */
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
  /* 跟 danger-text 同色但稍亮 —— 让「拒绝」二字被一眼抓住 */
  color: var(--danger, #FF5630);
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
  background: var(--danger, #FF5630);
  color: white;
  transition: background 0.12s ease;
}

.btn-leave:hover {
  background: var(--danger-hover, #C9371F);
}
</style>
