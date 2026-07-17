<script setup lang="ts">
/**
 * SettingsDrawer — P1-6 + M11 用户自助修改姓名 / 颜色 / 头像。
 *
 *   入口:UserMenu 「设置」 → uiStore.openSettings()
 *   渲染于 App.vue 顶层(mounted once at boot),实际门户只受
 *   uiStore.settingsDrawerOpen 控制。
 *
 * 显示策略:
 *   - 抽屉打开时 GET /api/users/me 拉一次最新数据,保证看的是后端真值
 *     而不是可能过时的 authStore.user(后台 admin 改了你的头像,这里要同步)。
 *   - 表单本地 dirty state;Close / Esc / backdrop 都不污染。
 *   - 保存后 PATCH /api/users/me 返新 User,直接写回 authStore.user →
 *     TopBar 头像、ActivityView actor 名、Sidebar owner 名同步刷新。
 *
 * M11 头像三态(Plan §决策 a):
 *   - kind === null:用 initials + color
 *   - kind === 'preset':ref = AVATAR_PRESETS 里的 slug
 *   - kind === 'custom':ref = user_avatars.id,渲染走 /api/user-avatars/{id}/raw
 *   三态互斥,UI 上分三 panel(颜色 / 预制 / 上传),点选即改 editAvatar。
 *   互斥逻辑不在 UI 控制 —— <UserAvatar> 渲染优先级就是优先级 (custom > preset > initials)。
 *
 * 颜色 picker 永久可点 —— 颜色是字母头像的背景色,选了 preset/custom 时改了
 * 不可见(图覆盖),但下次清头像时即时生效。
 *
 * Per CLAUDE.md "不主动 commit / push":changes stay local;user says
 * "提交吧" before any git commit/push.
 */
import { computed, ref, watch } from 'vue'
import Drawer from '@/components/ui/Drawer.vue'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import AvatarCropper, { type CroppedAvatarPayload } from '@/components/AvatarCropper.vue'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import { useToast } from '@/composables/useToast'
import { useUserAvatarUpload } from '@/composables/useUserAvatarUpload'
import { usePresetAvatars, presetFileSync } from '@/composables/usePresetAvatars'
import { api, ApiError } from '@/lib/api'
import {
  AVATAR_ALLOWED_MIME,
  AVATAR_UPLOAD_MAX_BYTES,
  type AvatarAllowedMime,
  type AvatarSelectInput,
  type User,
} from '@power-wiki/shared'

const authStore = useAuthStore()
const uiStore = useUiStore()
const toast = useToast()
const { upload, abort: abortUpload } = useUserAvatarUpload()
/** M11 v2:预设头像清单由后端扫盘提供,模块顶层 cache + reactive presets。
 *  见 apps/web/src/composables/usePresetAvatars.ts。 */
const { presets } = usePresetAvatars()

/** Picker 改色 — 8 个 Atlassian palette 常用色,加一个 native picker。
 *  hex 必须满足 UpdateUserInputSchema 的 /^#[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?$/,
 *  否则后端 400。换色时大小写统一用大写,UI 渲染一致。 */
const PALETTE = [
  '#0052CC', // blue
  '#36B37E', // green
  '#FF5630', // red
  '#FF8B00', // orange
  '#6554C0', // purple
  '#00B8D9', // teal
  '#172B4D', // dark
  '#5E6C84', // slate
] as const

/** MIME → 人类可读文案(toast / error 用)。 */
const MIME_HUMAN: Record<AvatarAllowedMime, string> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/webp': 'WEBP',
  'image/gif': 'GIF',
}

const open = computed({
  get: () => uiStore.settingsDrawerOpen,
  set: (v) => (v ? uiStore.openSettings() : uiStore.closeSettings()),
})

const editName = ref('')
const editColor = ref('#0052CC')
/** M11: 头像三态本地编辑态。`null` = 用 initials+color 兜底。
 *  赋值后 user 只看到状态被改,真正落库要等 onSave 一次性 PATCH。 */
const editAvatar = ref<AvatarSelectInput | null>(null)
const livePreview = ref<User | null>(null)
const loading = ref(false)
const saving = ref(false)
const errorMsg = ref<string | null>(null)
/** 保存成功后的「✓ 已保存」按钮态 — 1.8s 绿底,然后回落 disable。
 *  对齐 TrashView 保留期按钮的反馈通道:`docs/loading-ux.md` 第 17 节
 *  说「用户在按钮上看着」就用按钮态,不弹 toast。 */
const justSaved = ref(false)
let savedTimer: ReturnType<typeof setTimeout> | null = null

// 修改密码 — 独立 ref + 独立 error(改密失败不能污染 name/color/avatar 的
// dirty/save 状态)。ResetPasswordInputSchema 已经在后端做了长度校验
// (8-128),前端只校验「两次输入一致」+ 实时展示规则。
const currentPwd = ref('')
const newPwd = ref('')
const confirmPwd = ref('')
const changingPwd = ref(false)
const pwdError = ref<string | null>(null)
const pwdOpen = ref(false)
/** 三个密码输入框独立的「显示明文」开关 —— 默认隐藏,用户点眼睛图标切换 */
const showCurrentPwd = ref(false)
const showNewPwd = ref(false)
const showConfirmPwd = ref(false)

/**
 * 新密码强度 —— 4 档(level 0-3):
 *   0  < 8 位                 → 太短
 *   1  ≥ 8 位,只有小写/大写/数字之一  → 弱
 *   2  ≥ 8 位,两类组合       → 中
 *   3  ≥ 8 位,三类或更多      → 强
 * label 给中文文案,UI 用 --strength-color 配色
 */
const pwdStrength = computed(() => {
  const p = newPwd.value
  if (p.length === 0) return { level: 0, label: '' }
  if (p.length < 8) return { level: 0, label: '至少 8 位' }
  const hasLower = /[a-z]/.test(p)
  const hasUpper = /[A-Z]/.test(p)
  const hasDigit = /[0-9]/.test(p)
  const hasSym = /[^a-zA-Z0-9]/.test(p)
  const kinds = [hasLower, hasUpper, hasDigit, hasSym].filter(Boolean).length
  if (kinds <= 1) return { level: 1, label: '弱 — 试试混合大小写' }
  if (kinds === 2) return { level: 2, label: '中' }
  return { level: 3, label: '强' }
})

/* ─────────────────────────────────────────────────────────────────
 *  上传 widget 局部状态(只控制 UI,真正上传由 composable 接管)
 * ───────────────────────────────────────────────────────────────── */
const uploadInput = ref<HTMLInputElement | null>(null)
const uploading = ref(false)
/** Drag-over 视觉态 —— 只用于 .is-dragover class。 */
const isDragOver = ref(false)
/** M11 v3 polish:上传面板是否展开。默认收起 → 只显示一个紧凑按钮,
 *  点「上传/替换」按钮才展开 → 出现虚线圆 / 裁剪器 / 取消按钮。 */
const uploadExpanded = ref(false)
/* M11 v3:裁剪器状态。
 *  cropperFile  非 null → 显示 AvatarCropper(图已加载,可拖)
 *  croppingBlob cropper emit 的最新 blob,「保存头像」按钮从这里读
 *  cropperRef  ref 到 cropper 实例,显式调 commit() 拿最终值(无节流)
 */
