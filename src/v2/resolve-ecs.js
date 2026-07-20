// ECS image resolution is not implemented in v2 pass 1. The router dispatches
// here for type=ecs; the interface is settled so a later pass fills this in
// without changing resolve-image's contract.
export async function resolveEcs () {
  throw new Error('resolve-image: ecs support lands in a later v2 pass')
}
