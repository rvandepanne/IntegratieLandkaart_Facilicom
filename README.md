# Integratie-landkaart — Template

Generieke template voor een datagedreven integratie-landkaart op basis van Workato Event Streams.

Eén bron van waarheid in Markdown, twee uitvoeren: een interactief HTML-artifact voor stakeholders en een drift-rapport tegen Workato. Wijzigingen lopen via Git/PR, dat geeft automatisch versiehistorie, auteurschap en traceability naar Jira-stories.

---

## Nieuwe klant opzetten

1. Klik op **"Use this template"** op GitHub en maak een nieuwe repo aan (bv. `KlantNaam_IntegratieLandkaart`).
2. Open [`project.config.json`](project.config.json) en vul in:
   - `klant_naam` — naam van de klant (verschijnt in de header en footer van de landkaart)
   - `project_naam` — naam van het project (bv. "Integration Foundation")
   - `document_eigenaar` — naam/rol van de eigenaar (bv. "Product Owner Klant BV")
3. Vul `data/systemen.md` met de systemen van de klant.
4. Voeg API's, topics en CDM's toe in `data/apis/<naam>/`.
5. *(Optioneel)* Voeg `WORKATO_API_TOKEN` toe via Settings → Secrets and variables → Actions.
6. Push — de workflow genereert automatisch `output/landkaart.html`.

---

## Projectstructuur

```
integratie-landkaart/
├── project.config.json            ← klant-specifieke instellingen (naam, eigenaar)
├── data/                          ← bewerk hier
│   ├── systemen.md                ← systemen-tabel (kleur/logo/connector)
│   └── apis/<naam>/
│       ├── api.md                 ← API-frontmatter
│       ├── cdm.md                 ← canoniek datamodel
│       └── topics/*.md            ← event topics
├── scripts/                       ← generiek, niet aanpassen
├── output/                        ← auto-gegenereerd
│   ├── landkaart.html
│   └── workato-state.json
└── .github/workflows/generate.yml ← CI: bij push regenereren + commit
```

---

## Voor developers

Vereist: Node.js 20+ en npm.

```bash
npm install
npm run validate       # schema- en referentiechecks
npm run generate       # valideert + genereert output/landkaart.html
npm run validate:workato  # drift-check tegen Workato (vereist .env)
```

Zie de [Scandia-implementatie](https://github.com/Ciphix/Scandia_IntegratieLandkaart) als volledig ingevuld voorbeeld.
