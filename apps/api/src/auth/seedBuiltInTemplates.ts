/**
 * Stage 8 — seed the 5 built-in page templates.
 *
 * Called from `auth/bootstrap.ts` step 6. Idempotent: each built-in is
 * checked by `(space_id IS NULL AND title = ? AND is_built_in = true)` and
 * only inserted when absent. Admin deletion of a built-in wins permanently —
 * this seed NEVER re-creates deleted rows. That matches the spec where
 * built-ins are bootstrap-installed, then admin-curated.
 *
 * Why hand-written Tiptap docs (vs generating from HTML): the spec asks for
 * the 5 doc shapes a wiki team would actually use — meeting notes, RFC,
 * SOP, weekly report — with semantic headings the user can navigate with
 * TOC. Hand-built gives us anchors (`#meeting-date`, `#rfc-decision`,
 * `#sop-steps`, etc.) and keeps the JSON deterministic across migrations.
 * The matching HTML is also hand-written so v-html renders cleanly before
 * any edit. Pattern matches `apps/api/src/lib/ensurePersonalSpace.ts:
 * buildWelcomeContent`.
 *
 * No user input → only the static strings below. `escapeHtml` is enough;
 * DOMPurify would be wasted cycles for this hard-coded content.
 */
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../db/client'
import { pageTemplates, users } from '../db/schema'
import { generatePageId } from '../lib/ids'
import type { TiptapJSON } from '@power-wiki/shared'

interface BuiltInTemplate {
  title: string
  description: string
  icon: string
  contentJSON: TiptapJSON
  contentHTML: string
}

const BUILT_INS: BuiltInTemplate[] = [
  buildBlank(),
  buildMeetingNotes(),
  buildRfc(),
  buildSop(),
  buildWeeklyReport(),
]

export interface SeedResult {
  inserted: number
  skipped: number
}

export async function seedBuiltInTemplates(): Promise<SeedResult> {
  // Resolve the bootstrap admin as `createdBy`. On a fresh install that's
  // the only user; on an upgrade the admin still owns these. Falls back to
  // any active admin if the env-bootstrap admin was disabled.
  const [author] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, 'admin'))
    .orderBy(users.createdAt)
    .limit(1)
  if (!author) {
    console.warn(
      '[api] templates: no admin user found — skipping built-in template seed',
    )
    return { inserted: 0, skipped: BUILT_INS.length }
  }

  let inserted = 0
  let skipped = 0
  const now = Date.now()
  for (const t of BUILT_INS) {
    const existing = await db
      .select({ id: pageTemplates.id })
      .from(pageTemplates)
      .where(
        and(
          isNull(pageTemplates.spaceId),
          eq(pageTemplates.title, t.title),
          eq(pageTemplates.isBuiltIn, true),
        ),
      )
      .limit(1)
    if (existing.length > 0) {
      skipped++
      continue
    }
    await db.insert(pageTemplates).values({
      id: generatePageId(),
      spaceId: null,
      title: t.title,
      description: t.description,
      contentJson: t.contentJSON,
      contentHtml: t.contentHTML,
      icon: t.icon,
      isBuiltIn: true,
      createdBy: author.id,
      createdAt: now,
    })
    inserted++
  }
  if (inserted > 0) {
    console.log(
      `[api] templates: ✓ seeded ${inserted} built-in template(s), skipped ${skipped} existing`,
    )
  }
  return { inserted, skipped }
}

