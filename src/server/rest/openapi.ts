/**
 * OpenAPI 3.0 description of the external REST API (rest/router.ts), served
 * unauthenticated at GET /api/rest/v1/openapi.json and rendered by the
 * vendored Swagger UI page (public/openapi/ → served at /openapi/).
 *
 * HAND-WRITTEN MIRROR: the request schemas below restate the zod schemas in
 * rest/operations.ts and shared/export.ts, and the response shapes mirror
 * what the shared operations return. Update this file whenever those change.
 */
import {
  EXPORT_FILE_NAMES,
  EXPORT_FORMATS,
  EXPORT_GROUPINGS,
  EXPORT_PACKAGINGS,
} from '../../shared/export.js';
import { MAX_BATCH_ITEMS } from './operations.js';
import pkg from '../../../package.json';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const jsonResponse = (schema: unknown, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});

const errorResponse = (description: string) =>
  jsonResponse(ref('Error'), description);

const textOrPlurals = {
  description:
    'A single text, or one entry per plural form for pluralized strings.',
  oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
} as const;

export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Weblate Friendly Bridge REST API',
    version: pkg.version,
    description: [
      'Create, modify, delete and export translation strings in Weblate.',
      '',
      'Authentication: send a Weblate API key either as `Authorization: Token <key>`',
      'or as `X-API-Key: <key>`. Keys are validated against the Weblate instance, so',
      'permissions follow the key’s user. (In mock mode any key is accepted.)',
      '',
      'The same operations are also available as MCP tools under `/mcp/v1`',
      '(streamable HTTP, stateless): list_projects, list_components, create_strings,',
      'patch_translations, delete_translation. Export is REST-only.',
    ].join('\n'),
  },
  servers: [{ url: '/' }],
  tags: [
    { name: 'Discovery', description: 'Projects and components' },
    { name: 'Strings', description: 'Batch-create, modify and delete translation strings' },
    { name: 'Export', description: 'Export translations as i18next/ARB files' },
  ],
  components: {
    securitySchemes: {
      TokenAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'Authorization',
        description: '`Token <Weblate API key>`',
      },
      XApiKey: {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
        description: 'Alternative to the Authorization header.',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        required: ['error'],
        properties: { error: { type: 'string' } },
      },
      WeblateProject: {
        type: 'object',
        required: ['slug', 'name', 'web_url'],
        properties: {
          slug: { type: 'string' },
          name: { type: 'string' },
          web_url: { type: 'string' },
          translation_review: {
            type: 'boolean',
            description: 'Whether the review workflow (state 30) is enabled.',
          },
        },
      },
      WeblateComponent: {
        type: 'object',
        required: ['slug', 'name', 'project', 'source_language', 'translations_url', 'web_url'],
        properties: {
          slug: { type: 'string' },
          name: { type: 'string' },
          project: { type: 'string' },
          source_language: {
            type: 'object',
            properties: { code: { type: 'string' }, name: { type: 'string' } },
          },
          translations_url: { type: 'string' },
          web_url: { type: 'string' },
        },
      },
      TextOrPlurals: textOrPlurals,
      CreateItem: {
        type: 'object',
        required: ['source'],
        properties: {
          context: {
            type: 'string',
            maxLength: 500,
            description:
              'Context key of the string. Omitted keys are generated as `auto-<random>`.',
          },
          source: {
            description: 'Source-language text (the string’s content). Must not be empty.',
            oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          },
          translations: {
            type: 'object',
            additionalProperties: textOrPlurals,
            description:
              'Per-language translations to set right away; they are created with state 10 ("Needs editing").',
          },
        },
      },
      LanguageChange: {
        type: 'object',
        required: ['target'],
        properties: {
          target: {
            description: 'New text (one entry per plural form for pluralized strings).',
            oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          },
          state: {
            type: 'integer',
            enum: [0, 10, 20, 30],
            default: 20,
            description:
              '0 = untranslated (clears the text), 10 = needs editing, 20 = translated (default), 30 = approved. States 20/30 require non-empty content.',
          },
        },
      },
      UnitUpdate: {
        type: 'object',
        required: ['unitId', 'state'],
        properties: {
          unitId: { type: 'integer', description: 'Weblate unit id' },
          state: { type: 'integer', enum: [0, 10, 20, 30] },
        },
      },
      CreateResultItem: {
        type: 'object',
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          context: { type: 'string' },
          sourceUnitId: { type: 'integer' },
          translations: {
            type: 'object',
            additionalProperties: ref('UnitUpdate'),
            description: 'Per-language results of the created translations.',
          },
          error: { type: 'string', description: 'Failure reason (ok = false).' },
        },
      },
      ExportFile: {
        type: 'object',
        required: ['name', 'contentBase64'],
        properties: {
          name: {
            type: 'string',
            description: 'Archive path, e.g. `project/component/en.json`.',
          },
          contentBase64: { type: 'string', description: 'Base64-encoded utf-8 file content.' },
        },
      },
    },
  },
  security: [{ TokenAuth: [] }, { XApiKey: [] }],
  paths: {
    '/api/rest/v1/projects': {
      get: {
        tags: ['Discovery'],
        operationId: 'listProjects',
        summary: 'List projects',
        responses: {
          200: jsonResponse(
            { type: 'object', required: ['results'], properties: { results: { type: 'array', items: ref('WeblateProject') } } },
            'All projects visible to the API key.',
          ),
          401: errorResponse('Missing or invalid API key'),
          503: errorResponse('The API key was rejected by Weblate (temporarily unavailable)'),
        },
      },
    },
    '/api/rest/v1/projects/{project}/components': {
      get: {
        tags: ['Discovery'],
        operationId: 'listComponents',
        summary: 'List the components of a project',
        parameters: [
          {
            name: 'project',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          200: jsonResponse(
            { type: 'object', required: ['results'], properties: { results: { type: 'array', items: ref('WeblateComponent') } } },
            'All components of the project.',
          ),
          401: errorResponse('Missing or invalid API key'),
          404: errorResponse('Unknown project'),
          503: errorResponse('The API key was rejected by Weblate'),
        },
      },
    },
    '/api/rest/v1/projects/{project}/components/{component}/translations': {
      post: {
        tags: ['Strings'],
        operationId: 'createStrings',
        summary: 'Batch-create translation strings',
        description: [
          'Creates one string per item: the source unit first (state 20), then each',
          'provided translation (state 10, "Needs editing").',
          '',
          `- At most ${MAX_BATCH_ITEMS} items per request.`,
          '- The response contains one entry per item (and per failed translation),',
          '  each with `ok: true/false`; a failed item does not abort the batch.',
          '- Contexts are unique per component: creating an existing context fails that item.',
        ].join('\n'),
        parameters: [
          { name: 'project', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'component', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: jsonResponse(
          {
            type: 'object',
            required: ['items'],
            properties: {
              items: {
                type: 'array',
                minItems: 1,
                maxItems: MAX_BATCH_ITEMS,
                items: ref('CreateItem'),
              },
            },
          },
          'Batch of strings to create.',
        ),
        responses: {
          200: jsonResponse(
            {
              type: 'object',
              required: ['results'],
              properties: { results: { type: 'array', items: ref('CreateResultItem') } },
            },
            'Per-item outcome (ok / error); the batch is not all-or-nothing.',
          ),
          400: errorResponse('Malformed body (invalid item, empty source, too many items)'),
          401: errorResponse('Missing or invalid API key'),
          404: errorResponse('Unknown component (or component without a source translation)'),
          503: errorResponse('The API key was rejected by Weblate'),
        },
      },
    },
    '/api/rest/v1/projects/{project}/components/{component}/translations/{context}': {
      patch: {
        tags: ['Strings'],
        operationId: 'patchTranslations',
        summary: 'Set several languages of one string',
        description: [
          'Modifies the existing translation of the given context key for each language',
          'in the body. Languages without an existing translation are reported in',
          '`errors` (nothing is auto-created); when no language matches at all the',
          'string is considered unknown (404).',
        ].join('\n'),
        parameters: [
          { name: 'project', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'component', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'context', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: jsonResponse(
          {
            type: 'object',
            required: ['translations'],
            properties: {
              translations: {
                type: 'object',
                minProperties: 1,
                additionalProperties: ref('LanguageChange'),
              },
            },
          },
          'Per-language changes: `{ "<language>": { "target": "…", "state": 20 } }`.',
        ),
        responses: {
          200: jsonResponse(
            {
              type: 'object',
              required: ['context', 'translations'],
              properties: {
                context: { type: 'string' },
                translations: {
                  type: 'object',
                  additionalProperties: ref('UnitUpdate'),
                },
                errors: {
                  type: 'object',
                  additionalProperties: { type: 'string' },
                  description: 'Per-language failures (e.g. no translation exists for this language).',
                },
              },
            },
            'Applied changes; partial success is possible when `errors` is present.',
          ),
          400: errorResponse('Malformed body (empty translations, missing target, invalid state)'),
          401: errorResponse('Missing or invalid API key'),
          404: errorResponse('Unknown context'),
          503: errorResponse('The API key was rejected by Weblate'),
        },
      },
      delete: {
        tags: ['Strings'],
        operationId: 'deleteTranslation',
        summary: 'Delete a language of a string, or the whole string',
        description: [
          'Semantics follow Weblate’s model:',
          '',
          '- No `language` → the whole string is deleted (all languages at once).',
          '- `language=<source language>&all=true` → same, explicitly confirmed.',
          '- `language=<target>&clear=true` → the target translation cannot be deleted',
          '  individually; it is cleared instead (state 0, empty target).',
          '',
          'Any other combination answers 400 (source language without `all`) or 422',
          '(target language without `clear`).',
        ].join('\n'),
        parameters: [
          { name: 'project', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'component', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'context', in: 'path', required: true, schema: { type: 'string' } },
          {
            name: 'language',
            in: 'query',
            description: 'Language to delete/clear; omit to delete the whole string.',
            schema: { type: 'string' },
          },
          {
            name: 'all',
            in: 'query',
            description: 'Confirm whole-string deletion via `language=<source>&all=true`.',
            schema: { type: 'string', enum: ['true', 'false'] },
          },
          {
            name: 'clear',
            in: 'query',
            description: 'Allow clearing a target-language translation (state 0).',
            schema: { type: 'string', enum: ['true', 'false'] },
          },
        ],
        responses: {
          200: jsonResponse(
            {
              oneOf: [
                {
                  type: 'object',
                  properties: {
                    deleted: { type: 'boolean', enum: [true] },
                    context: { type: 'string' },
                    wholeString: { type: 'boolean' },
                    language: { type: 'string' },
                  },
                },
                {
                  type: 'object',
                  properties: {
                    cleared: { type: 'boolean', enum: [true] },
                    context: { type: 'string' },
                    language: { type: 'string' },
                  },
                },
              ],
            },
            '`deleted` (unit removed) or `cleared` (translation emptied).',
          ),
          400: errorResponse('Source language without all=true, or invalid parameters'),
          401: errorResponse('Missing or invalid API key'),
          404: errorResponse('Unknown context, or no translation in the given language'),
          422: errorResponse('Target-language delete without clear=true'),
          503: errorResponse('The API key was rejected by Weblate'),
        },
      },
    },
    '/api/rest/v1/export': {
      post: {
        tags: ['Export'],
        operationId: 'exportTranslations',
        summary: 'Export translations as i18next/ARB files',
        description: [
          'Turns one or more (project, component) pairs into one file per language',
          '(format `i18next` or `arb`), delivered as a zip archive or as base64',
          'entries in a JSON response.',
          '',
          '- File keys are the string context (falling back to the source text for',
          '  key-less components); untranslated strings export as empty values;',
          '  plural forms as suffixed keys `key_0`, `key_1`, …',
          '- Grouping `per-component` writes `project/component/<file>` entries;',
          '  `merged` combines all components into one file per language (first',
          '  component wins on duplicate keys).',
          '- This endpoint may also be used **without an API key** ("public export")',
          '  when the server is configured with both `WEBLATE_EXPORT_API_KEY` and',
          '  `WEBLATE_EXPORT_ALLOWED_HOSTS` and the caller’s IP is inside those CIDR',
          '  ranges (403 otherwise). It answers 503 while the configured key is',
          '  rejected by Weblate.',
        ].join('\n'),
        requestBody: jsonResponse(
          {
            type: 'object',
            required: ['scope', 'format', 'fileName', 'grouping', 'packaging'],
            properties: {
              scope: {
                type: 'array',
                minItems: 1,
                maxItems: 100,
                items: {
                  type: 'object',
                  required: ['project', 'component'],
                  properties: { project: { type: 'string' }, component: { type: 'string' } },
                },
              },
              languages: {
                type: 'array',
                items: { type: 'string' },
                description: 'Language codes to export; omitted/empty = all languages.',
              },
              format: { type: 'string', enum: [...EXPORT_FORMATS] },
              fileName: {
                type: 'string',
                enum: [...EXPORT_FILE_NAMES],
                description: '`[language]` → code, `[LANGUAGE]` → uppercased code.',
              },
              grouping: { type: 'string', enum: [...EXPORT_GROUPINGS] },
              packaging: { type: 'string', enum: [...EXPORT_PACKAGINGS] },
            },
          },
          'Export parameters.',
        ),
        responses: {
          200: {
            description: 'The exported files (zip archive or base64 JSON entries).',
            content: {
              'application/zip': {
                schema: { type: 'string', format: 'binary' },
              },
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['files'],
                  properties: { files: { type: 'array', items: ref('ExportFile') } },
                },
              },
            },
          },
          400: errorResponse('Malformed parameters'),
          401: errorResponse('Missing or invalid API key (and public export not configured)'),
          403: errorResponse('Public export not enabled, or client host outside the allowed ranges'),
          404: errorResponse('Unknown component, or no matching languages'),
          503: errorResponse('The API key was rejected by Weblate'),
        },
      },
    },
  },
} as const;