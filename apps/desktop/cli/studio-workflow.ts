import { resolve } from "node:path";
import type { ApplicationContext } from "../application/context";
import type { StudioWorkflowOptions } from "./args";
import { createStudioService } from "./studio-service";

/** An invocation-scoped host envelope is never serialized into the authored graph or a reusable grant. */
export function withStudioWorkflowApplication(application: ApplicationContext, options: StudioWorkflowOptions): ApplicationContext {
  const selected = options.studio;
  if (selected === undefined) return application;
  const service = createStudioService({ application, selection: {
    threads: 1,
    ...(selected.python === undefined ? {} : { python: resolve(application.paths.repositoryRoot, selected.python) }),
    ...(selected.blender === undefined ? {} : { blender: resolve(application.paths.repositoryRoot, selected.blender) }),
  } });
  return { ...application, studioPort: service.port,
    ...(selected.allowTrustedCode ? { studioAuthorization: { authorize: async request => /^studio_[a-zA-Z0-9][a-zA-Z0-9_-]{0,120}$/u.test(request.jobId)
      && /^[a-f0-9]{64}$/u.test(request.planSha256) && /^[a-f0-9]{64}$/u.test(request.bundleSha256) } } : {}),
  };
}
