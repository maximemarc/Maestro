/**
 * Projection d'un outil maison sur un schéma Zod.
 *
 * Ce module existe pour éviter un cycle : la construction du serveur MCP a
 * besoin du schéma, et le registre en a besoin aussi pour que l'essai depuis
 * l'interface valide exactement comme le fera le SDK. Le mettre dans l'un des
 * deux ferait dépendre chacun de l'autre.
 */
import { z } from 'zod';
import type { McpToolDef, McpToolParam } from '@maestro/shared';

/** Projette un paramètre déclaré sur le schéma Zod attendu par le SDK. */
function paramSchema(param: McpToolParam): z.ZodTypeAny {
  let schema: z.ZodTypeAny;
  if (param.type === 'number') {
    schema = z.number();
  } else if (param.type === 'boolean') {
    schema = z.boolean();
  } else if (param.enumValues.length > 0) {
    /* Une énumération vaut mieux qu'une chaîne libre : le modèle n'a plus à
       deviner les valeurs acceptées, et une valeur hors liste est refusée
       avant l'appel réseau. */
    schema = z.enum(param.enumValues as [string, ...string[]]);
  } else {
    schema = z.string();
  }
  if (param.description.trim() !== '') schema = schema.describe(param.description);
  return param.required ? schema : schema.optional();
}

/** Schéma des paramètres d'un outil, tel qu'il est exposé au modèle. */
export function toolSchema(def: McpToolDef): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const param of def.params) shape[param.name] = paramSchema(param);
  return shape;
}

// ---------------------------------------------------------------------------
// Projection JSON Schema (clients MCP tiers)
// ---------------------------------------------------------------------------

/**
 * Un schéma d'outil au format JSON Schema, tel que l'attend le protocole MCP.
 *
 * La passerelle qui sert Codex, OpenCode ou Goose ne passe pas par Zod : elle
 * répond à `tools/list` avec du JSON Schema brut. Le produire ici, à côté de la
 * projection Zod, garde les deux vues d'un même outil sous les yeux — deux
 * fichiers séparés se seraient désynchronisés au premier type de paramètre
 * ajouté.
 */
export interface JsonSchemaObject {
  type: 'object';
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties: false;
}

function paramJsonSchema(param: McpToolParam): Record<string, unknown> {
  const schema: Record<string, unknown> =
    param.type === 'number'
      ? { type: 'number' }
      : param.type === 'boolean'
        ? { type: 'boolean' }
        : param.enumValues.length > 0
          ? { type: 'string', enum: [...param.enumValues] }
          : { type: 'string' };
  if (param.description.trim() !== '') schema.description = param.description;
  return schema;
}

/** Schéma JSON des paramètres d'un outil maison. */
export function toolJsonSchema(def: McpToolDef): JsonSchemaObject {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  for (const param of def.params) {
    properties[param.name] = paramJsonSchema(param);
    if (param.required) required.push(param.name);
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}
