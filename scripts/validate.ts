#!/usr/bin/env tsx
import { loadLandkaart } from './lib/loader.ts';

try {
  const lk = loadLandkaart();
  const topicCount = lk.apis.reduce((n, a) => n + a.topics.length, 0);
  console.log('✓ Landkaart valide');
  console.log(`  ${Object.keys(lk.systemen).length} systemen`);
  console.log(`  ${lk.apis.length} API's (${topicCount} topics totaal)`);
  console.log(`  versie ${lk.metadata.versie} (${lk.metadata.datum})`);
} catch (err) {
  console.error('✗ Validatie mislukt\n');
  console.error((err as Error).message);
  process.exit(1);
}
