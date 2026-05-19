/**
 * Workato Platform API client — read-only.
 * Documentatie: https://docs.workato.com/workato-api.html
 */

const DEFAULT_BASE_URL = 'https://app.eu.workato.com';

export interface WorkatoConfig {
  token: string;
  baseUrl: string;
}

export interface EventTopic {
  id?: number;
  name: string;
  description?: string;
  schema?: unknown;
  // Workato kan extra velden teruggeven; bewaar het hele object voor debugging.
  [key: string]: unknown;
}

export interface Recipe {
  id: number;
  user_id?: number;
  name: string;
  description?: string;
  running?: boolean;
  folder_id?: number | null;
  /** JSON-string met de hele recipe-tree (trigger + actions). */
  code?: string;
  config?: unknown;
  [key: string]: unknown;
}

export function readWorkatoConfig(): WorkatoConfig {
  const token = process.env.WORKATO_API_TOKEN;
  if (!token) {
    throw new Error(
      'WORKATO_API_TOKEN niet gezet. Kopieer .env.example naar .env en vul je token in.'
    );
  }
  return {
    token,
    baseUrl: process.env.WORKATO_BASE_URL || DEFAULT_BASE_URL,
  };
}

async function request<T>(
  cfg: WorkatoConfig,
  path: string,
  params?: Record<string, string | number>
): Promise<T> {
  const url = new URL(path.startsWith('http') ? path : cfg.baseUrl + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Workato API ${res.status} ${res.statusText} bij GET ${url.pathname}\n  ${body.slice(0, 400)}`
    );
  }
  return res.json() as Promise<T>;
}

/**
 * Workato lijst-endpoints geven óf `{ result: [...] }` óf direct een array terug;
 * pak hier uniform een array uit het response.
 */
function unwrap<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object') {
    for (const key of ['result', 'items', 'data']) {
      if (key in data) {
        const r = (data as Record<string, unknown>)[key];
        if (Array.isArray(r)) return r as T[];
      }
    }
  }
  return [];
}

export async function listEventTopics(cfg: WorkatoConfig): Promise<EventTopic[]> {
  // Workato Event Streams API: /api/event_streams/topics
  // Docs: https://docs.workato.com/en/workato-api/event-streams.html
  // Response-shape: { count, data: [...] }. Default page-size lijkt klein,
  // dus we loopen tot een lege response of tot we `count` bereikt hebben.
  const all: EventTopic[] = [];
  const perPage = 100;
  let page = 1;
  while (true) {
    const data = await request<unknown>(cfg, '/api/event_streams/topics', {
      per_page: perPage,
      page,
    });
    const items = unwrap<EventTopic>(data);
    if (items.length === 0) break;
    all.push(...items);
    const total = (data as { count?: number })?.count;
    if (typeof total === 'number' && all.length >= total) break;
    if (items.length < perPage) break;
    page++;
    if (page > 50) break; // safety net
  }
  return all;
}

export async function listRecipes(cfg: WorkatoConfig, limit = 100): Promise<Recipe[]> {
  // /api/recipes paginereert via `adjusted_after` cursor; voor v1 pakken we max één pagina.
  const data = await request<unknown>(cfg, '/api/recipes', { per_page: limit });
  return unwrap<Recipe>(data);
}

export async function getRecipe(cfg: WorkatoConfig, id: number): Promise<Recipe> {
  return request<Recipe>(cfg, `/api/recipes/${id}`);
}

/** Sanity-check: bevestigt dat het token überhaupt geldig is. */
export async function getCurrentUser(cfg: WorkatoConfig): Promise<unknown> {
  return request<unknown>(cfg, '/api/users/me');
}
