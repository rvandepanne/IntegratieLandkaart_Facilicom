import { z } from 'zod';

export const StatusSchema = z.enum(['placeholder', 'concept', 'live']);
export type Status = z.infer<typeof StatusSchema>;

/**
 * Schema voor een systeem (bron, consumer of data-leverancier).
 */
export const SysteemSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, 'id moet lowercase met dashes zijn'),
  naam: z.string(),
  rol: z.string(),
  beschrijving: z.string(),
  type: z.enum(['bron-consumer', 'bron', 'consumer', 'data-leverancier']),
  workato_connector: z.array(z.string()).default([]),
  kleur: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'kleur moet een hex zijn (bv. #ff7a59)').optional(),
  logo: z.string().url('logo moet een geldige URL zijn').optional(),
});

export type Systeem = z.infer<typeof SysteemSchema>;

/**
 * Schema voor één topic binnen een API.
 * Een topic is een concrete event-stream met één bron en 1+ consumers.
 */
export const TopicSchema = z.object({
  id: z.string().regex(/^topic-[a-z0-9-]+$/, 'topic-id moet beginnen met "topic-"'),
  naam: z.string(),
  beschrijving: z.string().default(''),

  bron: z.preprocess(
    (v) => (Array.isArray(v) ? v : [v]),
    z.array(z.string()).min(1, 'minimaal één bronsysteem')
  ),
  consumers: z.array(z.string()).min(1, 'minimaal één consumer'),

  triggers: z.array(z.string()).min(1, 'minimaal één trigger-gebeurtenis'),

  fallback: z.string(),

  status: StatusSchema.default('placeholder'),
});

export type Topic = z.infer<typeof TopicSchema>;

/**
 * Schema voor een API — het functionele onderwerp.
 * Koppelt één CDM aan één of meer event topics.
 */
export const ApiSchema = z.object({
  id: z.string().regex(/^api-[a-z0-9-]+$/, 'api-id moet beginnen met "api-"'),
  naam: z.string(),
  label: z.string(),

  cdm: z.string(),

  afhankelijk_van: z.array(z.string()).default([]),

  gerelateerde_stories: z.array(z.string()).default([]),

  status: StatusSchema.default('placeholder'),

  topics: z.array(TopicSchema).min(1, 'minimaal één topic'),
});

export type Api = z.infer<typeof ApiSchema>;

/**
 * Schema voor het hele systemen-bestand.
 */
export const SystemenBestandSchema = z.object({
  systemen: z.array(SysteemSchema),
});

export type SystemenBestand = z.infer<typeof SystemenBestandSchema>;

/**
 * CDM-veld uit een tabelregel in data/cdm/<domein>.md.
 * `mapping` is een map van systeem-id naar veldnaam in dat systeem.
 */
export interface CdmVeld {
  naam: string;
  type: string;
  verplicht: boolean;
  beschrijving: string;
  eigenaar?: string;
  opmerkingen?: string;
  mapping: Record<string, string>;
}

/**
 * Sub-object binnen een CDM-domein — bv. "Adres" of "Orderregel".
 */
export interface CdmSubObject {
  naam: string;
  velden: CdmVeld[];
}

/**
 * Canoniek datamodel voor één domein.
 */
export interface CdmDomein {
  domein: string;
  versie: string;
  beschrijving: string;
  status: Status;
  velden: CdmVeld[];
  subObjecten: CdmSubObject[];
}

/**
 * Compleet landkaart-model — in-memory representatie na laden en valideren.
 */
export interface Landkaart {
  systemen: Record<string, Systeem>;
  apis: Api[];
  cdm: Record<string, CdmDomein>;
  metadata: {
    versie: string;
    datum: string;
    status: string;
  };
}
