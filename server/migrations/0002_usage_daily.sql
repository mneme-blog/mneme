-- 0002_usage_daily.sql — owner-less daily usage counters for the admin dashboard.
-- Deliberately NO owner_id column: these aggregates must never be attributable to
-- a vault. Per-vault storage figures come from the existing bookkeeping tables
-- (entry_blobs/media_blobs), which the relay already stores as accepted metadata.
--
-- rollback: safe — a new table only; an older relay never looks at it.
CREATE TABLE usage_daily (
    day    DATE   NOT NULL,
    metric TEXT   NOT NULL,
    count  BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (day, metric)
);
