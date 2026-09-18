const API_BASE = (window as any).__TAURI__ ? '' : window.location.origin;

async function request(path: string, opts: RequestInit = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('auth-required'));
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `HTTP ${res.status}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  health: () => request('/api/health'),
  session: () => request('/api/session'),
  providers: () => request('/api/llm/providers'),
  models: () => request('/api/llm/models'),
  limits: () => request('/api/llm/limits'),
  chat: (body: any) => request('/api/llm/chat', { method: 'POST', body: JSON.stringify(body) }),
  skills: () => request('/api/skills'),
  websearch: (q: string) => request(`/api/llm/websearch?q=${encodeURIComponent(q)}`),
  fetch: (url: string) => request(`/api/llm/fetch?url=${encodeURIComponent(url)}`),

  buildSessions: () => request('/api/build/sessions'),
  buildRun: (body: any) => request('/api/build/sessions', { method: 'POST', body: JSON.stringify(body) }),
  buildStatus: (id: string) => request(`/api/build/sessions/${id}`),

  designTemplates: () => request('/api/design/templates'),
  designProjects: () => request('/api/design/projects'),
  designCreateProject: (body: any) => request('/api/design/projects', { method: 'POST', body: JSON.stringify(body) }),
  designGetProject: (id: string) => request(`/api/design/projects/${id}`),
  designUpdateProject: (id: string, body: any) => request(`/api/design/projects/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  designDeleteProject: (id: string) => request(`/api/design/projects/${id}`, { method: 'DELETE' }),
  designGenerate: (body: any) => request('/api/design/generate', { method: 'POST', body: JSON.stringify(body) }),
  designExport: (body: any) => request('/api/design/export', { method: 'POST', body: JSON.stringify(body) }),
  designBrand: () => request('/api/design/brand'),
  designSaveBrand: (body: any) => request('/api/design/brand', { method: 'POST', body: JSON.stringify(body) }),

  githubRepos: () => request('/api/github/repos'),
  workspaceFiles: () => request('/api/workspace/files'),
  workspaceRun: (body: any) => request('/api/workspace/run', { method: 'POST', body: JSON.stringify(body) }),

  imageProviders: () => request('/api/llm/images/providers'),
  imageGenerate: (body: any) => request('/api/llm/images/generations', { method: 'POST', body: JSON.stringify(body) }),
};