const cropperFile = ref<File | null>(null)
const croppingBlob = ref<CroppedAvatarPayload | null>(null)
const cropperRef = ref<InstanceType<typeof AvatarCropper> | null>(null)

/** 同步表单到 authStore.user。打开抽屉时调一次,保存成功后也调一次。 */
function syncFormFromUser(u: User | null) {
  if (!u) return
  editName.value = u.name
  editColor.value = u.color.toUpperCase()
  // 三态互斥。AvatarSelectInput 推导成 discriminated union,这里显式按
  // kind 分支填充 ref 后赋给 ref。mutable 一次不阻塞 dispatch。
  const kind = u.avatarKind ?? null
  editAvatar.value =
    kind === null
      ? ({ kind: null, ref: null } as AvatarSelectInput)
      : ({ kind, ref: u.avatarRef ?? '' } as AvatarSelectInput)
  livePreview.value = {
    ...u,
    name: editName.value,
    color: editColor.value,
    avatarKind: kind,
    avatarRef: u.avatarRef ?? null,
  }
}

/** 打开时拉一次最新 user,关时重置。watch 比 onMounted+close 容易处理副作用。 */
watch(open, async (isOpen) => {
  if (isOpen) {
    loading.value = true
    errorMsg.value = null
    justSaved.value = false
    if (savedTimer != null) {
      clearTimeout(savedTimer)
      savedTimer = null
    }
    try {
      const fresh = await api.users.me.get()
      syncFormFromUser(fresh)
      // 后端真值盖掉 authStore(防止 stale)
      authStore.user = fresh
    } catch (e) {
      // 拿不到就用 store 现有的兜底 — 不要因为 meta 失败就让用户开不到抽屉
      errorMsg.value = e instanceof ApiError ? e.message : '加载用户信息失败'
      syncFormFromUser(authStore.user)
    } finally {
      loading.value = false
    }
  } else {
    errorMsg.value = null
    saving.value = false
    uploading.value = false
    justSaved.value = false
    if (savedTimer != null) {
      clearTimeout(savedTimer)
      savedTimer = null
    }
    // 关闭抽屉时清掉裁剪器 state(下次开抽屉从干净态开始)
    cropperFile.value = null
    croppingBlob.value = null
    uploadExpanded.value = false
    if (uploadInput.value) uploadInput.value.value = ''
    isDragOver.value = false
    abortUpload()
    // 关闭抽屉时清掉密码可见性 toggle(下次开抽屉从隐藏态开始,符合安全默认)
    showCurrentPwd.value = false
    showNewPwd.value = false
    showConfirmPwd.value = false
  }
})

/** Live preview 跟手 — 不打后端,只刷新右上角预览头像 + 文案预览 */
function updatePreviewName(name: string) {
  editName.value = name
  if (livePreview.value) {
    livePreview.value = { ...livePreview.value, name }
  }
}
function updatePreviewColor(color: string) {
  const normalized = color.toUpperCase()
  editColor.value = normalized
  // 选颜色 → 自动切到字母头像形态
  //(用户模型:颜色 = 字母头像背景,跟 image 互斥;
  // 不再让用户在 image 模式下点颜色看不出效果)
  if (editAvatar.value && editAvatar.value.kind !== null) {
    editAvatar.value = { kind: null, ref: null }
    if (livePreview.value) {
      livePreview.value = { ...livePreview.value, avatarKind: null, avatarRef: null }
    }
  }
  if (livePreview.value) {
    livePreview.value = { ...livePreview.value, color: normalized }
  }
}

const editPreviewColor = computed(() => editColor.value)

/* ─────────────────────────────────────────────────────────────────
 *  M11 头像三态 UI 切换
 *    pickPreset(slug)   — editAvatar = { kind: 'preset', ref: slug }
 *    pickCustom(id)     — editAvatar = { kind: 'custom', ref: id }(由上传 callback 提供)
 *    clearAvatar()      — editAvatar = { kind: null, ref: null }(回退 initials+color)
 *
 *  selectedKind (computed from editAvatar): 用于 UI 高亮当前 panel。
 * ───────────────────────────────────────────────────────────────── */
const selectedKind = computed<null | 'preset' | 'custom'>(() => {
  const e = editAvatar.value
  return e ? e.kind : null
})

function pickPreset(slug: string) {
  editAvatar.value = { kind: 'preset', ref: slug as never }
  if (livePreview.value) {
    livePreview.value = { ...livePreview.value, avatarKind: 'preset', avatarRef: slug }
  }
  // 切 preset 时清掉裁剪器 state(无关,但避免视觉残留)
  clearCropperState()
}

function clearAvatar() {
  editAvatar.value = { kind: null, ref: null }
  if (livePreview.value) {
    livePreview.value = { ...livePreview.value, avatarKind: null, avatarRef: null }
  }
  clearCropperState()
}

function clearCropperState() {
  cropperFile.value = null
  croppingBlob.value = null
  uploadExpanded.value = false
  if (uploadInput.value) uploadInput.value.value = ''
}

/** 展开上传面板 ——「上传自定义头像」/「替换」按钮触发。
 *  不主动清 cropperFile —— 如果用户正在 cropper 里,保留状态。
 *  此函数语义是「进入上传流程」,不是「重置裁剪器」。 */
function openCropper() {
  uploadExpanded.value = true
  if (uploading.value) return
  // 自动打开 file picker,让用户选文件
  triggerUpload()
}

/** 收起上传面板 ——「取消」按钮 / 抽屉关闭时调。
 *  清掉 cropperFile / croppingBlob,回到紧凑按钮态。 */
function closeCropper() {
  if (uploading.value) return  // 上传中不允许取消
  clearCropperState()
}

/* ─────────────────────────────────────────────────────────────────
 *  上传 widget — M11 v3:选文件后先进 AvatarCropper,「保存头像」按钮才上传
 *  - click trigger → 打开 file picker
 *  - change / drop → validateFile → cropperFile(file) → 裁剪器显示
 *  -「保存头像」按钮 → cropperRef.commit() 拿最终 blob → 上传 + finalize
 *  -「重选」按钮 → 清 cropperFile + triggerUpload 重开 picker
 * ───────────────────────────────────────────────────────────────── */
function triggerUpload() {
  uploadInput.value?.click()
}

/** MIME 白名单 + 体积上限校验 — onFileChosen / onFileDropped 复用。返
 *  true 表示通过,errorMsg 已填好(失败时);失败时也会 reset input.value。 */
function validateFile(file: File): boolean {
  const mime = file.type as AvatarAllowedMime | ''
  if (!mime || !(AVATAR_ALLOWED_MIME as readonly string[]).includes(mime)) {
    errorMsg.value = `不支持的文件类型:${file.type || '未知'}。仅支持 ${Object.values(MIME_HUMAN).join('/')}`
    if (uploadInput.value) uploadInput.value.value = ''
    return false
  }
  if (file.size > AVATAR_UPLOAD_MAX_BYTES) {
    errorMsg.value = `文件超过 ${Math.round(AVATAR_UPLOAD_MAX_BYTES / 1024 / 1024)}MB 上限`
    if (uploadInput.value) uploadInput.value.value = ''
    return false
  }
  return true
}

