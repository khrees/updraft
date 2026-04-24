import { z } from 'zod';

export const createDeploymentSchema = z.object({
  git_url: z.string().url('git_url must be a valid URL').optional(),
  archive_ref: z.string().min(1).optional(),
}).refine(
  (d) => d.git_url !== undefined || d.archive_ref !== undefined,
  { message: 'Either git_url or archive_ref is required' },
);

export type CreateDeploymentBody = z.infer<typeof createDeploymentSchema>;
