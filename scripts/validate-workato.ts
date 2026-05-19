#!/usr/bin/env tsx
/**
 * VALIDATE-WORKATO — exploratiefase (read-only)
 * =============================================
 *
 * Vergelijkt de in Git vastgelegde event topics met de werkelijke staat in Workato.
 *
 * Huidige scope:
 *   1. Auth via WORKATO_API_TOKEN (.env).
 *   2. Haal event topics op uit Workato en vergelijk op naam met data/apis/.
 *   3. Haal recipes op en dump één sample-recipe naar tmp/recipe-sample.json
 *      zodat we de undocumented `code`-structuur kunnen analyseren.
 *
 * Volgende stap (na exploratie):
 *   - Connector → systeem-id mapping.
 *   - Parser die per recipe afleidt: (topic, bron, consumers) en vergelijken
 *     met onze topic-definities.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadLandkaart } from './lib/loader.ts';
import {
  getCurrentUser,
  listEventTopics,
  listRecipes,
  readWorkatoConfig,
  type EventTopic,
  type Recipe,
} from './lib/workato.ts';
import {
  aggregeerBindings,
  buildConnectorMap,
  parsePubSubBindings,
  statesToSnapshot,
  type PubSubBinding,
} from './lib/workato-parser.ts';
import type { Topic, Systeem } from './lib/schema.ts';

function loadEnv() {
  // Node 20.6+ heeft process.loadEnvFile(). Stille no-op als .env ontbreekt.
  const loader = (process as unknown as { loadEnvFile?: (path?: string) => void }).loadEnvFile;
  if (typeof loader === 'function') {
    try { loader('.env'); } catch { /* .env optioneel */ }
  }
}

function normaliseer(naam: string): string {
  return naam.trim().toLowerCase().replace(/[\s_-]+/g, '-');
}

function rapporteerTopicDrift(workatoTopics: EventTopic[], gitTopicNamen: string[]): {
  inGitNietInWorkato: string[];
  inWorkatoNietInGit: string[];
} {
  const wkSet = new Map<string, EventTopic>();
  for (const t of workatoTopics) wkSet.set(normaliseer(t.name), t);
  const gitSet = new Map<string, string>();
  for (const n of gitTopicNamen) gitSet.set(normaliseer(n), n);

  const inGitNietInWorkato = [...gitSet].filter(([k]) => !wkSet.has(k)).map(([, v]) => v);
  const inWorkatoNietInGit = [...wkSet].filter(([k]) => !gitSet.has(k)).map(([, v]) => v.name);

  console.log(`\n— Drift-rapport · event topics —`);
  console.log(`  Git: ${gitSet.size} topics · Workato: ${wkSet.size} topics`);
  if (inGitNietInWorkato.length > 0) {
    console.log(`\n  ⚠ Wel in Git, niet in Workato (${inGitNietInWorkato.length}):`);
    for (const n of inGitNietInWorkato) console.log(`    - ${n}`);
  }
  if (inWorkatoNietInGit.length > 0) {
    console.log(`\n  ⚠ Wel in Workato, niet in Git (${inWorkatoNietInGit.length}):`);
    for (const n of inWorkatoNietInGit) console.log(`    - ${n}`);
  }
  if (inGitNietInWorkato.length === 0 && inWorkatoNietInGit.length === 0) {
    console.log(`\n  ✓ Topic-namen komen overeen.`);
  }
  return { inGitNietInWorkato, inWorkatoNietInGit };
}

function expandRecipeCode(recipe: Recipe): Record<string, unknown> {
  const expanded: Record<string, unknown> = { ...recipe };
  if (typeof recipe.code === 'string') {
    try { expanded.code = JSON.parse(recipe.code); } catch { /* laat ruw */ }
  }
  return expanded;
}

function safeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'recipe';
}

