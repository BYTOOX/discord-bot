const STAR_CITIZEN_PREFIXES = [
  "Stanton",
  "Pyro",
  "Hurston",
  "ArcCorp",
  "microTech",
  "Crusader",
  "Aegis",
  "Anvil",
  "Drake",
  "Origin",
  "Banu",
  "Vanduul",
  "Carrack",
  "Cutlass",
  "Gladius",
  "Hornet",
  "Pisces",
  "Reclaimer",
  "Mole",
  "Javelin"
];

const MUSIC_SUFFIXES = [
  "Jean-Michel Jukebox",
  "Elton Jump",
  "DJ Quantum",
  "Bass Citizen",
  "Disco Drive",
  "Groove Atlas",
  "Boogie Beacon",
  "Synth Navigator",
  "Mixtape Pilot",
  "Vinyl Vanguard",
  "Nocturne Controller",
  "Trance Mechanic"
];

const CURATED_NAMES = [
  "Jean Michel Jukebox",
  "Elton John (pas le vrai)",
  "DJ Port Olisar",
  "Benny's Bassline",
  "Captain Tempo",
  "Major Harmonie",
  "Commodore Kickdrum",
  "Le Baron du BPM",
  "Miss Quantum Chorus",
  "Admiral AutoTune",
  "Guitarro Roberts",
  "Rythme de la Terre 2",
  "Space Crooner 3000",
  "Corsair du Solfege",
  "Piano de Pyro"
];

export const JUKEBOX_NAME_POOL: string[] = Array.from(
  new Set([
    ...CURATED_NAMES,
    ...STAR_CITIZEN_PREFIXES.flatMap((prefix) =>
      MUSIC_SUFFIXES.map((suffix) => `${prefix} ${suffix}`)
    )
  ])
);

export function pickRandomJukeboxNames(count: number, fixedNames: string[]): string[] {
  const normalizedFixed = fixedNames
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  const used = new Set<string>(normalizedFixed.map((value) => value.toLowerCase()));
  const names = [...normalizedFixed];

  if (names.length >= count) {
    return names.slice(0, count);
  }

  const candidates = JUKEBOX_NAME_POOL.filter((name) => !used.has(name.toLowerCase()));
  while (names.length < count && candidates.length > 0) {
    const index = Math.floor(Math.random() * candidates.length);
    const selected = candidates[index];
    if (!selected) {
      break;
    }

    names.push(selected);
    used.add(selected.toLowerCase());
    candidates.splice(index, 1);
  }

  while (names.length < count) {
    names.push(`Jukebox ${names.length + 1}`);
  }

  return names;
}

