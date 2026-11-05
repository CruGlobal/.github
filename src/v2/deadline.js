// One overall deadline for a series of requests. Each request gets what is
// left of it (at most `timeoutMs`), and a request started after it throws, so
// the series as a whole cannot outlast the deadline by more than a moment.
//
// Calling the returned function gives a request's options, its signal alone,
// which is what the hotfix checks hand to octokit. `next()` on it gives the
// same signal and also `cutByDeadline`: whether that request's limit was cut
// to what was left of the deadline. A caller whose request was stopped uses it
// to tell the overall deadline from the request's own limit. It is decided
// when the signal is made, not by reading the clock after the stop, because
// the timer can fire a moment before the clock reaches the deadline.
//
// Its own module, with no imports, so an action that needs only this does
// not bundle the code of the action it came from.
export function deadlineRequests ({ deadlineMs, timeoutMs = 10000, now = Date.now }) {
  const end = now() + deadlineMs
  const next = () => {
    const left = end - now()
    if (left <= 0) throw new Error(`gave up after ${deadlineMs / 1000} seconds`)
    return { signal: AbortSignal.timeout(Math.min(timeoutMs, left)), cutByDeadline: left < timeoutMs }
  }
  const request = () => ({ signal: next().signal })
  request.next = next
  return request
}
