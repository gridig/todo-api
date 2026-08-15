-- Verified email change. PATCH /user/me/email previously re-authenticated with
-- the current password and swapped the address immediately, proving nothing
-- about the NEW address: a typo locked the user out of their own account, and an
-- attacker holding a session plus the password could move the account to an
-- inbox they control. The address now lands here until a token mailed to it is
-- redeemed.
--
-- Hand-written rather than `prisma migrate dev --create-only`: db_admin is not a
-- superuser and cannot create the shadow database (P3014). Mirrors the shape the
-- generator produced for email_verification_tokens.

-- CreateTable
CREATE TABLE "email_change_tokens" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "new_email" TEXT NOT NULL,
    "new_email_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumed_at" TIMESTAMPTZ,

    CONSTRAINT "email_change_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_change_tokens_token_hash_key" ON "email_change_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "email_change_tokens_user_id_idx" ON "email_change_tokens"("user_id");

-- CreateIndex
CREATE INDEX "email_change_tokens_expires_at_idx" ON "email_change_tokens"("expires_at");

-- AddForeignKey
ALTER TABLE "email_change_tokens" ADD CONSTRAINT "email_change_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
