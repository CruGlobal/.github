// Lambda deploys are not implemented in v2 pass 1. The router dispatches here
// for type=lambda; the interface is settled so a later pass fills this in
// without changing deploy's contract.
export async function deployLambda () {
  throw new Error('deploy: lambda support lands in a later v2 pass')
}