function onFileChosen(e: Event) {
  const target = e.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return
  if (!validateFile(file)) return
  errorMsg.value = null
  cropperFile.value = file
  croppingBlob.value = null
  // 收起态(v-if 虚线圆)选完文件后必须展开,否则 cropperFile 设了但模板还
  // 停在 v-if 分支,用户感知「选完啥都没发生」
  uploadExpanded.value = true
}

function onFileDropped(e: DragEvent) {
  isDragOver.value = false
  const file = e.dataTransfer?.files?.[0]
  if (!file) return
  if (!validateFile(file)) return
  errorMsg.value = null
  cropperFile.value = file
  croppingBlob.value = null
  uploadExpanded.value = true
}

/** cropper 实时 emit(200ms 节流)的当前裁剪 blob —— 「保存头像」按钮
 *  之前会先调 cropperRef.commit() 立即 emit 一次最终值(无节流),
 *  这里把 emit 结果存住供 upload() 消费。 */
function onCropEvent(payload: CroppedAvatarPayload) {
  croppingBlob.value = payload
}

/** AvatarCropper 内部 createImageBitmap / render 失败兜底 —— 错误冒泡到这里,
 *  清 cropperFile 让用户回到选文件状态;error 条也会同时显示。
 *  不弹 toast:错误条已经在用户眼前(UserMenu 顶部抽屉里),toast 冗余。 */
function onCropperError(payload: { message: string }) {
  errorMsg.value = payload.message
  clearCropperState()
}

/** 「保存头像」按钮 — 一步完成:cropper commit → upload 到 MinIO →
 *  finalize 写 user_avatars 行 → PATCH /me 写 users.avatar_kind/ref。
 *  不再依赖底部 footer「保存」按钮(用户认知错位)。 */
async function onCropSave() {
  if (uploading.value || !cropperFile.value) return
  // 强制让 cropper emit 当前 view 的最终 blob(无节流)
  const final = await cropperRef.value?.commit()
  // cropper emit 同步触发 onCropEvent → croppingBlob 已有值;为防御
  // 极少数情况(ref 未挂 / emit 失败),fallback 用 final 直接上传
  const blob = croppingBlob.value?.blob ?? final?.blob
  if (!blob) {
    errorMsg.value = '裁剪结果未就绪,请重试'
    return
  }
  const payload = croppingBlob.value ?? final
  if (!payload) {
    errorMsg.value = '裁剪结果未就绪,请重试'
    return
  }
  uploading.value = true
  errorMsg.value = null
  try {
    const { avatarId } = await upload(
      blob,
      payload.mime,
      payload.width,
      payload.height,
    )
    // 直接 PATCH /me,把 users.avatar_kind/ref 一次性写进去
    // (与 onSave 走同一 API,但不走底部按钮 —— 用户在 Panel C 就完成全部动作)
    const updated = await api.users.me.update({
      name: editName.value.trim(),
      color: editColor.value,
      avatar: { kind: 'custom', ref: avatarId },
    })
    authStore.user = updated
    syncFormFromUser(updated)
    // 反馈通道跟 onSave 对齐:按钮态变「✓ 已保存」绿底 1.8s
    justSaved.value = true
    if (savedTimer != null) clearTimeout(savedTimer)
    savedTimer = setTimeout(() => {
      justSaved.value = false
      savedTimer = null
    }, 1800)
    editAvatar.value = { kind: 'custom', ref: avatarId }
    if (livePreview.value) {
      livePreview.value = {
        ...livePreview.value,
        avatarKind: 'custom',
        avatarRef: avatarId,
      }
    }
    clearCropperState()  // uploadExpanded=false → 面板自动收回到 thumbnail + 替换/移除
  } catch (err) {
    errorMsg.value = err instanceof ApiError ? err.message : (err instanceof Error ? err.message : '上传失败')
    // 保留 cropperFile,允许用户重试
  } finally {
    uploading.value = false
  }
}

/** 「重选」按钮 —— 清裁剪器 state,重开 file picker。 */
function onCropReselect() {
  cropperFile.value = null
  croppingBlob.value = null
  triggerUpload()
}

/** 已有头像时,「移除」按钮:DELETE /api/users/me/avatar/custom + 清 pending + 清 editAvatar。
 *  后端会自动 best-effort 删 user_avatars 行 + S3 对象。 */
async function removeCustom() {
  uploading.value = true
  errorMsg.value = null
  try {
    await api.users.me.removeAvatar()
    editAvatar.value = { kind: null, ref: null }
    if (livePreview.value) {
      livePreview.value = { ...livePreview.value, avatarKind: null, avatarRef: null }
    }
    clearCropperState()
  } catch (e) {
    errorMsg.value = e instanceof ApiError ? e.message : '清除失败'
  } finally {
    uploading.value = false
  }
}

/** 是否有未保存改动。 */
const dirty = computed(() => {
  const u = authStore.user
  if (!u) return false
  const nameChanged = editName.value.trim() !== u.name
  const colorChanged = editColor.value.toUpperCase() !== u.color.toUpperCase()
  // avatar 三态比较
  const prevKind = u.avatarKind ?? null
  const prevRef = u.avatarRef ?? null
  const curKind = editAvatar.value?.kind ?? null
  const curRef = editAvatar.value?.ref ?? null
  const avatarChanged = prevKind !== curKind || prevRef !== curRef
  return nameChanged || colorChanged || avatarChanged
})

const nameInvalid = computed(
  () => editName.value.trim().length === 0 || editName.value.length > 64,
)

/**
 * 新密码是否与当前密码相同。ResetPasswordView 已有同名 computed,
 * SettingsDrawer 之前漏了这个检查(改密 = 拿 A 改 A 等于没改)。
 * 后端 ResetPasswordInputSchema refine 也卡这层(前后端共用一条规则,
 * 前端拦住让用户即时看到 hint,后端兜底防绕过)。
 */
const pwdSameAsCurrent = computed(
  () =>
    newPwd.value.length > 0 &&
    currentPwd.value.length > 0 &&
    newPwd.value === currentPwd.value,
)

/** 改密表单的就绪态 — 8 字符以上 / 两次输入一致 / 当前密码非空 / 新旧不同。 */
const pwdReady = computed(
  () =>
    currentPwd.value.length > 0 &&
    newPwd.value.length >= 8 &&
    newPwd.value === confirmPwd.value &&
    !pwdSameAsCurrent.value,
)

async function onChangePassword() {
  if (changingPwd.value || !pwdReady.value) return
  changingPwd.value = true
  pwdError.value = null
  try {
    // 后端 ResetPasswordInputSchema 已经校验 currentPassword 非空 /
    // newPassword 8-128 字符。前端 8 字符 + 两次一致已对得上,但仍走
    // 真实请求,后端是最终事实。
    const r = await api.auth.resetPassword({
      currentPassword: currentPwd.value,
      newPassword: newPwd.value,
    })
    // 后端 status → 'active',会返新 user;同步 authStore 让顶栏 / 其他 view 刷新
    authStore.user = r.user
    // 清空输入 — 敏感字段不留在 DOM
    currentPwd.value = ''
    newPwd.value = ''
    confirmPwd.value = ''
    // 折叠 + 清空 3 个 password input 是「改密成功」的就地反馈(用户
    // 在抽屉里看着,toast 冗余);但 kickedSessions 是「安全相关」的副
    // 效果 —— 用户大概率没想到改密码会自动踢其他设备,显式 toast 一句
    // 「已退出其他 N 个设备」让他确认动作已生效。
    pwdOpen.value = false
    if (r.kickedSessions > 0) {
      toast.info(`已退出其他 ${r.kickedSessions} 个设备的登录`, 2500)
    }
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      pwdError.value = '当前密码不正确'
    } else if (e instanceof ApiError && e.status === 400) {
      pwdError.value = e.message || '新密码格式不正确'
    } else {
      pwdError.value = e instanceof ApiError ? e.message : '改密失败'
    }
  } finally {
    changingPwd.value = false
  }
}

