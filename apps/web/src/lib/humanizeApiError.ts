/**
 * humanizeApiError —— 把后端错误码 / 网络层错误翻译成中文人话。
 *
 * 模块 9 P0:此前各 store 直接把 `ApiError.message`(后端英文,如 "fetch
 * failed" / "Invalid cursor")拼进中文提示,中英混杂且大量落到笼统的
 * 「操作失败」。这里以 `ApiError.code`(后端 `error` 字段)为主键做映射,
 * 是错误文案的单一事实来源;调用方负责补业务前缀(如「删除失败: 」)。
 *
 * 映射表覆盖 apps/api 里出现的全部错误码;未命中的码回退到通用文案,
 * 而不是暴露英文 message。
 */
import { ApiError } from './api'

/** 通用兜底 —— 命中不到具体码时用,避免把后端英文原文抛给用户。 */
const FALLBACK = '操作失败,请稍后重试'

const CODE_MESSAGES: Record<string, string> = {
  // 网络 / 传输层(status=0 或显式 network code)
  network: '网络连接失败,请检查网络后重试',
  // zod 边界:前后端契约漂移(api.ts 抛的 schema_drift)
  schema_drift: '数据格式异常,请刷新后重试',

  // 鉴权 / 权限
  unauthorized: '登录状态已失效,请重新登录',
  forbidden: '没有权限执行此操作',
  account_disabled: '账号已被停用,请联系管理员',

  // 通用校验 / 资源
  invalid_input: '输入内容不合法,请检查后重试',
  not_found: '目标不存在或已被删除',
  conflict: '操作冲突,请刷新后重试',
  duplicate: '已存在重复项',
  reserved: '该名称为系统保留,请换一个',
  unknown_key: '无效的配置项',
  invalid_cursor: '翻页数据已过期,请刷新后重试',

  // 页面移动 / 层级
  cycle: '不能把页面移动到它自己的子页面下',
  has_children: '该页面还有子页面,请先处理子页面',
  cross_space_no_parent: '跨空间移动需要先选择目标位置',
  personal_move_only: '个人空间的页面只能在个人空间内移动',
  personal_space_readonly: '个人空间不支持此操作',

  // 回收站
  page_trashed: '该页面已在回收站中',
  not_trashed: '该页面不在回收站中',
  parent_trashed: '上级页面在回收站中,请先恢复上级',

  // 发布到团队空间
  publish_not_owner: '只能发布自己个人空间的页面',
  publish_same_space: '该页面已在目标空间',
  publish_source_must_be_personal: '只能从个人空间发布页面',
  publish_target_not_personal: '发布目标必须是团队空间',

  // 标签
  invalid_label: '标签格式不合法',

  // 空间
  space_required: '请先选择一个空间',
  space_not_found: '空间不存在',
  space_not_empty: '空间下还有页面,无法删除',
  personal_space_cannot_delete: '个人空间不能直接删除,请改用「注销该用户」清理',

  // Phase A — 空间角色管理
  invalid_role: '无效的角色类型',
  admin_role_to_group: '不能把管理权限授予用户组',
  cannot_remove_last_admin: '个人空间必须至少保留一个用户级管理员',
  permission_denied: '没有权限执行此操作',

  // Phase B — 页面级限制
  page_restricted: '该页面已设置编辑限制,您没有编辑权限',
  view_restricted: '该页面已设置查看限制,您没有访问权限',

  // Phase D — 公开链接分享
  share_forbidden: '该页面不可分享(仅共享空间、无查看限制的页面可以分享)',
  share_expired: '该分享链接已过期',
  share_revoked: '该分享链接已被撤销',
  share_invalid: '该分享链接无效',
  share_already_revoked: '该分享链接已撤销,无需重复操作',

  // 用户管理
  email_taken: '该邮箱已被占用',
  last_admin: '不能停用或删除最后一个管理员',
  self_disable: '不能停用自己的账号',
  self_reset: '不能重置自己的密码,请用「修改密码」',
  self_anonymize: '不能注销自己的账号',

  // 附件上传
  size_mismatch: '上传文件大小与声明不一致,请重试',
  storage_unavailable: '存储服务暂不可达,请稍后重试',
  upload_not_found: '上传记录不存在或已过期,请重新上传',

  // 服务器
  internal: '服务器内部错误,请稍后重试',
}

export function humanizeApiError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 0) return CODE_MESSAGES.network
    return CODE_MESSAGES[e.code] ?? FALLBACK
  }
  return FALLBACK
}
