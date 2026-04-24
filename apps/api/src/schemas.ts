import { z } from 'zod';

export const createDeploymentSchema = z.object({
  gitUrl: z.string().url('gitUrl must be a valid URL').optional(),
  archiveRef: z.string().min(1).optional(),
}).refine(
  (d) => d.gitUrl !== undefined || d.archiveRef !== undefined,
  { message: 'Either gitUrl or archiveRef is required' },
);

export type CreateDeploymentBody = z.infer<typeof createDeploymentSchema>;