async function onSave() {
  if (saving.value || !dirty.value || nameInvalid.value) return
  saving.value = true
  errorMsg.value = null
  try {
    const updated = await api.users.me.update({
      name: editName.value.trim(),
      color: editColor.value,
      avatar: editAvatar.value ?? undefined,
    })
    authStore.user = updated
    syncFormFromUser(updated)
    // 不弹 toast:按钮态(绿底「✓ 已保存」1.8s)就是反馈,
    // 用户就在抽屉里盯着保存按钮,toast 是冗余。
    if (savedTimer != null) clearTimeout(savedTimer)
    justSaved.value = true
    savedTimer = setTimeout(() => {
      justSaved.value = false
      savedTimer = null
    }, 1800)
  } catch (e) {
    if (e instanceof ApiError && e.status === 400) {
      errorMsg.value = '姓名 / 颜色 / 头像格式不正确'
    } else {
      errorMsg.value = e instanceof ApiError ? e.message : '保存失败'
    }
  } finally {
    saving.value = false
  }
}

function onReset() {
  if (!authStore.user) return
  syncFormFromUser(authStore.user)
  errorMsg.value = null
  clearCropperState()
}

/** 头像当前的 src —— 给大预览用(Panel A 顶部) */
const previewAvatarSrc = computed<string | null>(() => {
  const lp = livePreview.value
  if (!lp) return null
  if (lp.avatarKind === 'custom' && lp.avatarRef && lp.id) {
    // avatarRef 作 query —— 切头像时让 <img> 强制重新发请求(原 URL
    // /raw 在 user 不变时是同一字符串,浏览器会走 max-age=300 缓存)
    return `/api/user-avatars/${lp.id}/raw?v=${encodeURIComponent(lp.avatarRef)}`
  }
  // M11 v2:preset 走 presetFileSync 拿真实 file,扩展名按图定
  if (lp.avatarKind === 'preset' && lp.avatarRef) {
    return `/avatars/${presetFileSync(lp.avatarRef)}`
  }
  return null
})
</script>

