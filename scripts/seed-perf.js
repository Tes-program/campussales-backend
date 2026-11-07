#!/usr/bin/env node
/* eslint-disable */
// LOCAL TESTING ONLY. Seeds realistic data for performance checks:
//   node scripts/seed-perf.js --database=campussales_bench [--products=10000]
// Refuses any non-local host and any database not ending in _bench or _test.
// Creates 400 sellers spread over every seeded school (>= 8) and products in
// all 13 categories, with 1-3 images, varied prices, ages (0-120 days),
// statuses (mostly active), tags and some price drops.

const { parseArgs, connect, isLocalHost, dbConfig } = require('./lib/common');
const bcrypt = require('bcryptjs');

const TEMPLATES = {
  electronics: ['Apple iPhone {n} Pro', 'Samsung Galaxy A{n}', 'HP laptop 15 inch {n}GB RAM', 'Dell Inspiron laptop', 'Tecno Camon {n}', 'Infinix Hot {n}', 'Oraimo power bank 20000mAh', 'JBL Bluetooth speaker', 'Lenovo ThinkPad T{n}', 'iPad Air {n}th gen', 'Sony headphones', 'Tokunbo MacBook Pro'],
  'books-textbooks': ['Engineering Mathematics by Stroud', 'Organic Chemistry textbook', 'Introduction to Algorithms', 'JAMB past questions', 'Principles of Economics', 'Law of Contract notes', 'Anatomy atlas', 'Things Fall Apart novel'],
  'school-supplies': ['Casio fx-991ES calculator', 'Lab coat size {s}', 'Drawing board and T-square', 'Scientific calculator', 'Stapler and punch set', 'A4 ring binder pack'],
  'clothing-apparel': ['Ankara dress size {s}', 'Nike sneakers size {n}', 'Agbada set', 'Denim jacket', 'Corporate shirt', 'Canvas shoes size {n}'],
  furniture: ['Reading table and chair', 'Plastic chair', 'Shoe rack', 'Bookshelf 4 tier', 'Foam mattress 6 by 4', 'Bedside drawer'],
  'home-kitchen': ['Electric kettle', 'Standing fan', 'Rechargeable fan', 'Gas cooker 2 burner', 'Blender', 'Pressing iron', 'Mini fridge'],
  'sports-outdoors': ['Football size 5', 'Gym dumbbells {n}kg', 'Jersey', 'Badminton rackets', 'Skipping rope'],
  gaming: ['PS4 slim with 2 pads', 'PS5 controller', 'FIFA 24 PS5', 'Xbox Series S', 'Chess board'],
  'musical-instruments': ['Acoustic guitar', 'Yamaha keyboard', 'Talking drum', 'Ukulele', 'Microphone stand'],
  'art-crafts': ['Acrylic paint set', 'Sketch pad A3', 'Canvas boards pack', 'Brush set'],
  'bikes-transportation': ['Mountain bicycle', 'Bicycle with gears', 'Electric scooter', 'Bicycle helmet'],
  'beauty-personal-care': ['Hair dryer', 'Shea butter 500g', 'Perfume oil', 'Clippers set'],
  other: ['Room heater', 'Umbrella', 'Wall clock', 'Backpack'],
};
const CONDITIONS = ['new', 'like_new', 'used', 'used', 'fair'];
const SIZES = ['S', 'M', 'L', 'XL'];
const rnd = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const pick = (a) => a[Math.floor(Math.random() * a.length)];

