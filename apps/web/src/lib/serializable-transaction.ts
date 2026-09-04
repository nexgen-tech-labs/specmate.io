import { Prisma } from '@prisma/client';

// Postgres can abort a Serializable transaction with a serialization failure
// (surfaced by Prisma as P2034) when it detects a conflict with a concurrent
// transaction, even if that conflict wouldn't actually violate correctness —
// this is expected under this isolation level and the documented way to
// handle it is to retry. It can abort a retried transaction too under
// contention (Issue #114), so this retries a bounded number of times rather
// than giving up after one attempt.
function isSerializationFailure(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034';
}

const MAX_SERIALIZABLE_ATTEMPTS = 3;

export async function withSerializableRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= MAX_SERIALIZABLE_ATTEMPTS; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (!isSerializationFailure(err) || attempt === MAX_SERIALIZABLE_ATTEMPTS) throw err;
    }
  }
  throw new Error('unreachable');
}
