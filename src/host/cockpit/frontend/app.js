(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  let token = sessionStorage.getItem('cockpit-token') || '';
  let selectedId = null;
  let selectionGeneration = 0;
  let selectionController = null;
  let timer = null;
  let chatNeedsBottom = true;
  let chatReadingTop = 0;

  const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };
  const line = (parent, tag, text, className) => {
    const node = document.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    parent.appendChild(node);
    return node;
  };
  const showError = (id, message) => { $(id).textContent = message || ''; };
  const isAbort = (err) => err && err.name === 'AbortError';
  const current = (id, generation) => selectedId === id && selectionGeneration === generation;

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        'authorization': `Bearer ${token}`,
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });
    if (response.status === 401) {
      token = '';
      sessionStorage.removeItem('cockpit-token');
      showLogin('token refused or absent');
      throw new Error('unauthorized');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `request failed (${response.status})`);
    return data;
  }

  function showLogin(message) {
    $('app').hidden = true;
    $('login').hidden = false;
    showError('login-error', message || '');
    if (timer) { clearInterval(timer); timer = null; }
  }

  function showApp() {
    $('login').hidden = true;
    $('app').hidden = false;
    if (!timer) timer = setInterval(refresh, 2500);
  }

  async function loadCatalog() {
    try {
      const data = await api('/api/catalog');
      const list = $('models');
      clear(list);
      for (const model of data.models || []) {
        const option = document.createElement('option');
        option.value = model.id;
        option.label = model.contextTokens !== undefined
          ? `${model.id} (${model.contextTokens}/${model.maxOutputTokens})` : model.id;
        list.appendChild(option);
      }
    } catch (err) {
      if (!isAbort(err)) showError('create-error', err.message);
    }
  }

  async function refresh() {
    if (!token) return;
    const id = selectedId;
    const generation = selectionGeneration;
    try {
      const data = await api('/api/runs');
      if (!current(id, generation) && id !== null) return;
      renderRuns(data.runs || [], data.active);
      if (id !== null && current(id, generation)) {
        await loadSelected(id, generation, selectionController?.signal);
      }
    } catch (err) {
      if (!isAbort(err) && current(id, generation)) showError('run-error', err.message);
    }
  }

  function renderRuns(runs, active) {
    const list = $('run-list');
    clear(list);
    if (runs.length === 0) {
      line(list, 'li', 'No runs yet.', 'muted');
      return;
    }
    for (const view of runs) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = view.run.label;
      button.className = view.run.id === selectedId ? 'selected' : '';
      button.addEventListener('click', () => { void selectRun(view.run.id); });
      item.appendChild(button);
      line(item, 'span', view.active || view.run.id === active ? ' active' : '', 'muted');
      list.appendChild(item);
    }
  }

  async function selectRun(id) {
    selectionGeneration += 1;
    selectedId = id;
    chatNeedsBottom = true;
    if (selectionController) selectionController.abort();
    selectionController = new AbortController();
    showError('run-error', '');
    await loadSelected(id, selectionGeneration, selectionController.signal);
  }

  async function loadSelected(id, generation, signal) {
    try {
      const data = await api(`/api/runs/${encodeURIComponent(id)}`, { signal });
      if (!current(id, generation)) return;
      const view = data.view;
      showError('run-error', '');
      $('selected').hidden = false;
      $('selected-label').textContent = view.run.label;
      const budget = view.budget
        ? `${view.budget.usedTokens}/${view.budget.limitTokens} ${view.budget.state}`
        : 'none configured';
      $('run-meta').textContent = [
        `host: ${view.host}`,
        `node tokens: ${budget}`,
        'agent zero/gateway: uncapped',
        `nodes: ${view.run.nodeCount}`,
        `spawn: ${view.run.spawn ? 'on' : 'off'}`,
        'last observed, not a liveness claim',
      ].join(' · ');
      renderActivity(view.nodes || [], id, generation);
      await Promise.all([
        loadChat(id, generation, signal),
        loadMailbox(id, generation, signal),
        loadTree(id, generation, signal),
      ]);
    } catch (err) {
      if (!isAbort(err) && current(id, generation)) showError('run-error', err.message);
    }
  }

  function renderActivity(nodes, id, generation) {
    if (!current(id, generation)) return;
    const pane = $('pane-activity');
    clear(pane);
    if (nodes.length === 0) { line(pane, 'p', 'No nodes observed.', 'muted'); return; }
    for (const node of nodes) {
      const row = document.createElement('div');
      row.className = 'entry';
      const when = node.lastObservedAt
        ? new Date(node.lastObservedAt).toLocaleString() : 'never observed';
      line(row, 'strong', node.uid);
      line(row, 'span', ` — ${node.lastActivity} — ${when}`, 'muted');
      if (node.error) line(row, 'span', ' (unreadable)', 'error');
      pane.appendChild(row);
    }
  }

  async function loadChat(id, generation, signal) {
    try {
      const data = await api(`/api/runs/${encodeURIComponent(id)}/chat`, { signal });
      if (!current(id, generation)) return;
      const pane = $('pane-chat');
      const content = $('chat');
      const visible = !pane.hidden;
      const nearBottom = visible
        && pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40;
      const readingTop = visible ? pane.scrollTop : null;
      clear(content);
      for (const record of data.records || []) {
        const row = document.createElement('div');
        row.className = 'entry';
        line(row, 'strong', record.uid);
        line(row, 'span', ` ${new Date(record.at).toLocaleString()}`, 'muted');
        line(row, 'p', record.text);
        content.appendChild(row);
      }
      if (data.degraded) line(content, 'p', `${data.degraded} damaged record(s) skipped`, 'error');
      if (visible) {
        if (nearBottom || chatNeedsBottom) {
          pane.scrollTop = pane.scrollHeight;
          chatNeedsBottom = false;
        } else if (readingTop !== null) {
          pane.scrollTop = readingTop;
        }
      }
    } catch (err) {
      if (!isAbort(err) && current(id, generation)) showError('run-error', err.message);
    }
  }

  async function loadMailbox(id, generation, signal) {
    try {
      const data = await api(`/api/runs/${encodeURIComponent(id)}/mailbox`, { signal });
      if (!current(id, generation)) return;
      const pane = $('pane-mailbox');
      clear(pane);
      for (const record of data.records || []) {
        const row = document.createElement('div');
        row.className = 'entry';
        line(row, 'strong', `${record.from} → ${record.to}`);
        line(row, 'span', ` ${new Date(record.at).toLocaleString()}`, 'muted');
        line(row, 'p', record.text);
        pane.appendChild(row);
      }
    } catch (err) {
      if (!isAbort(err) && current(id, generation)) showError('run-error', err.message);
    }
  }

  async function loadTree(id, generation, signal) {
    try {
      const data = await api(`/api/runs/${encodeURIComponent(id)}/tree`, { signal });
      if (!current(id, generation)) return;
      const pane = $('pane-tree');
      clear(pane);
      if (data.error) { line(pane, 'p', data.error, 'error'); return; }
      for (const entry of data.entries || []) {
        const row = document.createElement('div');
        row.className = `tree ${entry.type}`;
        const size = entry.size !== undefined ? ` · ${entry.size} bytes` : '';
        row.textContent = `${entry.path} · ${entry.type}${size}`;
        pane.appendChild(row);
      }
      if (data.truncated) line(pane, 'p', 'listing truncated', 'muted');
    } catch (err) {
      if (!isAbort(err) && current(id, generation)) showError('run-error', err.message);
    }
  }

  function showTab(name) {
    const pane = $('pane-chat');
    if (name !== 'chat' && !pane.hidden) {
      chatReadingTop = pane.scrollTop;
      if (pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40) chatNeedsBottom = true;
    }
    for (const tab of ['activity', 'chat', 'mailbox', 'tree']) {
      $(`pane-${tab}`).hidden = tab !== name;
      $(`tab-${tab}`).classList.toggle('selected', tab === name);
    }
    if (name === 'chat') {
      requestAnimationFrame(() => {
        if (pane.hidden) return;
        if (chatNeedsBottom) {
          pane.scrollTop = pane.scrollHeight;
          chatNeedsBottom = false;
        } else {
          pane.scrollTop = chatReadingTop;
        }
      });
    }
  }

  $('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    token = $('token').value.trim();
    if (!token) return showLogin('a token is required');
    try {
      await api('/api/runs');
      sessionStorage.setItem('cockpit-token', token);
      $('token').value = '';
      showApp();
      await loadCatalog();
      await refresh();
    } catch (err) {
      showLogin(err.message === 'unauthorized' ? 'token refused' : err.message);
    }
  });

  $('create-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    showError('create-error', '');
    try {
      const created = await api('/api/runs', {
        method: 'POST',
        body: JSON.stringify({
          label: $('label').value,
          heading: $('heading').value,
          nodeModel: $('node-model').value,
          gatewayModel: $('gateway-model').value,
          nodeCount: Number($('node-count').value),
          nodeLimit: Number($('node-limit').value),
          spawn: $('spawn').checked,
        }),
      });
      $('create-form').reset();
      await selectRun(created.run.id);
      await refresh();
    } catch (err) {
      showError('create-error', err.message);
    }
  });

  $('chat-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = selectedId;
    const generation = selectionGeneration;
    if (!id) return;
    const text = $('chat-text').value;
    if (!text.trim()) return;
    try {
      await api(`/api/runs/${encodeURIComponent(id)}/chat`, {
        method: 'POST', body: JSON.stringify({ text }),
      });
      if (!current(id, generation)) return;
      showError('run-error', '');
      $('chat-text').value = '';
      await loadChat(id, generation, selectionController?.signal);
      const pane = $('pane-chat');
      if (pane.hidden) {
        chatNeedsBottom = true;
      } else {
        pane.scrollTop = pane.scrollHeight;
        chatNeedsBottom = false;
      }
    } catch (err) {
      if (!isAbort(err) && current(id, generation)) showError('run-error', err.message);
    }
  });

  $('observe').addEventListener('click', async () => {
    const id = selectedId;
    if (!id) return;
    showError('run-error', '');
    try {
      await api(`/api/runs/${encodeURIComponent(id)}/observe`, { method: 'POST' });
      if (!current(id, selectionGeneration)) return;
      await refresh();
    } catch (err) { if (!isAbort(err) && current(id, selectionGeneration)) showError('run-error', err.message); }
  });

  $('pause').addEventListener('click', async () => {
    const id = selectedId;
    if (!id) return;
    showError('run-error', '');
    try {
      await api(`/api/runs/${encodeURIComponent(id)}/pause`, { method: 'POST' });
      if (!current(id, selectionGeneration)) return;
      await refresh();
    } catch (err) { if (!isAbort(err) && current(id, selectionGeneration)) showError('run-error', err.message); }
  });

  for (const tab of ['activity', 'chat', 'mailbox', 'tree']) {
    $(`tab-${tab}`).addEventListener('click', () => showTab(tab));
  }
  $('refresh').addEventListener('click', () => { void refresh(); });

  if (token) {
    showApp();
    void loadCatalog();
    void refresh();
  } else {
    showLogin();
  }
})();
