/** Shared URL slug helpers — used by pages, sitemap, API routes, and client components. */

function deAccent(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Full name → hyphenated slug: "Carlos Alcaraz" → "carlos-alcaraz" */
export function playerNameSlug(name: string): string {
  return deAccent(name.toLowerCase()).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** id + name → player path segment: "273680-carlos-alcaraz" */
export function toPlayerSlug(id: string | number, name: string): string {
  return `${id}-${playerNameSlug(name)}`;
}

/** Full player URL: "/player/273680-carlos-alcaraz" */
export function playerUrl(id: number, name: string): string {
  return `/player/${toPlayerSlug(id, name)}`;
}

/** Last name only, no hyphens — used in compare URLs: "Alcaraz" → "alcaraz" */
export function slugifyLastName(name: string): string {
  return deAccent((name.split(/[\s-]/).pop() || name).toLowerCase()).replace(/[^a-z0-9]/g, '');
}

/** Tournament name → hyphenated slug: "Wimbledon, Men" → "wimbledon-men" */
export function tournamentNameSlug(name: string): string {
  return deAccent(name.toLowerCase()).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** id + name + year → tournament path segment: "2361-wimbledon-men-2026" */
export function toTournamentSlug(id: string | number, name: string, year: string | number): string {
  return `${id}-${tournamentNameSlug(name)}-${year}`;
}

/** Full tournament URL derived from a fixture date string: "/tournament/2361-wimbledon-men-2026" */
export function tournamentUrl(id: number | undefined, name: string, date: string): string {
  if (!id) return '#';
  return `/tournament/${toTournamentSlug(id, name, date.slice(0, 4))}`;
}
