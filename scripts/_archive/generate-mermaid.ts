#!/usr/bin/env tsx
/**
 * Genereert een Mermaid-diagram van de landkaart in output/landkaart.mermaid.md
 * Plakbaar in Jira/Confluence/GitHub.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadLandkaart } from './lib/loader.ts';
import type { Landkaart, CdmVeld } from './lib/schema.ts';

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9]/g, '_');
}

function genereerMermaid(lk: Landkaart): string {
  const lines: string[] = [];
  lines.push('flowchart LR');
  lines.push('  classDef bron fill:#fff,stroke:#0a2540,stroke-width:2px,color:#0a2540');
  lines.push('  classDef topic fill:#ffe4d6,stroke:#ff6b35,stroke-width:2px,color:#0a2540');
  lines.push('  classDef api fill:#0a2540,stroke:#0a2540,stroke-width:2px,color:#fff');
  lines.push('  classDef consumer fill:#fff,stroke:#1e3a5f,stroke-width:2px,color:#1e3a5f');
  lines.push('  classDef dataleverancier fill:#f5f5f5,stroke:#999,stroke-width:1px,stroke-dasharray: 5 3,color:#666');
  lines.push('');

  const bronnen = new Set<string>();
  const consumers = new Set<string>();
  for (const a of lk.apis) {
    for (const t of a.topics) {
      bronnen.add(t.bron);
      for (const c of t.consumers) consumers.add(c);
    }
  }

  lines.push('  subgraph BRONNEN["🔵 Bronsystemen"]');
  lines.push('    direction TB');
  for (const sysId of bronnen) {
    const s = lk.systemen[sysId];
    lines.push(`    B_${slug(sysId)}["<b>${s.naam}</b><br/><i>${s.beschrijving}</i>"]:::bron`);
  }
  for (const s of Object.values(lk.systemen)) {
    if (s.type === 'data-leverancier') {
      lines.push(`    DL_${slug(s.id)}["<b>${s.naam}</b><br/><i>${s.beschrijving}</i>"]:::dataleverancier`);
    }
  }
  lines.push('  end');
  lines.push('');

  lines.push('  subgraph APIS["🟧 API\'s (Workato event topics)"]');
  lines.push('    direction TB');
  for (const api of lk.apis) {
    lines.push(`    subgraph A_${slug(api.naam)}["${api.label}"]`);
    lines.push('      direction TB');
    for (const t of api.topics) {
      lines.push(`      T_${slug(t.id)}(["${t.naam}"]):::topic`);
    }
    lines.push('    end');
  }
  lines.push('  end');
  lines.push('');

  lines.push('  subgraph CONSUMERS["🟢 Consumers"]');
  lines.push('    direction TB');
  for (const sysId of consumers) {
    const s = lk.systemen[sysId];
    lines.push(`    C_${slug(sysId)}["<b>${s.naam}</b><br/><i>${s.beschrijving}</i>"]:::consumer`);
  }
  lines.push('  end');
  lines.push('');

  lines.push('  %% Publicaties en subscriptions');
  for (const api of lk.apis) {
    for (const t of api.topics) {
      lines.push(`  B_${slug(t.bron)} -->|publiceert| T_${slug(t.id)}`);
      for (const c of t.consumers) {
        lines.push(`  T_${slug(t.id)} -->|abonneert| C_${slug(c)}`);
      }
    }
  }

  const dataLeveranciers = Object.values(lk.systemen).filter(
    (s) => s.type === 'data-leverancier'
  );
  if (dataLeveranciers.length > 0) {
    lines.push('');
    lines.push('  %% Interne data-aanlevering (buiten EDA)');
    for (const dl of dataLeveranciers) {
      if (bronnen.has('exact-globe')) {
        lines.push(`  DL_${slug(dl.id)} -.->|levert mutaties| B_exact_globe`);
      }
    }
  }

  return lines.join('\n');
}

function cdmAnker(domein: string): string {
  return `cdm-${domein.toLowerCase()}`;
}

function veldenTabel(velden: CdmVeld[], systeemIds: string[], systemen: Landkaart['systemen']): string {
  const header = ['Veld', 'Type', 'Verplicht', 'Beschrijving', ...systeemIds.map((id) => systemen[id]?.naam ?? id)];
  const separator = header.map(() => '---');
  const rows = velden.map((v) => [
    `\`${v.naam}\``,
    `\`${v.type}\``,
    v.verplicht ? '✓' : '',
    v.beschrijving,
    ...systeemIds.map((id) => {
      const mapped = v.mapping[id];
      return mapped ? `\`${mapped}\`` : '—';
    }),
  ]);
  return [header, separator, ...rows]
    .map((cells) => `| ${cells.join(' | ')} |`)
    .join('\n');
}

function cdmSectie(lk: Landkaart): string {
  const domeinen = Object.values(lk.cdm);
  if (domeinen.length === 0) return '';

  const secties = domeinen.map((d) => {
    const systeemIdsInTabel = new Set<string>();
    for (const v of d.velden) Object.keys(v.mapping).forEach((id) => systeemIdsInTabel.add(id));
    for (const sub of d.subObjecten) {
      for (const v of sub.velden) Object.keys(v.mapping).forEach((id) => systeemIdsInTabel.add(id));
    }
    const systeemIds = [...systeemIdsInTabel];

    const hoofdTabel = veldenTabel(d.velden, systeemIds, lk.systemen);
    const subSecties = d.subObjecten
      .map((sub) => `#### ${sub.naam}\n\n${veldenTabel(sub.velden, systeemIds, lk.systemen)}`)
      .join('\n\n');

    return `### <a id="${cdmAnker(d.domein)}"></a>${d.domein} · v${d.versie}

${d.beschrijving}

${hoofdTabel}${subSecties ? `\n\n${subSecties}` : ''}`;
  });

  return `\n## Canoniek Datamodel (CDM)

> Versiebeheer per domein. Zie [CDM-CHANGELOG.md](../CDM-CHANGELOG.md) voor historie.

${secties.join('\n\n')}\n`;
}

function genereerMarkdown(lk: Landkaart): string {
  const mermaid = genereerMermaid(lk);
  const apiTabel = lk.apis
    .map((a, i) => {
      const bronnen = [...new Set(a.topics.flatMap((t) => lk.systemen[t.bron].naam))];
      const consumers = [...new Set(a.topics.flatMap((t) => t.consumers.map((c) => lk.systemen[c].naam)))];
      return `| ${i + 1} | **${a.label}** | ${a.topics.length} | ${bronnen.join(', ')} | ${consumers.join(', ')} | ${a.afhankelijk_van.length === 0 ? '—' : a.afhankelijk_van.join(', ')} |`;
    })
    .join('\n');

  return `# Integratie-landkaart Pilot B2B Portaal

> **Auto-gegenereerd** vanuit \`data/\` op ${lk.metadata.datum} · versie ${lk.metadata.versie} · status ${lk.metadata.status}
>
> Bewerk **niet dit bestand** — pas de YAML in \`data/\` aan en draai \`npm run generate\`.

## Diagram

\`\`\`mermaid
${mermaid}
\`\`\`

## API's — overzicht

| # | API | Topics | Bronnen | Consumers | Afhankelijk van |
|---|---|---|---|---|---|
${apiTabel}
${cdmSectie(lk)}
## API-details

${lk.apis
  .map(
    (a) => `### ${a.label}

- **CDM**: [${a.cdm} v${lk.cdm[a.cdm]?.versie ?? '?'}](#${cdmAnker(a.cdm)})
- **Stories**: ${a.gerelateerde_stories.length === 0 ? '—' : a.gerelateerde_stories.map((s) => `[${s}](https://scandiagear.atlassian.net/browse/${s})`).join(', ')}
- **Afhankelijk van**: ${a.afhankelijk_van.length === 0 ? '—' : a.afhankelijk_van.join(', ')}

${a.topics
  .map(
    (t) => `#### Topic · ${t.naam}

- **Bron**: ${lk.systemen[t.bron].naam} (${lk.systemen[t.bron].beschrijving})
- **Consumers**: ${t.consumers.map((c) => lk.systemen[c].naam).join(', ')}
- **Uitrolstatus**: \`${t.uitrolstatus}\`

**Triggers**
${t.triggers.map((tr) => `- ${tr}`).join('\n')}

**Fallback**
> ${t.fallback}
`
  )
  .join('\n')}`
  )
  .join('\n')}

---

*Gegenereerd door \`scripts/generate-mermaid.ts\` · wijzigingen: pas YAML aan en run \`npm run generate\`.*
`;
}

const lk = loadLandkaart();
const markdown = genereerMarkdown(lk);

mkdirSync(join(process.cwd(), 'output'), { recursive: true });
const outputPath = join(process.cwd(), 'output', 'landkaart.mermaid.md');
writeFileSync(outputPath, markdown, 'utf8');

const topicCount = lk.apis.reduce((n, a) => n + a.topics.length, 0);
console.log(`✓ Mermaid landkaart gegenereerd: ${outputPath}`);
console.log(`  ${lk.apis.length} API's (${topicCount} topics), ${Object.keys(lk.systemen).length} systemen`);
