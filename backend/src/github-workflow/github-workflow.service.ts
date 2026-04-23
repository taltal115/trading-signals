import {
  BadGatewayException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class GithubWorkflowService {
  private readonly log = new Logger(GithubWorkflowService.name);

  constructor(private readonly config: ConfigService) {}

  async dispatch(workflowFile: string, inputs: Record<string, string>): Promise<void> {
    const token = this.config.get<string>('githubWorkflowToken')?.trim();
    if (!token) {
      throw new ServiceUnavailableException(
        'GitHub workflow dispatch is not configured. Set GITHUB_PERSONAL_TOKEN (or GITHUB_TOKEN) in the API .env.',
      );
    }
    const owner = this.config.get<string>('githubRepoOwner') || '';
    const repo = this.config.get<string>('githubRepoName') || '';
    if (!owner || !repo) {
      throw new ServiceUnavailableException(
        'Set GITHUB_REPO_OWNER and GITHUB_REPO_NAME in the API environment.',
      );
    }

    const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowFile}/dispatches`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        ref: 'main',
        inputs,
      }),
    });

    if (res.status === 401 || res.status === 403) {
      this.log.warn(`GitHub workflow dispatch auth failed: ${res.status} ${workflowFile}`);
      throw new ForbiddenException(
        'GitHub rejected the token (needs workflow scope and repo access).',
      );
    }
    if (!res.ok) {
      const text = await res.text();
      this.log.warn(`GitHub API ${res.status} for ${workflowFile}: ${text.slice(0, 300)}`);
      throw new BadGatewayException(
        `GitHub API error ${res.status}: ${text.slice(0, 200)}`,
      );
    }
  }
}
