<script setup lang="ts">
/**
 * EmptySpaceOnboarding — 团队空白空间的「三步上手」大卡。
 *
 * 替代原来的「空状态 + 单个创建按钮」。三个并排动作:
 *   1. 建第一个空白页 —— canCreate=false 时置灰 + tooltip
 *   2. 从 Markdown 导入 —— 同上
 *   3. 邀请成员加入 —— 任何角色都可见,emit 由父组件接 invite 流程
 *
 * 三件事都通过 emit 上交,组件本身不持有 store 调用 —— 父组件统一处理
 * 路由跳转 / modal 打开 / toast 兜底,符合「view 管业务,组件管视觉」。
 *
 * 2026-08-07 P0:`/` 重定向到 /me 后,本组件只服务于团队空间(
 * SpaceHomeView 的 EmptySpaceOnboarding 调用点),删掉了原来的
 * `kind: 'personal' | 'shared'` prop。personal 空态由 PersonalHomeView
 * 的 todo card 兜底(1894 行,mainSection === null 时渲染)。
 */
defineProps<{
  spaceName: string
  canCreate: boolean
}>()

const emit = defineEmits<{
  (e: 'create-page'): void
  (e: 'import-markdown'): void
  (e: 'invite-members'): void
}>()
</script>

<template>
  <div class="onboarding">
    <div class="onboarding-illustration" aria-hidden="true">
      <svg viewBox="0 0 240 160" width="240" height="160">
        <rect x="40" y="36" width="120" height="14" rx="3" fill="var(--accent-soft)" />
        <rect x="50" y="58" width="90" height="10" rx="3" fill="var(--bg-subtle)" />
        <rect x="50" y="74" width="100" height="10" rx="3" fill="var(--bg-subtle)" />
        <rect x="50" y="90" width="80" height="10" rx="3" fill="var(--bg-subtle)" />
        <rect x="120" y="20" width="80" height="100" rx="6" fill="var(--bg)" stroke="var(--border)" stroke-width="1.5" />
        <rect x="132" y="34" width="40" height="6" rx="2" fill="var(--accent)" />
        <rect x="132" y="50" width="56" height="4" rx="2" fill="var(--border)" />
        <rect x="132" y="60" width="48" height="4" rx="2" fill="var(--border)" />
        <rect x="132" y="70" width="52" height="4" rx="2" fill="var(--border)" />
        <circle cx="184" cy="118" r="14" fill="var(--accent)" />
        <path d="M 178 118 L 182 122 L 190 114" stroke="var(--bg)" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </div>

    <h2 class="onboarding-title">{{ spaceName }} 还是空的</h2>
    <p class="onboarding-lead">创建第一个页面,开始记录团队的思考、决策和成果。</p>

    <div class="onboarding-grid">
      <article class="ob-card" :class="{ 'is-disabled': !canCreate }">
        <span class="ob-icon material-symbols-outlined">note_add</span>
        <h3 class="ob-title">建第一个空白页</h3>
        <p class="ob-desc">从零开始记录你的思考与想法。</p>
        <button
          type="button"
          class="btn primary ob-cta"
          :disabled="!canCreate"
          :title="canCreate ? '创建一个新的空白页面' : '你在此空间只有只读权限,无法创建新页面'"
          @click="canCreate && emit('create-page')"
        >
          <span class="material-symbols-outlined icon-sm">add</span>
          创建空白页
        </button>
      </article>

      <article class="ob-card" :class="{ 'is-disabled': !canCreate }">
        <span class="ob-icon material-symbols-outlined">upload_file</span>
        <h3 class="ob-title">从 Markdown 导入</h3>
        <p class="ob-desc">把已有的 .md 笔记批量导入,自动建页。</p>
        <button
          type="button"
          class="btn ghost ob-cta"
          :disabled="!canCreate"
          :title="canCreate ? '粘贴或拖入 .md 文件,导入为新页' : '你在此空间只有只读权限,无法导入'"
          @click="canCreate && emit('import-markdown')"
        >
          导入 Markdown…
        </button>
      </article>

      <article class="ob-card">
        <span class="ob-icon material-symbols-outlined">group_add</span>
        <h3 class="ob-title">邀请队友加入</h3>
        <p class="ob-desc">把同事或伙伴拉进来一起记录。</p>
        <button
          type="button"
          class="btn ghost ob-cta"
          @click="emit('invite-members')"
        >
          邀请成员…
        </button>
      </article>
    </div>
  </div>
</template>

<style scoped>
.onboarding {
  max-width: 880px;
  margin: 24px auto 0;
  padding: 24px 8px 40px;
  text-align: center;
}
.onboarding-illustration {
  display: flex;
  justify-content: center;
  margin-bottom: 16px;
}
.onboarding-title {
  font-size: 20px;
  font-weight: 600;
  color: var(--text-1);
  margin: 0 0 6px;
}
.onboarding-lead {
  font-size: 14px;
  color: var(--text-2);
  margin: 0 0 24px;
  line-height: 1.5;
}

.onboarding-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(220px, 1fr));
  gap: 16px;
  text-align: left;
}
.ob-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 20px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  transition: border-color var(--duration-fast) var(--ease-out),
    box-shadow var(--duration-fast) var(--ease-out),
    transform var(--duration-fast) var(--ease-out),
    opacity var(--duration-fast) var(--ease-out);
}
.ob-card:hover {
  border-color: var(--accent);
  box-shadow: var(--shadow-sm);
  transform: translateY(-1px);
}
.ob-card.is-disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.ob-card.is-disabled:hover {
  border-color: var(--border);
  box-shadow: none;
  transform: none;
}

.ob-icon {
  font-size: 28px;
  color: var(--accent);
  line-height: 1;
}
.ob-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-1);
  margin: 0;
}
.ob-desc {
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.5;
  margin: 0;
  flex: 1;
}
.ob-cta {
  align-self: flex-start;
  margin-top: 4px;
}
.ob-cta .material-symbols-outlined {
  font-size: 16px;
  vertical-align: -3px;
  margin-right: 2px;
}
</style>