async function main() {
  const args = parseArgs();
  const cfg = dbConfig(args);
  if (!isLocalHost(cfg.host) || !/_(bench|test)$/.test(cfg.database)) {
    console.error(
      `Refusing: seed-perf only runs on a local *_bench or *_test database (got ${cfg.host}/${cfg.database}).`,
    );
    process.exit(2);
  }
  const total = Number(args.products || 10000);
  const { client } = await connect(args);
  try {
    const schools = (await client.query(`SELECT id FROM universities WHERE "isActive"`)).rows;
    const cats = (await client.query(`SELECT id, slug FROM categories WHERE "isActive"`)).rows;
    if (schools.length < 8 || cats.length < 12) {
      throw new Error('Seed schools and categories first (npm run seed:schools, npm run seed:categories).');
    }
    const catBySlug = Object.fromEntries(cats.map((c) => [c.slug, c.id]));
    const hash = bcrypt.hashSync('bench-password-1', 4);
    const stamp = Date.now();

    console.log(`Creating 400 sellers across ${schools.length} schools...`);
    const sellers = [];
    for (let i = 0; i < 400; i++) {
      const school = schools[i % schools.length];
      const u = await client.query(
        `INSERT INTO users (email, "passwordHash", username, "lastActiveAt", "emailVerifiedAt")
         VALUES ($1, $2, $3, now() - ($4 || ' hours')::interval, now()) RETURNING id`,
        [`bench${i}-${stamp}@example.edu.ng`, hash, `bench_${i}_${stamp}`, String(rnd(0, 240))],
      );
      await client.query(
        `INSERT INTO user_profiles ("userId", "firstName", "lastName", "universityId") VALUES ($1, $2, $3, $4)`,
        [u.rows[0].id, pick(['Ada', 'Tunde', 'Chioma', 'Ibrahim', 'Zainab', 'Femi', 'Ngozi', 'Musa']), 'Bench', school.id],
      );
      sellers.push({ id: u.rows[0].id, campus: school.id });
    }

    console.log(`Creating ${total} products...`);
    const slugs = Object.keys(TEMPLATES).filter((s) => catBySlug[s]);
    const BATCH = 500;
    for (let start = 0; start < total; start += BATCH) {
      const values = [];
      const params = [];
      for (let k = 0; k < Math.min(BATCH, total - start); k++) {
        const slug = slugs[(start + k) % slugs.length];
        const s = pick(sellers);
        const title = pick(TEMPLATES[slug]).replace('{n}', String(rnd(4, 16))).replace('{s}', pick(SIZES));
        const price = rnd(5, 4000) * 100;
        const roll = Math.random();
        const status = roll < 0.85 ? 'active' : roll < 0.95 ? 'sold' : 'inactive';
        const drop =
          Math.random() < 0.1
            ? JSON.stringify([{ oldPrice: price + 2000, newPrice: price, changedAt: new Date(Date.now() - rnd(0, 10) * 86400000).toISOString() }])
            : '[]';
        const tags = JSON.stringify([slug.split('-')[0], title.split(' ')[0].toLowerCase()]);
        const p = params.length;
        values.push(
          `($${p + 1}, $${p + 2}, $${p + 3}, $${p + 4}, $${p + 5}, $${p + 6}, 1, $${p + 7}, $${p + 8}, $${p + 9}, $${p + 10}::jsonb, $${p + 11}::jsonb, now() - ($${p + 12} || ' minutes')::interval, $${p + 13})`,
        );
        params.push(
          s.id, catBySlug[slug], title,
          `${title}. Clean and working, pickup on campus. ${'Good condition. '.repeat(rnd(1, 8))}`,
          price, pick(CONDITIONS), status === 'active', status === 'sold', status, tags, drop,
          String(rnd(0, 120 * 24 * 60)), s.campus,
        );
      }
      const res = await client.query(
        `INSERT INTO products ("sellerId", "categoryId", title, description, price, condition, quantity, "isAvailable", "isSold", status, tags, "priceHistory", "createdAt", "campusId")
         VALUES ${values.join(',')} RETURNING id`,
        params,
      );
      const imgVals = [];
      const imgParams = [];
      for (const r of res.rows) {
        const n = rnd(1, 3);
        for (let j = 0; j < n; j++) {
          const q = imgParams.length;
          imgVals.push(`($${q + 1}, $${q + 2}, $${q + 3}, $${q + 4})`);
          imgParams.push(r.id, `https://res.cloudinary.com/campussales-bench/image/upload/${r.id}-${j}.jpg`, j === 0, j);
        }
      }
      await client.query(
        `INSERT INTO product_images ("productId", "imageUrl", "isPrimary", "sortOrder") VALUES ${imgVals.join(',')}`,
        imgParams,
      );
      process.stdout.write(`  ${Math.min(start + BATCH, total)}/${total}\r`);
    }
    console.log('\nRefreshing search vocabulary and planner statistics...');
    await client.query(`REFRESH MATERIALIZED VIEW "search_vocabulary"`);
    await client.query(`ANALYZE`);
    console.log('Done.');
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('seed-perf failed:', e.message);
  process.exit(1);
});
