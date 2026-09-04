// TagNotFoundError: a tag lookup against a registry found no image carrying
// that tag. Both registries' tag resolvers throw it (Artifact Registry in
// gcp.js, ECR in aws.js) so a caller can tell "this tag does not exist" apart
// from every other failure. The no-change guard in build-candidate.yml depends
// on that distinction: an absent sha tag is its expected signal to build.
export class TagNotFoundError extends Error {
  constructor (tag, location) {
    super(`Tag "${tag}" not found in ${location}`)
    this.name = 'TagNotFoundError'
    this.tag = tag
    this.location = location
  }
}
