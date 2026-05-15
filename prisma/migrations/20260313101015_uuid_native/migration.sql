/*
  Warnings:

  - The primary key for the `todos` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `users` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - Changed the type of `id` on the `todos` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `user_id` on the `todos` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `id` on the `users` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- DropForeignKey
ALTER TABLE "todos" DROP CONSTRAINT "todos_user_id_fkey";

-- DropIndex
DROP INDEX "todos_user_id_created_at_idx";

-- AlterTable users: in-place type change (must run before todos.user_id references it)
ALTER TABLE "users" ALTER COLUMN "id" TYPE uuid USING "id"::uuid;

-- AlterTable todos: in-place type change
ALTER TABLE "todos" ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;
ALTER TABLE "todos" ALTER COLUMN "id" TYPE uuid USING "id"::uuid;

-- CreateIndex
CREATE INDEX "todos_user_id_created_at_idx" ON "todos"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "todos" ADD CONSTRAINT "todos_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
