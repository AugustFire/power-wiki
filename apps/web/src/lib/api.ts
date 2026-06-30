/**
 * Typed API client.
 *
 * Talks to `apps/api` (Hono) through Vite's dev proxy: same-origin at `/api/*`
 * (proxied to `http://127.0.0.1:8787` by apps/web/vite.config.ts). No CORS,
 * no credentials dance — proxy hides the cross-origin nature in dev.
 *
 * Every successful response is validated with the matching zod schema at the
 * boundary so a backend/frontend contract drift surfaces here, not at the
 * component layer that consumes the data.
 *
 * Errors: throws `ApiError` with `status`, `code` (server's `error` field),
 * and raw `body`. Callers can branch on `instanceof ApiError` to distinguish
 * network/HTTP errors from bugs.
 *
 * Stage 4: ALL requests include `credentials: 'include'` so the `pw_session`
 * cookie travels with every fetch. The backend's CORS config already sets
 * `Access-Control-Allow-Credentials: true` and pins `Access-Control-Allow-Origin`
 * to the dev origin (not `*`) — both required for credentialed cross-origin.
 */

import {
  CreatePageInputSchema,
  PageNodeSchema,
  PaginatedListSchema,
  ResetPasswordInputSchema,
  SignInInputSchema,
  SpaceSchema,
  UserGroupSchema,
  UserSchema,
} from '@power-wiki/shared/schemas'
import type {
  CreatePageInput,
  MovePageInput,
  PageNode,
  Paginated,
  PaginatedQuery,
  ResetPasswordInput,
  SignInInput,
  Space,
  UpdatePageInput,
  User,
  UserGroup,
  CreateUserInput,
  UpdateUserInput,
  CreateGroupInput,
  UpdateGroupInput,
  CreateSpaceInput,
  UpdateSpaceInput,
  SetSpaceAccessInput,
} from '@power-wiki/shared'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/* ─── 401 handler ───────────────────────────────────────────────────────
 * Any non-public endpoint that returns 401 is treated as "your session
 * expired" and triggers a global handler that clears auth + navigates to
 * /login. The handler is pluggable so this module doesn't need to know
 * about stores/router — `main.ts` wires it up at boot.
 *
 * Public auth endpoints (sign-in / session / sign-out) may legitimately
 * return 401 and the caller (authStore.init / LoginView) needs to see that
 * raw response to branch. Those paths are excluded from auto-handling.
 */
type UnauthorizedHandler = () => void | Promise<void>
let unauthorizedHandler: UnauthorizedHandler = () => {
  // Fallback before main.ts wires the real handler: hard reload to /login
  // preserving the current hash route.
  const target =
    '/login?redirect=' + encodeURIComponent(window.location.hash || '/')
  window.location.assign(target)
}
let unauthorizedFiring = false

export function setUnauthorizedHandler(fn: UnauthorizedHandler): void {
  unauthorizedHandler = fn
}

const PUBLIC_AUTH_PATHS = new Set([
  '/auth/session',
  '/auth/sign-in',
  '/auth/sign-out',
])

/* ─── GET cache ────────────────────────────────────────────────────────
 * A 30s in-memory cache for GET responses. Two motivations:
 *   1. Manager views mount a list + a context panel simultaneously; without
 *      a shared cache both fire `api.admin.users.list()` and double the load.
 *   2. Navigating between sibling admin routes reuses the list instead of
 *      hitting the API again on every mount.
 *
 * Mutations call `invalidatePrefix()` after success so stale list/get
 * responses don't survive a write. Failed requests are auto-evicted so a
 * 5xx doesn't poison the cache for the full TTL.
 *
 * We deliberately do NOT cache pages/ (`api.pages.*`) — pages are mutated
 * constantly through the editor and the optimistic in-memory store already
 * de-duplicates. Caching here would only delay the next refresh.
 */
const FETCH_CACHE_TTL_MS = 30_000
interface CacheEntry {
  ts: number
  promise: Promise<unknown>
}
const fetchCache = new Map<string, CacheEntry>()

function cacheKey(method: string, path: string): string {
  return `${method} ${path}`
}

/**
 * Drop every cached entry whose path component starts with `prefix`.
 * Use after any mutation that affects the listed resource — the simplest
 * safe pattern is `invalidatePrefix('/admin/users')` for any users.* call.
 */
export function invalidatePrefix(prefix: string): void {
  const needle = ' ' + prefix
  for (const key of fetchCache.keys()) {
    const sep = key.indexOf(' ')
    if (sep >= 0 && key.indexOf(needle, sep) === sep) {
      fetchCache.delete(key)
    }
  }
}

