// The file esbuild bundles for this action. It always calls run(). Nothing in
// the environment can turn it off, so the action's production checks cannot
// be skipped. The module below does nothing on import, so tests load it
// directly.
import { run } from '../deploy.js'

run()
