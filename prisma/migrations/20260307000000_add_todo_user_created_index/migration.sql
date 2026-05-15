-- CreateIndex
CREATE INDEX "todos_user_id_created_at_idx" ON "todos"("user_id", "created_at" DESC);
