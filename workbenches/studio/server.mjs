// The studio registered as its own project: no export artifact. Studio
// versions are git tags on the studio repo; "build" explains that instead of
// pretending.
import { HttpError } from '../../server/lib/paths.mjs';

export async function build() {
  throw new HttpError(400, 'no_artifact', 'The studio has no export artifact. Studio versions are git tags (studio/vX.Y.Z) on the studio repository; use Keep version to record one.');
}

export default { kind: 'studio', build };
