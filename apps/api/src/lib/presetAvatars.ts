/**
 * presetAvatars — M11 v2 运行时扫 apps/web/public/avatars/,给前端
 * GET /api/avatars/presets 提供清单。
 *
 * 设计要点:
 *  - dev 路径:`process.cwd()` 是 apps/api(从 root 跑 pnpm dev),所以
 *    `..` 跳到 root,`web/public/avatars` 即目标。prod 部署路径不在本
 *    轮范围,需要时用 env `AVATAR_PRESETS_DIR` 覆盖。
 *  - 60s TTL 缓存:用户加新 PNG 进 public/avatars/ 后,等 60s 或重启 api
 *    即可看到;不需要 fs.watch 实时事件(单进程 watch 风险大于收益)。
 *  - 扩展名白名单跟 AVATAR_ALLOWED_MIME 对齐(无 svg/avif,理由见 shared
 *    constants 注释)。点开头文件(.DS_Store / .gitkeep)自动跳过。
 *  - readdir 失败(目录不存在 / 权限)→ console.warn + 返空 list,不 crash
 *    启动。SettingsDrawer grid 显空,前端 `<img @error>` 兜底也不影响。
 *  - 大小写不敏感:`.PNG` / `.Png` 都接受;Linux fs 上 `Dog.png` 和
 *    `dog.png` 视为两个 slug(用户责任,git 走 review 收敛)。
 */

import { readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'

const ALLOWED_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'] as const
type AllowedExt = (typeof ALLOWED_EXTS)[number]

/** 跟 `AVATAR_ALLOWED_MIME` 同语义,preset 端不引 shared 避免循环。 */
const MIME_BY_EXT: Record<AllowedExt, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** slug → file 映射。`{slug:'dog', file:'dog.png'}`。 */
export interface PresetAvatar {
  slug: string
  /** 含扩展名的文件名,前端拼 `/avatars/${file}` 直接 serve。 */
  file: string
  mime: string
}

const PRESETS_DIR = (() => {
  return (
    process.env.AVATAR_PRESETS_DIR ??
    join(process.cwd(), '..', 'web', 'public', 'avatars')
  )
})()

interface Cache {
  at: number
  entries: PresetAvatar[]
}
let cache: Cache | null = null
const TTL_MS = 60_000

export function listPresetAvatars(): PresetAvatar[] {
  const now = Date.now()
  if (cache && now - cache.at < TTL_MS) return cache.entries

  let entries: PresetAvatar[] = []
  try {
    const stat = statSync(PRESETS_DIR)
    if (stat.isDirectory()) {
      for (const name of readdirSync(PRESETS_DIR).sort()) {
        const ext = extname(name).toLowerCase() as AllowedExt
        if (!(ALLOWED_EXTS as readonly string[]).includes(ext)) continue
        const slug = name.slice(0, -ext.length)
        if (!slug) continue
        entries.push({ slug, file: name, mime: MIME_BY_EXT[ext] })
      }
    }
  } catch (err) {
    console.warn('[presetAvatars] read failed', PRESETS_DIR, err)
    entries = []
  }

  cache = { at: now, entries }
  return entries
}
