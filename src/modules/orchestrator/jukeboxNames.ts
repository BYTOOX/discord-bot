const DISCORD_NICKNAME_MAX_LENGTH = 32;

const STAR_CITIZEN_REFERENCES = [
  "Area18",
  "Lorville",
  "Orison",
  "New Babbage",
  "Port Olisar",
  "Grim HEX",
  "Levski",
  "Bajini Point",
  "Everus Harbor",
  "Jumptown",
  "Stanton",
  "Pyro",
  "ArcCorp",
  "Hurston",
  "microTech",
  "Crusader",
  "Yela",
  "Daymar",
  "Cellin",
  "Calliope",
  "Clio",
  "Euterpe",
  "Banu",
  "Vanduul",
  "Carrack",
  "Cutlass",
  "Gladius",
  "Hornet",
  "Pisces",
  "Reclaimer",
  "Mole",
  "Javelin",
  "Sabre",
  "Redeemer",
  "Hammerhead",
  "Vulture",
  "Cutter",
  "Constellation",
  "Avenger",
  "Mustang",
  "Aurora",
  "Corsair",
  "Vanguard",
  "Retaliator",
  "Drake",
  "Anvil",
  "Aegis",
  "Origin",
  "UEE"
];

const FRENCH_PRENOMS = [
  "Jean Claude",
  "Jean Michel",
  "Juan Michael",
  "Jakie",
  "Didier",
  "Dede",
  "Roro",
  "Nono",
  "Jojo",
  "Kiki",
  "Momo",
  "Titouan",
  "Karim",
  "Hakim",
  "Nassim",
  "Farid",
  "Rachid",
  "Nadia",
  "Samira",
  "Fatou",
  "Chantal",
  "Brigitte",
  "Monique",
  "Gerard",
  "Pascal",
  "Serge",
  "Alain",
  "Pierrot",
  "Gino",
  "Zinedine",
  "Nico",
  "Kevin",
  "Brahim",
  "Mireille",
  "Renato"
];

const ARGOT_PREFIXES = [
  "Le Frero",
  "Le Cousin",
  "Le Tonton",
  "Le Daron",
  "La Daronne",
  "La Tata",
  "Le Zinzin",
  "Le Sang",
  "La Mif",
  "Le Voisin",
  "Le Patron",
  "Le Debrouillard",
  "Le Bolosse",
  "Le Seumard",
  "Le Bledard"
];

const ARGOT_SUFFIXES = [
  "du bled",
  "du quartier",
  "de la mif",
  "de service",
  "du dimanche",
  "de la zone",
  "du hangar",
  "de la station",
  "du coin",
  "pas net",
  "en galere",
  "en retard",
  "sans permis",
  "en PLS",
  "du futur"
];

const CURATED_NAMES = [
  "Jean Claude Vanduul",
  "Jean Michel",
  "Jakie Channel",
  "Juan Michael",
  "Blague annulee",
  "Dede de Stanton",
  "Momo de Pyro",
  "Karim de Lorville",
  "Nadia de Grim HEX",
  "Monique de microTech",
  "Farid de Hurston",
  "Rachid de ArcCorp",
  "Serge de Crusader",
  "Gino de Port Olisar",
  "Chantal de Daymar",
  "Alain de Levski",
  "Le Frero de Jumptown",
  "Le Cousin de Banu",
  "Le Tonton de Carrack",
  "Le Daron de Retaliator",
  "La Daronne de Vanduul",
  "La Tata de Yela",
  "Le Zinzin de Pyro",
  "Le Sang de Stanton",
  "La Mif de Orison",
  "Le Voisin de Area18",
  "Le Patron de Everus Harbor",
  "Le Debrouillard de Cellin",
  "Le Bolosse de Clio",
  "Le Seumard de Calliope",
  "Le Bledard de New Babbage"
];

function normalizeName(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, DISCORD_NICKNAME_MAX_LENGTH);
}

function uniqueNormalized(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = normalizeName(value);
    if (!normalized) {
      continue;
    }

    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(normalized);
  }

  return result;
}

function pickRandomFromPool(pool: string[]): string | null {
  if (pool.length === 0) {
    return null;
  }

  const index = Math.floor(Math.random() * pool.length);
  return pool[index] ?? null;
}

function buildNamePool(customNames: string[]): string[] {
  return uniqueNormalized([
    ...customNames,
    ...CURATED_NAMES,
    ...FRENCH_PRENOMS.flatMap((prenom) =>
      STAR_CITIZEN_REFERENCES.map((reference) => `${prenom} ${reference}`)
    ),
    ...FRENCH_PRENOMS.flatMap((prenom) =>
      STAR_CITIZEN_REFERENCES.map((reference) => `${prenom} de ${reference}`)
    ),
    ...ARGOT_PREFIXES.flatMap((prefix) =>
      STAR_CITIZEN_REFERENCES.map((reference) => `${prefix} de ${reference}`)
    ),
    ...FRENCH_PRENOMS.flatMap((prenom) =>
      ARGOT_SUFFIXES.map((suffix) => `${prenom} ${suffix}`)
    ),
    ...ARGOT_PREFIXES.flatMap((prefix) =>
      ARGOT_SUFFIXES.map((suffix) => `${prefix} ${suffix}`)
    )
  ]);
}

export const JUKEBOX_NAME_POOL: string[] = buildNamePool([]);

export function pickRandomJukeboxName(customNames: string[], excludedNames: string[] = []): string {
  const pool = buildNamePool(customNames);
  if (pool.length === 0) {
    return `Pilote ${Math.floor(Math.random() * 9_000) + 1_000}`;
  }

  const excluded = new Set(uniqueNormalized(excludedNames).map((name) => name.toLowerCase()));
  const available = pool.filter((name) => !excluded.has(name.toLowerCase()));
  const selected = pickRandomFromPool(available.length > 0 ? available : pool);
  return selected ?? pool[0] ?? "Jukebox";
}

export function pickRandomJukeboxNames(count: number, customNames: string[]): string[] {
  const pool = [...buildNamePool(customNames)];
  const names: string[] = [];

  while (names.length < count && pool.length > 0) {
    const index = Math.floor(Math.random() * pool.length);
    const selected = pool[index];
    if (!selected) {
      break;
    }

    names.push(selected);
    pool.splice(index, 1);
  }

  while (names.length < count) {
    names.push(`Pilote ${names.length + 1}`);
  }

  return names;
}
