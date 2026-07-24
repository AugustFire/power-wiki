<script setup lang="ts">
import { computed, ref } from 'vue'
import type { User } from '@power-wiki/shared'
import { presetFileSync } from '@/composables/usePresetAvatars'

const props = withDefaults(
  defineProps<{
    /**
     * Text shown inside the avatar. If a full name is given, the initials
     * are auto-derived (first letter of the first two words). Otherwise the
     * literal label is shown — keeps backwards compat with the old "ME" prop.
     */
    label?: string
    /** 20 / 24 / 28 / 32 / 36 / 40 / 48 / 56 */
    size?: 20 | 24 | 28 | 32 | 36 | 40 | 48 | 56
    /** tooltip */
    title?: string
    /** Background colour. Defaults to the brand accent. */
    color?: string | null
    /** M11 头像形态:由调用方传的 user 对象派生,不传则走 initials+color */
    avatarKind?: User['avatarKind'] | null
    avatarRef?: User['avatarRef'] | null
    /** custom 模式拼 /api/user-avatars/{userId}/raw 用,preset 不需要 */
    userId?: string | null
  }>(),
  { label: 'ME', size: 24, title: '我', color: '', avatarKind: null, avatarRef: null, userId: null },
)

const initials = computed(() => {
  const trimmed = props.label.trim()
  if (!trimmed) return '?'
  // If it looks like a full name (has whitespace or CJK + ASCII mix), take up to
  // first two leading chars. CJK names like "张三" → "张"; English "Alice Smith" → "AS".
  // Single-token labels (legacy "ME") pass through unchanged.
  if (trimmed.length <= 3 && !/\s/.test(trimmed)) return trimmed.toUpperCase()
  // Split on whitespace first; fall back to first two chars if no whitespace.
  const parts = trimmed.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase()
  return trimmed.slice(0, 2).toUpperCase()
})

/* ─────────────────────────────────────────────────────────────────
 *  M11 头像 src 解析 —— 优先级
 *    1. kind === 'custom' && ref && userId → /api/user-avatars/{userId}/raw
 *       (公开流式代理端点,在 apps/api/src/index.ts 独立 router,不带 requireAuth)
 *    2. kind === 'preset' && ref → /avatars/{file}(M11 v2:用 presetFileSync
 *       从 GET /api/avatars/presets 拿到的清单拼 file,扩展名按真实图;
 *       cache 未 ready 时 fallback ${slug}.svg → 错的扩展名 → 404 →
 *       <img @error> 兜底回 initials,见 usePresetAvatars.ts)
 *    3. null → 留空(走 initials 兜底)
 *
 *  任何加载失败(404 / 网络)会触发 <img @error>,把 imgFailed 置 true
 *  后又走回 initials 兜底 —— 用户看到的永远是「头像」或 initials+color。
 * ───────────────────────────────────────────────────────────────── */
const resolvedSrc = computed<string | null>(() => {
  if (props.avatarKind === 'custom' && props.avatarRef && props.userId) {
    // avatarRef 作 query —— 同一个 user 的 raw 端点 URL 不变(后端按
    // users.avatar_ref 决定返哪张),但 src 字符串必须变才能让 <img>
    // 重新发请求并绕开 max-age=300 浏览器缓存;切头像 = ref 变了 = URL
    // 变了 = 浏览器强制 reload
    return `/api/user-avatars/${props.userId}/raw?v=${encodeURIComponent(props.avatarRef)}`
  }
  if (props.avatarKind === 'preset' && props.avatarRef) {
    return `/avatars/${presetFileSync(props.avatarRef)}`
  }
  return null
})

/** <img> 加载失败时拉回 initials。custom ref 被 GC / preset slug 文件丢失
 *  都会触发 → 兜底,不显示碎图 */
const imgFailed = ref(false)

/** 切换 src 时(用户重新选了头像),把上次的失败状态清掉 */
function onImgLoad() {
  imgFailed.value = false
}
function onImgError() {
  imgFailed.value = true
}
</script>

<template>
  <span
    class="user-avatar"
    :class="[`size-${size}`, { 'has-image': resolvedSrc && !imgFailed }]"
    :title="title"
    :aria-label="title"
    role="img"
    :style="!resolvedSrc || imgFailed ? (color ? { background: color } : undefined) : undefined"
  >
    <img
      v-if="resolvedSrc && !imgFailed"
      :src="resolvedSrc"
      alt=""
      draggable="false"
      @load="onImgLoad"
      @error="onImgError"
    />
    <template v-else>{{ initials }}</template>
  </span>
</template>

<style scoped>
.user-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--accent);
  color: var(--text-invert);
  border-radius: 50%;
  font-weight: 600;
  font-family: inherit;
  flex-shrink: 0;
  user-select: none;
  line-height: 1;
  overflow: hidden;
}
.user-avatar.has-image {
  /* 图片自身有底色,不要被 accent 透出来 */
  background: transparent;
}
.user-avatar img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
  /* 平滑收边,Confluence 风格 */
  border-radius: 50%;
}
.size-20 { width: 20px; height: 20px; font-size: 9px;  letter-spacing: 0.02em; }
.size-24 { width: 24px; height: 24px; font-size: 10px; letter-spacing: 0.02em; }
.size-28 { width: 28px; height: 28px; font-size: 11px; letter-spacing: 0.03em; }
.size-32 { width: 32px; height: 32px; font-size: 12px; letter-spacing: 0.04em; }
.size-36 { width: 36px; height: 36px; font-size: 13px; letter-spacing: 0.04em; }
.size-40 { width: 40px; height: 40px; font-size: 14px; letter-spacing: 0.05em; }
.size-48 { width: 48px; height: 48px; font-size: 16px; letter-spacing: 0.05em; }
.size-56 { width: 56px; height: 56px; font-size: 18px; letter-spacing: 0.05em; }
</style>
