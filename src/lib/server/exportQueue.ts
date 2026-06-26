/**
 * Serial export queue — ensures only one storage export runs at a time.
 * Additional requests wait in a FIFO queue. If the queue is full, new
 * requests are rejected immediately.
 */

const MAX_QUEUE_SIZE = 5;

type QueueEntry = {
  resolve: () => void;
  reject: (err: Error) => void;
};

let running = false;
const queue: QueueEntry[] = [];

/**
 * Acquire the export lock. Resolves when it's this caller's turn.
 * Rejects if the queue is full.
 */
export function acquireExportLock(): Promise<void> {
  if (!running && queue.length === 0) {
    running = true;
    return Promise.resolve();
  }

  if (queue.length >= MAX_QUEUE_SIZE) {
    return Promise.reject(new Error('Export queue is full. Please try again later.'));
  }

  return new Promise<void>((resolve, reject) => {
    queue.push({ resolve, reject });
  });
}

/**
 * Release the export lock so the next queued export can proceed.
 */
export function releaseExportLock(): void {
  const next = queue.shift();
  if (next) {
    next.resolve();
  } else {
    running = false;
  }
}
