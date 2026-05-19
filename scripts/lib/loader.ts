import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  ApiSchema,
  SysteemSchema,
  type Api,
  type CdmDomein,
  type Landkaart,
  type Systeem,
} from './schema.ts';
import { parseCdmFile } from './cdm.ts';

const DATA_DIR = join(process.cwd(), 'data');
const APIS_DIR = join(DATA_DIR, 'apis');

function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new Error('bestand mist YAML-frontmatter (--- ... ---) bovenaan');
  }
  const meta = parseYaml(match[1]);
  if (!meta || typeof meta !== 'object') {
    throw new Error('frontmatter is leeg of ongeldig');
  }
  return { meta: meta as Record<string, unknown>, body: match[2] };
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
}

function parseSystemenMd(path: string): Systeem[] {
  const raw = readFileSync(path, 'utf8');
  const lines = raw.split(/\r?\n/);
  const tableLines = lines.filter((l) => l.trim().startsWith('|'));
  if (tableLines.length < 3) {
    throw new Error(`${path}: verwacht een tabel met kop + scheider + minimaal één rij`);
  }
  const headers = splitRow(tableLines[0]).map((h) => h.toLowerCase());
  const expected = ['id', 'naam', 'rol', 'type', 'beschrijving'];
  const optional = ['workato_connector', 'kleur', 'logo'];
  for (const col of expected) {
    if (!headers.includes(col)) {
      throw new Error(`${path}: tabel mist kolom "${col}"`);
    }
  }
  const idx: Record<string, number> = {};
  for (const c of [...expected, ...optional]) {
    const i = headers.indexOf(c);
    if (i >= 0) idx[c] = i;
  }

  const rows = tableLines.slice(2).map(splitRow);
  return rows.map((row, i) => {
    const obj: Record<string, string | undefined> = {
      id: row[idx.id],
      naam: row[idx.naam],
      rol: row[idx.rol],
      type: row[idx.type],
      beschrijving: row[idx.beschrijving],
    };
    if (idx.workato_connector !== undefined) {
      const v = row[idx.workato_connector]?.trim();
      const lijst = v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];
      (obj as Record<string, unknown>).workato_connector = lijst;
    }
    if (idx.kleur !== undefined) {
      const v = row[idx.kleur]?.trim();
      if (v) (obj as Record<string, unknown>).kleur = v;
    }
    if (idx.logo !== undefined) {
      const v = row[idx.logo]?.trim();
      if (v) (obj as Record<string, unknown>).logo = v;
    }
    try {
      return SysteemSchema.parse(obj);
    } catch (err) {
      throw new Error(`${path} · rij ${i + 1}: ${formatZodError(err)}`);
    }
  });
}

function parseTopicMd(filePath: string): unknown {
  const raw = readFileSync(filePath, 'utf8');
  const { meta, body } = parseFrontmatter(raw);

  const triggers: string[] = [];
  const fallbackLines: string[] = [];
  let mode: 'triggers' | 'fallback' | null = null;

  for (const line of body.split(/\r?\n/)) {
    if (/^\*\*Triggers\*\*/i.test(line.trim())) { mode = 'triggers'; continue; }
    if (/^\*\*Fallback\*\*/i.test(line.trim())) { mode = 'fallback'; continue; }

    if (mode === 'triggers') {
      const m = line.match(/^\s*-\s+(.+?)\s*$/);
      if (m) triggers.push(m[1]);
    } else if (mode === 'fallback') {
      const m = line.match(/^\s*>\s?(.*)$/);
      if (m) fallbackLines.push(m[1].trim());
    }
  }

  return {
    id: meta.id,
    naam: meta.naam,
    beschrijving: meta.beschrijving ?? '',
    bron: meta.bron,
    consumers: meta.consumers ?? [],
    status: meta.status ?? 'placeholder',
    triggers,
    fallback: fallbackLines.filter((l) => l.length > 0).join(' '),
  };
}

function formatZodError(err: unknown): string {
  if (err && typeof err === 'object' && 'issues' in err) {
    const issues = (err as { issues: Array<{ path: (string | number)[]; message: string }> }).issues;
    return issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
  }
  return String(err);
}

