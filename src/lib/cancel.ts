// The current tool call's cancellation signal. The SDK aborts it when the
// client cancels the call (notifications/cancelled) or disconnects, and sends
// no response after that, so all that's left is to stop spending AniList's
// rate budget on it. tools/register.ts runs every call inside it, and
// lib/graphql.ts reads it, so no domain function has to pass a signal along.
import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as sleepFor } from "node:timers/promises";
import { ApiError } from "./errors.ts";

/** The current tool call: its cancellation signal, and whether a mutation
 *  succeeded during it (so a failure after that can say the write applied). */
export interface CallContext {
  signal: AbortSignal;
  wrote: boolean;
}

export const callContext = new AsyncLocalStorage<CallContext>();

/** `inFlight`: whether the request had already been sent, when the caller
 *  knows (undefined: a waiter on a shared read, which doesn't); for a write
 *  (`write`) that was in flight, it may then have landed. */
export function cancelledError(cause?: unknown, inFlight?: boolean, write = false): ApiError {
  return new ApiError({
    code: "cancelled",
    message:
      inFlight === undefined
        ? "Request cancelled by the caller"
        : inFlight
          ? "Request cancelled by the caller while in flight"
          : "Request cancelled by the caller before it was sent",
    writeMayHaveApplied: inFlight === true && write,
    cause,
  });
}

/** Waits `ms`; rejects as cancelled as soon as `signal` aborts (the timer is
 *  cleared, not left running). */
export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await sleepFor(ms, undefined, { signal });
  } catch (err) {
    if (signal?.aborted) throw cancelledError(err, false);
    throw err;
  }
}

/** Settles with `promise`, or rejects as cancelled as soon as `signal` aborts.
 *  It stops only this caller's wait, not `promise`'s work: for work other
 *  callers share (a deduplicated read), stopping it would cancel it for them. */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(cancelledError());
  const { promise: aborted, reject } = Promise.withResolvers<never>();
  const onAbort = () => reject(cancelledError());
  signal.addEventListener("abort", onAbort, { once: true });
  return Promise.race([promise, aborted]).finally(() =>
    signal.removeEventListener("abort", onAbort),
  );
}
