/**
 * *** ONE BOOKING ATTEMPT AT A TIME, PER CONVERSATION. ***
 *
 * Lifted verbatim out of `VoiceBookingService`'s private `serialize()` so that
 * TWO booking services — the stable `/ai/voice/book` one and the balanced-V2
 * one — can share a single queue.
 *
 * That sharing is the point, and it is not cosmetic. The write gate in
 * `voiceBookingService.ts` decides whether a command may write by reading the
 * durable idempotency journal, and that decision is only meaningful if nothing
 * can slip past it while it is deciding. Both services read and write the SAME
 * journal (see `src/services/container.ts`), so two instances each holding
 * their own private queue would leave exactly the gap the queue exists to
 * close: a V1 request and a V2 request of the same call, arriving together,
 * both finding an empty journal, both passing the gate, both writing.
 *
 * The behaviour is unchanged for a service that does not pass one: the
 * constructor default is a fresh instance, so every existing direct
 * construction (and every existing test) keeps its own queue exactly as before.
 *
 * A plain promise chain rather than a lock object: there is nothing to forget to
 * release, and the queue drains itself. The tail deliberately swallows outcomes
 * so one failed attempt cannot poison the ones behind it — each caller keeps its
 * own result through `next`.
 *
 * Deliberately NOT persisted. It holds in-flight promises, which belong to this
 * process and mean nothing to another; a restart cancels the request anyway, and
 * the durable journal is what makes the retry safe.
 */
export class ConversationSerializer {
  private readonly chain = new Map<string, Promise<void>>();

  /** Runs `work` after every task already queued for this conversation. */
  run<T>(conversationId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chain.get(conversationId) ?? Promise.resolve();
    const next = previous.then(work);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.chain.set(conversationId, tail);
    void tail.then(() => {
      // Only the CURRENT tail may clear the slot. A later caller has already
      // replaced it, and deleting theirs would unserialize them.
      if (this.chain.get(conversationId) === tail) {
        this.chain.delete(conversationId);
      }
    });
    return next;
  }

  /** How many conversations currently have work queued. Tests only. */
  get pending(): number {
    return this.chain.size;
  }
}
