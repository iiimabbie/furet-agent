import { logger } from "../logger.js";

/**
 * Search indexes are rebuildable projections. A projection failure must never make a
 * successful canonical file write look like it failed and trigger duplicate retries.
 */
export function updateSearchProjection(label: string, operation: () => void): string | null {
  try {
    operation();
    return null;
  } catch (error) {
    const message = (error as Error).message;
    logger.error({ label, err: message }, "canonical source saved but search projection update failed");
    return message;
  }
}

export function withProjectionNotice(success: string, projectionError: string | null): string {
  return projectionError ? `${success} Search reindex pending: ${projectionError}` : success;
}