/** Drop a single entry by method+path. */
export function invalidatePath(method: string, path: string): void {
  fetchCache.delete(cacheKey(method.toUpperCase(), path))
}

/** Wipe the entire cache — exposed for tests / forced refresh paths. */
export function clearFetchCache(): void {
  fetchCache.clear()
}

/**
 * Raw HTTP + 401 handling. No caching. Callers normally go through `request`,
 * which adds the GET cache layer on top.
 */
async function fetchAndParse<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      ...init,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...init?.headers,
      },
    })
  } catch (e) {
    // Network failure (server down, DNS, CORS rejected, offline…)
    throw new ApiError(0, 'network', e instanceof Error ? e.message : 'network failure')
  }

  if (res.status === 204) return undefined as T

  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = null
  }

  if (!res.ok) {
    const errBody = body as { error?: string; message?: string } | null
    const apiErr = new ApiError(
      res.status,
      errBody?.error ?? 'unknown',
      errBody?.message ?? `${res.status} ${res.statusText}`,
      body,
    )
    // Fire-and-forget the unauthorized handler for non-public 401s. Guarded
    // so a burst of parallel requests only triggers one navigation.
    if (
      res.status === 401 &&
      !PUBLIC_AUTH_PATHS.has(path) &&
      !unauthorizedFiring
    ) {
      unauthorizedFiring = true
      Promise.resolve()
        .then(() => unauthorizedHandler())
        .catch(() => {})
        .finally(() => {
          // Allow re-firing once the user has logged back in (handler usually
          // navigates to /login, which re-instantiates the app shell).
          setTimeout(() => {
            unauthorizedFiring = false
          }, 1000)
        })
    }
    throw apiErr
  }

  return body as T
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase()
  // Non-GET (POST/PATCH/PUT/DELETE) bypasses cache entirely. The endpoint
  // groups below call `invalidatePrefix()` after success to drop related
  // GET entries.
  if (method !== 'GET') return fetchAndParse<T>(path, init)

  const key = cacheKey(method, path)
  const cached = fetchCache.get(key)
  if (cached && Date.now() - cached.ts < FETCH_CACHE_TTL_MS) {
    return cached.promise as Promise<T>
  }
  const promise = fetchAndParse<T>(path, init)
  fetchCache.set(key, { ts: Date.now(), promise })
  // Evict on failure so the next caller retries instead of seeing a
  // rejected promise replayed for the next 30s.
  promise.catch(() => fetchCache.delete(key))
  return promise
}

/**
 * Single validated page. zod parse runs after the fetch — if the server sends
 * junk, this throws ApiError(500, 'schema_drift', …) before any consumer runs.
 */
async function getOnePage(path: string, init?: RequestInit): Promise<PageNode> {
  const raw = await request<PageNode>(path, init)
  return PageNodeSchema.parse(raw) as PageNode
}

/**
 * Paginated page list (Stage B.1). Validates the wrapper shape, then validates
 * each item with PageNodeSchema so a backend/frontend contract drift still
 * surfaces here, not at the component layer.
 */
async function getManyPages(path: string): Promise<Paginated<PageNode>> {
  const raw = await request<Paginated<PageNode>>(path)
  const wrapped = PaginatedListSchema(PageNodeSchema).parse(raw)
  return {
    items: wrapped.items,
    limit: wrapped.limit,
    offset: wrapped.offset,
    hasMore: wrapped.hasMore,
  }
}

async function getOneUser<TUser>(path: string, init?: RequestInit): Promise<TUser> {
  const raw = await request<TUser>(path, init)
  return UserSchema.parse(raw) as TUser
}

/**
 * Generic paginated list wrapper for `T` schemas. Same shape as getManyPages
 * but parameterised so admin endpoints (User / UserGroup / Space) reuse it.
 *
 * `schema` is typed loosely here because `PaginatedListSchema` requires a
 * `z.ZodTypeAny`, but we only use its `.parse()` at runtime — the loose
 * `{ parse: (v: unknown) => T }` shape is enough for the consumer side.
 * Cast at the call site keeps the type narrowing.
 */
async function getManyPaginated<T>(
  path: string,
  schema: { parse: (v: unknown) => T },
): Promise<Paginated<T>> {
  const raw = await request<Paginated<T>>(path)
  const wrapped = PaginatedListSchema(
    schema as unknown as Parameters<typeof PaginatedListSchema>[0],
  ).parse(raw)
  return {
    items: wrapped.items,
    limit: wrapped.limit,
    offset: wrapped.offset,
    hasMore: wrapped.hasMore,
  }
}

