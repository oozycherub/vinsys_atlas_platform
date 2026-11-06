/**
 * Lookup key for skill names, aliases and raw terms (PRD §2.1 stage 8): Unicode-normalised,
 * lower-cased, whitespace collapsed, punctuation removed EXCEPT the characters that carry
 * meaning in skill names (`+`, `#`, `.` inside a token), so "C++", "C#" and ".NET" survive.
 */
export function termKey(raw: string): string {
  return raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#.\s]/gu, ' ')
    .replace(/(^|\s)\.(?=\s|$)/g, ' ') // a lone dot is punctuation
    .replace(/\.(?=\s|$)/g, '') // trailing sentence dot: "Python." → "python"
    .replace(/\s+/g, ' ')
    .trim();
}

/** Every key a skill answers to: its name and each alias, de-duplicated. */
export function searchKeys(name: string, aliases: readonly string[]): string[] {
  return [...new Set([name, ...aliases].map(termKey).filter((k) => k.length > 0))].sort();
}

export function cleanAliases(aliases: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const alias of aliases) {
    const trimmed = alias.trim().replace(/\s+/g, ' ');
    const key = termKey(trimmed);
    if (trimmed && key && !seen.has(key)) {
      seen.add(key);
      out.push(trimmed);
    }
  }
  return out;
}
