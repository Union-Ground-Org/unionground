// Fictional long registered names for record #8743: a name is built from
// repeated words up to an exact character count, never from real data.
import { exportLedgerId } from "./union-catalog-americas-fixture.mjs";

export function longName(length, lead = "Sindicato Nacional de Trabajadores de Ejemplo") {
  let name = lead;
  const words = ["de", "la", "Industria", "Ejemplar", "y", "Similares", "del", "Ramo", "Fixture"];
  for (let i = 0; name.length < length; i += 1) name += ` ${words[i % words.length]}`;
  return name.slice(0, length).trimEnd().padEnd(length, "x");
}

export const LONG_NAMES = Object.freeze({ MX: longName(622), BR: longName(1000, "Sindicato dos Trabalhadores de Exemplo"), AR: longName(1001, "Sindicato Argentino de Ejemplo") });

/** Gives three Americas sample bodies names of 622, 1,000 and 1,001 characters. */
export function withLongNames(fixture) {
  for (const [country, name] of Object.entries(LONG_NAMES)) fixture.enriched[exportLedgerId(country)].name = name;
  return fixture;
}
