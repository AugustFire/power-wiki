<script setup lang="ts">
/**
 * PageActions — 统一容器,把页面顶部的操作按钮(导出 / 关注 / 限制 / 分享 /
 * 编辑等)Teleport 进 #app-subheader,跟面包屑在同一行左右并列。
 *
 * 此前每个 view 自己写 <Teleport to="#app-subheader"><div class="page-actions">。
 * 但 #app-subheader 在 manager 路由(没有 workspace 分支)下不渲染,而 workspace
 * 分支也只在 v-else-if="loaded" 之后才出 ref;路由切换期间后代 view 抢先
 * mount 时,字符串 target 走 querySelector 拿不到元素,Teleport 触发
 * "Failed to locate Teleport target" + 后续 patch 时 null 错误。
 *
 * 跟 <Breadcrumb> 同款:走 inject('appSubheader') 拿到 ref,用 v-if + disabled
 * 双保险;ref 没就绪(targetEl === null)时 Teleport 整个不渲染,等下一帧
 * workspace 分支 mount、ref 赋值后由 reactive 触发重新挂载,不会 race。
 * manager 路由下永远没 ref,自然 fallback 到 disabled + 原地渲染。
 */
import { computed, inject, type Ref } from 'vue'

const subheaderRef = inject<Ref<HTMLElement | null> | null>('appSubheader', null)
const targetEl = computed<HTMLElement | null>(() => subheaderRef?.value ?? null)
const inWorkspace = computed(() => targetEl.value !== null)
</script>

<template>
  <Teleport
    v-if="inWorkspace"
    :to="targetEl"
    :disabled="!inWorkspace"
  >
    <div class="page-actions">
      <slot />
    </div>
  </Teleport>
  <!-- manager / boot 期间 target 还没就绪:原地渲染,等待 reactive
       触发后下次 patch 切到 Teleport 分支。 -->
  <div v-else class="page-actions">
    <slot />
  </div>
</template>
