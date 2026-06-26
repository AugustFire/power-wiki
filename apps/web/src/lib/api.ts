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
  ResetPasswordInputSchema,
  SignInInputSchema,
  SpaceSchema,
  UserSchema,
} from '@power-wiki/shared/schemas'
import type {
  CreatePageInput,
  MovePageInput,
  PageNode,
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
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
    throw new ApiError(
      res.status,
      errBody?.error ?? 'unknown',
      errBody?.message ?? `${res.status} ${res.statusText}`,
      body,
    )
  }

  return body as T
}

/**
 * Single validated page. zod parse runs after the fetch — if the server sends
 * junk, this throws ApiError(500, 'schema_drift', …) before any consumer runs.
 */
async function getOnePage(path: string, init?: RequestInit): Promise<PageNode> {
  const raw = await request<PageNode>(path, init)
  return PageNodeSchema.parse(raw) as PageNode
}

async function getManyPages(path: string): Promise<PageNode[]> {
  const raw = await request<PageNode[]>(path)
  return raw.map((p) => PageNodeSchema.parse(p) as PageNode)
}

async function getOneUser<TUser>(path: string, init?: RequestInit): Promise<TUser> {
  const raw = await request<TUser>(path, init)
  return UserSchema.parse(raw) as TUser
}

/* ─── Endpoint groups ──────────────────────────────────────────────────── */

export const api = {
  pages: {
    list: (query?: { space?: string }) => {
      const qs = query?.space ? `?space=${encodeURIComponent(query.space)}` : ''
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
  },

  spaces: {
    list: async (): Promise<Space[]> => {
      const raw = await request<Space[]>('/spaces')
      return raw.map((s) => SpaceSchema.parse(s) as Space)
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
      return request<{ user: User; mustResetPassword: boolean }>(
        '/auth/sign-in',
        { method: 'POST', body: JSON.stringify(parsed) },
      ).then((r) => ({
        user: UserSchema.parse(r.user) as User,
        mustResetPassword: r.mustResetPassword,
      }))
    },
    signOut: () => request<void>('/auth/sign-out', { method: 'POST' }),
    /** GET /api/auth/session — returns user + mustResetPassword; 401 if not logged in. */
    getSession: () =>
      request<{ user: User; mustResetPassword: boolean }>('/auth/session').then(
        (r) => ({
          user: UserSchema.parse(r.user) as User,
          mustResetPassword: r.mustResetPassword,
        }),
      ),
    resetPassword: async (input: ResetPasswordInput) => {
      const parsed = ResetPasswordInputSchema.parse(input)
      return request<{ user: User }>('/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify(parsed),
      }).then((r) => ({ user: UserSchema.parse(r.user) as User }))
    },
  },

  // Admin endpoints — Stage 4b/c. Defined here so callers can `api.admin.*`
  // without waiting for the manager UI to land.
  admin: {
    users: {
      list: async (): Promise<User[]> => {
        const raw = await request<User[]>('/admin/users')
        return raw.map((u) => UserSchema.parse(u) as User)
      },
      get: (id: string) => getOneUser<User>(`/admin/users/${encodeURIComponent(id)}`),
      create: async (
        input: CreateUserInput,
      ): Promise<{ user: User; initialPassword: string }> => {
        const raw = await request<{ user: User; initialPassword: string }>(
          '/admin/users',
          { method: 'POST', body: JSON.stringify(input) },
        )
        return {
          user: UserSchema.parse(raw.user) as User,
          initialPassword: raw.initialPassword,
        }
      },
      update: (id: string, input: UpdateUserInput) =>
        request<User>(`/admin/users/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify(input),
        }).then((u) => UserSchema.parse(u) as User),
      disable: (id: string) =>
        request<User>(`/admin/users/${encodeURIComponent(id)}/disable`, {
          method: 'POST',
        }).then((u) => UserSchema.parse(u) as User),
      enable: (id: string) =>
        request<User>(`/admin/users/${encodeURIComponent(id)}/enable`, {
          method: 'POST',
        }).then((u) => UserSchema.parse(u) as User),
      resetPassword: (id: string) =>
        request<{ initialPassword: string }>(
          `/admin/users/${encodeURIComponent(id)}/reset-password`,
          { method: 'POST' },
        ).then((r) => r.initialPassword),
    },
    groups: {
      list: async (): Promise<UserGroup[]> => request<UserGroup[]>('/admin/groups'),
      get: (id: string) =>
        request<UserGroup>(`/admin/groups/${encodeURIComponent(id)}`),
      create: (input: CreateGroupInput) =>
        request<UserGroup>('/admin/groups', {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      update: (id: string, input: UpdateGroupInput) =>
        request<UserGroup>(`/admin/groups/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify(input),
        }),
      delete: (id: string) =>
        request<void>(`/admin/groups/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        }),
      addMember: (groupId: string, userId: string) =>
        request<UserGroup>(`/admin/groups/${encodeURIComponent(groupId)}/members`, {
          method: 'POST',
          body: JSON.stringify({ userId }),
        }),
      removeMember: (groupId: string, userId: string) =>
        request<void>(
          `/admin/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`,
          { method: 'DELETE' },
        ),
    },
    spaces: {
      list: async (): Promise<Space[]> => {
        const raw = await request<Space[]>('/admin/spaces')
        return raw.map((s) => SpaceSchema.parse(s) as Space)
      },
      get: async (id: string): Promise<Space> => {
        const raw = await request<Space>(
          `/admin/spaces/${encodeURIComponent(id)}`,
        )
        return SpaceSchema.parse(raw) as Space
      },
      create: (input: CreateSpaceInput) =>
        request<Space>('/admin/spaces', {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      update: (id: string, input: UpdateSpaceInput) =>
        request<Space>(`/admin/spaces/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify(input),
        }),
      delete: (id: string) =>
        request<void>(`/admin/spaces/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        }),
      setAccess: (id: string, input: SetSpaceAccessInput) =>
        request<Space>(`/admin/spaces/${encodeURIComponent(id)}/access`, {
          method: 'PUT',
          body: JSON.stringify(input),
        }),
    },
  },
} as const
