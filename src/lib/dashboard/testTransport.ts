/**
 * A controllable stand-in for the query transport, for tests.
 *
 * Lives in `src/lib` rather than beside the test because the runner's contract
 * is the transport interface, and a fake that drifts from real `fetch` makes
 * the cancellation tests prove nothing.
 *
 * Its abort behaviour was verified against real `fetch` on the four properties
 * the runner depends on, and matches on all of them:
 *
 *   - abort mid-flight                 -> rejects AbortError
 *   - signal already aborted           -> rejects without running
 *   - abort after the promise resolved -> no-op
 *   - abort(customReason)              -> that reason propagates verbatim
 *
 * That last one is why the runner must decide "was this cancelled?" from
 * `signal.aborted` rather than the error's name: `abort()` defaults to a
 * `DOMException` named AbortError, but `abort(new Error('superseded'))` arrives
 * as an ordinary Error and would otherwise be painted as a query failure.
 */

import type { QueryResult } from '../arcClient';
import type { QueryTransport, TransportRequest } from './queryRunner';

export interface TransportCall extends TransportRequest {
  /** Resolution order, so tests can assert which request won a race. */
  seq: number;
}

export interface FakeTransport {
  transport: QueryTransport;
  /** Every call, in order, including ones later aborted. */
  calls: TransportCall[];
  /** Highest number of simultaneously-unsettled calls. */
  peakConcurrent: number;
  /** Resolve the call at `index` with a result. */
  resolve(index: number, result?: Partial<QueryResult>): void;
  /** Reject the call at `index`. */
  reject(index: number, err: Error): void;
  /** Resolve every currently-pending call. */
  resolveAll(result?: Partial<QueryResult>): void;
  /** Pending (unsettled, unaborted) call count. */
  pending(): number;
}

const defaultResult = (over: Partial<QueryResult> = {}): QueryResult => ({
  columns: ['time', 'value'],
  rows: [['2026-01-01T00:00:00Z', 1]],
  rowCount: 1,
  ...over,
});

/**
 * @param autoResolveMs when set, every call settles on its own after this many
 * milliseconds; otherwise tests drive settlement explicitly.
 */
export function createFakeTransport(autoResolveMs?: number): FakeTransport {
  const calls: TransportCall[] = [];
  /** One settler per call. `settled` is the guard that keeps `live` honest. */
  const settlers: Array<{
    settle: (fn: () => void) => void;
    resolve: (r: QueryResult) => void;
    reject: (e: unknown) => void;
    settled: boolean;
  }> = [];
  let live = 0;
  let seq = 0;

  const fake: FakeTransport = {
    calls,
    peakConcurrent: 0,
    transport(req: TransportRequest): Promise<QueryResult> {
      const index = calls.length;
      calls.push({ ...req, seq: seq++ });

      return new Promise<QueryResult>((resolve, reject) => {
        const entry = {
          settled: false,
          settle(fn: () => void) {
            if (entry.settled) return;
            entry.settled = true;
            live--;
            fn();
          },
          resolve: (r: QueryResult) => entry.settle(() => resolve(r)),
          reject: (e: unknown) => entry.settle(() => reject(e)),
        };
        settlers[index] = entry;

        // Matches fetch: an already-aborted signal never runs the request, and
        // must not be counted as live.
        if (req.signal?.aborted) {
          entry.settled = true;
          reject(req.signal.reason ?? abortError());
          return;
        }

        live++;
        if (live > fake.peakConcurrent) fake.peakConcurrent = live;

        req.signal?.addEventListener('abort', () => entry.reject(req.signal!.reason ?? abortError()), {
          once: true,
        });

        if (autoResolveMs !== undefined) {
          setTimeout(() => entry.resolve(defaultResult()), autoResolveMs);
        }
      });
    },
    resolve(index, result) {
      settlers[index]?.resolve(defaultResult(result));
    },
    reject(index, err) {
      settlers[index]?.reject(err);
    },
    resolveAll(result) {
      for (const s of settlers) if (s && !s.settled) s.resolve(defaultResult(result));
    },
    pending() {
      return live;
    },
  };

  return fake;
}

function abortError(): Error {
  // Node and browsers both produce this shape from a bare abort().
  return typeof DOMException !== 'undefined'
    ? new DOMException('This operation was aborted', 'AbortError')
    : Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
}