function loadApiFolder(folder: string, systeemIds: Set<string>): { api: Api; cdm: CdmDomein } {
  const apiPath = join(folder, 'api.md');
  const cdmPath = join(folder, 'cdm.md');
  const topicsDir = join(folder, 'topics');

  if (!existsSync(apiPath)) throw new Error(`${folder}: mist api.md`);
  if (!existsSync(cdmPath)) throw new Error(`${folder}: mist cdm.md`);
  if (!existsSync(topicsDir)) throw new Error(`${folder}: mist topics/ folder`);

  const apiRaw = readFileSync(apiPath, 'utf8');
  const { meta } = parseFrontmatter(apiRaw);

  const cdmDomein = parseCdmFile(cdmPath, systeemIds);

  const topicFiles = readdirSync(topicsDir).filter((f) => f.endsWith('.md'));
  if (topicFiles.length === 0) {
    throw new Error(`${topicsDir}: geen topic-bestanden gevonden`);
  }
  const topics = topicFiles.map((f) => parseTopicMd(join(topicsDir, f)));

  const rawApi = {
    id: meta.id,
    naam: meta.naam,
    label: meta.label,
    cdm: cdmDomein.domein,
    afhankelijk_van: meta.afhankelijk_van ?? [],
    gerelateerde_stories: meta.gerelateerde_stories ?? [],
    status: meta.status ?? 'placeholder',
    topics,
  };

  let api: Api;
  try {
    api = ApiSchema.parse(rawApi);
  } catch (err) {
    throw new Error(`Validatiefout in ${apiPath}:\n${formatZodError(err)}`);
  }

  return { api, cdm: cdmDomein };
}

export function loadLandkaart(): Landkaart {
  const systemenList = parseSystemenMd(join(DATA_DIR, 'systemen.md'));
  const systemen: Landkaart['systemen'] = {};
  for (const s of systemenList) systemen[s.id] = s;
  const systeemIds = new Set(Object.keys(systemen));

  const apis: Api[] = [];
  const cdm: Record<string, CdmDomein> = {};

  const apiFolders = readdirSync(APIS_DIR).filter((f) => {
    const fp = join(APIS_DIR, f);
    return statSync(fp).isDirectory();
  });

  for (const folder of apiFolders) {
    const { api, cdm: cdmDomein } = loadApiFolder(join(APIS_DIR, folder), systeemIds);
    apis.push(api);
    if (cdm[cdmDomein.domein]) {
      throw new Error(`CDM-domein "${cdmDomein.domein}" komt in meerdere API-folders voor`);
    }
    cdm[cdmDomein.domein] = cdmDomein;
  }

  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));

  validateReferences(apis, systemen, cdm);

  return {
    systemen,
    apis,
    cdm,
    metadata: {
      versie: pkg.version,
      datum: new Date().toISOString().split('T')[0],
      status: 'Concept',
    },
  };
}

function validateReferences(
  apis: Api[],
  systemen: Landkaart['systemen'],
  cdm: Landkaart['cdm']
): void {
  const apiNamen = new Set(apis.map((a) => a.naam));
  const systeemIds = new Set(Object.keys(systemen));
  const cdmDomeinen = new Set(Object.keys(cdm));
  const errors: string[] = [];

  for (const api of apis) {
    if (!cdmDomeinen.has(api.cdm)) {
      errors.push(
        `API "${api.naam}" verwijst naar onbekend CDM-domein "${api.cdm}". ` +
          `Bekende domeinen: ${[...cdmDomeinen].join(', ') || '(geen)'}`
      );
    }
    for (const afh of api.afhankelijk_van) {
      if (!apiNamen.has(afh)) {
        errors.push(
          `API "${api.naam}" is afhankelijk van onbekende API "${afh}". ` +
            `Bekende API's: ${[...apiNamen].join(', ')}`
        );
      }
    }
    for (const t of api.topics) {
      for (const b of t.bron) {
        if (!systeemIds.has(b)) {
          errors.push(
            `Topic "${t.naam}" (API ${api.naam}) verwijst naar onbekend bronsysteem "${b}".`
          );
        }
      }
      for (const c of t.consumers) {
        if (!systeemIds.has(c)) {
          errors.push(
            `Topic "${t.naam}" (API ${api.naam}) verwijst naar onbekende consumer "${c}".`
          );
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Cross-referentie fouten:\n${errors.map((e) => '  - ' + e).join('\n')}`);
  }
}
