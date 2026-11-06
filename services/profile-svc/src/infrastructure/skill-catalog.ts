import { type SkillCatalog } from '../application/ports';

/**
 * Resolves skill ids through taxonomy-svc (`GET /v1/skills/{id}?tenant_id=`) with a service
 * token: a hidden or unknown skill resolves to null, a non-leaf node to null, and a deprecated
 * skill to its active successor.
 */
export class HttpSkillCatalog implements SkillCatalog {
  constructor(
    private readonly options: { baseUrl: string; token: () => Promise<string>; timeoutMs?: number },
  ) {}

  async resolve(
    tenantId: string,
    skillIds: readonly string[],
  ): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    const token = await this.options.token();
    await Promise.all(
      skillIds.map(async (id) => {
        const response = await fetch(
          `${this.options.baseUrl.replace(/\/$/, '')}/v1/skills/${encodeURIComponent(id)}?tenant_id=${encodeURIComponent(tenantId)}`,
          {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(this.options.timeoutMs ?? 3000),
          },
        );
        if (response.status === 404 || response.status === 400) {
          out.set(id, null);
          return;
        }
        if (!response.ok) throw new Error(`taxonomy-svc answered ${response.status}`);
        const skill = (await response.json()) as {
          skill_id: string;
          node_type: string;
          deprecated_at: string | null;
          successor: { skill_id: string } | null;
        };
        if (skill.node_type !== 'skill') out.set(id, null);
        else
          out.set(id, skill.deprecated_at ? (skill.successor?.skill_id ?? null) : skill.skill_id);
      }),
    );
    return out;
  }
}

/** Development/tests: a fixed set of known skill ids, plus optional deprecated → successor links. */
export class StaticSkillCatalog implements SkillCatalog {
  constructor(
    private readonly known: ReadonlySet<string>,
    private readonly successors: ReadonlyMap<string, string> = new Map(),
  ) {}

  resolve(_tenantId: string, skillIds: readonly string[]): Promise<Map<string, string | null>> {
    return Promise.resolve(
      new Map(
        skillIds.map(
          (id) => [id, this.successors.get(id) ?? (this.known.has(id) ? id : null)] as const,
        ),
      ),
    );
  }
}
