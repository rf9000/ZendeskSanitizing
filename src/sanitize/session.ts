import type { Allowlist } from "./allowlist.ts";
import { splitText } from "./chunking.ts";
import { detectLang as defaultDetectLang } from "./language.ts";
import { PlaceholderTable } from "./placeholders.ts";
import { applySpans, splitSpansAroundRanges } from "./replace.ts";
import { SanitizerError, emptyCounts, type Chunk, type Counts, type Lang, type Pass1Client, type Span, type SpanDetector } from "./types.ts";

export interface SessionDeps {
  pass1: Pass1Client;
  pass2: SpanDetector | null;
  allowlist: Allowlist;
  detectLang?: (text: string) => Lang;
  timeouts: { pass1Ms: number; pass2Ms: number };
  chunkMaxChars: number;
  concurrency: number;
}

export interface SanitizeOutput {
  texts: Map<string, string>;
  counts: Counts;
  perPass: { pass1: number; pass2: number };
}

/** One `splitText` piece, mutated in place as later passes are applied. */
interface Piece {
  readonly id: string;
  readonly lang: Lang;
  text: string;
}

export class SanitizeSession {
  private readonly table = new PlaceholderTable();
  private readonly counts = emptyCounts();
  private readonly perPass = { pass1: 0, pass2: 0 };
  private readonly detectLang: (text: string) => Lang;
  private used = false;

  constructor(private readonly deps: SessionDeps) {
    this.detectLang = deps.detectLang ?? defaultDetectLang;
  }

  /**
   * Detection runs concurrently (bounded by `concurrency`) across every piece of every chunk;
   * placeholder assignment always walks the results in input order, so numbering depends only
   * on the order chunks/pieces were given, never on which network call happened to finish first.
   */
  async sanitize(chunks: Chunk[]): Promise<SanitizeOutput> {
    if (this.used) throw new SanitizerError("SANITIZER_INTERNAL", "SanitizeSession is single-use");
    this.used = true;

    if (!Number.isInteger(this.deps.concurrency) || this.deps.concurrency < 1) {
      throw new SanitizerError("SANITIZER_INTERNAL", "concurrency must be a positive integer");
    }
    const seenIds = new Set<string>();
    for (let i = 0; i < chunks.length; i++) {
      const id = chunks[i]!.id;
      if (seenIds.has(id)) throw new SanitizerError("SANITIZER_INTERNAL", "duplicate chunk id");
      seenIds.add(id);
    }

    // Pieces grouped per chunk (for the final join) and as one flat, input-ordered list (for pooling).
    const chunkPieces: Piece[][] = chunks.map((chunk) => {
      const lang = chunk.lang ?? this.detectLang(chunk.text);
      return splitText(chunk.text, this.deps.chunkMaxChars).map((text, pieceIndex) => ({
        id: `${chunk.id}#${pieceIndex}`,
        lang,
        text,
      }));
    });
    const flat: Piece[] = chunkPieces.flat();

    const callController = new AbortController();
    try {
      const spans1 = await this.runPool(flat, (piece) =>
        piece.text.length === 0
          ? Promise.resolve([])
          : this.withTimeout(this.deps.timeouts.pass1Ms, callController.signal, (signal) =>
              this.deps.pass1.analyze({ id: piece.id, text: piece.text, lang: piece.lang }, { signal }),
            ),
      );
      for (let i = 0; i < flat.length; i++) {
        const piece = flat[i]!;
        const step = this.apply(piece.text, spans1[i]!);
        this.perPass.pass1 += step.applied.length;
        piece.text = step.text;
      }

      if (this.deps.pass2 !== null) {
        const pass2 = this.deps.pass2;
        const spans2 = await this.runPool(flat, (piece) =>
          piece.text.length === 0
            ? Promise.resolve([])
            : this.withTimeout(this.deps.timeouts.pass2Ms, callController.signal, (signal) =>
                pass2.detect({ id: piece.id, text: piece.text, lang: piece.lang }, { signal }),
              ),
        );
        for (let i = 0; i < flat.length; i++) {
          const piece = flat[i]!;
          const step = this.apply(piece.text, spans2[i]!);
          this.perPass.pass2 += step.applied.length;
          piece.text = step.text;
        }
      }
    } catch (e) {
      callController.abort();
      if (e instanceof SanitizerError) throw e;
      throw new SanitizerError("SANITIZER_INTERNAL", `unexpected ${(e as Error)?.name ?? typeof e}`, { cause: e });
    }

    const texts = new Map<string, string>();
    for (let chunkIndex = 0; chunkIndex < chunkPieces.length; chunkIndex++) {
      const pieces = chunkPieces[chunkIndex]!;
      let joined = "";
      for (let i = 0; i < pieces.length; i++) joined += pieces[i]!.text;
      texts.set(chunks[chunkIndex]!.id, joined);
    }
    if (texts.size !== chunks.length) {
      throw new SanitizerError("SANITIZER_INTERNAL", "incomplete sanitization");
    }

    return { texts, counts: { ...this.counts }, perPass: { ...this.perPass } };
  }

  /** Runs `fn` over `items` with up to `concurrency` in flight; results land at their input index. */
  private async runPool<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    if (items.length === 0) return results;
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next;
        next = i + 1;
        if (i >= items.length) return;
        results[i] = await fn(items[i]!);
      }
    };
    const workerCount = Math.min(this.deps.concurrency, items.length);
    await Promise.all(Array.from({ length: workerCount }, worker));
    return results;
  }

  private apply(text: string, spans: Span[]) {
    const filtered = this.deps.allowlist.filter(text, spans);
    const protectedRanges = this.deps.allowlist.findOccurrences(text);
    const result = applySpans(text, splitSpansAroundRanges(filtered, protectedRanges), this.table);
    for (const sp of result.applied) this.counts[sp.type]++;
    return result;
  }

  /**
   * Bounds one client call to `ms`, aborting it early if `callSignal` (the whole-session abort,
   * fired on the first sibling failure) aborts first. Any rejection observed after the local
   * controller has aborted — for whatever reason — is normalized to SANITIZER_UNAVAILABLE.
   *
   * The abort signal alone is not enough: a detector that ignores its `AbortSignal` would keep
   * `fn`'s promise pending forever, hanging `await fn(...)` right along with it. So this also
   * races a deadline promise that rejects at `ms` regardless of whether `fn` ever settles — the
   * abandoned `fn` promise's eventual rejection (once its own abort listener fires) is caught and
   * normalized, but discarded by `Promise.race` if the deadline already won.
   */
  private async withTimeout<T>(ms: number, callSignal: AbortSignal, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const onCallAbort = () => controller.abort();
    if (callSignal.aborted) controller.abort();
    else callSignal.addEventListener("abort", onCallAbort);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_res, rej) => {
      timer = setTimeout(() => {
        controller.abort();
        rej(new SanitizerError("SANITIZER_UNAVAILABLE", `sanitizer call exceeded ${ms}ms`));
      }, ms);
    });
    try {
      return await Promise.race([
        fn(controller.signal).catch((e) => {
          if (controller.signal.aborted) {
            throw new SanitizerError("SANITIZER_UNAVAILABLE", "sanitizer call aborted or timed out");
          }
          throw e;
        }),
        deadline,
      ]);
    } finally {
      clearTimeout(timer);
      callSignal.removeEventListener("abort", onCallAbort);
    }
  }
}