function dumpAlleRecipes(recipes: Recipe[]) {
  if (recipes.length === 0) {
    console.log(`\n— Recipes —`);
    console.log(`  Geen recipes gevonden.`);
    return;
  }
  const dir = join('tmp', 'recipes');
  mkdirSync(dir, { recursive: true });

  const providerCounts = new Map<string, number>();
  const eventStreamRecipes: { id: number; name: string; rol: string; operatie: string }[] = [];

  for (const r of recipes) {
    const expanded = expandRecipeCode(r);
    const path = join(dir, `${r.id}-${safeFilename(r.name)}.json`);
    writeFileSync(path, JSON.stringify(expanded, null, 2), 'utf8');

    // Walk de code-tree om providers te tellen + event-stream recipes te flaggen.
    const code = expanded.code;
    walkCode(code, (node) => {
      if (node.provider) {
        providerCounts.set(node.provider, (providerCounts.get(node.provider) ?? 0) + 1);
      }
      if (node.provider === 'workato_pub_sub') {
        eventStreamRecipes.push({
          id: r.id,
          name: r.name,
          rol: node.keyword === 'trigger' ? 'subscriber' : 'publisher',
          operatie: node.name ?? '?',
        });
      }
    });
  }

  console.log(`\n— Recipes —`);
  console.log(`  Totaal: ${recipes.length} · gedumpt naar ${dir}/`);
  console.log(`\n  Providers gevonden in recipe-code:`);
  const sorted = [...providerCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [p, n] of sorted) {
    console.log(`    ${String(n).padStart(3)} × ${p}`);
  }
  if (eventStreamRecipes.length > 0) {
    console.log(`\n  Pub/sub gerelateerde recipes (${eventStreamRecipes.length} hits):`);
    for (const r of eventStreamRecipes) {
      console.log(`    [${r.rol}] ${r.id} · ${r.name}  (${r.operatie})`);
    }
  } else {
    console.log(`\n  ⚠ Geen recipes met workato_pub_sub provider gevonden.`);
  }
}

function formatSysteemMetRecipes(map: Map<string, { id: number; name: string }[]>): string {
  if (map.size === 0) return '(geen)';
  return [...map].map(([sys, recipes]) =>
    `${sys} [${recipes.map((r) => `${r.id}`).join(', ')}]`
  ).join(', ');
}

function rapporteerMappingDrift(
  recipes: Recipe[],
  workatoTopics: EventTopic[],
  systemen: Record<string, Systeem>,
  gitTopics: Topic[],
) {
  const connectorMap = buildConnectorMap(systemen);
  if (connectorMap.size === 0) {
    console.log(`\n— Mapping-drift —`);
    console.log(`  ⚠ Geen workato_connector kolom ingevuld in data/systemen.md — kan geen systemen koppelen.`);
    return new Map();
  }

  const allBindings: PubSubBinding[] = [];
  for (const r of recipes) allBindings.push(...parsePubSubBindings(r, connectorMap));

  const states = aggregeerBindings(allBindings, workatoTopics);

  const gitByNaam = new Map<string, Topic>();
  for (const t of gitTopics) gitByNaam.set(normaliseer(t.naam), t);

  console.log(`\n— Mapping-drift · per topic —`);
  if (states.size === 0) {
    console.log(`  Geen pub/sub bindings gevonden in recipes.`);
    return states;
  }

  for (const [, s] of states) {
    const git = gitByNaam.get(normaliseer(s.workatoName));
    console.log(`\n  Topic "${s.workatoName}" (id ${s.workatoId})`);

    const issues: string[] = [];
    if (!git) {
      issues.push(`niet gevonden in Git`);
    } else {
      const verwachteBron = new Set(git.bron);
      const wkPubs = new Set(s.publishers.keys());
      const ontbrekendeBron = [...verwachteBron].filter((b) => !wkPubs.has(b));
      const onverwachteBron = [...wkPubs].filter((p) => !verwachteBron.has(p));
      if (ontbrekendeBron.length > 0) issues.push(`ontbrekende bronnen in Workato: ${ontbrekendeBron.join(', ')}`);
      if (onverwachteBron.length > 0) issues.push(`onverwachte bronnen in Workato: ${onverwachteBron.join(', ')}`);

      const verwachteCons = new Set(git.consumers);
      const wkSubs = new Set(s.subscribers.keys());
      const ontbrekend = [...verwachteCons].filter((c) => !wkSubs.has(c));
      const onverwacht = [...wkSubs].filter((c) => !verwachteCons.has(c));
      if (ontbrekend.length > 0) issues.push(`ontbrekende consumers in Workato: ${ontbrekend.join(', ')}`);
      if (onverwacht.length > 0) issues.push(`onverwachte consumers in Workato: ${onverwacht.join(', ')}`);
    }

    if (s.ambiguousRecipes.length > 0) {
      for (const r of s.ambiguousRecipes) {
        issues.push(
          `ambigu in recipe ${r.id} "${r.name}" [${r.rol}]: kandidaten ${r.candidaten.length === 0 ? '(geen bekend systeem)' : r.candidaten.join(', ')}`
        );
      }
    }

    if (issues.length === 0) {
      console.log(`    ✓ ok — bron ${git!.bron.join(', ')}, consumers ${git!.consumers.join(', ')}`);
    } else {
      for (const i of issues) console.log(`    ⚠ ${i}`);
      if (git) {
        console.log(`    Git verwacht  · bron: ${git.bron.join(', ')} · consumers: ${git.consumers.join(', ')}`);
      }
      console.log(`    Workato detecteert · publishers: ${formatSysteemMetRecipes(s.publishers)}`);
      console.log(`                       · subscribers: ${formatSysteemMetRecipes(s.subscribers)}`);
    }
  }
  return states;
}

