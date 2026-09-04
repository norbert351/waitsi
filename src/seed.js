// Seed the discovery catalog with the Sponsor Ad Network demo fixtures.
import { db, initSchema } from './db.js';
import { formatMicro } from './world.js';

initSchema();

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

const existing = db.prepare('SELECT COUNT(*) AS n FROM discoveries').get().n;
if (existing === 0) {
  const ins = db.prepare(
    `INSERT INTO discoveries (sponsor, title, category, surface, cpm, budget_remaining)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const f of fixtures) {
    ins.run(f.sponsor, f.title, f.category, f.surface, f.cpm, f.budget);
  }
  console.log(`Seeded ${fixtures.length} discovery surfaces.`);
} else {
  console.log('Discoveries already present — skipping seed.');
}

const total = db.prepare('SELECT COALESCE(SUM(budget_remaining),0) AS t, COUNT(*) AS n FROM discoveries').get();
console.log(`Discovery budget remaining: ${formatMicro(total.t)} $CMNS across ${total.n} surfaces.`);