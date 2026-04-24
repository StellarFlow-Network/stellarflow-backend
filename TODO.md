# TODO: Add Indexes for Historical Data Query Performance

## Plan
- [x] Analyze schema.prisma and query patterns in history.ts / intelligenceService.ts
- [x] Edit prisma/schema.prisma: Add `@@index([updatedAt])` to PriceHistory model
- [x] Edit prisma/schema.prisma: Add `@@index([symbol])` to Currency model
- [x] Run Prisma generate and db push to apply indexes (Node/npm not available in current terminal; user must run locally)
- [ ] Verify changes and test endpoints

