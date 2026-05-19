import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { CdmDomein, CdmVeld } from './schema.ts';

const REQUIRED_COLS = ['veld', 'type', 'verplicht', 'beschrijving'];
const OPTIONAL_COLS = ['eigenaar', 'opmerkingen'];

function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
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

interface RawTable {
  headers: string[];
  rows: string[][];
}

function parseTable(lines: string[]): RawTable {
  const tableLines = lines.filter((l) => l.trim().startsWith('|'));
  if (tableLines.length < 2) {
    throw new Error('tabel heeft te weinig regels (kop + scheider + minimaal één rij verwacht)');
  }
  const headers = splitRow(tableLines[0]);
  const dataRows = tableLines.slice(2).map(splitRow);
  return { headers, rows: dataRows };
}

interface Section {
  heading: string;
  lines: string[];
}

function splitSections(body: string): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;
  for (const line of body.split(/\r?\n/)) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      if (current) sections.push(current);
      current = { heading: h2[1], lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push(current);
  return sections;
}

function parseVeldenSection(
  section: Section,
  systeemIds: Set<string>,
  filePath: string
): CdmVeld[] {
  let table: RawTable;
  try {
    table = parseTable(section.lines);
  } catch (err) {
    throw new Error(`${filePath} · sectie "${section.heading}": ${(err as Error).message}`);
  }

  const normHeaders = table.headers.map((h) => h.toLowerCase());

  // Zoek de kolom-indices voor de verplichte en optionele headers. Systeem-kolommen
  // zijn alle overige headers in volgorde.
  const metaIdx: Record<string, number> = {};
  for (const name of [...REQUIRED_COLS, ...OPTIONAL_COLS]) {
    const i = normHeaders.indexOf(name);
    if (i !== -1) metaIdx[name] = i;
  }
  for (const name of REQUIRED_COLS) {
    if (metaIdx[name] === undefined) {
      throw new Error(
        `${filePath} · sectie "${section.heading}": tabelkop mist verplichte kolom "${name}". ` +
          `Gevonden: "${table.headers.join(' | ')}"`
      );
    }
  }

  const metaCols = new Set(Object.values(metaIdx));
  const systemColumnIdx: number[] = [];
  for (let i = 0; i < table.headers.length; i++) {
    if (!metaCols.has(i)) systemColumnIdx.push(i);
  }
  const systemColumns = systemColumnIdx.map((i) => table.headers[i]);
  for (const colHeader of systemColumns) {
    if (!systeemIds.has(colHeader)) {
      throw new Error(
        `${filePath} · sectie "${section.heading}": mapping-kolom "${colHeader}" ` +
          `komt niet voor als systeem-id in data/systemen.yaml. ` +
          `Bekende systemen: ${[...systeemIds].join(', ')}`
      );
    }
  }

  return table.rows.map((row, idx) => {
    if (row.length !== table.headers.length) {
      throw new Error(
        `${filePath} · sectie "${section.heading}" rij ${idx + 1}: ` +
          `${row.length} cellen, maar tabel heeft ${table.headers.length} kolommen`
      );
    }
    const naam = row[metaIdx['veld']];
    const type = row[metaIdx['type']];
    const verplichtRaw = row[metaIdx['verplicht']];
    const beschrijving = row[metaIdx['beschrijving']];
    if (!naam) {
      throw new Error(`${filePath} · sectie "${section.heading}" rij ${idx + 1}: veld-naam leeg`);
    }
    const verplicht = /^(✓|✔|ja|yes|x|true|1)$/i.test(verplichtRaw);
    const mapping: Record<string, string> = {};
    systemColumnIdx.forEach((colIdx, i) => {
      const v = row[colIdx];
      if (v && v !== '—' && v !== '-') {
        mapping[systemColumns[i]] = v;
      }
    });
    const eigenaarIdx = metaIdx['eigenaar'];
    const eigenaar = eigenaarIdx !== undefined ? row[eigenaarIdx] : undefined;
    const opmerkingenIdx = metaIdx['opmerkingen'];
    const opmerkingen = opmerkingenIdx !== undefined ? row[opmerkingenIdx] : undefined;
    const veld: CdmVeld = { naam, type, verplicht, beschrijving, mapping };
    if (eigenaar) veld.eigenaar = eigenaar;
    if (opmerkingen) veld.opmerkingen = opmerkingen;
    return veld;
  });
}

export function parseCdmFile(filePath: string, systeemIds: Set<string>): CdmDomein {
  const raw = readFileSync(filePath, 'utf8');
  const { meta, body } = parseFrontmatter(raw);

  for (const key of ['domein', 'versie', 'beschrijving']) {
    if (typeof meta[key] !== 'string' && typeof meta[key] !== 'number') {
      throw new Error(`${filePath}: frontmatter mist verplicht veld "${key}"`);
    }
  }

  const sections = splitSections(body);
  const velden = sections.find((s) => s.heading.toLowerCase() === 'velden');
  if (!velden) {
    throw new Error(`${filePath}: geen "## Velden" sectie gevonden`);
  }

  const hoofdVelden = parseVeldenSection(velden, systeemIds, filePath);
  const subObjecten = sections
    .filter((s) => s.heading.toLowerCase() !== 'velden')
    .map((s) => ({
      naam: s.heading,
      velden: parseVeldenSection(s, systeemIds, filePath),
    }));

  const rawStatus = typeof meta.status === 'string' ? meta.status : 'placeholder';
  const status = (['placeholder', 'concept', 'live'].includes(rawStatus) ? rawStatus : 'placeholder') as CdmDomein['status'];

  return {
    domein: String(meta.domein),
    versie: String(meta.versie),
    beschrijving: String(meta.beschrijving),
    status,
    velden: hoofdVelden,
    subObjecten,
  };
}

/**
 * Backwards-compat helper — wordt niet meer gebruikt in de nieuwe folder-structuur
 * (CDM's staan nu per API in data/apis/<naam>/cdm.md). Laten staan voor eventuele
 * losse tooling die nog uit data/cdm leest.
 */
export function loadCdm(systeemIds: Set<string>): Record<string, CdmDomein> {
  const CDM_DIR = join(process.cwd(), 'data', 'cdm');
  let files: string[];
  try {
    files = readdirSync(CDM_DIR).filter((f) => f.endsWith('.md'));
  } catch {
    return {};
  }

  const result: Record<string, CdmDomein> = {};
  for (const f of files) {
    const domein = parseCdmFile(join(CDM_DIR, f), systeemIds);
    if (result[domein.domein]) {
      throw new Error(`CDM-domein "${domein.domein}" komt in meerdere bestanden voor`);
    }
    result[domein.domein] = domein;
  }
  return result;
}
