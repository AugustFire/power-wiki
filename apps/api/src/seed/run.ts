/**
 * Seed runner — `pnpm -F api seed`.
 *
 * Flow (Stage 4+):
 *   1. Sign in as the admin (env: ADMIN_EMAIL + ADMIN_PASSWORD) to get a session
 *      cookie. The API now requires auth for /api/pages/*.
 *   2. GET /api/spaces to find the default space — bootstrap.ts created it on
 *      first boot. Every seeded page needs a spaceId.
 *   3. POST each page from ./data.ts with that spaceId.
 *
 * Skips pages that already exist (same `id`) so re-running is safe. To start
 * fresh, truncate pages in psql first.
 *
 * The script is a one-shot dev convenience — the frontend never auto-seeds.
 */

import { seedPages } from './data'

const API = process.env.SEED_API ?? 'http://127.0.0.1:8787'
const ADMIN_EMAIL = process.env.ADMIN_EMAIL
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD

async function main() {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.error('[seed] FATAL: ADMIN_EMAIL and ADMIN_PASSWORD must be set in env')
    process.exit(1)
  }

  // 1. Sign in as admin.
  const signInRes = await fetch(`${API}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  })
  if (!signInRes.ok) {
    const text = await signInRes.text().catch(() => '')
    console.error(`[seed] FATAL: admin sign-in failed (${signInRes.status}): ${text}`)
    process.exit(1)
  }
  // Capture the Set-Cookie header. fetch in Node doesn't auto-store cookies,
  // so we forward it on every subsequent request.
  const setCookie = signInRes.headers.get('set-cookie')
  if (!setCookie) {
    console.error('[seed] FATAL: no Set-Cookie header on sign-in response')
    process.exit(1)
  }
  const cookieHeader = setCookie.split(';')[0]! // e.g. "pw_session=abc..."

  // 2. Find the default space.
  const spacesRes = await fetch(`${API}/api/spaces`, {
    headers: { Cookie: cookieHeader },
  })
  if (!spacesRes.ok) {
    console.error(`[seed] FATAL: GET /api/spaces failed (${spacesRes.status})`)
    process.exit(1)
  }
  const spaces = (await spacesRes.json()) as Array<{ id: string; name: string }>
  if (spaces.length === 0) {
    console.error('[seed] FATAL: no spaces exist; run the API once so bootstrap creates the default')
    process.exit(1)
  }
  const defaultSpace = spaces[0]!
  console.log(`[seed] using space "${defaultSpace.name}" (${defaultSpace.id})`)

  // 3. POST each seed page with spaceId.
  const pages = seedPages(defaultSpace.id)
  console.log(`[seed] ${pages.length} pages to import → ${API}`)

  let ok = 0
  let skipped = 0
  for (const p of pages) {
    const checkRes = await fetch(`${API}/api/pages/${p.id}`, {
      headers: { Cookie: cookieHeader },
    })
    if (checkRes.ok) {
      skipped++
      continue
    }
    const res = await fetch(`${API}/api/pages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({
        id: p.id,
        spaceId: p.spaceId,
        parentId: p.parentId,
        title: p.title,
        contentJSON: p.contentJSON,
        contentHTML: p.contentHTML,
        order: p.order,
      }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.error(`[seed] ✗ ${p.id} "${p.title}" → ${res.status} ${text}`)
      process.exitCode = 1
      continue
    }
    console.log(`[seed] ✓ ${p.title}`)
    ok++
  }

  console.log(`[seed] done — ${ok} created, ${skipped} skipped`)
}

main().catch((err) => {
  console.error('[seed] fatal', err)
  process.exit(1)
})