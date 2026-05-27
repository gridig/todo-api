-- Backfill: NFC-normalize existing users.email values so the stored rows
-- agree with the canonical form produced by normalizeEmail() in
-- models/User.ts (which itself agrees with the rate-limit key and Joi
-- validation in middleware/rateLimiter.ts and middleware/validation.ts).
--
-- Requires Postgres >= 13 for the `normalize(text, FORM)` function.
--
-- Fails closed if two existing rows would collide on NFC normalization
-- (e.g. one user registered as `café@...`, another as `café@...`);
-- the operator must reconcile manually before re-running.

DO $$
DECLARE
  dup INTEGER;
BEGIN
  SELECT COUNT(*) INTO dup FROM (
    SELECT normalize(email, NFC) AS norm
    FROM users
    GROUP BY norm
    HAVING COUNT(*) > 1
  ) d;

  IF dup > 0 THEN
    RAISE EXCEPTION
      'NFC backfill aborted: % distinct emails would collide after normalization. Reconcile manually before re-running this migration.', dup;
  END IF;
END $$;

UPDATE users
SET email = normalize(email, NFC)
WHERE email <> normalize(email, NFC);
