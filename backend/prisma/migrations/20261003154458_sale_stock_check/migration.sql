-- Prisma schema cannot express CHECK constraints, so this one lives only in SQL.
ALTER TABLE "Sale"
  ADD CONSTRAINT "Sale_available_stock_check"
  CHECK (available_stock >= 0 AND available_stock <= total_stock);
