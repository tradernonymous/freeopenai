const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createRequestHandler } = require('../server.js');

async function startApp() {
  const app = http.createServer(createRequestHandler(__dirname + '/..'));
  await new Promise((r) => app.listen(0, r));
  return app;
}

function get(app, path) {
  return fetch(`http://127.0.0.1:${app.address().port}${path}`);
}

function postJson(app, path, body) {
  return fetch(`http://127.0.0.1:${app.address().port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function putJson(app, path, body) {
  return fetch(`http://127.0.0.1:${app.address().port}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function del(app, path) {
  return fetch(`http://127.0.0.1:${app.address().port}${path}`, { method: 'DELETE' });
}

test('design templates returns the template list', async () => {
  const app = await startApp();
  try {
    const res = await get(app, '/api/design/templates');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
    assert.ok(data.length > 0);
    assert.ok(data.some((t) => t.id === 'social-post'));
  } finally {
    app.close();
  }
});

test('design project create/list/get/delete round trip', async () => {
  const app = await startApp();
  try {
    const createRes = await postJson(app, '/api/design/projects', { name: 'Test project', template: 'social-post', prompt: 'hello' });
    assert.equal(createRes.status, 200);
    const created = await createRes.json();
    assert.ok(created.id);
    assert.equal(created.name, 'Test project');

    const listRes = await get(app, '/api/design/projects');
    assert.equal(listRes.status, 200);
    const list = await listRes.json();
    assert.ok(list.some((p) => p.id === created.id));

    const getRes = await get(app, '/api/design/projects/' + created.id);
    assert.equal(getRes.status, 200);
    const fetched = await getRes.json();
    assert.equal(fetched.id, created.id);

    const updateRes = await putJson(app, '/api/design/projects/' + created.id, { name: 'Renamed', canvas: { foo: 1 } });
    assert.equal(updateRes.status, 200);
    const updated = await updateRes.json();
    assert.equal(updated.name, 'Renamed');
    assert.deepEqual(updated.canvas, { foo: 1 });

    const deleteRes = await fetch(`http://127.0.0.1:${app.address().port}/api/design/projects/${created.id}`, { method: 'DELETE' });
    assert.equal(deleteRes.status, 200);
    const afterDelete = await get(app, '/api/design/projects/' + created.id);
    assert.equal(afterDelete.status, 404);
  } finally {
    app.close();
  }
});

test('design generate returns queued status', async () => {
  const app = await startApp();
  try {
    const createRes = await postJson(app, '/api/design/projects', { name: 'Gen project', template: 'deck', prompt: 'make slides' });
    const created = await createRes.json();
    const res = await postJson(app, '/api/design/generate', { projectId: created.id, prompt: 'make slides about coffee' });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'queued');
    assert.equal(data.projectId, created.id);
  } finally {
    app.close();
  }
});

test('design export returns an export record for supported formats', async () => {
  const app = await startApp();
  try {
    const createRes = await postJson(app, '/api/design/projects', { name: 'Export project', template: 'infographic' });
    const created = await createRes.json();
    const formats = ['html', 'pdf', 'png', 'svg'];
    for (const format of formats) {
      const res = await postJson(app, '/api/design/export', { projectId: created.id, format });
      assert.equal(res.status, 200, format);
      const data = await res.json();
      assert.equal(data.format, format);
      assert.equal(data.projectId, created.id);
    }
  } finally {
    app.close();
  }
});

test('design brand profile save/load round trip', async () => {
  const app = await startApp();
  try {
    const createRes = await postJson(app, '/api/design/projects', { name: 'Brand project' });
    const created = await createRes.json();
    const saveRes = await postJson(app, '/api/design/brand', {
      projectId: created.id,
      key: 'brand-1',
      palette: ['#111111', '#eeeeee'],
      fontStack: 'Inter, sans-serif',
      semanticRoles: { primary: '#111111' },
      source: 'manual',
    });
    assert.equal(saveRes.status, 200);
    const saved = await saveRes.json();
    assert.equal(saved.key, 'brand-1');

    const loadRes = await get(app, '/api/design/brand?key=brand-1');
    assert.equal(loadRes.status, 200);
    const loaded = await loadRes.json();
    assert.deepEqual(loaded.palette, ['#111111', '#eeeeee']);
  } finally {
    app.close();
  }
});
