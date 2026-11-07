# B3 performance proof

Run on 2026-11-07, local PostgreSQL 14, WSL2 laptop. Database `campussales_bench` seeded with `npm run seed:perf` (10,000 products, 400 sellers, 73 schools, 13 categories, 1 to 3 images each). The compiled API (`node dist/main`) was measured over HTTP with `node scripts/bench-b3.js` (200 sequential requests per scenario after 10 warm-up requests), so the numbers include Nest, serialisation and the network stack, which is stricter than the database-only target.

**Target:** p95 under 300 ms for list and item endpoints. **Result:** worst p95 is 49 ms (search). List endpoints run 3 queries (4 with `q`); the budget is 5.

```

Scenario                           p50 ms   p95 ms   max ms  queries
---------------------------------  ------   ------   ------  -------
list newest (first page)             16.3     20.7     24.2        3
list newest (cursor page)            15.1     19.9     33.6        3
list campus + category               11.7     16.6     43.5        3
list price_asc + range               16.2     23.4     31.6        3
search q=laptop                      38.7     49.0     63.3        4
search q=laptpo (typo)               38.2     47.7     59.6        4
search q=iphon relevance             31.2     36.1     44.4        4
item GET /products/:id                9.5     12.0     16.8        3
suggest q=lap                         1.7      5.1     62.2        0

EXPLAIN ANALYZE: list newest, campus filter
  Limit (actual time=0.023..0.226 rows=21 loops=1)
    Buffers: shared hit=22
    ->  Index Scan using "IDX_products_status_campus_created" on products p (actual time=0.022..0.221 rows=21 loops=1)
          Index Cond: (((status)::text = 'active'::text) AND ("campusId" = '7cceedf4-33c4-48ee-b5b2-8d4961390b10'::uuid))
          Filter: ("deletedAt" IS NULL)
          Buffers: shared hit=22
  Planning:
    Buffers: shared hit=29
  Planning Time: 0.256 ms
  Execution Time: 0.254 ms

EXPLAIN ANALYZE: full-text search "laptop"
  Limit (actual time=9.778..9.784 rows=21 loops=1)
    Buffers: shared hit=152
    ->  Sort (actual time=9.776..9.780 rows=21 loops=1)
          Sort Key: "createdAt" DESC, id DESC
          Sort Method: top-N heapsort  Memory: 27kB
          Buffers: shared hit=152
          ->  Bitmap Heap Scan on products p (actual time=0.340..9.696 rows=107 loops=1)
                Recheck Cond: ((((setweight(to_tsvector('english'::regconfig, (COALESCE(title, ''::character varying))::text), 'A'::"char") || setweight(to_tsvector('english'::regconfig, translate(COALESCE((tags)::text, ''::text), '[]",'::text, '    '::text)), 'B'::"char")) || setweight(to_tsvector('english'::regconfig, COALESCE(description, ''::text)), 'D'::"char")) @@ '''laptop'':*'::tsquery) OR ('laptop'::text <% lower((title)::text)))
                Filter: (("deletedAt" IS NULL) AND ((status)::text = 'active'::text) AND ((((setweight(to_tsvector('english'::regconfig, (COALESCE(title, ''::character varying))::text), 'A'::"char") || setweight(to_tsvector('english'::regconfig, translate(COALESCE((tags)::text, ''::text), '[]",'::text, '    '::text)), 'B'::"char")) || setweight(to_tsvector('english'::regconfig, COALESCE(description, ''::text)), 'D'::"char")) @@ '''laptop'':*'::tsquery) OR ('laptop'::text <% lower((title)::text))))
                Rows Removed by Filter: 20
                Heap Blocks: exact=119
                Buffers: shared hit=146
                ->  BitmapOr (actual time=0.219..0.220 rows=0 loops=1)
                      Buffers: shared hit=23
                      ->  Bitmap Index Scan on "IDX_products_search" (actual time=0.078..0.078 rows=127 loops=1)
                            Index Cond: (((setweight(to_tsvector('english'::regconfig, (COALESCE(title, ''::character varying))::text), 'A'::"char") || setweight(to_tsvector('english'::regconfig, translate(COALESCE((tags)::text, ''::text), '[]",'::text, '    '::text)), 'B'::"char")) || setweight(to_tsvector('english'::regconfig, COALESCE(description, ''::text)), 'D'::"char")) @@ '''laptop'':*'::tsquery)
                            Buffers: shared hit=5
                      ->  Bitmap Index Scan on "IDX_products_title_trgm" (actual time=0.141..0.141 rows=127 loops=1)
                            Index Cond: (lower((title)::text) %> 'laptop'::text)
                            Buffers: shared hit=18
  Planning:
    Buffers: shared hit=55
  Planning Time: 2.266 ms
  Execution Time: 9.885 ms

Worst p95: 49.0 ms (target 300 ms).
```

Reproduce:

```bash
createdb campussales_bench
DATABASE_NAME=campussales_bench npm run migration:run
DATABASE_NAME=campussales_bench npm run seed:categories
DATABASE_NAME=campussales_bench npm run seed:schools
node scripts/seed-perf.js --database=campussales_bench
npm run build && DATABASE_NAME=campussales_bench NODE_ENV=test PORT=3999 node dist/main &
node scripts/bench-b3.js --base=http://localhost:3999/api --database=campussales_bench
```
