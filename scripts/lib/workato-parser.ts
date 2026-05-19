import type { EventTopic, Recipe } from './workato.ts';
import type { Systeem } from './schema.ts';

export interface PubSubBinding {
  recipeId: number;
  recipeName: string;
  topicId: string;
  topicLabel: string;
  rol: 'publisher' | 'subscriber';
  systeemId: string | null;
  candidaten: string[];
}

interface CodeNode {
  provider?: string;
  keyword?: string;
  name?: string;
  block?: CodeNode[];
  input?: { topic_id?: string | number; [k: string]: unknown };
  dynamicPickListSelection?: { topic_id?: string; [k: string]: unknown };
}

function walk(node: CodeNode | null | undefined, visit: (n: CodeNode) => void) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  if (Array.isArray(node.block)) for (const c of node.block) walk(c, visit);
}

function parseCodeField(recipe: Recipe): CodeNode | null {
  if (!recipe.code) return null;
  if (typeof recipe.code === 'object') return recipe.code as CodeNode;
  try { return JSON.parse(recipe.code as string) as CodeNode; } catch { return null; }
}

/**
 * Bouwt een lookup van Workato-connector-naam (zoals in recipe.applications)
 * naar onze interne systeem-id.
 */
export function buildConnectorMap(systemen: Record<string, Systeem>): Map<string, string> {
  const m = new Map<string, string>();
  for (const s of Object.values(systemen)) {
    for (const c of s.workato_connector ?? []) {
      if (m.has(c) && m.get(c) !== s.id) {
        throw new Error(
          `Connector "${c}" is in data/systemen.md aan meerdere systemen gekoppeld (${m.get(c)} en ${s.id}).`
        );
      }
      m.set(c, s.id);
    }
  }
  return m;
}

/**
 * Vindt het systeem dat bij deze recipe hoort op basis van welke connectoren
 * voorkomen in `applications`. Levert null op als 0 of >1 bekende systemen
 * gevonden worden (ambigu).
 */
function resolveRecipeSysteem(recipe: Recipe, connectorMap: Map<string, string>): {
  systeemId: string | null;
  candidaten: string[];
} {
  const apps = (recipe.applications as string[] | undefined) ?? [];
  const matched = apps
    .map((a) => connectorMap.get(a))
    .filter((x): x is string => Boolean(x));
  const unique = [...new Set(matched)];
  return {
    systeemId: unique.length === 1 ? unique[0] : null,
    candidaten: unique,
  };
}

export function parsePubSubBindings(
  recipe: Recipe,
  connectorMap: Map<string, string>,
): PubSubBinding[] {
  const code = parseCodeField(recipe);
  if (!code) return [];

  const { systeemId, candidaten } = resolveRecipeSysteem(recipe, connectorMap);
  const bindings: PubSubBinding[] = [];

  walk(code, (node) => {
    if (node.provider !== 'workato_pub_sub') return;
    if (node.name !== 'publish_to_topic' && node.name !== 'subscribe_to_topic') return;

    const topicId = String(node.input?.topic_id ?? '');
    const topicLabel = String(node.dynamicPickListSelection?.topic_id ?? '');
    const rol = node.keyword === 'trigger' ? 'subscriber' : 'publisher';

    bindings.push({
      recipeId: recipe.id,
      recipeName: recipe.name,
      topicId,
      topicLabel,
      rol,
      systeemId,
      candidaten,
    });
  });

  return bindings;
}

export interface RecipeRef {
  id: number;
  name: string;
}

export interface TopicState {
  workatoId: string;
  workatoName: string;
  publishers: Map<string, RecipeRef[]>;
  subscribers: Map<string, RecipeRef[]>;
  ambiguousRecipes: { id: number; name: string; rol: string; candidaten: string[] }[];
}

/**
 * Aggregeert bindings per Workato-topic, met fallback op label als de numerieke
 * ID niet voorkomt in `topics` (bv. event_streams scope ontbreekt).
 */
export function aggregeerBindings(
  bindings: PubSubBinding[],
  topics: EventTopic[],
): Map<string, TopicState> {
  const byId = new Map<string, EventTopic>();
  for (const t of topics) {
    if (t.id !== undefined) byId.set(String(t.id), t);
  }

  const states = new Map<string, TopicState>();
  for (const b of bindings) {
    const wkTopic = byId.get(b.topicId);
    const key = wkTopic ? String(wkTopic.id) : `label:${b.topicLabel || b.topicId}`;
    const naam = wkTopic?.name ?? b.topicLabel ?? b.topicId;
    let s = states.get(key);
    if (!s) {
      s = {
        workatoId: wkTopic ? String(wkTopic.id) : b.topicId,
        workatoName: naam,
        publishers: new Map(),
        subscribers: new Map(),
        ambiguousRecipes: [],
      };
      states.set(key, s);
    }
    if (b.systeemId) {
      const bucket = b.rol === 'publisher' ? s.publishers : s.subscribers;
      const lijst = bucket.get(b.systeemId) ?? [];
      if (!lijst.some((r) => r.id === b.recipeId)) {
        lijst.push({ id: b.recipeId, name: b.recipeName });
      }
      bucket.set(b.systeemId, lijst);
    } else {
      s.ambiguousRecipes.push({ id: b.recipeId, name: b.recipeName, rol: b.rol, candidaten: b.candidaten });
    }
  }
  return states;
}

/**
 * Serialiseerbare snapshot van de Workato-staat zoals afgeleid uit recipes.
 * Wordt naar output/workato-state.json geschreven en door de visual ingelezen.
 */
export interface WorkatoStateSnapshot {
  checkedAt: string;
  baseUrl: string;
  topicsInGitNietInWorkato: string[];
  topicsInWorkatoNietInGit: string[];
  topics: Record<string, {
    workatoId: string;
    workatoName: string;
    publishers: { systeemId: string; recipes: RecipeRef[] }[];
    subscribers: { systeemId: string; recipes: RecipeRef[] }[];
    ambiguousRecipes: { id: number; name: string; rol: string; candidaten: string[] }[];
  }>;
}

export function statesToSnapshot(
  states: Map<string, TopicState>,
  baseUrl: string,
  topicsInGitNietInWorkato: string[],
  topicsInWorkatoNietInGit: string[],
): WorkatoStateSnapshot {
  const topics: WorkatoStateSnapshot['topics'] = {};
  for (const s of states.values()) {
    topics[s.workatoName] = {
      workatoId: s.workatoId,
      workatoName: s.workatoName,
      publishers: [...s.publishers].map(([systeemId, recipes]) => ({ systeemId, recipes })),
      subscribers: [...s.subscribers].map(([systeemId, recipes]) => ({ systeemId, recipes })),
      ambiguousRecipes: s.ambiguousRecipes,
    };
  }
  return {
    checkedAt: new Date().toISOString(),
    baseUrl,
    topicsInGitNietInWorkato,
    topicsInWorkatoNietInGit,
    topics,
  };
}
