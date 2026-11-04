// One overall deadline for a series of requests. Each request gets what is
// left of it (at most `timeoutMs`), and a request started after it throws, so
// the series as a whole cannot outlast the deadline by more than a moment.
//
// The returned function's `expired()` says whether the deadline has passed,
// so a caller whose request was stopped can tell the overall deadline from
// the request's own limit.
//
// Its own module, with no imports, so an action that needs only this does
// not bundle the code of the action it came from.
export function deadlineRequests ({ deadlineMs, timeoutMs = 10000, now = Date.now }) {
  const end = now() + deadlineMs
  const request = () => {
    const left = end - now()
    if (left <= 0) throw new Error(`gave up after ${deadlineMs / 1000} seconds`)
    return { signal: AbortSignal.timeout(Math.min(timeoutMs, left)) }
  }
  request.expired = () => end - now() <= 0
  return request
}
