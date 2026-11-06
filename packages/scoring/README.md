# @atlas/scoring

The candidate ↔ job scoring formula from PRD §2.1(b) as pure functions: no I/O, no clock, no randomness. matching-svc (brick 7) and the internal marketplace (brick 12) both use it, so they score identically.

| Function                                     | What it computes                                                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `semFromCosine`, `candidateEmbedding`, `sem` | SEM: the cosine between the job and the normalised mean of the candidate's top-3 chunks, rescaled between 0.30 and 0.85. |
| `assessSkill`, `coverage`                    | COV, with related-skill credit `p̂ = max(p, ρ·p')` and ρ capped at 0.8.                                                   |
| `mustHaveGate`                               | M: a factor of 0.5 for each must-have below half its target.                                                             |
| `experience`                                 | EXP: a Gaussian on missing years, σ = 2.                                                                                 |
| `lexical`                                    | LEX: BM25 divided by the best BM25 in the result set.                                                                    |
| `combine`, `scoreCandidate`, `band`          | The weighted score and its band.                                                                                         |
| `assertWeights`                              | Weights must be non-negative and sum to 1.                                                                               |

**Marketplace options (PRD §2.5(iv)).**

- `unvalidatedFactor: 0.5` counts unvalidated proficiencies at half their value.
- `availability` multiplies the final score.
