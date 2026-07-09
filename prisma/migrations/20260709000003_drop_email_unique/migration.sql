-- Encryption-at-rest, CONTRACT phase (3/3). The email column now holds
-- AES-256-GCM ciphertext (backfill --phase=encrypt on a populated DB), so its
-- plaintext unique index no longer enforces anything meaningful — two rows for
-- the same address encrypt to different ciphertext. Uniqueness now rests solely
-- on users_email_hash_key.
--
-- Apply only after every row's email is encrypted and the app that reads by
-- blind index (findByEmail) is live. See docs/operations.md.
DROP INDEX "users_email_key";