<template>
  <Drawer v-model:open="open" title="个人设置" :width="520">
    <div class="settings-drawer">
      <p class="lead">
        姓名、颜色和头像 — 一改即生效,顶栏、@提及和活动流会同步刷新。
      </p>

      <div v-if="loading" class="loading-state">加载中…</div>

      <div v-else class="settings-body">
        <!-- Section 1: 预览卡 —— 跟其他 section 同形白底卡,无渐变
             56px 头像 + 姓名 + email 横排,作为「当前自己」的视觉锚点
             跟姓名 / 头像 / 设置密码 视觉重量对齐,共用 .section-card -->
        <section class="section-card section-card--preview">
          <UserAvatar
            :size="56"
            :label="livePreview?.name ?? authStore.user?.name ?? '?'"
            :color="editPreviewColor"
            :avatar-kind="livePreview?.avatarKind ?? null"
            :avatar-ref="livePreview?.avatarRef ?? null"
            :user-id="livePreview?.id ?? null"
          />
          <div class="preview-meta">
            <div class="preview-name">{{ livePreview?.name ?? '—' }}</div>
            <div class="preview-email">{{ authStore.user?.email ?? '' }}</div>
          </div>
        </section>

        <!-- Section 2: 姓名 —— 标准白底卡,带 icon 的 sd-label -->
        <section class="section-card">
          <div class="sd-label">
            <span class="material-symbols-outlined">person</span>
            姓名
          </div>
          <label class="field">
            <input
              v-model="editName"
              type="text"
              class="field-input"
              maxlength="64"
              autocomplete="name"
              placeholder="你的显示名"
              @input="updatePreviewName(($event.target as HTMLInputElement).value)"
            />
            <span v-if="nameInvalid" class="field-hint error">
              姓名不能为空,且不能超过 64 个字符
            </span>
          </label>
        </section>

        <!-- Section 3: M11 头像三态 picker —— 标准白底卡 + icon sd-label
             三个 panel(插画 / 颜色 / 自定义上传)各自带 label,
             跟 .sd-label 共用排版语言 -->
        <section class="section-card section-card--avatar">
          <div class="sd-label">
            <span class="material-symbols-outlined">face</span>
            头像
          </div>

          <!-- Panel A 插画头像(M11 v2:运行时扫盘,放新图进
               apps/web/public/avatars/ 即可出现在这里) -->
          <div class="avatar-panel" :class="{ active: selectedKind === 'preset' }">
            <div class="avatar-panel-label">
              <span class="material-symbols-outlined">palette</span>
              插画
              <span v-if="selectedKind === 'preset'" class="mode-check material-symbols-outlined">check_circle</span>
            </div>
            <div v-if="presets.length === 0" class="preset-loading">
              加载预设中…
            </div>
            <div v-else class="preset-grid">
              <button
                v-for="p in presets"
                :key="p.slug"
                type="button"
                class="preset-cell"
                :class="{ active: selectedKind === 'preset' && editAvatar?.ref === p.slug }"
                :aria-pressed="selectedKind === 'preset' && editAvatar?.ref === p.slug"
                :title="p.slug"
                @click="pickPreset(p.slug)"
              >
                <img :src="`/avatars/${p.file}`" :alt="p.slug" draggable="false" />
              </button>
            </div>
          </div>

          <!-- Panel B 颜色 picker —— 三态之一:点色块切到「字母 + 色」模式。
               跟插画 / 自定义 互斥。 -->
          <div class="avatar-panel" :class="{ active: selectedKind === null }">
            <div class="avatar-panel-label">
              <span class="material-symbols-outlined">format_color_fill</span>
              颜色
              <span v-if="selectedKind === null" class="mode-check material-symbols-outlined">check_circle</span>
              <span v-else class="panel-hint">点色块切到字母头像</span>
            </div>
            <div class="palette">
              <button
                v-for="c in PALETTE"
                :key="c"
                type="button"
                class="palette-swatch"
                :class="{
                  active:
                    selectedKind === null &&
                    editColor.toUpperCase() === c.toUpperCase(),
                }"
                :style="{ background: c }"
                :title="c"
                :aria-label="`选择颜色 ${c}`"
                @click="updatePreviewColor(c)"
              ></button>
              <label
                class="palette-custom"
                title="自定义颜色(字母头像背景)"
              >
                <input
                  type="color"
                  :value="editColor"
                  aria-label="自定义颜色"
                  @input="updatePreviewColor(($event.target as HTMLInputElement).value)"
                />
                <span class="material-symbols-outlined">colorize</span>
              </label>
            </div>
            <span class="field-hint">{{ editColor }}</span>
          </div>

          <!-- Panel C 自定义上传 —— 三态之一,跟插画 / 颜色 互斥 -->
          <div class="avatar-panel" :class="{ active: selectedKind === 'custom' }">
            <!-- 始终挂载的 file input —— 收起态(v-if / v-else-if)和展开态
                 (v-else)三处 upload-zone 都通过 triggerUpload() 调用 input.click();
                 放在 .avatar-panel 直接子级、跟三个 branch 同级,确保
                 uploadExpanded=false 时虚线圆也能开 picker,否则 input ref 为
                 null → .click() 静默 no-op,用户感知「点了没反应」 -->
            <input
              ref="uploadInput"
              type="file"
              :accept="(AVATAR_ALLOWED_MIME as readonly string[]).join(',')"
              class="upload-input-hidden"
              @change="onFileChosen"
            />
            <div class="avatar-panel-label">
              <span class="material-symbols-outlined">add_photo_alternate</span>
              自定义上传
              <span v-if="selectedKind === 'custom'" class="mode-check material-symbols-outlined">check_circle</span>
            </div>

            <!-- 收起态 1:无 custom 头像 —— 直接显示 dashed circle affordance,
                 click / drag 都开 file picker,跟展开态同一 markup,
                 三 panel 视觉权重平衡,少一次「按钮 → 圆」中间态 -->
            <div
              v-if="!uploadExpanded && selectedKind !== 'custom'"
              class="upload-zone"
              :class="{
                uploading,
                'is-dragover': isDragOver,
              }"
              role="button"
              tabindex="0"
              aria-label="上传自定义头像"
              :aria-disabled="uploading"
              @click="!uploading && triggerUpload()"
              @keydown.enter.prevent="!uploading && triggerUpload()"
              @keydown.space.prevent="!uploading && triggerUpload()"
              @dragover.prevent="isDragOver = true"
              @dragenter.prevent="isDragOver = true"
              @dragleave.prevent="isDragOver = false"
              @drop.prevent="onFileDropped"
            >
              <template v-if="uploading">
                <span class="material-symbols-outlined is-loading">progress_activity</span>
              </template>
              <template v-else>
                <span class="material-symbols-outlined">add_photo_alternate</span>
              </template>
            </div>
            <!-- 圆下提示:收起态 1 跟展开态同样展示 MIME / size 限制 -->
            <div v-if="!uploadExpanded && selectedKind !== 'custom'" class="upload-meta">
              点击或拖入 {{ Object.values(MIME_HUMAN).join('/') }} 图片(≤ {{ Math.round(AVATAR_UPLOAD_MAX_BYTES / 1024 / 1024) }} MB)
            </div>

            <!-- 收起态 2:已有 custom 头像,显示缩略图 + 替换 / 移除 icon -->
            <div
              v-else-if="!uploadExpanded && selectedKind === 'custom'"
              class="upload-summary"
            >
              <UserAvatar
                :size="48"
                :label="livePreview?.name ?? '?'"
                :color="editPreviewColor"
                :avatar-kind="'custom'"
                :avatar-ref="editAvatar?.ref ?? null"
                :user-id="livePreview?.id ?? null"
              />
              <span class="upload-summary-text">自定义头像已设置</span>
              <div class="upload-actions">
                <button
                  type="button"
                  class="btn-icon"
                  aria-label="替换图片"
                  :disabled="uploading"
                  @click="openCropper"
                >
                  <span class="material-symbols-outlined">refresh</span>
                </button>
                <button
                  type="button"
                  class="btn-icon btn-icon-danger"
                  aria-label="移除自定义头像"
                  :disabled="uploading"
                  @click="removeCustom"
                >
                  <span class="material-symbols-outlined">delete</span>
                </button>
              </div>
            </div>

            <!-- 展开态:虚线圆 / 裁剪器 + 取消按钮 -->
            <template v-else>
              <!-- 虚线圆:展开但还没选文件 -->
              <div
                v-if="!cropperFile"
                class="upload-zone"
                :class="{
                  uploading,
                  'is-dragover': isDragOver,
                }"
                role="button"
                tabindex="0"
                aria-label="选择自定义头像"
                :aria-disabled="uploading"
                @click="!uploading && triggerUpload()"
                @keydown.enter.prevent="!uploading && triggerUpload()"
                @keydown.space.prevent="!uploading && triggerUpload()"
                @dragover.prevent="isDragOver = true"
                @dragenter.prevent="isDragOver = true"
                @dragleave.prevent="isDragOver = false"
                @drop.prevent="onFileDropped"
              >
                <template v-if="uploading">
                  <span class="material-symbols-outlined is-loading">progress_activity</span>
                </template>
                <template v-else>
                  <span class="material-symbols-outlined">add_photo_alternate</span>
                </template>
              </div>

              <!-- 裁剪器:已选文件,拖动定位 -->
              <template v-else>
                <div class="cropper-wrap">
                  <AvatarCropper
                    ref="cropperRef"
                    :file="cropperFile"
                    :size="256"
                    @crop="onCropEvent"
                    @commit="onCropEvent"
                    @error="onCropperError"
                  />
                </div>
                <div class="cropper-hint">拖动图调整位置</div>
              </template>

              <!-- 圆下提示 -->
              <div v-if="!cropperFile" class="upload-meta">
                点击或拖入 {{ Object.values(MIME_HUMAN).join('/') }} 图片(≤ {{ Math.round(AVATAR_UPLOAD_MAX_BYTES / 1024 / 1024) }} MB)
              </div>

              <!-- file input 已上提到 .avatar-panel 直接子级,任何 upload-zone
                   状态(triggerUpload)都能命中 -->

              <!-- 展开态按钮行 -->
              <div class="upload-actions">
                <!-- 已选文件:保存 / 重选 -->
                <template v-if="cropperFile">
                  <button
                    type="button"
                    class="btn-icon btn-icon-primary"
                    aria-label="保存头像"
                    :disabled="uploading"
                    @click="onCropSave"
                  >
                    <template v-if="uploading">
                      <span class="material-symbols-outlined is-loading">progress_activity</span>
                    </template>
                    <template v-else>
                      <span class="material-symbols-outlined">check</span>
                    </template>
                  </button>
                  <button
                    type="button"
                    class="btn-icon"
                    aria-label="重选图片"
                    :disabled="uploading"
                    @click="onCropReselect"
                  >
                    <span class="material-symbols-outlined">refresh</span>
                  </button>
                </template>
                <!-- 返回 —— 把展开面板收回到「+ 上传自定义头像」按钮态;
                     跟 footer 的「放弃修改」(放弃所有改动)语义不同 -->
                <button
                  v-if="cropperFile"
                  type="button"
                  class="btn-icon"
                  aria-label="返回"
                  :disabled="uploading"
                  @click="closeCropper"
                >
                  <span class="material-symbols-outlined">arrow_back</span>
                </button>
              </div>
            </template>
          </div>
        </section>

        <!-- Section 4: 设置密码 — 折叠态,默认收起避免跟主表单抢视觉焦点 -->
        <details class="section-card section-card--collapsible" :open="pwdOpen" @toggle="pwdOpen = ($event.target as HTMLDetailsElement).open">
          <summary class="sd-label sd-summary">
            <span class="material-symbols-outlined">lock</span>
            设置密码
          </summary>
          <div class="pwd-body">
            <label class="field">
              <span class="field-label">当前密码</span>
              <div class="input-with-action">
                <input
                  v-model="currentPwd"
                  :type="showCurrentPwd ? 'text' : 'password'"
                  class="field-input"
                  autocomplete="current-password"
                  placeholder="你正在使用的密码"
                />
                <button
                  type="button"
                  class="input-action"
                  :aria-label="showCurrentPwd ? '隐藏密码' : '显示密码'"
                  @click="showCurrentPwd = !showCurrentPwd"
                >
                  <span class="material-symbols-outlined">{{ showCurrentPwd ? 'visibility_off' : 'visibility' }}</span>
                </button>
              </div>
            </label>

            <label class="field">
              <span class="field-label">新密码</span>
              <div class="input-with-action">
                <input
                  v-model="newPwd"
                  :type="showNewPwd ? 'text' : 'password'"
                  class="field-input"
                  autocomplete="new-password"
                  placeholder="至少 8 位"
                />
                <button
                  type="button"
                  class="input-action"
                  :aria-label="showNewPwd ? '隐藏密码' : '显示密码'"
                  @click="showNewPwd = !showNewPwd"
                >
                  <span class="material-symbols-outlined">{{ showNewPwd ? 'visibility_off' : 'visibility' }}</span>
                </button>
              </div>
              <!-- 强度条:只在用户开始输入后显示,实时给视觉反馈 -->
              <div v-if="newPwd.length > 0" class="pwd-strength">
                <div class="pwd-strength-bar">
                  <div class="pwd-strength-fill" :data-level="pwdStrength.level"></div>
                </div>
                <span class="pwd-strength-text" :data-level="pwdStrength.level">
                  {{ pwdStrength.label }}
                </span>
              </div>
              <!-- 新旧密码相同:与 ResetPasswordView 同步显示,
                   强度条之外再加一条 error hint(强度条还能显示「弱」,
                   但「跟旧密码一样」是更严重的阻断信号)。 -->
              <span v-if="pwdSameAsCurrent" class="field-hint error">
                新密码不能与当前密码相同
              </span>
            </label>

            <label class="field">
              <span class="field-label">确认新密码</span>
              <div class="input-with-action">
                <input
                  v-model="confirmPwd"
                  :type="showConfirmPwd ? 'text' : 'password'"
                  class="field-input"
                  autocomplete="new-password"
                  placeholder="再输入一次"
                />
                <button
                  type="button"
                  class="input-action"
                  :aria-label="showConfirmPwd ? '隐藏密码' : '显示密码'"
                  @click="showConfirmPwd = !showConfirmPwd"
                >
                  <span class="material-symbols-outlined">{{ showConfirmPwd ? 'visibility_off' : 'visibility' }}</span>
                </button>
              </div>
              <span
                v-if="confirmPwd.length > 0 && newPwd !== confirmPwd"
                class="field-hint error"
              >
                两次输入的新密码不一致
              </span>
            </label>

            <div v-if="pwdError" class="error-bar" role="alert">
              <span class="material-symbols-outlined">error</span>
              <span>{{ pwdError }}</span>
            </div>

            <div class="pwd-actions">
              <button
                type="button"
                class="btn btn-primary btn-full"
                :disabled="!pwdReady || changingPwd"
                @click="onChangePassword"
              >
                <span
                  v-if="changingPwd"
                  class="material-symbols-outlined icon-sm is-loading"
                >progress_activity</span>
                <span v-else class="material-symbols-outlined icon-sm">lock_reset</span>
                保存新密码
              </button>
            </div>
          </div>
        </details>

        <!-- 错误条 -->
        <div v-if="errorMsg" class="error-bar" role="alert">
          <span class="material-symbols-outlined">error</span>
          <span>{{ errorMsg }}</span>
        </div>
      </div>
    </div>

    <template #footer>
      <div class="actions">
        <button
          v-if="dirty && !loading"
          type="button"
          class="btn btn-link"
          @click="onReset"
        >
          放弃修改
        </button>
        <button
          type="button"
          class="btn btn-primary"
          :class="{ 'is-saved': justSaved }"
          :disabled="!dirty || nameInvalid || saving || loading || justSaved || uploading"
          @click="onSave"
        >
          <template v-if="saving">
            <span class="material-symbols-outlined icon-sm is-loading">progress_activity</span>
            保存中…
          </template>
          <template v-else-if="justSaved">
            <span class="material-symbols-outlined icon-sm">check</span>
            已保存
          </template>
          <template v-else>保存</template>
        </button>
      </div>
    </template>
  </Drawer>