/* ─── helpers ────────────────────────────────────────────────────────────── */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** A heading. The `anchor` parameter is unused in JSON — HeadingView derives
 *  the heading id from the node's text + position at render time
 *  (apps/web/src/components/editor/HeadingView.vue:27-33), so the JSON side
 *  doesn't need a mark. Earlier versions stamped `marks: [{type:'anchor',
 *  attrs:{id:anchor}}]` onto the inner text node, but the editor schema
 *  doesn't define an `anchor` mark — Tiptap threw "There is no mark type
 *  anchor in this schema" and rendered the doc as empty, which then got
 *  PATCH'd back as `<p></p>` and erased the template body. The HTML output
 *  still carries the explicit `id` so TOC works in read view. */
function heading(level: 1 | 2 | 3, text: string, _anchor: string) {
  return {
    type: 'heading',
    attrs: { level },
    content: [{ type: 'text', text }],
  }
}

function para(text: string) {
  // Empty paragraphs in the seed (placeholders like 'sop-purpose' body) MUST
  // omit `content` entirely — Tiptap's schema throws "Empty text nodes are
  // not allowed" on `{type:'text', text:''}`, which made the editor reject
  // the entire doc and render an empty paragraph. A heading/paragraph with
  // no `content` parses cleanly as a placeholder the user can type into.
  return text ? { type: 'paragraph', content: [{ type: 'text', text }] } : { type: 'paragraph' }
}

function bulletList(items: string[]) {
  return {
    type: 'bulletList',
    content: items.map((t) => ({
      type: 'listItem',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }],
    })),
  }
}

function taskList(items: { text: string; checked: boolean }[]) {
  return {
    type: 'taskList',
    content: items.map((it) => ({
      type: 'taskItem',
      attrs: { checked: it.checked },
      content: [{ type: 'paragraph', content: [{ type: 'text', text: it.text }] }],
    })),
  }
}

/** Mirror of heading() for HTML output. Heading anchors are emitted by the
 *  editor on first edit; for the seed we set them ourselves so the user
 *  sees TOC entries immediately on pages created from a template. */
function htmlHeading(level: 1 | 2 | 3, text: string, anchor: string): string {
  return `<h${level} id="${anchor}">${escapeHtml(text)}</h${level}>`
}

function htmlPara(text: string): string {
  return `<p>${escapeHtml(text)}</p>`
}

function htmlBulletList(items: string[]): string {
  return (
    '<ul>' +
    items.map((t) => `<li><p>${escapeHtml(t)}</p></li>`).join('') +
    '</ul>'
  )
}

function htmlTaskList(items: { text: string; checked: boolean }[]): string {
  return (
    '<ul data-type="taskList">' +
    items
      .map(
        (it) =>
          `<li data-type="taskItem" data-checked="${it.checked}">` +
          `<p>${escapeHtml(it.text)}</p></li>`,
      )
      .join('') +
    '</ul>'
  )
}

/* ─── 1. 空白 ────────────────────────────────────────────────────────────── */
function buildBlank(): BuiltInTemplate {
  const json: TiptapJSON = {
    type: 'doc',
    content: [para('')],
  }
  const html = htmlPara('')
  return {
    title: '空白',
    description: '一张白纸,什么内容都没有。适合随手记笔记。',
    icon: 'description',
    contentJSON: json,
    contentHTML: html,
  }
}

/* ─── 2. 会议纪要 ────────────────────────────────────────────────────────── */
function buildMeetingNotes(): BuiltInTemplate {
  const sections = [
    { anchor: 'meeting-info', level: 2 as const, text: '会议信息' },
    { anchor: 'meeting-date', level: 3 as const, text: '日期' },
    { anchor: 'meeting-attendees', level: 3 as const, text: '参会人' },
    { anchor: 'meeting-agenda', level: 2 as const, text: '议程' },
    { anchor: 'meeting-discussion', level: 2 as const, text: '讨论' },
    { anchor: 'meeting-decisions', level: 2 as const, text: '决议' },
    { anchor: 'meeting-actions', level: 2 as const, text: '行动项' },
  ]
  const json: TiptapJSON = {
    type: 'doc',
    content: [
      heading(2, '会议纪要', 'meeting-title'),
      ...sections.flatMap((s) => [
        heading(s.level, s.text, s.anchor),
        s.anchor === 'meeting-date' || s.anchor === 'meeting-attendees'
          ? para('')
          : s.anchor === 'meeting-agenda'
            ? bulletList(['议题 1', '议题 2', '议题 3'])
            : s.anchor === 'meeting-actions'
              ? taskList([
                  { text: '负责人 A:跟进 XX,截止下周五', checked: false },
                  { text: '负责人 B:产出 YY 方案,本周内', checked: false },
                ])
              : para(''),
      ]),
    ],
  }
  const html =
    htmlHeading(2, '会议纪要', 'meeting-title') +
    sections
      .map((s) => {
        let body = ''
        if (s.anchor === 'meeting-date' || s.anchor === 'meeting-attendees') {
          body = htmlPara('')
        } else if (s.anchor === 'meeting-agenda') {
          body = htmlBulletList(['议题 1', '议题 2', '议题 3'])
        } else if (s.anchor === 'meeting-actions') {
          body = htmlTaskList([
            { text: '负责人 A:跟进 XX,截止下周五', checked: false },
            { text: '负责人 B:产出 YY 方案,本周内', checked: false },
          ])
        } else {
          body = htmlPara('')
        }
        return htmlHeading(s.level, s.text, s.anchor) + body
      })
      .join('')
  return {
    title: '会议纪要',
    description: '标准会议纪要模板:日期、参会人、议程、讨论、决议、行动项。',
    icon: 'edit_note',
    contentJSON: json,
    contentHTML: html,
  }
}

/* ─── 3. RFC ─────────────────────────────────────────────────────────────── */
function buildRfc(): BuiltInTemplate {
  const sections = [
    { anchor: 'rfc-summary', level: 2 as const, text: '摘要', body: 'paragraph' as const },
    { anchor: 'rfc-background', level: 2 as const, text: '背景', body: 'paragraph' as const },
    { anchor: 'rfc-design', level: 2 as const, text: '设计', body: 'paragraph' as const },
    {
      anchor: 'rfc-tradeoffs',
      level: 2 as const,
      text: '取舍',
      body: 'list' as const,
    },
    { anchor: 'rfc-decision', level: 2 as const, text: '决策', body: 'paragraph' as const },
  ]
  const json: TiptapJSON = {
    type: 'doc',
    content: [
      heading(1, 'RFC: <标题>', 'rfc-title'),
      para('作者 · 日期 · 状态:草案 / 评审中 / 已采纳'),
      ...sections.flatMap((s) => [
        heading(s.level, s.text, s.anchor),
        s.body === 'list'
          ? bulletList(['备选方案 A:...', '备选方案 B:...'])
          : para(''),
      ]),
    ],
  }
  const html =
    htmlHeading(1, 'RFC: <标题>', 'rfc-title') +
    htmlPara('作者 · 日期 · 状态:草案 / 评审中 / 已采纳') +
    sections
      .map((s) => {
        const body =
          s.body === 'list'
            ? htmlBulletList(['备选方案 A:...', '备选方案 B:...'])
            : htmlPara('')
        return htmlHeading(s.level, s.text, s.anchor) + body
      })
      .join('')
  return {
    title: 'RFC',
    description: '技术提案模板:摘要、背景、设计、取舍、决策。',
    icon: 'menu_book',
    contentJSON: json,
    contentHTML: html,
  }
}

/* ─── 4. SOP ─────────────────────────────────────────────────────────────── */
function buildSop(): BuiltInTemplate {
  const sections = [
    { anchor: 'sop-purpose', level: 2 as const, text: '目的', body: 'paragraph' as const },
    { anchor: 'sop-scope', level: 2 as const, text: '范围', body: 'paragraph' as const },
    {
      anchor: 'sop-steps',
      level: 2 as const,
      text: '步骤',
      body: 'list' as const,
    },
    {
      anchor: 'sop-verification',
      level: 2 as const,
      text: '验证',
      body: 'list' as const,
    },
  ]
  const json: TiptapJSON = {
    type: 'doc',
    content: [
      heading(1, 'SOP: <流程名>', 'sop-title'),
      ...sections.flatMap((s) => [
        heading(s.level, s.text, s.anchor),
        s.body === 'list'
          ? bulletList(['步骤 1:...', '步骤 2:...', '步骤 3:...'])
          : para(''),
      ]),
    ],
  }
  const html =
    htmlHeading(1, 'SOP: <流程名>', 'sop-title') +
    sections
      .map((s) => {
        const body =
          s.body === 'list'
            ? htmlBulletList(['步骤 1:...', '步骤 2:...', '步骤 3:...'])
            : htmlPara('')
        return htmlHeading(s.level, s.text, s.anchor) + body
      })
      .join('')
  return {
    title: 'SOP',
    description: '标准操作流程模板:目的、范围、步骤、验证。',
    icon: 'fact_check',
    contentJSON: json,
    contentHTML: html,
  }
}

/* ─── 5. 周报 ────────────────────────────────────────────────────────────── */
function buildWeeklyReport(): BuiltInTemplate {
  const sections = [
    {
      anchor: 'weekly-done',
      level: 2 as const,
      text: '本周完成',
      body: 'list' as const,
    },
    {
      anchor: 'weekly-next',
      level: 2 as const,
      text: '下周计划',
      body: 'list' as const,
    },
    {
      anchor: 'weekly-risks',
      level: 2 as const,
      text: '风险与阻塞',
      body: 'list' as const,
    },
    { anchor: 'weekly-notes', level: 2 as const, text: '备注', body: 'paragraph' as const },
  ]
  const json: TiptapJSON = {
    type: 'doc',
    content: [
      heading(1, '周报: <姓名> · 第 N 周', 'weekly-title'),
      para('日期范围:YYYY-MM-DD ~ YYYY-MM-DD'),
      ...sections.flatMap((s) => [
        heading(s.level, s.text, s.anchor),
        s.body === 'list' ? bulletList(['项 1', '项 2']) : para(''),
      ]),
    ],
  }
  const html =
    htmlHeading(1, '周报: <姓名> · 第 N 周', 'weekly-title') +
    htmlPara('日期范围:YYYY-MM-DD ~ YYYY-MM-DD') +
    sections
      .map((s) => {
        const body =
          s.body === 'list' ? htmlBulletList(['项 1', '项 2']) : htmlPara('')
        return htmlHeading(s.level, s.text, s.anchor) + body
      })
      .join('')
  return {
    title: '周报',
    description: '周报模板:本周完成、下周计划、风险与阻塞、备注。',
    icon: 'event_note',
    contentJSON: json,
    contentHTML: html,
  }
}