import { z } from 'zod';

function isValidGitUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const validProtocols = ['https:', 'http:'];
    if (!validProtocols.includes(parsed.protocol)) {
      return false;
    }
    if (parsed.host === 'localhost' || parsed.host === '127.0.0.1') {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export const createDeploymentSchema = z.object({
  git_url: z.string().url('git_url must be a valid URL').refine(isValidGitUrl, {
    message: 'git_url must be a valid HTTPS/HTTP URL pointing to a remote repository',
  }).optional(),
}).refine(
  (d) => d.git_url !== undefined,
  { message: 'git_url is required for JSON requests; use multipart/form-data for uploads' },
);

export type CreateDeploymentBody = z.infer<typeof createDeploymentSchema>;

export const redeployDeploymentSchema = z.object({
  image_tag: z.string().trim().min(1, 'image_tag is required'),
});

export type RedeployDeploymentBody = z.infer<typeof redeployDeploymentSchema>;