</template>

<style scoped>
.settings-drawer {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px 20px;
}
.lead {
  font-size: 13px;
  color: var(--text-3, #6b778c);
  margin: 0;
  line-height: 1.55;
  letter-spacing: 0.01em;
}
.loading-state {
  font-size: 13px;
  color: var(--text-3, #6b778c);
  padding: 24px 0;
  text-align: center;
}

/* ─────────────────────────────────────────────────────────────────
 *  统一的 section 语言 —— 所有 section 共享 .section-card 容器
 *    白底 / 1px 边 / 6px 圆角 / 14px-16px padding;modifier 只改 layout
 *    不再有渐变 / 边框 / 配色上的差异 —— 用户名 / 头像 / 设置三个 section
 *    视觉重量对齐,共用一套节奏
 *  preview  variant:横排 layout —— 56px 头像 + name/email 横排
 *  avatar   variant:同 baseline,内部 panel 走统一 gap(无内部 border)
 *  collapsible variant:折叠 details —— 容器 padding 0,summary 自管 padding
 * ───────────────────────────────────────────────────────────────── */
.section-card {
  border: 1px solid var(--border, #dfe1e6);
  border-radius: var(--radius-lg, 6px);
  background: var(--bg, #fff);
  padding: 14px 16px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.section-card--preview {
  flex-direction: row;
  align-items: center;
  gap: 16px;
  padding: 14px 16px;
}
.section-card--avatar {
  gap: 14px;
  padding: 14px 16px 16px;
}
.section-card--collapsible {
  padding: 0;
  overflow: hidden;
}

/* ─────────────────────────────────────────────────────────────────
 *  统一的 label 排版 —— sd-label / avatar-panel-label / field-label
 *    共用一套规则:13px / 600 / text-2 / 16px icon 前缀(text-3)
 *    之前 .avatar-panel-label 走 11px UPPERCASE tracking 跟其他 label 不一样
 *    现在三者一致,「姓名」/「头像」/「当前密码」/「插画」视觉节奏统一
 *
 *  命名用 sd- 前缀而不是 .section-title —— 后者在 components.css 是
 *  全局规则(11px / UPPERCASE / margin: 32px 0 12px / ::after 分割线),
 *  专给编辑器 / HomeView / PeopleContextPanel 那种带分割线的小标题用,
 *  跟 drawer 这里的「section 容器 title」语义不同 —— 直接覆盖会让全局
 *  ::after 分隔线和 margin 也被吃掉(本来就不该影响 drawer),所以用前缀避开。
 * ───────────────────────────────────────────────────────────────── */
.sd-label,
.avatar-panel-label,
.field-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2, #44546f);
  letter-spacing: 0;
  text-transform: none;
  line-height: 1.4;
}
.sd-label .material-symbols-outlined,
.avatar-panel-label .material-symbols-outlined,
.field-label .material-symbols-outlined {
  font-size: 16px;
  color: var(--text-3, #6b778c);
  font-weight: 400;
}

/* sd-summary —— 复用 .sd-label 的排版,
 * 额外加 chevron ::before + hover bg,折叠态的 affordance */
.sd-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 14px 16px;
  cursor: pointer;
  list-style: none;
  user-select: none;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2, #44546f);
  transition: background var(--duration-fast);
}
.sd-summary::-webkit-details-marker { display: none; }
.sd-summary::before {
  content: 'chevron_right';
  font-family: 'Material Symbols Outlined';
  font-size: 16px;
  color: var(--text-3, #6b778c);
  font-weight: 400;
  transition: transform var(--duration-fast);
  margin-right: 2px;
}
.section-card--collapsible[open] > .sd-summary::before {
  transform: rotate(90deg);
}
.sd-summary:hover { background: var(--bg-subtle, #f4f5f7); }
.sd-summary .material-symbols-outlined {
  font-size: 16px;
  color: var(--text-3, #6b778c);
  font-weight: 400;
}

.preview-meta { min-width: 0; }
.preview-name {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-1, #172b4d);
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  letter-spacing: -0.01em;
}
.preview-email {
  font-size: 12px;
  color: var(--text-3, #6b778c);
  line-height: 1.3;
  margin-top: 2px;
}

.field { display: flex; flex-direction: column; gap: 6px; }
.field-input {
  height: 36px;
  padding: 0 12px;
  font-family: inherit;
  font-size: 14px;
  border: 1px solid var(--border, #dfe1e6);
  border-radius: var(--radius-md, 4px);
  background: var(--bg, #fff);
  color: var(--text-1, #172b4d);
}
.field-input:hover { border-color: var(--border-strong, #c1c7d0); }
.field-input:focus {
  outline: none;
  border-color: var(--focus-ring, #4c9aff);
  box-shadow: 0 0 0 1px var(--focus-ring, #4c9aff);
}

/* 密码输入框 + 眼睛 toggle —— 输入框 padding-right 留位置给 icon button */
.input-with-action {
  position: relative;
  display: flex;
  align-items: center;
}
.input-with-action .field-input {
  flex: 1;
  /* 给右侧眼睛按钮留 36px,避免文字被 icon 盖住 */
  padding-right: 36px;
}
.input-action {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  background: transparent;
  color: var(--text-3, #6b778c);
  cursor: pointer;
  border-radius: var(--radius, 4px);
  transition: color var(--duration-fast), background var(--duration-fast);
}
.input-action:hover { color: var(--text-1, #172b4d); background: var(--bg-subtle, #f4f5f7); }
.input-action:focus-visible {
  outline: 2px solid var(--focus-ring, #4c9aff);
  outline-offset: -2px;
}
.input-action .material-symbols-outlined {
  font-size: 18px;
  pointer-events: none;
}
.field-hint {
  font-size: 12px;
  color: var(--text-3, #6b778c);
}
.field-hint.error { color: var(--danger, #de350b); }

/* ─────────────────────────────────────────────────────────────────
 *  M11 头像三态 panel —— 在 .section-card--avatar 容器内部排版
 *  panel 之间靠 .section-card--avatar 的 gap(14px)分隔,不再用内部 border
 *  三态互斥:active panel 只把 label + icon 上 accent 色,不再染整 panel 底
 *  (整 panel 染色会把 panel 撑大,跟其他 section 节奏不齐)
 * ───────────────────────────────────────────────────────────────── */
.avatar-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  transition: background var(--duration-fast);
}
.avatar-panel.active .avatar-panel-label {
  color: var(--accent-strong, #0747a6);
}
.avatar-panel.active .avatar-panel-label .material-symbols-outlined {
  color: var(--accent, #0052cc);
}
.mode-check {
  margin-left: auto;
  font-size: 16px !important;
  color: var(--accent, #0052cc) !important;
}
.panel-hint {
  margin-left: auto;
  font-size: 12px;
  color: var(--text-3, #6b778c);
  font-weight: 400;
}

.preset-loading {
  font-size: 12px;
  color: var(--text-3, #6b778c);
  padding: 12px 0;
}
.preset-grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 12px;
}
.preset-cell {
  width: 100%;
  aspect-ratio: 1 / 1;
  border-radius: 50%;
  border: 2px solid var(--border, #dfe1e6);
  background: var(--bg, #fff);
  padding: 3px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  transition: border-color var(--duration-fast), transform var(--duration-fast),
    box-shadow var(--duration-fast);
}
.preset-cell:hover {
  transform: scale(1.05);
  border-color: var(--border-strong, #c1c7d0);
}
.preset-cell.active {
  border-color: var(--accent, #0052cc);
  box-shadow: 0 0 0 2px var(--accent-soft, #deebff);
}
.preset-cell:focus-visible {
  outline: 2px solid var(--focus-ring, #4c9aff);
  outline-offset: 2px;
}
.preset-cell img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 50%;
  pointer-events: none;
}

.palette {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.palette-swatch {
  width: 28px;
  height: 28px;
  border: 2px solid transparent;
  border-radius: 50%;
  cursor: pointer;
  padding: 0;
  transition: transform var(--duration-fast), border-color var(--duration-fast);
}
.palette-swatch:hover { transform: scale(1.1); }
.palette-swatch.active {
  border-color: var(--text-1, #172b4d);
  box-shadow: 0 0 0 2px var(--bg, #fff) inset;
}
.palette-swatch:focus-visible {
  outline: 2px solid var(--focus-ring, #4c9aff);
  outline-offset: 2px;
}

.palette-custom {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px dashed var(--border, #dfe1e6);
  border-radius: 50%;
  cursor: pointer;
  color: var(--text-3, #6b778c);
  background: var(--bg, #fff);
}
.palette-custom .material-symbols-outlined {
  font-size: 16px;
}
.palette-custom input[type='color'] {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
  width: 100%;
  height: 100%;
  padding: 0;
  border: 0;
}

/* ─────────────────────────────────────────────────────────────────
 *  M11 自定义上传 zone —— 圆形 104px,点击 / 拖拽皆可
 *  沿用 .preset-cell 的 aspect-ratio 1/1 + 圆角 + active inset ring 范式
 * ───────────────────────────────────────────────────────────────── */
.upload-zone {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 104px;
  height: 104px;
  margin: 4px auto 0;
  border: 2px dashed var(--border-strong, #c1c7d0);
  border-radius: 50%;
  background: var(--accent-softer, #f4f8ff);
  color: var(--text-2, #44546f);
  cursor: pointer;
  transition: border-color var(--duration-fast), background var(--duration-fast),
    transform var(--duration-fast), color var(--duration-fast);
  overflow: hidden;
  position: relative;
}
.upload-zone:hover {
  border-color: var(--accent, #0052cc);
  border-style: solid;
  background: var(--accent-soft, #deebff);
  color: var(--accent, #0052cc);
}
.upload-zone:focus-visible {
  outline: 2px solid var(--focus-ring, #4c9aff);
  outline-offset: 2px;
}
.upload-zone.uploading {
  cursor: progress;
  border-color: var(--focus-ring, #4c9aff);
}
.upload-zone.is-dragover {
  border-color: var(--focus-ring, #4c9aff);
  background: var(--focus-ring, #4c9aff);
  color: #fff;
  transform: scale(1.04);
}
.upload-zone .material-symbols-outlined {
  font-size: 32px;
  pointer-events: none;
}
.upload-meta {
  font-size: 12px;
  color: var(--text-3, #6b778c);
  text-align: center;
  margin-top: 6px;
  /* 长文件名截断 */
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-left: auto;
  margin-right: auto;
  line-height: 1.45;
}
.upload-input-hidden {
  /* hidden 仍要 display:none(不拿 display:hidden),click() 仍能找到 */
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
.upload-actions {
  display: flex;
  gap: 10px;
  justify-content: center;
  margin-top: 10px;
}

/* M11 v3 polish:Panel C 收起态 ——「+ 上传自定义头像」紧凑按钮 */
.upload-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;       /* 不占满整行,贴 label 左对齐 */
  height: 32px;
  padding: 0 12px;
  font-family: inherit;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-2, #42526e);
  background: var(--bg, #fff);
  border: 1px dashed var(--border-strong, #c1c7d0);
  border-radius: var(--radius, 4px);
  cursor: pointer;
  transition: border-color var(--duration-fast), color var(--duration-fast),
    background var(--duration-fast);
}
.upload-trigger:hover:not(:disabled) {
  border-color: var(--focus-ring, #4c9aff);
  border-style: solid;
  color: var(--focus-ring, #4c9aff);
}
.upload-trigger:focus-visible {
  outline: 2px solid var(--focus-ring, #4c9aff);
  outline-offset: 2px;
}
.upload-trigger:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.upload-trigger .material-symbols-outlined {
  font-size: 18px;
}

/* 已有 custom 头像时,收起态显示 缩略图 + 文字 + 替换/移除 icon 行 */
.upload-summary {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 10px;
  background: var(--bg-subtle, #f4f5f7);
  border-radius: var(--radius, 4px);
}
.upload-summary-text {
  flex: 1;
  font-size: 13px;
  color: var(--text-2, #42526e);
  font-weight: 500;
}
.upload-summary .upload-actions {
  margin-top: 0;
  flex-shrink: 0;
}

/* M11 v3:AvatarCropper 容器 —— 居中,跟 .upload-zone 同位 */
.cropper-wrap {
  display: flex;
  justify-content: center;
  margin: 4px auto 0;
}
.cropper-hint {
  font-size: 11px;
  color: var(--text-3, #6b778c);
  text-align: center;
  margin-top: 12px;
  letter-spacing: 0.02em;
}

/* M11 v3:Panel C 圆下方的 icon-only 圆形按钮(Confluence 风格)
 *  - 32×32,圆形,单 icon
 *  - 默认 secondary 蓝边
 *  - hover:蓝边 + 蓝 icon
 *  - primary variant:实心蓝,save 按钮用
 *  - danger variant:hover 红边 + 红 icon + 红软底 */
.btn-icon {
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border, #dfe1e6);
  border-radius: 50%;
  background: var(--bg, #fff);
  color: var(--text-2, #42526e);
  cursor: pointer;
  padding: 0;
  transition: border-color var(--duration-fast), background var(--duration-fast),
    color var(--duration-fast);
}
.btn-icon:hover:not(:disabled) {
  border-color: var(--focus-ring, #4c9aff);
  color: var(--focus-ring, #4c9aff);
}
.btn-icon:focus-visible {
  outline: 2px solid var(--focus-ring, #4c9aff);
  outline-offset: 2px;
}
.btn-icon:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn-icon .material-symbols-outlined {
  font-size: 18px;
  pointer-events: none;
}
.btn-icon-primary {
  background: var(--accent, #0052cc);
  border-color: var(--accent, #0052cc);
  color: #fff;
}
.btn-icon-primary:hover:not(:disabled) {
  background: var(--accent-strong, #0747a6);
  border-color: var(--accent-strong, #0747a6);
  color: #fff;
}
.btn-icon-danger:hover:not(:disabled) {
  border-color: var(--danger, #de350b);
  color: var(--danger, #de350b);
  background: var(--error-soft, #ffebe6);
}

.error-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background: var(--error-soft, #ffebe6);
  border: 1px solid var(--error, #de350b);
  border-radius: var(--radius, 4px);
  color: var(--error, #de350b);
  font-size: 13px;
}
.error-bar .material-symbols-outlined { font-size: 18px; }

.actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
}
.actions .btn-link { margin-right: auto; }
.btn {
  height: 32px;
  padding: 0 16px;
  font-family: inherit;
  font-size: 13px;
  font-weight: 500;
  border-radius: var(--radius, 4px);
  border: 1px solid transparent;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.btn-primary {
  background: var(--accent, #0052cc);
  color: #fff;
}
.btn-primary:hover:not(:disabled) { background: var(--accent-strong, #0747a6); }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-primary.is-saved {
  background: #36B37E;
}
.btn-primary.is-saved:hover:not(:disabled) { filter: brightness(0.95); }
/* 全宽主按钮 —— 改密 / 等只有一个 primary action 的场景 */
.btn-full {
  width: 100%;
  justify-content: center;
  height: 36px;
  font-weight: 600;
}
.btn-link {
  background: transparent;
  color: var(--accent, #0052cc);
  padding: 0;
  border: 0;
  text-decoration: underline;
  height: auto;
}
.btn-link:hover:not(:disabled) { color: var(--accent-strong, #0747a6); }
.btn-link.danger { color: var(--danger, #de350b); }
.btn-link.danger:hover:not(:disabled) { color: #bf2600; }
.btn-link:disabled { opacity: 0.5; cursor: not-allowed; }
.icon-sm { font-size: 16px; }
.is-loading { animation: spin 0.9s linear infinite; }
@keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }

/* .pwd-body / .pwd-actions 是密码面板专属内层排版,
 * 容器 border / radius / hover / chevron 全部由 .section-card +
 * .section-summary 提供(见上)。
 * 节奏收紧:从 16/18/18 → 12/16/14,跟其他 section-card 内部一致。 */
.pwd-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px 16px;
  border-top: 1px solid var(--border, #ebecf0);
}
.pwd-actions {
  display: flex;
  justify-content: stretch;
  margin-top: 4px;
}

/* 密码强度条 —— 4 段水平 bar,按 level 上色 */
.pwd-strength {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
}
.pwd-strength-bar {
  flex: 1;
  height: 4px;
  background: var(--bg-subtle, #ebecf0);
  border-radius: 2px;
  overflow: hidden;
  position: relative;
}
.pwd-strength-fill {
  height: 100%;
  width: 0;
  border-radius: 2px;
  transition: width var(--duration-fast), background var(--duration-fast);
}
.pwd-strength-fill[data-level='0'] { width: 25%; background: var(--text-3, #6b778c); }
.pwd-strength-fill[data-level='1'] { width: 50%; background: #de350b; }
.pwd-strength-fill[data-level='2'] { width: 75%; background: #ff991f; }
.pwd-strength-fill[data-level='3'] { width: 100%; background: #36B37E; }
.pwd-strength-text {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-3, #6b778c);
  white-space: nowrap;
  min-width: 90px;
  text-align: right;
}
.pwd-strength-text[data-level='1'] { color: #de350b; }
.pwd-strength-text[data-level='2'] { color: #ff991f; }
.pwd-strength-text[data-level='3'] { color: #36B37E; }
</style>
