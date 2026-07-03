-- page_templates was removed entirely in 61a3367 (schema / routes / frontend),
-- but no DROP migration was added at the time. This cleans the orphan table
-- and its data from any environment that ran 0006 under the original tag.
DROP TABLE IF EXISTS "page_templates";