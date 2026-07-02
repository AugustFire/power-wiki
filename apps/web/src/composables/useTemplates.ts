/**
 * useTemplates — module-scoped singleton for page templates.
 *
 * Templates are scoped per "view space" — when the TemplatePickerDialog
 * opens for space X we want to load built-ins + X-scoped templates once
 * and share that load across mounts. Per-space promise cache matches the
 * pattern in useManagerStats / usePageVersions.
 *
 * Invalidate on auth reset so a different user doesn't see the previous
 * user's template picker.
 */
import { reactive } from 'vue'
import { api } from '@/lib/api'
import type { PageTemplate } from '@power-wiki/shared'

interface SpaceState {
  templates: PageTemplate[]
  loading: boolean
  loaded: boolean
  inflight: Promise<void> | null
  loadError: unknown
}

const bySpace = new Map<string, SpaceState>()

function get(spaceId: string | null): SpaceState {
  const key = spaceId ?? '__globals'
  let s = bySpace.get(key)
  if (!s) {
    s = reactive({
      templates: [],
      loading: false,
      loaded: false,
      inflight: null,
      loadError: null,
    }) as SpaceState
    bySpace.set(key, s)
  }
  return s
}

async function doLoad(spaceId: string | null): Promise<void> {
  const state = get(spaceId)
  state.loading = true
  state.loadError = null
  try {
    state.templates = await api.templates.list(spaceId)
    state.loaded = true
  } catch (e) {
    state.loadError = e
    throw e
  } finally {
    state.loading = false
  }
}

async function ensureLoaded(spaceId: string | null): Promise<void> {
  const state = get(spaceId)
  if (state.loaded && !state.loadError) return
  if (state.inflight) return state.inflight
  state.inflight = doLoad(spaceId).finally(() => {
    state.inflight = null
  })
  return state.inflight
}

async function refresh(spaceId: string | null): Promise<void> {
  bySpace.delete(spaceId ?? '__globals')
  await ensureLoaded(spaceId)
}

async function create(input: Parameters<typeof api.templates.create>[0]): Promise<PageTemplate> {
  const t = await api.templates.create(input)
  // Invalidate both the target space + globals (the new template might be either).
  bySpace.delete(input.spaceId ?? '__globals')
  return t
}

async function remove(id: string): Promise<void> {
  await api.templates.delete(id)
  bySpace.clear()
}

function invalidate(): void {
  bySpace.clear()
}

export function useTemplates() {
  return {
    ensureLoaded,
    refresh,
    create,
    remove,
    invalidate,
    state: (spaceId: string | null): SpaceState => get(spaceId),
  }
}