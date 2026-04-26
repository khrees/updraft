import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Deployment } from '@updraft/shared-types';
import { createDeployment, listDeployments } from '../lib/api';
import { LogViewer } from '../components/log-viewer';

type SourceMode = 'git' | 'upload';

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}

export function AppPage() {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<SourceMode>('git');
  const [gitUrl, setGitUrl] = useState('');
  const [archive, setArchive] = useState<File | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [selectedDeployment, setSelectedDeployment] = useState<Deployment | null>(null);

  const deploymentsQuery = useQuery({
    queryKey: ['deployments'],
    queryFn: listDeployments,
    refetchInterval: 3000,
  });

  const createMutation = useMutation({
    mutationFn: createDeployment,
    onSuccess: async () => {
      setGitUrl('');
      setArchive(null);
      setFormError(null);
      await queryClient.invalidateQueries({ queryKey: ['deployments'] });
    },
  });

  const submitLabel = useMemo(() => {
    if (createMutation.isPending) {
      return mode === 'git' ? 'Queueing repo...' : 'Uploading...';
    }
    return 'Deploy';
  }, [createMutation.isPending, mode]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);

    if (mode === 'git') {
      if (!gitUrl.trim()) {
        setFormError('Enter a git URL');
        return;
      }
      await createMutation.mutateAsync({ mode: 'git', gitUrl: gitUrl.trim() }).catch((error: unknown) => {
        setFormError(error instanceof Error ? error.message : 'Failed to deploy');
      });
      return;
    }

    if (!archive) {
      setFormError('Select a file to upload');
      return;
    }

    await createMutation.mutateAsync({ mode: 'upload', archive }).catch((error: unknown) => {
      setFormError(error instanceof Error ? error.message : 'Failed to deploy');
    });
  };

  return (
    <main className="page-shell">
      <header className="page-header">
        <div className="brand">
          <div className="brand-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
            </svg>
          </div>
          <span className="brand-name">Updraft</span>
        </div>
      </header>

      <section className="hero">
        <h1>Deploy your project</h1>
        <p>Connect a Git repository or upload a build archive to deploy instantly.</p>
      </section>

      <section className="main-grid">
        <section className="panel">
          <div className="panel-header">
            <h2>New Deployment</h2>
            <p>Start from a git URL or upload an archive.</p>
          </div>

          <form className="deployment-form" onSubmit={handleSubmit}>
            <div className="mode-toggle" role="tablist">
              <button
                type="button"
                className={mode === 'git' ? 'toggle-button active' : 'toggle-button'}
                onClick={() => setMode('git')}
              >
                Git
              </button>
              <button
                type="button"
                className={mode === 'upload' ? 'toggle-button active' : 'toggle-button'}
                onClick={() => setMode('upload')}
              >
                Upload
              </button>
            </div>

            {mode === 'git' ? (
              <label className="field">
                <label>Repository URL</label>
                <input
                  type="url"
                  placeholder="https://github.com/owner/repo"
                  value={gitUrl}
                  onChange={(event) => setGitUrl(event.target.value)}
                />
              </label>
            ) : (
              <label className="field">
                <label>Project archive</label>
                <div className="file-input-wrapper">
                  <div className="file-input-label">
                    <span>{archive ? archive.name : 'Drop a file or click to browse'}</span>
                  </div>
                  <input
                    type="file"
                    accept=".tar,.tar.gz,.tgz,.zip"
                    onChange={(event) => setArchive(event.target.files?.[0] ?? null)}
                  />
                </div>
              </label>
            )}

            {(formError || createMutation.error) ? (
              <p className="form-message error">{formError ?? createMutation.error?.message}</p>
            ) : null}

            {createMutation.isSuccess ? (
              <p className="form-message success">Deployment queued</p>
            ) : null}

            <button type="submit" className="submit-button" disabled={createMutation.isPending}>
              {submitLabel}
            </button>
          </form>
        </section>

        <section className="panel">
          <div className="deployments-header">
            <h2>Recent Deployments</h2>
          </div>

          {deploymentsQuery.isLoading ? <p className="empty-state">Loading...</p> : null}
          {deploymentsQuery.isError ? <p className="empty-state">{deploymentsQuery.error.message}</p> : null}

          {!deploymentsQuery.isLoading && !deploymentsQuery.isError ? (
            deploymentsQuery.data && deploymentsQuery.data.length > 0 ? (
              <ul className="deployment-list">
                {deploymentsQuery.data.map((deployment) => (
                  <li
                    key={deployment.id}
                    className={`deployment-row${selectedDeployment?.id === deployment.id ? ' deployment-row--selected' : ''}`}
                    onClick={() => setSelectedDeployment(deployment)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === 'Enter' && setSelectedDeployment(deployment)}
                  >
                    <div className="deployment-info">
                      <p className="deployment-id">{deployment.id}</p>
                      <p className="deployment-source">{deployment.source_ref}</p>
                      {deployment.live_url ? (
                        <a className="deployment-url" href={deployment.live_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                          {deployment.live_url}
                        </a>
                      ) : null}
                    </div>
                    <div className="deployment-meta">
                      <span className={`status-pill status-${deployment.status}`}>{deployment.status}</span>
                      {deployment.image_tag ? <span className="image-tag">{deployment.image_tag}</span> : null}
                      <span className="deployment-time">{formatDate(deployment.created_at)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty-state">No deployments yet</p>
            )
          ) : null}
        </section>
      </section>

      {selectedDeployment ? (
        <LogViewer deployment={selectedDeployment} onClose={() => setSelectedDeployment(null)} />
      ) : null}
    </main>
  );
}
