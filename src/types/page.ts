export interface PageNode {
  id: string
  parentId: string | null
  title: string
  contentJSON: Record<string, unknown>
  contentHTML: string
  icon?: string
  order: number
  createdAt: number
  updatedAt: number
  authorId: string
  starred?: boolean
}

export interface TreeNode {
  id: string
  title: string
  parentId: string | null
  order: number
  children: TreeNode[]
}