/* ─── Endpoint groups ──────────────────────────────────────────────────── */

export const api = {
  pages: {
    /**
     * List pages. `space` scopes to one space; `limit`/`offset` paginate.
     * Omitting both returns ALL pages (back-compat for stores/Sidebar tree).
     */
    list: (query?: PaginatedQuery & { space?: string }): Promise<Paginated<PageNode>> => {
      const params = new URLSearchParams()
      if (query?.space) params.set('space', query.space)
      if (query?.limit !== undefined) params.set('limit', String(query.limit))
      if (query?.offset !== undefined) params.set('offset', String(query.offset))
      const qs = params.toString() ? `?${params.toString()}` : ''
      return getManyPages(`/pages${qs}`)
    },
    get: (id: string) => getOnePage(`/pages/${encodeURIComponent(id)}`),
    create: (input: CreatePageInput) =>
      getOnePage('/pages', { method: 'POST', body: JSON.stringify(input) }),
    update: (id: string, input: UpdatePageInput) =>
      getOnePage(`/pages/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    move: (id: string, input: MovePageInput) =>
      getOnePage(`/pages/${encodeURIComponent(id)}/move`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    delete: (id: string) =>
      request<void>(`/pages/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    /**
     * Stage 5: trash listing (admin only).
     * `?space=<id>` is required by the backend; we surface the 400 as-is
     * and let the caller decide what to do. `limit`/`offset` paginate.
     */
    trash: {
      list: (spaceId: string, q?: PaginatedQuery): Promise<Paginated<PageNode>> => {
        const params = new URLSearchParams({ space: spaceId })
        if (q?.limit !== undefined) params.set('limit', String(q.limit))
        if (q?.offset !== undefined) params.set('offset', String(q.offset))
        return getManyPages(`/pages/trash?${params.toString()}`)
      },
    },
    /**
     * Stage 5: restore a single trashed page (admin only).
     * Returns void; on 409 the caller inspects `ApiError.body` for the
     * `parent_trashed` vs `not_trashed` reason.
     */
    restore: async (id: string): Promise<void> => {
      await request<void>(`/pages/${encodeURIComponent(id)}/restore`, {
        method: 'POST',
      })
      // Drop both: the main list (restored page reappears) and trash list
      // (restored page leaves the trash).
      invalidatePrefix('/pages/trash')
      invalidatePath('GET', '/pages')
    },
    /**
     * Stage 5: permanently delete a trashed page (admin only).
     * Underlying row must already be trashed, else backend returns 409.
     */
    purge: async (id: string): Promise<void> => {
      await request<void>(
        `/pages/${encodeURIComponent(id)}?purge=true`,
        { method: 'DELETE' },
      )
      invalidatePrefix('/pages/trash')
    },
  },

  spaces: {
    list: (q?: PaginatedQuery): Promise<Paginated<Space>> => {
      const params = new URLSearchParams()
      if (q?.limit !== undefined) params.set('limit', String(q.limit))
      if (q?.offset !== undefined) params.set('offset', String(q.offset))
      const qs = params.toString() ? `?${params.toString()}` : ''
      return getManyPaginated(`/spaces${qs}`, SpaceSchema)
    },
    get: async (id: string): Promise<Space> => {
      const raw = await request<Space>(`/spaces/${encodeURIComponent(id)}`)
      return SpaceSchema.parse(raw) as Space
    },
  },

  auth: {
    /** POST /api/auth/sign-in — returns user + mustResetPassword; sets cookie. */
    signIn: async (input: SignInInput) => {
      const parsed = SignInInputSchema.parse(input)
      const r = await request<{
        user: User
        mustResetPassword: boolean
        personalSpaceId: string | null
      }>('/auth/sign-in', { method: 'POST', body: JSON.stringify(parsed) })
      // Drop any cached /auth/session response (e.g. the boot init's 401, or
      // a previous user's session) so the very next init() — typically fired
      // by the router guard after router.replace('/...') — fetches a fresh
      // response reflecting the new session instead of replaying stale state.
      invalidatePath('GET', '/auth/session')
      // Wipe the entire GET cache. The cache is keyed by method+path only —
      // it does NOT know which user the response belongs to. Without this,
      // the very first authenticated call after sign-in (e.g. `GET /spaces`)
      // could replay a *previous* user's response, leaving the new user
      // looking at the old user's accessible spaces and selecting a space
      // they may not even be authorized for. Cheaper than threading the
      // user id through every cache key, and equally correct.
      clearFetchCache()
      return {
        user: UserSchema.parse(r.user) as User,
        mustResetPassword: r.mustResetPassword,
        personalSpaceId: r.personalSpaceId,
      }
    },
    signOut: async () => {
      await request<void>('/auth/sign-out', { method: 'POST' })
      // Drop the cached /auth/session response so the very next init() (from
      // router.replace → /login) doesn't replay the now-stale "logged in" user.
      // Without this, the public-route bounce branch in router.beforeEach
      // (isAuthed && to.name === 'login' → return '/') swallows the redirect
      // and the user appears stuck until they refresh.
      invalidatePath('GET', '/auth/session')
      // Wipe the entire cache for the same reason as signIn above: the next
      // user (or even a back-to-login boot) must not see a previous user's
      // cached responses (spaces, admin lists, group lists, etc.).
      clearFetchCache()
    },
    /** GET /api/auth/session — returns user + mustResetPassword; 401 if not logged in. */
    getSession: () =>
      request<{
        user: User
        mustResetPassword: boolean
        personalSpaceId: string | null
      }>('/auth/session').then((r) => ({
        user: UserSchema.parse(r.user) as User,
        mustResetPassword: r.mustResetPassword,
        personalSpaceId: r.personalSpaceId,
      })),
    resetPassword: async (input: ResetPasswordInput) => {
      const parsed = ResetPasswordInputSchema.parse(input)
      const r = await request<{ user: User; personalSpaceId: string | null }>(
        '/auth/reset-password',
        { method: 'POST', body: JSON.stringify(parsed) },
      )
      // Server flipped status → 'active', so the next /api/auth/session call
      // would return mustResetPassword=false. Without this invalidation, the
      // cached response (mustResetPassword=true from the pre-reset init())
      // would be replayed by the next init() in router.beforeEach, the guard
      // would see needsPasswordReset=true, and the user would be bounced
      // straight back to /reset-password — forcing them to set the password
      // twice.
      invalidatePath('GET', '/auth/session')
      return {
        user: UserSchema.parse(r.user) as User,
        personalSpaceId: r.personalSpaceId,
      }
    },
  },

  // Admin endpoints — Stage 4b/c. Defined here so callers can `api.admin.*`
  // without waiting for the manager UI to land.
  admin: {
    users: {
      list: (q?: PaginatedQuery): Promise<Paginated<User>> => {
        const params = new URLSearchParams()
        if (q?.limit !== undefined) params.set('limit', String(q.limit))
        if (q?.offset !== undefined) params.set('offset', String(q.offset))
        const qs = params.toString() ? `?${params.toString()}` : ''
        return getManyPaginated(`/admin/users${qs}`, UserSchema)
      },
      get: (id: string) => getOneUser<User>(`/admin/users/${encodeURIComponent(id)}`),
      create: async (
        input: CreateUserInput,
      ): Promise<{ user: User; initialPassword: string }> => {
        const raw = await request<{ user: User; initialPassword: string }>(
          '/admin/users',
          { method: 'POST', body: JSON.stringify(input) },
        )
        invalidatePrefix('/admin/users')
        return {
          user: UserSchema.parse(raw.user) as User,
          initialPassword: raw.initialPassword,
        }
      },
      update: async (id: string, input: UpdateUserInput): Promise<User> => {
        const u = await request<User>(
          `/admin/users/${encodeURIComponent(id)}`,
          { method: 'PATCH', body: JSON.stringify(input) },
        )
        invalidatePrefix('/admin/users')
        return UserSchema.parse(u) as User
      },
      disable: async (id: string): Promise<User> => {
        const u = await request<User>(
          `/admin/users/${encodeURIComponent(id)}/disable`,
          { method: 'POST' },
        )
        invalidatePrefix('/admin/users')
        return UserSchema.parse(u) as User
      },
      enable: async (id: string): Promise<User> => {
        const u = await request<User>(
          `/admin/users/${encodeURIComponent(id)}/enable`,
          { method: 'POST' },
        )
        invalidatePrefix('/admin/users')
        return UserSchema.parse(u) as User
      },
      resetPassword: async (id: string): Promise<string> => {
        const r = await request<{ initialPassword: string }>(
          `/admin/users/${encodeURIComponent(id)}/reset-password`,
          { method: 'POST' },
        )
        invalidatePrefix('/admin/users')
        return r.initialPassword
      },
    },
    groups: {
      list: (q?: PaginatedQuery): Promise<Paginated<UserGroup>> => {
        const params = new URLSearchParams()
        if (q?.limit !== undefined) params.set('limit', String(q.limit))
        if (q?.offset !== undefined) params.set('offset', String(q.offset))
        const qs = params.toString() ? `?${params.toString()}` : ''
        return getManyPaginated(`/admin/groups${qs}`, UserGroupSchema)
      },
      get: async (id: string): Promise<UserGroup> => {
        const raw = await request<UserGroup>(`/admin/groups/${encodeURIComponent(id)}`)
        return UserGroupSchema.parse(raw) as UserGroup
      },
      create: async (input: CreateGroupInput): Promise<UserGroup> => {
        const g = await request<UserGroup>('/admin/groups', {
          method: 'POST',
          body: JSON.stringify(input),
        })
        invalidatePrefix('/admin/groups')
        return UserGroupSchema.parse(g) as UserGroup
      },
      update: async (id: string, input: UpdateGroupInput): Promise<UserGroup> => {
        const g = await request<UserGroup>(
          `/admin/groups/${encodeURIComponent(id)}`,
          { method: 'PATCH', body: JSON.stringify(input) },
        )
        invalidatePrefix('/admin/groups')
        return UserGroupSchema.parse(g) as UserGroup
      },
      delete: async (id: string): Promise<void> => {
        await request<void>(`/admin/groups/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        })
        invalidatePrefix('/admin/groups')
      },
      addMember: async (groupId: string, userId: string): Promise<UserGroup> => {
        const g = await request<UserGroup>(
          `/admin/groups/${encodeURIComponent(groupId)}/members`,
          { method: 'POST', body: JSON.stringify({ userId }) },
        )
        invalidatePrefix('/admin/groups')
        return UserGroupSchema.parse(g) as UserGroup
      },
      removeMember: async (groupId: string, userId: string): Promise<void> => {
        await request<void>(
          `/admin/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`,
          { method: 'DELETE' },
        )
        invalidatePrefix('/admin/groups')
      },
    },
    spaces: {
      list: (q?: PaginatedQuery): Promise<Paginated<Space>> => {
        const params = new URLSearchParams()
        if (q?.limit !== undefined) params.set('limit', String(q.limit))
        if (q?.offset !== undefined) params.set('offset', String(q.offset))
        const qs = params.toString() ? `?${params.toString()}` : ''
        return getManyPaginated(`/admin/spaces${qs}`, SpaceSchema)
      },
      get: async (id: string): Promise<Space> => {
        const raw = await request<Space>(
          `/admin/spaces/${encodeURIComponent(id)}`,
        )
        return SpaceSchema.parse(raw) as Space
      },
      create: async (input: CreateSpaceInput): Promise<Space> => {
        const s = await request<Space>('/admin/spaces', {
          method: 'POST',
          body: JSON.stringify(input),
        })
        invalidatePrefix('/admin/spaces')
        return SpaceSchema.parse(s) as Space
      },
      update: async (id: string, input: UpdateSpaceInput): Promise<Space> => {
        const s = await request<Space>(
          `/admin/spaces/${encodeURIComponent(id)}`,
          { method: 'PATCH', body: JSON.stringify(input) },
        )
        invalidatePrefix('/admin/spaces')
        return SpaceSchema.parse(s) as Space
      },
      delete: async (id: string): Promise<void> => {
        await request<void>(`/admin/spaces/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        })
        invalidatePrefix('/admin/spaces')
      },
      setAccess: async (id: string, input: SetSpaceAccessInput): Promise<Space> => {
        const s = await request<Space>(
          `/admin/spaces/${encodeURIComponent(id)}/access`,
          { method: 'PUT', body: JSON.stringify(input) },
        )
        invalidatePrefix('/admin/spaces')
        return SpaceSchema.parse(s) as Space
      },
      addAccess: async (id: string, groupId: string): Promise<Space> => {
        const s = await request<Space>(
          `/admin/spaces/${encodeURIComponent(id)}/access/${encodeURIComponent(groupId)}`,
          { method: 'POST' },
        )
        invalidatePrefix('/admin/spaces')
        return SpaceSchema.parse(s) as Space
      },
      removeAccess: async (id: string, groupId: string): Promise<Space> => {
        const s = await request<Space>(
          `/admin/spaces/${encodeURIComponent(id)}/access/${encodeURIComponent(groupId)}`,
          { method: 'DELETE' },
        )
        invalidatePrefix('/admin/spaces')
        return SpaceSchema.parse(s) as Space
      },
    },
  },
} as const
