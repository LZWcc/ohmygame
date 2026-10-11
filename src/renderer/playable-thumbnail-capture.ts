export interface PendingPlayableThumbnail {
  nodeId: string;
  hash: string;
}

/**
 * Submits every capture immediately. The desktop owns the resource limit, and
 * each successful result is published without waiting for the rest of the batch.
 */
export async function capturePlayableThumbnails(
  pending: readonly PendingPlayableThumbnail[],
  capture: (candidate: PendingPlayableThumbnail) => Promise<boolean>,
  onCaptured: (candidate: PendingPlayableThumbnail) => Promise<void>,
): Promise<void> {
  await Promise.all(
    pending.map(async (candidate) => {
      const captured = await capture(candidate).catch(() => false);
      if (captured) await onCaptured(candidate);
    }),
  );
}
