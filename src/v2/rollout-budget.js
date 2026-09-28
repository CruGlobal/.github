import * as core from '@actions/core'

// How long a deploy may wait for its rollout to land, across every service (or
// function) it updates.
//
// Why a deploy waits at all past a failed update: the platforms keep going
// after they give up on telling us. Cloud Run fails an update's operation when
// a new revision misses its readiness deadline, then keeps retrying the
// revision, which can become ready many minutes later and take the traffic.
// Lambda's waiter gives up on a slow update while Lambda finishes it anyway.
// If the step failed there, every later step would be skipped (the ledger row,
// the release event, Datadog, and on promote the release tag and GitHub
// Release) while the release went live anyway, with nothing recording it.
//
// Why ONE deadline per deploy rather than one per service: the services roll
// out one after another inside one job, and the job has one timeout. A stall
// on the first service leaves less time for the next, and that is the point.
//
// The clock starts at the first update, not when the step starts, so the
// migration that runs first (src/v2/deploy-cloudrun.js) does not eat into the
// wait. But the wait must also never run past STEP_CAP_MS after the step
// started, or a long migration followed by a stall would push the job into its
// timeout (60 minutes in every v2 deploy job), which kills the step before it
// can report anything or stop the rollout, and skips every later step. The cap
// sits ten minutes inside that timeout because the same 60 minutes also cover
// the steps before the deploy and every record step after it.
//
// Nothing in here knows about Cloud Run, so the ECS rollout wait can share it.
export const ROLLOUT_BUDGET_MS = 45 * 60 * 1000
export const STEP_CAP_MS = 50 * 60 * 1000

// How often the waits look, and how often they say they are still looking. A
// line a minute is enough to show a long wait is alive and not hung, without
// burying the log in a line every poll.
export const POLL_INTERVAL_MS = 15 * 1000
export const PROGRESS_INTERVAL_MS = 60 * 1000

// When this step started, as a wall-clock time. The deploy action runs in a
// process of its own (a node action), so the process's age is the step's age,
// and this holds however late the module happens to load.
const STEP_STARTED_AT = Date.now() - process.uptime() * 1000

const realSleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// One deploy's budget. `now`, `sleep` and `stepStartedAt` are there for tests,
// which drive a fake clock through a wait of many minutes in no time at all.
export function rolloutBudget ({
  now = Date.now,
  sleep = realSleep,
  stepStartedAt = STEP_STARTED_AT,
  budgetMs = ROLLOUT_BUDGET_MS,
  stepCapMs = STEP_CAP_MS
} = {}) {
  let startedAt = null
  let deadline = null
  const end = () => deadline ?? Math.min(now() + budgetMs, stepStartedAt + stepCapMs)

  return {
    now,
    sleep,

    // Start the clock. Call it right before the first update; later calls
    // change nothing, which is how the services share one deadline.
    start () {
      if (startedAt === null) {
        startedAt = now()
        deadline = end()
      }
    },

    // Time spent since the first update.
    elapsed () {
      return startedAt === null ? 0 : now() - startedAt
    },

    // Time left, keeping `reserveMs` back for whatever has to happen at the
    // bound (pinning traffic back, restoring an image). Never negative.
    remaining (reserveMs = 0) {
      return Math.max(0, end() - reserveMs - now())
    }
  }
}

// A logger that writes at most one line per interval: call it every poll and
// it keeps quiet in between. The first call always writes.
export function progressLogger (budget, intervalMs = PROGRESS_INTERVAL_MS) {
  let last = null
  return line => {
    const now = budget.now()
    if (last !== null && now - last < intervalMs) return
    last = now
    core.info(line)
  }
}

// 125000 -> "2m 5s", 45000 -> "45s".
export function formatDuration (ms) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
}
