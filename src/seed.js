// Seed the discovery catalog with the Sponsor Ad Network demo fixtures.
import { pool, initSchema, S } from './db.js';
import { formatMicro } from './world.js';

await initSchema();

const fixtures = [
  { sponsor: 'Commons Compute', title: 'Rent idle build capacity', category: 'infra', surface: 'a compute marketplace',
    cpm: 2400, budget: 2_000_000 },
  { sponsor: 'VibeNova', title: 'A faster reasoning model', category: 'model', surface: 'a model playground',
    cpm: 3200, budget: 3_000_000 },
  { sponsor: 'ShipDeploy', title: 'Zero-config deploys', category: 'tool', surface: 'a deploy dashboard',
    cpm: 1800, budget: 1_500_000 },
  { sponsor: 'PromptForge', title: 'Battle-tested prompt kits', category: 'tool', surface: 'a prompt library',
    cpm: 1500, budget: 1_200_000 },
  { sponsor: 'AgentFleet', title: 'Run 10 agents on one job', category: 'infra', surface: 'an orchestration panel',
    cpm: 2800, budget: 2_400_000 },
  { sponsor: 'DevTokens', title: 'Community $CMNS layer', category: 'brand', surface: 'the commons ledger',
    cpm: 2000, budget: 1_800_000 },
];

const existing = (await pool.query(`SELECT COUNT(*)::int AS n FROM ${S}discoveries`)).rows[0].n;
if (existing === 0) {
  for (const f of fixtures) {
    await pool.query(
      `INSERT INTO ${S}discoveries (sponsor, title, category, surface, cpm, budget_remaining)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [f.sponsor, f.title, f.category, f.surface, f.cpm, f.budget],
    );
  }
  console.log(`Seeded ${fixtures.length} discovery surfaces.`);
} else {
  console.log('Discoveries already present — skipping seed.');
}

const t = (await pool.query(`SELECT COALESCE(SUM(budget_remaining),0) AS t, COUNT(*)::int AS n FROM ${S}discoveries`)).rows[0];
console.log(`Discovery budget remaining: ${formatMicro(t.t)} $CMNS across ${t.n} surfaces.`);

await pool.end();