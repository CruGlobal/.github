// Pipeline v2 environment model.
//
// v2 introduces user-facing "long names" for the three promotion stages and
// maps them onto the existing runtime-infra nicknames used by v1 (per-app,
// per-env GCP projects / ECS clusters are unchanged from v1):
//
//   long name           nickname   meaning
//   ------------------  ---------  --------------------------------------------
//   production          prod       the live production environment
//   release-candidate   stage      the pre-prod candidate environment
//   preview             lab        ephemeral / preview environment
//
// The nickname is what existing v1 infra naming keys off of (secret paths,
// role suffixes, cluster names, etc.), so v2 actions resolve the long name to
// a nickname before touching any v1-shaped resource.
export const V2_ENVIRONMENTS = Object.freeze({
  production: 'prod',
  'release-candidate': 'stage',
  preview: 'lab'
})

// Resolve a v2 long environment name to its runtime nickname. Throws on an
// unknown name so a typo fails fast instead of silently targeting nothing.
export function environmentNickname (environment) {
  const nickname = V2_ENVIRONMENTS[environment]
  if (!nickname) {
    throw new Error(
      `Unknown v2 environment "${environment}". Expected one of: ${Object.keys(V2_ENVIRONMENTS).join(', ')}`
    )
  }
  return nickname
}

// v2 long name -> the LEGACY long environment name that existing infra (and the
// v1 info service) keys off. ECS service / task-definition names were created by
// v1 infra using these legacy names, so ECS resolution matches against both the
// legacy long name and the nickname. This is the same translation the app-info
// lookup in the workflows performs inline (release-candidate -> staging).
//
//   v2 long name         legacy long name
//   ------------------   ----------------
//   production           production
//   release-candidate    staging
//   preview              lab
export const V2_LEGACY_ENVIRONMENTS = Object.freeze({
  production: 'production',
  'release-candidate': 'staging',
  preview: 'lab'
})

// Resolve a v2 long environment name to its legacy long name. Throws on an
// unknown name, matching environmentNickname's fail-fast behavior.
export function legacyEnvironment (environment) {
  const legacy = V2_LEGACY_ENVIRONMENTS[environment]
  if (!legacy) {
    throw new Error(
      `Unknown v2 environment "${environment}". Expected one of: ${Object.keys(V2_LEGACY_ENVIRONMENTS).join(', ')}`
    )
  }
  return legacy
}
