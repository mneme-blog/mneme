-- 0003_owner_approval.sql — optional operator approval for new vaults (forward-only).
--
-- Opt-in via REQUIRE_APPROVAL. When enabled, a newly registered owner starts
-- 'pending' and cannot obtain a session (nor make any authenticated call) until
-- the operator approves it in /admin. When disabled (the default) new owners are
-- created 'approved', i.e. today's open trust-on-first-use behaviour.
--
-- The column DEFAULT is 'approved', so every owner that ALREADY exists is
-- grandfathered to 'approved' by this migration — enabling approval later never
-- locks out anyone already on the relay; it only gates registrations made after.
--
-- approval_hint is a short, human-readable code the CLIENT derives one-way from
-- the seed (like owner_id) purely so the operator can tell which pending vault
-- belongs to whom. It is a hint, not a secret, and the only non-ciphertext,
-- user-adjacent string the relay stores — a deliberate, minimal accepted leak
-- (§3). Its charset is constrained to [a-z0-9-] by the register handler, so it
-- can never carry markup or free-form PII.
--
-- rollback: safe — two columns with defaults plus an index; an older relay that
-- never selects them keeps working against this schema unchanged.
ALTER TABLE owners
    ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'
        CHECK (status IN ('pending', 'approved', 'rejected'));

ALTER TABLE owners
    ADD COLUMN approval_hint TEXT NOT NULL DEFAULT '';

-- Approving/rejecting scans for pending vaults; keep that cheap.
CREATE INDEX owners_status_idx ON owners (status);
