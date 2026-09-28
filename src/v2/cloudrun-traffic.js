// How a Cloud Run service's traffic is read, shared by the resolver (what is
// serving?) and the deploy's rollout wait (has our revision landed? what do we
// pin back to?). One reading, so the two can never disagree about which
// revision takes the traffic.

// Traffic that follows the service's latest ready revision, and traffic sent to
// one revision by name. The generated client decodes enums as their string
// names.
export const TRAFFIC_LATEST = 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST'
export const TRAFFIC_REVISION = 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION'

// A revision's full resource name. Traffic entries name a revision by its short
// id; latestReadyRevision and latestCreatedRevision are full resource names.
export const revisionPath = (service, revision) =>
  revision.includes('/') ? revision : `${service.name}/revisions/${revision}`

// The share of the service's traffic each revision takes, as Cloud Run resolved
// it (trafficStatuses), keyed by full resource name.
//
// The shares are added up, since two entries can name the same revision. An
// entry with no revision name stands for the latest ready revision only when it
// follows LATEST; otherwise it names nothing (the '' key).
export function trafficShares (service) {
  const shares = new Map()
  for (const status of service.trafficStatuses ?? []) {
    const name = status.revision || (status.type === TRAFFIC_LATEST ? service.latestReadyRevision : '')
    const key = name ? revisionPath(service, name) : ''
    shares.set(key, (shares.get(key) ?? 0) + (status.percent ?? 0))
  }
  return shares
}

// The full resource name of the revision that takes all of a service's
// traffic, null when no revision is serving yet, or 'split'.
//
// trafficStatuses is the traffic as Cloud Run resolved it, and it keeps
// describing the last serving revision when a rollout fails.
export function servingRevision (service) {
  if ((service.trafficStatuses ?? []).length > 0) {
    const all = [...trafficShares(service)].find(([, percent]) => percent === 100)
    if (!all) return 'split'
    return all[0] || null
  }

  // No resolved traffic. When traffic follows the latest ready revision (no
  // traffic block at all means the same), that revision is the one serving.
  // An empty latestReadyRevision means no revision has become ready yet.
  const followsLatest = (service.traffic ?? []).every(target => target.type === TRAFFIC_LATEST)
  const name = followsLatest ? service.latestReadyRevision : ''
  return name ? revisionPath(service, name) : null
}
