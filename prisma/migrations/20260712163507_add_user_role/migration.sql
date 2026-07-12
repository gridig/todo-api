-- AlterTable
ALTER TABLE "users" ADD COLUMN     "role" TEXT NOT NULL DEFAULT 'user';

-- Enforce the role domain at the DB layer. Kept in raw SQL (not schema.prisma)
-- so `prisma migrate diff` never emits a DROP for it.
ALTER TABLE "users" ADD CONSTRAINT "users_role_check" CHECK ("role" IN ('user', 'admin'));

-- CreateIndex
CREATE INDEX "users_created_at_idx" ON "users"("created_at");
