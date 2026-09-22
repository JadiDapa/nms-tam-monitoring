/**
 * The four honest outcomes of trying to obtain a metric. There is deliberately no "estimated" or "default" outcome.
 *
 *  ok            a real value was measured
 *  unavailable   could not be collected right now (timeout, host unreachable, agent not answering)
 *  error         the attempt failed in an unexpected way (auth failure, malformed response, tool error)
 *  not_supported the device answered but does not implement what we asked for
 */
export type CollectStatus = 'ok' | 'unavailable' | 'error' | 'not_supported';

export interface Reading {
  status: CollectStatus;
  value: number | null;
  error: string | null;
}

export const okReading = (value: number): Reading => ({ status: 'ok', value, error: null });
export const unavailableReading = (error: string): Reading => ({ status: 'unavailable', value: null, error });
export const errorReading = (error: string): Reading => ({ status: 'error', value: null, error });
export const notSupportedReading = (error: string): Reading => ({ status: 'not_supported', value: null, error });
