import { type EmbeddingPort } from '../../src/application/ports';
import { HashingEmbeddingStub } from '../../src/infrastructure/embeddings';

/**
 * Test embeddings: the lexical stub, plus pinned phrases placed at an exact cosine from a
 * target text. This stands in for bge-m3 semantics ("event streaming" ≈ Kafka) so the ANN
 * pipeline and its thresholds can be tested deterministically.
 */
export class FixtureEmbeddings implements EmbeddingPort {
  readonly model = 'atlas-hash-v1'; // same model id as the stub: vectors are comparable
  private readonly stub = new HashingEmbeddingStub();
  private readonly pinned = new Map<string, { target: string; cosine: number }>();
  calls = 0;
  failing = false;

  pin(phrase: string, target: string, cosine: number): void {
    this.pinned.set(phrase, { target, cosine });
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    this.calls += 1;
    if (this.failing) throw new Error('gateway down');
    const out: number[][] = [];
    for (const text of texts) {
      const pin = this.pinned.get(text);
      if (!pin) {
        out.push((await this.stub.embed([text]))[0]!);
        continue;
      }
      const [target, noise] = await this.stub.embed([pin.target, `orthogonal noise for ${text}`]);
      // Gram–Schmidt: a unit vector orthogonal to the target, then mix to the wanted cosine.
      const dot = noise!.reduce((s, x, i) => s + x * target![i]!, 0);
      const orth = noise!.map((x, i) => x - dot * target![i]!);
      const n = Math.sqrt(orth.reduce((s, x) => s + x * x, 0));
      const sin = Math.sqrt(1 - pin.cosine * pin.cosine);
      out.push(target!.map((x, i) => pin.cosine * x + (sin * orth[i]!) / n));
    }
    return out;
  }
}