function walkCode(node: unknown, visit: (n: { provider?: string; keyword?: string; name?: string; block?: unknown[] }) => void) {
  if (!node || typeof node !== 'object') return;
  const n = node as { provider?: string; keyword?: string; name?: string; block?: unknown[] };
  visit(n);
  if (Array.isArray(n.block)) {
    for (const child of n.block) walkCode(child, visit);
  }
}

async function main() {
  loadEnv();
  const cfg = readWorkatoConfig();
  console.log(`Workato base: ${cfg.baseUrl}`);

  const lk = loadLandkaart();
  const gitTopicNamen = lk.apis.flatMap((a) => a.topics.map((t) => t.naam));

  console.log(`\nAuth-check (/api/users/me)…`);
  try {
    const me = await getCurrentUser(cfg) as { name?: string; email?: string };
    console.log(`  ✓ ingelogd als ${me.name ?? '?'} (${me.email ?? '?'})`);
  } catch (err) {
    console.log(`  ✗ ${(err as Error).message}`);
    console.log(`\n  → Check of je token geldig is en of je base URL klopt voor je tenant.`);
    process.exit(1);
  }

  console.log(`\nOphalen uit Workato…`);
  const results = await Promise.allSettled([
    listEventTopics(cfg),
    listRecipes(cfg, 100),
  ]);

  let topicDrift = { inGitNietInWorkato: [] as string[], inWorkatoNietInGit: [] as string[] };
  if (results[0].status === 'fulfilled') {
    topicDrift = rapporteerTopicDrift(results[0].value, gitTopicNamen);
  } else {
    console.log(`\n— Drift-rapport · event topics —`);
    console.log(`  ✗ ${results[0].reason.message}`);
  }

  if (results[1].status === 'fulfilled') {
    dumpAlleRecipes(results[1].value);
    const recipes = results[1].value;
    const workatoTopics = results[0].status === 'fulfilled' ? results[0].value : [];
    const states = rapporteerMappingDrift(recipes, workatoTopics, lk.systemen, lk.apis.flatMap((a) => a.topics));

    const snapshot = statesToSnapshot(
      states,
      cfg.baseUrl,
      topicDrift.inGitNietInWorkato,
      topicDrift.inWorkatoNietInGit,
    );
    mkdirSync('output', { recursive: true });
    writeFileSync(join('output', 'workato-state.json'), JSON.stringify(snapshot, null, 2), 'utf8');
    console.log(`\n  ✓ Snapshot weggeschreven naar output/workato-state.json`);
  } else {
    console.log(`\n— Recipes —`);
    console.log(`  ✗ ${results[1].reason.message}`);
  }
}

main().catch((err) => {
  console.error('\n✗ ' + (err as Error).message);
  process.exit(1);
});
