import { z } from "zod";
import type { FetchImplementation } from "./service-health.js";

const responseSchema = z.object({
  repositories: z.array(z.object({
    fullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(255),
    url: z.string().url(),
    defaultBranch: z.string().min(1).max(255),
    private: z.boolean(),
  })).max(10_000),
});

export type GitHubRepositoryReader = () => Promise<z.infer<typeof responseSchema>["repositories"]>;

export function createGitHubRepositoryReader(options: {
  apiOrigin: string;
  serviceToken: string;
  timeoutMs: number;
  fetchImplementation?: FetchImplementation;
}): GitHubRepositoryReader {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  return async () => {
    const response = await fetchImplementation(
      new URL("/api/v1/integrations/internal/hub/github/repositories", options.apiOrigin),
      {
        headers: {
          accept: "application/json",
          "x-lh-hub-token": options.serviceToken,
        },
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs),
      },
    );
    if (!response.ok) throw new Error(`GitHub repositories returned ${response.status}`);
    return responseSchema.parse(await response.json()).repositories;
  };
}
