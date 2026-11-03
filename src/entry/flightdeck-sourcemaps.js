// The file esbuild bundles for this action. It always calls run(), which never
// rejects. The module below does nothing on import, so tests load it directly.
import { run } from '../flightdeck-sourcemaps.js'

run()
