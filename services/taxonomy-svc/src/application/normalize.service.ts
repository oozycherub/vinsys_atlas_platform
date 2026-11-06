import { Inject, Injectable } from '@nestjs/common';
import {
  DATABASE,
  type Database,
  type Principal,
  ServiceUnavailableError,
  type Tx,
} from '@atlas/platform';
import { decideAnn, type NormalizeResult, pickAliasMatch } from '../domain/normalize';
import { type Skill } from '../domain/skill';
import { termKey } from '../domain/terms';
import {
  EMBEDDING_PORT,
  type EmbeddingPort,
  SKILL_REPOSITORY,
  type SkillRepository,
  SUGGESTION_REPOSITORY,
  type SuggestionRepository,
  type View,
} from './ports';
import { inScope, readScope } from './scope';

const MAX_SUCCESSOR_HOPS = 10;

/**
 * Raw strings → canonical skills (PRD §2.1 stage 8): alias/name lookup first (confidence 1.0),
 * then nearest-neighbour search over skill embeddings with the §6 thresholds. Deprecated matches
 * resolve to their successor. Weak matches are queued for the tenant's taxonomy admins.
 */
@Injectable()
export class NormalizeService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(SKILL_REPOSITORY) private readonly skills: SkillRepository,
    @Inject(SUGGESTION_REPOSITORY) private readonly suggestions: SuggestionRepository,
    @Inject(EMBEDDING_PORT) private readonly embeddings: EmbeddingPort,
  ) {}

  async normalize(
    principal: Principal,
    terms: readonly string[],
    tenantHint?: string,
  ): Promise<NormalizeResult[]> {
    const scope = readScope(principal, tenantHint);
    const view = scope.tenantId;
    const keys = terms.map(termKey);
    const unique = [...new Set(keys.filter((k) => k.length > 0))];

    // 1. Alias / name lookup.
    const byKey = new Map<string, Skill>();
    await inScope(this.db, scope, async (tx) => {
      const candidates = await this.skills.aliasCandidates(tx, view, unique);
      for (const key of unique) {
        const match = pickAliasMatch(candidates.filter((c) => c.key === key).map((c) => c.skill));
        const active = match ? await this.active(tx, view, match) : null;
        if (active) byKey.set(key, active);
      }
    });

    // 2. ANN for the rest (embedding outside any transaction).
    const missing = unique.filter((k) => !byKey.has(k));
    const ann = new Map<string, NormalizeResult>();
    if (missing.length > 0) {
      let vectors: number[][];
      try {
        vectors = await this.embeddings.embed(missing);
      } catch {
        throw new ServiceUnavailableError(
          'EMBEDDINGS_UNAVAILABLE',
          'The embedding service is unavailable; retry shortly.',
        );
      }
      await inScope(this.db, scope, async (tx) => {
        for (const [i, key] of missing.entries()) {
          const vector = vectors[i];
          const nearest = vector
            ? await this.skills.nearest(tx, view, vector, this.embeddings.model)
            : null;
          const decision = decideAnn(nearest?.cosine ?? 0);
          if (decision.kind === 'accept' && nearest) {
            ann.set(key, {
              term: key,
              skill_id: nearest.skill.id,
              confidence: decision.confidence,
              method: 'ann',
            });
            continue;
          }
          if (decision.kind === 'suggest' && nearest && view) {
            await this.suggestions.record(tx, view, key, nearest.skill.id, decision.confidence);
          }
          ann.set(key, {
            term: key,
            skill_id: null,
            confidence: decision.confidence,
            method: 'none',
          });
        }
      });
    }

    return terms.map((term, i) => {
      const key = keys[i] ?? '';
      const aliasHit = byKey.get(key);
      if (aliasHit) return { term, skill_id: aliasHit.id, confidence: 1, method: 'alias' };
      const result = ann.get(key);
      return result ? { ...result, term } : { term, skill_id: null, confidence: 0, method: 'none' };
    });
  }

  /** Follows REPLACES links so callers never receive a deprecated skill id. */
  private async active(tx: Tx, view: View, skill: Skill): Promise<Skill | null> {
    let current: Skill | null = skill;
    for (let hop = 0; hop < MAX_SUCCESSOR_HOPS && current?.deprecatedAt; hop += 1) {
      current = current.replacedBy
        ? await this.skills.findById(tx, view, current.replacedBy)
        : null;
    }
    return current?.deprecatedAt ? null : current;
  }
}
