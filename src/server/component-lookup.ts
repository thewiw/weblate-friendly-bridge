/**
 * Precise errors for unknown project/component references. Shared by the
 * REST export and the string operations (which back both the REST API and
 * the MCP server), so both surfaces give the same actionable messages.
 *
 * The common mix-up this resolves: Weblate *display names* ("v4.2.0") are
 * not *slugs* ("v4-2-0") — API paths use slugs only.
 */
import type { WeblateApi } from './weblate/client.js';
import { UpstreamError } from './http-errors.js';

/** Lowercased, alphanumeric-only form for fuzzy slug/name matching. */
const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Whether an error means "the component (or project) is not there" — as
 * opposed to a network/other upstream failure that must not be masked.
 * Live Weblate answers 404; the mock throws a plain Error.
 */
export function isNotFound(err: unknown): boolean {
  if (err instanceof UpstreamError) return err.status === 404;
  return err instanceof Error && err.message.includes('Unknown');
}

/**
 * Builds the most precise 404 possible for a missing project/component:
 * unknown project → says so; known project with a slug/name that differs
 * only in punctuation/case → suggests the actual slug; otherwise lists the
 * available slugs.
 */
export async function unknownComponentError(
  api: WeblateApi,
  project: string,
  component: string,
): Promise<UpstreamError> {
  try {
    await api.getProject(project);
  } catch {
    return new UpstreamError(404, `Unknown project: ${project}`);
  }

  let components: Awaited<ReturnType<WeblateApi['listComponents']>>;
  try {
    components = await api.listComponents(project);
  } catch {
    return new UpstreamError(404, `Unknown project: ${project}`);
  }

  const wanted = normalize(component);
  const match = components.find(
    (c) => normalize(c.slug) === wanted || normalize(c.name) === wanted,
  );
  if (match !== undefined) {
    return new UpstreamError(
      404,
      `Unknown component: ${project}/${component} — did you mean the slug "${match.slug}"? ` +
        `API paths use component slugs, not display names ` +
        `(list them via GET /api/rest/v1/projects/${project}/components).`,
    );
  }

  const available = components.map((c) => c.slug).join(', ');
  return new UpstreamError(
    404,
    `Unknown component: ${project}/${component}. ` +
      `Available components in "${project}": ${available !== '' ? available : '(none)'}.`,
  );
}