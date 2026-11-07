/**
 * The weighted full-text document for a product row. Must stay identical to
 * the expression index in migration B3ProductsSearchFeed so PostgreSQL uses
 * the index. Title is weighted highest (A), tags B, description D.
 * Category names are matched separately (they live in another table).
 */
export const searchDocument = (alias: string) =>
  `(setweight(to_tsvector('english', coalesce(${alias}."title", '')), 'A') || ` +
  `setweight(to_tsvector('english', translate(coalesce(${alias}."tags"::text, ''), '[]",', '    ')), 'B') || ` +
  `setweight(to_tsvector('english', coalesce(${alias}."description", '')), 'D'))`;
