// ECS deploys are not implemented in v2 pass 1. The router dispatches here for
// type=ecs; the interface is settled so a later pass fills this in without
// changing deploy's contract.
export async function deployEcs () {
  throw new Error('deploy: ecs support lands in a later v2 pass')
}
