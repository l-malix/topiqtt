(function () {
  'use strict';

  const SERIES_COLORS = [
    { id: 'blue', hex: '#2563EB', name: 'Bleu' },
    { id: 'green', hex: '#16A34A', name: 'Vert' },
    { id: 'amber', hex: '#D97706', name: 'Ambre' },
    { id: 'red', hex: '#DC2626', name: 'Rouge' },
    { id: 'violet', hex: '#7C3AED', name: 'Violet' },
    { id: 'cyan', hex: '#0891B2', name: 'Cyan' }
  ];

  const state = {
    viewMode: 'explorer',
    status: { state: 'disconnected', brokerId: '', brokerName: 'TopiQTT', message: '', paused: false },
    topics: {},
    persisted: { activeBrokerId: '', profiles: [], pinnedByBroker: {}, dashboardsByBroker: {}, activeDashByBroker: {}, prefs: {} },
    flashed: new Set(),
    selectionType: 'topic',
    selectedPath: '',
    expandedFolders: new Set(),
    didAutoExpand: false,
    allExpanded: false,
    searchQuery: '',
    activeTab: 'readable',
    publishOpen: false,
    publishMode: 'json',
    publishHeight: 230,
    sidebarWidth: 380,
    pendingConfirm: null,
    editingProfile: null,
    chartBuilder: { editingChartId: null, series: [] },
    ndMode: 'create'
  };

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatNumber(num) {
    return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 }).format(num);
  }

  function formatTime(ts) {
    return new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(ts));
  }

  function formatRelativeAge(ts) {
    if (!ts) return '';
    const diffSec = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (diffSec < 2) return 'À l’instant';
    if (diffSec < 60) return `Il y a ${diffSec} s`;
    return `Il y a ${Math.floor(diffSec / 60)} min`;
  }

  function showToast(msg) {
    const el = document.getElementById('toast');
    document.getElementById('toast-msg').textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.classList.add('hidden'), 2600);
  }

  function getPinnedList() {
    const bid = state.status.brokerId || state.persisted.activeBrokerId;
    return (state.persisted.pinnedByBroker && state.persisted.pinnedByBroker[bid]) || [];
  }

  function getBrokerDashboards() {
    const bid = state.status.brokerId || state.persisted.activeBrokerId;
    return (state.persisted.dashboardsByBroker && state.persisted.dashboardsByBroker[bid]) || [];
  }

  function getActiveDashId() {
    const bid = state.status.brokerId || state.persisted.activeBrokerId;
    const dashes = getBrokerDashboards();
    const saved = state.persisted.activeDashByBroker && state.persisted.activeDashByBroker[bid];
    return dashes.some((d) => d.id === saved) ? saved : (dashes[0]?.id || '');
  }

  function getActiveDashboard() {
    const id = getActiveDashId();
    return getBrokerDashboards().find((d) => d.id === id) || null;
  }

  function savePrefs() {
    if (window.apiSavePrefs) {
      window.apiSavePrefs({
        theme: document.documentElement.getAttribute('data-theme') || 'auto',
        sidebarWidth: state.sidebarWidth,
        publishHeight: state.publishHeight,
        publishOpen: state.publishOpen
      }).catch(() => {});
    }
  }

  function saveDashboards() {
    const bid = state.status.brokerId || state.persisted.activeBrokerId;
    const dashes = getBrokerDashboards();
    const activeId = getActiveDashId();
    if (window.apiSaveDashboards) {
      window.apiSaveDashboards(bid, dashes, activeId).catch(() => {});
    }
  }

  function applySnapshot(snap, isInitial) {
    if (!snap) return;
    state.status = snap.status || state.status;
    state.topics = snap.topics || {};
    state.persisted = snap.persisted || state.persisted;

    if (Array.isArray(snap.flashed) && snap.flashed.length > 0) {
      snap.flashed.forEach((k) => state.flashed.add(k));
      setTimeout(() => {
        snap.flashed.forEach((k) => state.flashed.delete(k));
      }, 650);
    }

    if (isInitial) {
      const prefs = state.persisted.prefs || {};
      applyTheme(prefs.theme || 'auto', false);
      if (prefs.sidebarWidth) {
        state.sidebarWidth = prefs.sidebarWidth;
        document.getElementById('workspace-grid').style.setProperty('--sidebar-w', `${prefs.sidebarWidth}px`);
      }
      if (prefs.publishHeight) state.publishHeight = prefs.publishHeight;
      if (prefs.publishOpen) setPublishDrawerOpen(true, false);
    }

    const keys = Object.keys(state.topics).sort();
    if (!state.didAutoExpand && keys.length > 0) {
      state.didAutoExpand = true;
      getPinnedList().forEach(expandParents);
      keys.slice(0, 4).forEach(expandParents);
    }

    if (!state.selectedPath || (state.selectionType === 'topic' && !state.topics[state.selectedPath])) {
      state.selectionType = 'topic';
      const pinnedFirst = getPinnedList().find((p) => state.topics[p]);
      state.selectedPath = pinnedFirst || keys[0] || '';
      if (state.selectedPath) expandParents(state.selectedPath);
    }

    renderStatus();
    renderPinned();
    renderTree();
    if (state.viewMode === 'dashboards') {
      updateDashboardLiveData();
    } else {
      renderInspector();
    }
  }

  function getInlinePreview(item) {
    const p = item.payload;
    if (typeof p === 'number') return formatNumber(p);
    if (typeof p === 'string' || typeof p === 'boolean') return String(p);
    if (p && typeof p === 'object') {
      const vals = Object.values(p).slice(0, 2).map((v) => (typeof v === 'number' ? formatNumber(v) : String(v)));
      return vals.join(' · ') || '{…}';
    }
    return 'vide';
  }

  function getPayloadKindLabel(payload) {
    if (typeof payload === 'number') return 'Nombre';
    if (typeof payload === 'string') return 'Texte';
    if (typeof payload === 'boolean') return 'Booléen';
    if (Array.isArray(payload)) return 'Liste JSON';
    if (payload && typeof payload === 'object') return 'Objet JSON';
    return 'Donnée';
  }

  function renderStatus() {
    const st = state.status;
    document.getElementById('broker-label').textContent = st.brokerName || 'Choisir un serveur';
    document.getElementById('footer-status').textContent = st.message || st.brokerName || 'Prêt';

    const dotClass =
      st.state === 'connected' ? 'dot dot-success' :
      st.state === 'connecting' ? 'dot dot-warning' :
      st.state === 'error' ? 'dot dot-error' : 'dot dot-warning';
    document.getElementById('broker-dot').className = dotClass;
    document.getElementById('footer-dot').className = dotClass;

    document.getElementById('btn-toggle-stream').setAttribute('aria-pressed', String(!st.paused));
    document.getElementById('stream-btn-text').textContent = st.paused ? 'Reprendre' : 'Pause';
    document.getElementById('footer-rate').textContent =
      st.state !== 'connected' ? 'Hors ligne' : (st.paused ? 'Flux en pause' : 'Flux MQTT en direct');

    document.getElementById('nav-dash-count').textContent = `(${getBrokerDashboards().length})`;
  }

  function expandParents(topicPath) {
    const parts = topicPath.split('/');
    let acc = '';
    for (let i = 0; i < parts.length - 1; i++) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i];
      state.expandedFolders.add(acc);
    }
  }

  function buildTree(topicsMap, filterText) {
    const root = { name: '', fullPath: '', children: {}, topicKey: null };
    const q = filterText.trim().toLowerCase();

    Object.keys(topicsMap).sort().forEach((key) => {
      const data = topicsMap[key];
      const rawStr = data.raw || JSON.stringify(data.payload);
      if (q) {
        if (!key.toLowerCase().includes(q) && !String(rawStr).toLowerCase().includes(q)) return;
      }

      const parts = key.split('/');
      let curr = root;
      let acc = '';
      parts.forEach((part, idx) => {
        acc = acc ? `${acc}/${part}` : part;
        if (!curr.children[part]) {
          curr.children[part] = { name: part, fullPath: acc, children: {}, topicKey: null };
        }
        curr = curr.children[part];
        if (idx === parts.length - 1) curr.topicKey = key;
      });
    });

    return root;
  }

  function collectBranchStats(node) {
    let topics = 0;
    let messages = 0;
    let hasFlash = false;
    if (node.topicKey && state.topics[node.topicKey]) {
      topics += 1;
      messages += state.topics[node.topicKey].count || 0;
      if (state.flashed.has(node.topicKey)) hasFlash = true;
    }
    Object.values(node.children).forEach((child) => {
      const sub = collectBranchStats(child);
      topics += sub.topics;
      messages += sub.messages;
      if (sub.hasFlash) hasFlash = true;
    });
    return { topics, messages, hasFlash };
  }

  function renderPinned() {
    const pinned = getPinnedList().filter((k) => state.topics[k]);
    document.getElementById('pinned-count').textContent = String(pinned.length);
    const listEl = document.getElementById('pinned-list');

    if (pinned.length === 0) {
      listEl.innerHTML = '<span style="font-size:12px;color:var(--muted-foreground);">Aucun topic épinglé</span>';
      return;
    }

    listEl.innerHTML = pinned
      .map((key) => {
        const item = state.topics[key];
        const active = state.selectionType === 'topic' && state.selectedPath === key;
        const shortName = key.split('/').slice(-2).join('/');
        return `
          <button type="button" data-select-topic="${escapeHtml(key)}" title="${escapeHtml(key)}" class="pinned-chip ${active ? 'active' : ''}">
            <span class="mono" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:165px;" translate="no">${escapeHtml(shortName)}</span>
            <span class="tabular" style="opacity:0.85;">${escapeHtml(getInlinePreview(item))}</span>
          </button>
        `;
      })
      .join('');
  }

  function renderTreeNode(node) {
    return Object.values(node.children)
      .map((child) => {
        const hasChildren = Object.keys(child.children).length > 0;
        const stats = collectBranchStats(child);
        const isBranchSelected = state.selectionType === 'branch' && state.selectedPath === child.fullPath;
        const isTopicSelected = state.selectionType === 'topic' && state.selectedPath === child.topicKey;
        const isExpanded = state.searchQuery.trim() ? true : state.expandedFolders.has(child.fullPath);

        if (hasChildren) {
          const branchHighlight = !isExpanded && stats.hasFlash ? 'topic-flash' : '';
          const leafItem = child.topicKey ? state.topics[child.topicKey] : null;
          return `
            <div>
              <div role="treeitem" aria-expanded="${isExpanded}" aria-selected="${isBranchSelected}" class="tree-branch-row ${branchHighlight} ${isBranchSelected ? 'selected' : ''}">
                <div class="tree-branch-left">
                  <button type="button" data-toggle-folder="${escapeHtml(child.fullPath)}" class="tree-chevron-btn ${isExpanded ? 'open' : ''}" aria-label="${isExpanded ? 'Replier' : 'Déplier'} ${escapeHtml(child.name)}">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg>
                  </button>
                  <button type="button" data-select-branch="${escapeHtml(child.fullPath)}" class="tree-branch-btn mono" translate="no">${escapeHtml(child.name)}</button>
                </div>
                <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;font-size:12px;color:var(--muted-foreground);" class="tabular">
                  ${leafItem ? `<span style="max-width:85px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--foreground);">${escapeHtml(getInlinePreview(leafItem))}</span>` : ''}
                  <span>(${stats.topics} · ${stats.messages})</span>
                </div>
              </div>
              <div class="${isExpanded ? '' : 'hidden'} tree-children">
                ${renderTreeNode(child)}
              </div>
            </div>
          `;
        }

        if (child.topicKey) {
          const item = state.topics[child.topicKey];
          const flashed = state.flashed.has(child.topicKey);
          return `
            <button type="button" role="treeitem" aria-selected="${isTopicSelected}" data-select-topic="${escapeHtml(child.topicKey)}" title="${escapeHtml(child.topicKey)}" class="tree-leaf-btn ${flashed ? 'topic-flash' : ''} ${isTopicSelected ? 'selected' : ''}">
              <span class="tree-leaf-name">
                <span class="mono" translate="no">${escapeHtml(child.name)}</span>
                ${item.retained ? '<span class="retained-tag" title="Message mémorisé (Retain)">R</span>' : ''}
              </span>
              <span class="tree-preview mono tabular">${escapeHtml(getInlinePreview(item))}</span>
            </button>
          `;
        }
        return '';
      })
      .join('');
  }

  function renderTree() {
    const root = buildTree(state.topics, state.searchQuery);
    const treeEl = document.getElementById('topic-tree');
    const emptyEl = document.getElementById('tree-empty');
    const html = renderTreeNode(root);
    if (!html.trim()) {
      treeEl.innerHTML = '';
      emptyEl.classList.remove('hidden');
    } else {
      emptyEl.classList.add('hidden');
      treeEl.innerHTML = html;
    }

    const entries = Object.values(state.topics);
    const totalMsgs = entries.reduce((acc, item) => acc + (item.count || 0), 0);
    document.getElementById('footer-topic-count').textContent = `${entries.length} topics`;
    document.getElementById('footer-msg-total').textContent = `${totalMsgs} messages reçus`;
  }

  function renderBreadcrumbs(path) {
    const container = document.getElementById('breadcrumb-bar');
    if (!path) {
      container.innerHTML = '<span style="color:var(--muted-foreground);">Aucune sélection</span>';
      return;
    }
    const parts = path.split('/');
    let acc = '';
    container.innerHTML = parts
      .map((part, idx) => {
        acc = acc ? `${acc}/${part}` : part;
        const isLast = idx === parts.length - 1;
        const isTopic = isLast && state.selectionType === 'topic';
        const attr = isTopic ? `data-select-topic="${escapeHtml(acc)}"` : `data-select-branch="${escapeHtml(acc)}"`;
        return `${idx > 0 ? '<span style="color:var(--muted-foreground);" aria-hidden="true">/</span>' : ''}<button type="button" ${attr} class="crumb-btn ${isLast ? 'last' : ''}">${escapeHtml(part)}</button>`;
      })
      .join('');
  }

  function getBranchTopics(branchPrefix) {
    return Object.entries(state.topics).filter(([k]) => k === branchPrefix || k.startsWith(`${branchPrefix}/`));
  }

  function renderBranchInspector(branchPrefix) {
    const matched = getBranchTopics(branchPrefix);
    const totalMsgs = matched.reduce((acc, [, v]) => acc + (v.count || 0), 0);

    document.getElementById('detail-kind-badge').textContent = 'Branche';
    document.getElementById('detail-retained-badge').classList.add('hidden');
    document.getElementById('detail-live-age').textContent = `${matched.length} topics inclus`;
    document.getElementById('detail-msg-count').textContent = `${totalMsgs} messages`;
    document.getElementById('btn-toggle-pin').classList.add('hidden');
    document.getElementById('delete-btn-label').textContent = 'Effacer la branche';
    document.getElementById('leaf-tabs-bar').classList.add('hidden');

    ['readable', 'json', 'diff', 'chart'].forEach((id) => document.getElementById(`panel-${id}`).classList.add('hidden'));
    document.getElementById('panel-branch').classList.remove('hidden');
    document.getElementById('branch-summary-text').textContent = `Topics contenus sous « ${branchPrefix} »`;

    const tbody = document.getElementById('branch-tbody');
    if (matched.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--muted-foreground);padding:20px;">Aucun topic dans cette branche.</td></tr>';
      return;
    }

    tbody.innerHTML = matched
      .map(([k, item]) => {
        const rel = k === branchPrefix ? k : k.slice(branchPrefix.length + 1);
        return `
          <tr>
            <td class="mono" translate="no"><button type="button" data-select-topic="${escapeHtml(k)}" style="color:var(--link);text-align:left;">${escapeHtml(rel)}</button></td>
            <td class="mono tabular" style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(getInlinePreview(item))}</td>
            <td class="tabular" style="text-align:right;color:var(--muted-foreground);">${item.count}</td>
            <td class="tabular" style="text-align:right;color:var(--muted-foreground);">${formatRelativeAge(item.updatedAt)}</td>
          </tr>
        `;
      })
      .join('');
  }

  function renderReadableView(item) {
    const container = document.getElementById('readable-container');
    const p = item.payload;
    if (p && typeof p === 'object' && !Array.isArray(p)) {
      const entries = Object.entries(p);
      container.innerHTML = `
        <div class="card-header-bar">
          <span>Champs détectés (${entries.length})</span>
          <span>Format : ${getPayloadKindLabel(p)}</span>
        </div>
        <table class="data-table">
          <thead>
            <tr>
              <th>Clé</th>
              <th>Valeur</th>
              <th style="text-align:right;">Type</th>
            </tr>
          </thead>
          <tbody>
            ${entries.map(([k, v]) => {
              const typeName = typeof v === 'number' ? 'Nombre' : typeof v === 'boolean' ? 'Booléen' : 'Texte';
              const valStr = typeof v === 'number' ? formatNumber(v) : String(v);
              return `
                <tr>
                  <td class="mono" style="color:var(--muted-foreground);" translate="no">${escapeHtml(k)}</td>
                  <td class="tabular" style="font-weight:500;word-break:break-word;">${escapeHtml(valStr)}</td>
                  <td style="text-align:right;color:var(--muted-foreground);">${typeName}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      `;
    } else {
      const formatted = typeof p === 'number' ? formatNumber(p) : String(p);
      container.innerHTML = `
        <div class="card-header-bar">
          <span>Valeur reçue</span>
          <span>Format : ${getPayloadKindLabel(p)}</span>
        </div>
        <div style="padding:16px;font-size:17px;font-weight:600;word-break:break-word;" class="tabular">${escapeHtml(formatted)}</div>
      `;
    }
  }

  function renderJsonView(item) {
    document.getElementById('json-format-label').textContent = `Format : ${getPayloadKindLabel(item.payload)}`;
    document.getElementById('json-pre').textContent =
      typeof item.payload === 'object' && item.payload !== null
        ? JSON.stringify(item.payload, null, 2)
        : (item.raw ?? String(item.payload));
  }

  function renderDiffView(item) {
    const container = document.getElementById('diff-container');
    if (item.prevPayload === undefined || item.prevPayload === null) {
      container.innerHTML = '<p style="padding:14px;margin:0;color:var(--muted-foreground);">En attente d’un second message pour comparer les changements.</p>';
      return;
    }

    if (typeof item.payload === 'object' && typeof item.prevPayload === 'object' && item.payload !== null && item.prevPayload !== null) {
      const keys = Array.from(new Set([...Object.keys(item.prevPayload), ...Object.keys(item.payload)]));
      container.innerHTML = `
        <table class="data-table">
          <thead>
            <tr>
              <th>Clé</th>
              <th>Message précédent</th>
              <th>Message actuel</th>
            </tr>
          </thead>
          <tbody>
            ${keys.map((k) => {
              const prevVal = item.prevPayload[k];
              const currVal = item.payload[k];
              const changed = JSON.stringify(prevVal) !== JSON.stringify(currVal);
              return `
                <tr>
                  <td class="mono" translate="no">${escapeHtml(k)}</td>
                  <td class="mono tabular ${changed ? 'diff-old' : ''}">${escapeHtml(prevVal ?? 'absent')}</td>
                  <td class="mono tabular ${changed ? 'diff-new' : ''}">${escapeHtml(currVal ?? 'absent')}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      `;
    } else {
      container.innerHTML = `
        <div style="padding:14px;display:flex;flex-direction:column;gap:8px;" class="mono">
          <div style="padding:8px;border-radius:6px;background:color-mix(in srgb,var(--error) 12%,transparent);color:var(--error);">- ${escapeHtml(item.prevRaw || String(item.prevPayload))}</div>
          <div style="padding:8px;border-radius:6px;background:color-mix(in srgb,var(--success) 12%,transparent);color:var(--success);">+ ${escapeHtml(item.raw || String(item.payload))}</div>
        </div>
      `;
    }
  }

  function drawTopicChart() {
    const item = state.topics[state.selectedPath];
    const canvas = document.getElementById('topic-chart');
    const emptyEl = document.getElementById('chart-empty');
    const latestEl = document.getElementById('chart-latest-val');
    const titleEl = document.getElementById('chart-title');

    if (!item || !item.numericKey) {
      emptyEl.classList.remove('hidden');
      latestEl.textContent = 'non numérique';
      titleEl.textContent = 'Évolution des valeurs reçues';
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    emptyEl.classList.add('hidden');
    const keyName = item.numericKey === '__scalar__' ? state.selectedPath.split('/').pop() : item.numericKey;
    titleEl.textContent = `Évolution de « ${keyName} »`;

    const points = (item.history || [])
      .map((h) => ({
        ts: h.ts,
        val: item.numericKey === '__scalar__' ? h.payload : (h.payload && h.payload[item.numericKey])
      }))
      .filter((pt) => typeof pt.val === 'number');

    if (points.length === 0) return;
    latestEl.textContent = formatNumber(points[points.length - 1].val);

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const styles = getComputedStyle(document.documentElement);
    const lineColor = styles.getPropertyValue('--chart-1').trim() || '#2563EB';
    const mutedColor = styles.getPropertyValue('--muted-foreground').trim() || '#9CA3AF';
    const borderColor = styles.getPropertyValue('--border').trim() || '#334155';

    const pad = { top: 14, right: 16, bottom: 24, left: 48 };
    const w = rect.width - pad.left - pad.right;
    const h = rect.height - pad.top - pad.bottom;

    const vals = points.map((p) => p.val);
    let minV = Math.min(...vals);
    let maxV = Math.max(...vals);
    if (minV === maxV) { minV -= 1; maxV += 1; } else { const m = (maxV - minV) * 0.15; minV -= m; maxV += m; }

    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillStyle = mutedColor;
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 1;

    for (let i = 0; i <= 2; i++) {
      const y = pad.top + (h * i) / 2;
      const lbl = maxV - ((maxV - minV) * i) / 2;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + w, y);
      ctx.stroke();
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(formatNumber(lbl), pad.left - 8, y);
    }

    const coords = points.map((pt, idx) => ({
      x: pad.left + (points.length === 1 ? w / 2 : (w * idx) / (points.length - 1)),
      y: pad.top + h - ((pt.val - minV) / (maxV - minV)) * h,
      pt
    }));

    ctx.beginPath();
    coords.forEach((c, idx) => (idx === 0 ? ctx.moveTo(c.x, c.y) : ctx.lineTo(c.x, c.y)));
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();

    coords.forEach((c, idx) => {
      ctx.beginPath();
      ctx.arc(c.x, c.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = lineColor;
      ctx.fill();
      if (idx === 0 || idx === coords.length - 1) {
        ctx.fillStyle = mutedColor;
        ctx.textAlign = idx === 0 ? 'left' : 'right';
        ctx.textBaseline = 'top';
        ctx.fillText(formatTime(c.pt.ts), c.x, pad.top + h + 6);
      }
    });
  }

  function renderHistoryTable(item) {
    const tbody = document.getElementById('history-tbody');
    const rows = [...(item.history || [])].reverse().slice(0, 12);
    tbody.innerHTML = rows
      .map((entry, idx) => {
        const txt = entry.raw || JSON.stringify(entry.payload);
        return `
          <tr>
            <td class="tabular" style="color:var(--muted-foreground);white-space:nowrap;">${formatTime(entry.ts)}</td>
            <td class="mono" style="max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" translate="no">${escapeHtml(txt)}</td>
            <td style="text-align:right;"><button type="button" data-reuse-idx="${idx}" style="color:var(--link);">Réutiliser</button></td>
          </tr>
        `;
      })
      .join('');

    tbody.querySelectorAll('[data-reuse-idx]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const entry = rows[Number(btn.getAttribute('data-reuse-idx'))];
        if (!entry) return;
        const txt = typeof entry.payload === 'object' && entry.payload !== null
          ? JSON.stringify(entry.payload, null, 2)
          : (entry.raw || String(entry.payload));
        openPublishDrawer(state.selectedPath, txt);
      });
    });
  }

  function renderInspector() {
    renderBreadcrumbs(state.selectedPath);
    if (!state.selectedPath) {
      document.getElementById('detail-kind-badge').textContent = state.status.state === 'connected' ? 'En attente' : 'Non connecté';
      document.getElementById('detail-live-age').textContent = '';
      document.getElementById('detail-msg-count').textContent = '0 message';
      document.getElementById('leaf-tabs-bar').classList.add('hidden');
      document.getElementById('panel-branch').classList.add('hidden');
      document.getElementById('panel-readable').classList.remove('hidden');

      if (state.status.state !== 'connected') {
        document.getElementById('readable-container').innerHTML = `
          <div style="padding:28px 20px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:10px;">
            <strong style="font-size:14px;">Bienvenue dans TopiQTT</strong>
            <p style="margin:0;color:var(--muted-foreground);max-width:440px;">Connectez-vous à votre serveur MQTT (local, réseau d’entreprise ou cloud) pour explorer l’arborescence des topics et tracer vos courbes en direct.</p>
            <button type="button" id="btn-welcome-connect" class="btn btn-primary" style="margin-top:4px;">Connecter un serveur MQTT</button>
          </div>
        `;
        const wBtn = document.getElementById('btn-welcome-connect');
        if (wBtn) wBtn.addEventListener('click', openConnectionsModal);
      } else {
        document.getElementById('readable-container').innerHTML =
          '<p style="padding:14px;margin:0;color:var(--muted-foreground);">Connecté. Sélectionnez un topic dans l’arborescence ou attendez le prochain message.</p>';
      }
      return;
    }

    if (state.selectionType === 'branch') {
      renderBranchInspector(state.selectedPath);
      document.getElementById('publish-target-label').textContent = `${state.selectedPath}/nouveau`;
      if (!state.publishOpen) document.getElementById('pub-topic-input').value = `${state.selectedPath}/nouveau`;
      return;
    }

    const item = state.topics[state.selectedPath];
    if (!item) return;

    const pinned = getPinnedList().includes(state.selectedPath);
    document.getElementById('panel-branch').classList.add('hidden');
    document.getElementById('leaf-tabs-bar').classList.remove('hidden');
    document.getElementById('btn-toggle-pin').classList.remove('hidden');
    document.getElementById('delete-btn-label').textContent = 'Effacer';

    document.getElementById('detail-kind-badge').textContent = getPayloadKindLabel(item.payload);
    document.getElementById('detail-retained-badge').classList.toggle('hidden', !item.retained);
    document.getElementById('detail-live-age').textContent = formatRelativeAge(item.updatedAt);
    document.getElementById('detail-msg-count').textContent = `${item.count} messages`;
    document.getElementById('publish-target-label').textContent = state.selectedPath;

    document.getElementById('btn-toggle-pin').setAttribute('aria-pressed', String(pinned));
    document.getElementById('pin-btn-label').textContent = pinned ? 'Épinglé' : 'Épingler';

    if (!state.publishOpen) {
      document.getElementById('pub-topic-input').value = state.selectedPath;
      document.getElementById('pub-payload').value =
        typeof item.payload === 'object' && item.payload !== null
          ? JSON.stringify(item.payload, null, 2)
          : (item.raw ?? String(item.payload));
    }

    ['readable', 'json', 'diff', 'chart'].forEach((id) => {
      document.getElementById(`panel-${id}`).classList.toggle('hidden', id !== state.activeTab);
    });

    renderReadableView(item);
    renderJsonView(item);
    renderDiffView(item);
    renderHistoryTable(item);
    if (state.activeTab === 'chart') requestAnimationFrame(drawTopicChart);
  }

  function selectTopic(key) {
    if (!state.topics[key]) return;
    state.selectionType = 'topic';
    state.selectedPath = key;
    expandParents(key);
    renderPinned();
    renderTree();
    renderInspector();
  }

  function selectBranch(path) {
    state.selectionType = 'branch';
    state.selectedPath = path;
    state.expandedFolders.add(path);
    renderPinned();
    renderTree();
    renderInspector();
  }

  function setPublishDrawerOpen(open, persist = true) {
    state.publishOpen = open;
    const drawer = document.getElementById('publish-drawer');
    document.getElementById('publish-form').classList.toggle('hidden', !open);
    document.getElementById('btn-toggle-publish').setAttribute('aria-expanded', String(open));
    document.getElementById('publish-chevron').textContent = open ? 'Réduire' : 'Ouvrir';
    drawer.style.height = open ? `${state.publishHeight || 230}px` : '';
    if (state.activeTab === 'chart') requestAnimationFrame(drawTopicChart);
    if (persist) savePrefs();
  }

  function openPublishDrawer(topicPath, payloadText) {
    setPublishDrawerOpen(true);
    if (topicPath) document.getElementById('pub-topic-input').value = topicPath;
    if (payloadText !== undefined) document.getElementById('pub-payload').value = payloadText;
  }

  // ---- Dashboards & Multi-Curve Charts ----
  function getNumericFieldsForTopic(topicKey) {
    const item = state.topics[topicKey];
    if (!item) return [];
    const p = item.payload;
    if (typeof p === 'number') return [{ key: '__scalar__', label: 'Valeur numérique directe' }];
    if (p && typeof p === 'object' && !Array.isArray(p)) {
      return Object.entries(p).filter(([, v]) => typeof v === 'number').map(([k]) => ({ key: k, label: k }));
    }
    return [];
  }

  function getAllNumericTopics() {
    return Object.keys(state.topics).sort().filter((k) => getNumericFieldsForTopic(k).length > 0);
  }

  function extractSeriesPoints(seriesCfg) {
    const item = state.topics[seriesCfg.topic];
    if (!item || !Array.isArray(item.history)) return [];
    return item.history
      .map((h) => ({
        ts: h.ts,
        val: seriesCfg.field === '__scalar__'
          ? h.payload
          : (h.payload && typeof h.payload === 'object' ? h.payload[seriesCfg.field] : undefined)
      }))
      .filter((pt) => typeof pt.val === 'number');
  }

  function drawDashboardChart(chart, canvas, hoverRatio) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const styles = getComputedStyle(document.documentElement);
    const mutedColor = styles.getPropertyValue('--muted-foreground').trim() || '#9CA3AF';
    const borderColor = styles.getPropertyValue('--border').trim() || '#334155';
    const fgColor = styles.getPropertyValue('--foreground').trim() || '#F3F4F6';

    const visibleSeries = (chart.series || [])
      .filter((s) => !s.hidden)
      .map((s) => ({ cfg: s, pts: extractSeriesPoints(s) }))
      .filter((s) => s.pts.length > 0);

    ctx.clearRect(0, 0, rect.width, rect.height);
    if (visibleSeries.length === 0) {
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillStyle = mutedColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Aucune courbe active ou aucune donnée numérique reçue.', rect.width / 2, rect.height / 2);
      return;
    }

    let minTs = Infinity, maxTs = -Infinity, globalMin = Infinity, globalMax = -Infinity;
    visibleSeries.forEach((s) => {
      let sMin = Infinity, sMax = -Infinity;
      s.pts.forEach((pt) => {
        minTs = Math.min(minTs, pt.ts);
        maxTs = Math.max(maxTs, pt.ts);
        sMin = Math.min(sMin, pt.val);
        sMax = Math.max(sMax, pt.val);
        globalMin = Math.min(globalMin, pt.val);
        globalMax = Math.max(globalMax, pt.val);
      });
      if (sMin === sMax) { sMin -= 1; sMax += 1; }
      s.min = sMin;
      s.max = sMax;
    });
    if (minTs === maxTs) { minTs -= 5000; maxTs += 5000; }
    if (globalMin === globalMax) { globalMin -= 1; globalMax += 1; } else {
      const m = (globalMax - globalMin) * 0.12;
      globalMin -= m;
      globalMax += m;
    }

    const isNorm = chart.scale === 'normalized';
    const pad = { top: 14, right: 16, bottom: 24, left: 48 };
    const w = rect.width - pad.left - pad.right;
    const h = rect.height - pad.top - pad.bottom;

    ctx.font = '12px system-ui, sans-serif';
    ctx.fillStyle = mutedColor;
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 1;

    const yMin = isNorm ? 0 : globalMin;
    const yMax = isNorm ? 100 : globalMax;
    for (let i = 0; i <= 2; i++) {
      const y = pad.top + (h * i) / 2;
      const lbl = yMax - ((yMax - yMin) * i) / 2;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + w, y);
      ctx.stroke();
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(isNorm ? `${Math.round(lbl)}%` : formatNumber(lbl), pad.left - 8, y);
    }

    const hoverSummary = [];
    let hoverTs = null;
    visibleSeries.forEach((s) => {
      const coords = s.pts.map((pt) => {
        const x = pad.left + ((pt.ts - minTs) / (maxTs - minTs)) * w;
        const normVal = isNorm ? ((pt.val - s.min) / (s.max - s.min)) * 100 : pt.val;
        const y = pad.top + h - ((normVal - yMin) / (yMax - yMin)) * h;
        return { x, y, pt };
      });
      ctx.beginPath();
      coords.forEach((c, idx) => (idx === 0 ? ctx.moveTo(c.x, c.y) : ctx.lineTo(c.x, c.y)));
      ctx.strokeStyle = s.cfg.color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.stroke();

      coords.forEach((c) => {
        ctx.beginPath();
        ctx.arc(c.x, c.y, 2.8, 0, Math.PI * 2);
        ctx.fillStyle = s.cfg.color;
        ctx.fill();
      });

      if (hoverRatio !== null) {
        const targetX = pad.left + hoverRatio * w;
        let closest = coords[0];
        let minDist = Math.abs(coords[0].x - targetX);
        coords.forEach((c) => {
          const d = Math.abs(c.x - targetX);
          if (d < minDist) { minDist = d; closest = c; }
        });
        hoverTs = hoverTs ?? closest.pt.ts;
        hoverSummary.push({ label: s.cfg.label, color: s.cfg.color, val: closest.pt.val, x: closest.x, y: closest.y });
      }
    });

    ctx.fillStyle = mutedColor;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText(formatTime(minTs), pad.left, pad.top + h + 6);
    ctx.textAlign = 'right';
    ctx.fillText(formatTime(maxTs), pad.left + w, pad.top + h + 6);

    const readoutEl = document.getElementById(`dash-readout-${chart.id}`);
    if (hoverRatio !== null && hoverSummary.length > 0) {
      const lineX = pad.left + hoverRatio * w;
      ctx.beginPath();
      ctx.moveTo(lineX, pad.top);
      ctx.lineTo(lineX, pad.top + h);
      ctx.strokeStyle = mutedColor;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);

      hoverSummary.forEach((hs) => {
        ctx.beginPath();
        ctx.arc(hs.x, hs.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = hs.color;
        ctx.fill();
        ctx.strokeStyle = fgColor;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      });

      if (readoutEl) {
        readoutEl.innerHTML = `<span class="tabular">${formatTime(hoverTs)}</span> ` +
          hoverSummary.map((hs) => `<span style="display:inline-flex;align-items:center;gap:4px;" class="tabular"><span class="dot" style="background:${hs.color}"></span>${escapeHtml(hs.label)} : <strong>${formatNumber(hs.val)}</strong></span>`).join(' ');
      }
    } else if (readoutEl) {
      readoutEl.textContent = 'Survolez le graphique pour inspecter les valeurs';
    }
  }

  function drawAllDashboardCharts() {
    const dash = getActiveDashboard();
    if (!dash) return;
    (dash.charts || []).forEach((chart) => {
      const canvas = document.getElementById(`dash-canvas-${chart.id}`);
      if (canvas) drawDashboardChart(chart, canvas, null);
    });
  }

  function updateDashboardLiveData() {
    const dash = getActiveDashboard();
    if (!dash) return;
    (dash.charts || []).forEach((chart) => {
      (chart.series || []).forEach((s, idx) => {
        const el = document.querySelector(`[data-legend-val="${chart.id}:${idx}"]`);
        if (el) {
          const pts = extractSeriesPoints(s);
          el.textContent = pts.length > 0 ? formatNumber(pts[pts.length - 1].val) : 'vide';
        }
      });
    });
    requestAnimationFrame(drawAllDashboardCharts);
  }

  function renderDashboardsView() {
    const dashes = getBrokerDashboards();
    const dash = getActiveDashboard();
    document.getElementById('nav-dash-count').textContent = `(${dashes.length})`;

    document.getElementById('dashboards-list').innerHTML = dashes.length === 0
      ? '<p style="padding:8px;color:var(--muted-foreground);">Aucun dashboard</p>'
      : dashes.map((d) => {
          const active = dash && d.id === dash.id;
          return `<button type="button" data-select-dash="${escapeHtml(d.id)}" class="dash-item-btn ${active ? 'active' : ''}">
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(d.name)}</span>
            <span class="tabular" style="opacity:0.85;">${(d.charts || []).length}</span>
          </button>`;
        }).join('');

    const grid = document.getElementById('dash-charts-grid');
    const empty = document.getElementById('dash-empty-state');

    if (!dash) {
      document.getElementById('dash-active-title').textContent = 'Aucun dashboard';
      document.getElementById('dash-active-subtitle').textContent = 'Créez un dashboard pour commencer';
      grid.innerHTML = '';
      empty.classList.remove('hidden');
      document.getElementById('btn-rename-dashboard').disabled = true;
      document.getElementById('btn-delete-dashboard').disabled = true;
      return;
    }

    document.getElementById('btn-rename-dashboard').disabled = false;
    document.getElementById('btn-delete-dashboard').disabled = false;
    document.getElementById('dash-active-title').textContent = dash.name;
    const count = (dash.charts || []).length;
    document.getElementById('dash-active-subtitle').textContent = `${count} graphique${count > 1 ? 's' : ''}`;

    if (count === 0) {
      grid.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }

    empty.classList.add('hidden');
    grid.innerHTML = dash.charts.map((chart) => {
      const spanClass = chart.span === 2 ? 'span-2' : '';
      const scaleLabel = chart.scale === 'normalized' ? 'Normalisée (0–100%)' : 'Valeurs réelles';
      const legendHtml = (chart.series || []).map((s, idx) => {
        const pts = extractSeriesPoints(s);
        const latest = pts.length > 0 ? formatNumber(pts[pts.length - 1].val) : 'vide';
        return `
          <button type="button" data-toggle-series="${escapeHtml(chart.id)}:${idx}" aria-pressed="${!s.hidden}" class="legend-btn ${s.hidden ? 'muted' : ''}">
            <span class="dot" style="background:${s.color}" aria-hidden="true"></span>
            <span>${escapeHtml(s.label)}</span>
            <strong data-legend-val="${escapeHtml(chart.id)}:${idx}" class="mono tabular">${latest}</strong>
          </button>
        `;
      }).join('');

      return `
        <article class="card dash-card ${spanClass}">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;flex-wrap:wrap;">
            <div style="min-width:0;">
              <h3 style="margin:0;font-size:13px;font-weight:600;">${escapeHtml(chart.title)}</h3>
              <p style="margin:2px 0 0;font-size:12px;color:var(--muted-foreground);">${chart.series.length} courbe${chart.series.length > 1 ? 's' : ''} · ${scaleLabel}</p>
            </div>
            <div style="display:flex;gap:6px;flex-shrink:0;">
              <button type="button" data-cycle-height="${escapeHtml(chart.id)}" class="btn btn-sm tabular">${chart.height}px</button>
              <button type="button" data-toggle-span="${escapeHtml(chart.id)}" class="btn btn-sm">${chart.span === 2 ? '1/1 col' : '1/2 col'}</button>
              <button type="button" data-edit-chart="${escapeHtml(chart.id)}" class="btn btn-sm">Modifier</button>
              <button type="button" data-remove-chart="${escapeHtml(chart.id)}" class="btn btn-sm btn-danger">Retirer</button>
            </div>
          </div>

          <div style="width:100%;height:${chart.height}px;position:relative;">
            <canvas id="dash-canvas-${escapeHtml(chart.id)}" style="width:100%;height:100%;display:block;"></canvas>
          </div>

          <div id="dash-readout-${escapeHtml(chart.id)}" style="font-size:12px;color:var(--muted-foreground);min-height:18px;display:flex;flex-wrap:wrap;gap:10px;">
            Survolez le graphique pour inspecter les valeurs
          </div>

          <div class="legend-row">${legendHtml}</div>
        </article>
      `;
    }).join('');

    dash.charts.forEach((chart) => {
      const canvas = document.getElementById(`dash-canvas-${chart.id}`);
      if (!canvas) return;
      canvas.addEventListener('mousemove', (e) => {
        const rect = canvas.getBoundingClientRect();
        const plotW = Math.max(1, rect.width - 64);
        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left - 48) / plotW));
        drawDashboardChart(chart, canvas, ratio);
      });
      canvas.addEventListener('mouseleave', () => drawDashboardChart(chart, canvas, null));
    });

    requestAnimationFrame(drawAllDashboardCharts);
  }

  function switchMainView(mode) {
    state.viewMode = mode;
    const isExp = mode === 'explorer';
    document.getElementById('workspace-grid').classList.toggle('hidden', !isExp);
    document.getElementById('dashboards-view').classList.toggle('hidden', isExp);
    document.getElementById('nav-explorer').classList.toggle('active', isExp);
    document.getElementById('nav-explorer').setAttribute('aria-pressed', String(isExp));
    document.getElementById('nav-dashboards').classList.toggle('active', !isExp);
    document.getElementById('nav-dashboards').setAttribute('aria-pressed', String(!isExp));

    if (isExp) {
      if (state.activeTab === 'chart') requestAnimationFrame(drawTopicChart);
    } else {
      renderDashboardsView();
    }
  }

  function applyTheme(choice, persist = true) {
    document.documentElement.setAttribute('data-theme', choice);
    document.querySelectorAll('.theme-btn').forEach((b) => {
      const active = b.getAttribute('data-theme-choice') === choice;
      b.setAttribute('aria-pressed', String(active));
      b.classList.toggle('active-soft', active);
    });
    if (state.viewMode === 'explorer' && state.activeTab === 'chart') requestAnimationFrame(drawTopicChart);
    if (state.viewMode === 'dashboards') requestAnimationFrame(drawAllDashboardCharts);
    if (persist) savePrefs();
  }

  // ---- Modals ----
  function openConfirmModal(title, htmlDesc, onConfirm) {
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-desc').innerHTML = htmlDesc;
    state.pendingConfirm = onConfirm;
    document.getElementById('confirm-modal').classList.remove('hidden');
  }

  function emptyDraftProfile() {
    return {
      id: `srv-${Date.now()}`,
      name: '',
      proto: 'mqtt',
      host: '',
      port: 1883,
      subscription: '#'
    };
  }

  let certPickSeq = 0;
  const certPickPending = new Map();
  window.__topiqttResolveCertPick = function (res) {
    if (!res || !res.reqId) return;
    const pending = certPickPending.get(res.reqId);
    if (!pending) return;
    certPickPending.delete(res.reqId);
    if (res.error) pending.reject(new Error(res.error));
    else pending.resolve(res.path || '');
  };

  function pickCertFile(kind) {
    if (!window.apiPickCertFile) return Promise.resolve('');
    const reqId = `pick-${++certPickSeq}`;
    return new Promise((resolve, reject) => {
      certPickPending.set(reqId, { resolve, reject });
      window.apiPickCertFile(reqId, kind).catch((err) => {
        certPickPending.delete(reqId);
        reject(err);
      });
    });
  }

  function setTlsSectionOpen(open) {
    document.getElementById('conn-tls-body').classList.toggle('hidden', !open);
    document.getElementById('btn-conn-tls').setAttribute('aria-expanded', String(open));
    document.getElementById('conn-tls-chevron').textContent = open ? 'Masquer' : 'Afficher';
  }

  function syncTlsBadge() {
    const proto = document.getElementById('conn-proto').value;
    const isTls = proto === 'mqtts' || proto === 'wss';
    const hasTlsConfig = Boolean(
      document.getElementById('conn-ca-cert').value.trim() ||
      document.getElementById('conn-client-cert').value.trim() ||
      document.getElementById('conn-client-key').value.trim() ||
      document.getElementById('conn-skip-tls').checked
    );
    document.getElementById('conn-tls-badge').textContent = isTls
      ? (hasTlsConfig ? '(TLS activé · certificats configurés)' : '(TLS activé)')
      : (hasTlsConfig ? '(configuré · nécessite mqtts / wss)' : '(optionnel · mqtts / wss)');
    return { isTls, hasTlsConfig };
  }

  function renderBrokerProfiles() {
    const profiles = state.persisted.profiles || [];
    const list = document.getElementById('broker-profiles-list');
    if (profiles.length === 0) {
      list.innerHTML = '<p style="margin:0;padding:8px 4px;font-size:12px;color:var(--muted-foreground);">Aucun profil enregistré. Créez votre connexion à droite.</p>';
      return;
    }
    list.innerHTML = profiles.map((p) => {
      const selected = state.editingProfile && state.editingProfile.id === p.id;
      return `
        <button type="button" data-broker-id="${escapeHtml(p.id)}" class="dash-item-btn ${selected ? 'active' : ''}" style="padding:7px 10px;">
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(p.name)}</span>
        </button>
      `;
    }).join('');
  }

  function loadProfileIntoForm(p) {
    state.editingProfile = { ...p };
    document.getElementById('conn-name').value = p.name || '';
    document.getElementById('conn-proto').value = p.proto || 'mqtt';
    document.getElementById('conn-host').value = p.host || '';
    document.getElementById('conn-port').value = p.port || 1883;
    document.getElementById('conn-user').value = p.username || '';
    document.getElementById('conn-pass').value = p.password || '';
    document.getElementById('conn-sub').value = p.subscription || '#';
    document.getElementById('conn-client-id').value = p.clientId || '';
    document.getElementById('conn-ca-cert').value = p.caCertPath || '';
    document.getElementById('conn-client-cert').value = p.clientCertPath || '';
    document.getElementById('conn-client-key').value = p.clientKeyPath || '';
    document.getElementById('conn-skip-tls').checked = Boolean(p.insecureSkipVerify);
    document.getElementById('conn-test-feedback').classList.add('hidden');

    const isSavedProfile = (state.persisted.profiles || []).some((x) => x.id === p.id);
    document.getElementById('btn-delete-profile').disabled = !isSavedProfile;

    const tlsMeta = syncTlsBadge();
    setTlsSectionOpen(tlsMeta.isTls || tlsMeta.hasTlsConfig);
    renderBrokerProfiles();
  }

  function readProfileFromForm() {
    const base = state.editingProfile || { id: `srv-${Date.now()}` };
    return {
      id: base.id || `srv-${Date.now()}`,
      name: document.getElementById('conn-name').value.trim() || document.getElementById('conn-host').value.trim() || 'Serveur MQTT',
      proto: document.getElementById('conn-proto').value,
      host: document.getElementById('conn-host').value.trim(),
      port: Number(document.getElementById('conn-port').value) || 1883,
      username: document.getElementById('conn-user').value.trim(),
      password: document.getElementById('conn-pass').value,
      subscription: document.getElementById('conn-sub').value.trim() || '#',
      clientId: document.getElementById('conn-client-id').value.trim(),
      caCertPath: document.getElementById('conn-ca-cert').value.trim(),
      clientCertPath: document.getElementById('conn-client-cert').value.trim(),
      clientKeyPath: document.getElementById('conn-client-key').value.trim(),
      insecureSkipVerify: document.getElementById('conn-skip-tls').checked,
      color: base.color || 'var(--primary)'
    };
  }

  function openConnectionsModal() {
    const profiles = state.persisted.profiles || [];
    const activeId = state.status.brokerId || state.persisted.activeBrokerId;
    const current = profiles.find((p) => p.id === activeId) || profiles[0] || emptyDraftProfile();
    loadProfileIntoForm(current);
    document.getElementById('connections-modal').classList.remove('hidden');
    document.getElementById('conn-name').focus();
  }

  function closeConnectionsModal() {
    document.getElementById('connections-modal').classList.add('hidden');
  }

  // Chart Builder Modal
  function renderBuilderSeriesRows() {
    const container = document.getElementById('cb-series-list');
    const numericTopics = getAllNumericTopics();
    if (numericTopics.length === 0) {
      container.innerHTML = '<p style="margin:0;color:var(--error);">Aucun topic numérique reçu sur ce serveur pour le moment.</p>';
      return;
    }

    container.innerHTML = state.chartBuilder.series.map((row, idx) => {
      const fields = getNumericFieldsForTopic(row.topic);
      const topicOpts = numericTopics.map((t) => `<option value="${escapeHtml(t)}" ${t === row.topic ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('');
      const fieldOpts = fields.map((f) => `<option value="${escapeHtml(f.key)}" ${f.key === row.field ? 'selected' : ''}>${escapeHtml(f.label)}</option>`).join('');
      const swatches = SERIES_COLORS.map((c) => {
        const selected = c.hex === row.color;
        return `<button type="button" data-cb-color="${idx}:${c.hex}" aria-label="Couleur ${c.name}" aria-pressed="${selected}" class="swatch ${selected ? 'selected' : ''}" style="background:${c.hex}"></button>`;
      }).join('');

      return `
        <div class="card card-padded" style="background:var(--content);display:flex;flex-direction:column;gap:10px;">
          <div style="display:flex;align-items:center;justify-content:space-between;">
            <strong style="font-size:12px;color:var(--muted-foreground);">Courbe ${idx + 1}</strong>
            ${state.chartBuilder.series.length > 1 ? `<button type="button" data-cb-remove="${idx}" style="color:var(--error);font-size:12px;">Retirer</button>` : ''}
          </div>
          <div class="form-grid-3">
            <label>
              <span class="field-label" style="color:var(--muted-foreground);">Topic source</span>
              <select data-cb-topic="${idx}" class="select mono" style="width:100%;">${topicOpts}</select>
            </label>
            <label>
              <span class="field-label" style="color:var(--muted-foreground);">Champ numérique</span>
              <select data-cb-field="${idx}" class="select" style="width:100%;">${fieldOpts}</select>
            </label>
            <label>
              <span class="field-label" style="color:var(--muted-foreground);">Libellé légende</span>
              <input type="text" data-cb-label="${idx}" class="input" style="width:100%;" value="${escapeHtml(row.label)}" />
            </label>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:12px;color:var(--muted-foreground);">Couleur :</span>
            ${swatches}
          </div>
        </div>
      `;
    }).join('');
  }

  function openChartBuilder(opts = {}) {
    const numericTopics = getAllNumericTopics();
    if (numericTopics.length === 0) {
      showToast('Aucun topic numérique disponible à tracer');
      return;
    }

    const bid = state.status.brokerId || state.persisted.activeBrokerId;
    if (!state.persisted.dashboardsByBroker) state.persisted.dashboardsByBroker = {};
    if (!state.persisted.dashboardsByBroker[bid] || state.persisted.dashboardsByBroker[bid].length === 0) {
      state.persisted.dashboardsByBroker[bid] = [{ id: `dash-${Date.now()}`, name: 'Mon dashboard', charts: [] }];
      if (!state.persisted.activeDashByBroker) state.persisted.activeDashByBroker = {};
      state.persisted.activeDashByBroker[bid] = state.persisted.dashboardsByBroker[bid][0].id;
    }

    const dashes = getBrokerDashboards();
    const activeId = getActiveDashId();
    document.getElementById('cb-target-dash').innerHTML = dashes
      .map((d) => `<option value="${escapeHtml(d.id)}" ${d.id === activeId ? 'selected' : ''}>${escapeHtml(d.name)}</option>`)
      .join('');
    document.getElementById('cb-target-dash-wrap').classList.toggle('hidden', !opts.showDashSelect && !opts.editingChart);
    document.getElementById('cb-error').classList.add('hidden');

    if (opts.editingChart) {
      state.chartBuilder.editingChartId = opts.editingChart.id;
      document.getElementById('cb-modal-title').textContent = 'Modifier le graphique';
      document.getElementById('cb-title').value = opts.editingChart.title;
      document.getElementById('cb-span').value = String(opts.editingChart.span || 1);
      document.getElementById('cb-height').value = String(opts.editingChart.height || 240);
      document.getElementById('cb-scale').value = opts.editingChart.scale || 'raw';
      state.chartBuilder.series = (opts.editingChart.series || []).map((s) => ({ ...s }));
    } else {
      state.chartBuilder.editingChartId = null;
      document.getElementById('cb-modal-title').textContent = 'Créer un graphique multi-courbes';
      const defaultTopic = opts.prefillTopic && numericTopics.includes(opts.prefillTopic) ? opts.prefillTopic : numericTopics[0];
      const fields = getNumericFieldsForTopic(defaultTopic);
      const defaultField = fields[0]?.key || '__scalar__';
      const shortName = defaultTopic.split('/').pop();
      document.getElementById('cb-title').value = opts.prefillTopic ? `Suivi de ${shortName}` : '';
      document.getElementById('cb-span').value = '1';
      document.getElementById('cb-height').value = '240';
      document.getElementById('cb-scale').value = 'raw';
      state.chartBuilder.series = [{
        topic: defaultTopic,
        field: defaultField,
        label: defaultField === '__scalar__' ? shortName : `${shortName}.${defaultField}`,
        color: SERIES_COLORS[0].hex,
        hidden: false
      }];
    }

    renderBuilderSeriesRows();
    document.getElementById('chart-builder-modal').classList.remove('hidden');
    document.getElementById('cb-title').focus();
  }

  function closeChartBuilder() {
    document.getElementById('chart-builder-modal').classList.add('hidden');
  }

  // ---- Resizers ----
  (function initResizers() {
    const vRes = document.getElementById('sidebar-resizer');
    const grid = document.getElementById('workspace-grid');
    let dragV = false;

    function setSidebarWidth(px, persist) {
      state.sidebarWidth = Math.max(240, Math.min(560, Math.round(px)));
      grid.style.setProperty('--sidebar-w', `${state.sidebarWidth}px`);
      vRes.setAttribute('aria-valuenow', String(state.sidebarWidth));
      if (persist) savePrefs();
    }

    vRes.addEventListener('pointerdown', (e) => { dragV = true; vRes.setPointerCapture(e.pointerId); document.body.style.userSelect = 'none'; });
    vRes.addEventListener('pointermove', (e) => { if (dragV) setSidebarWidth(e.clientX - grid.getBoundingClientRect().left, false); });
    vRes.addEventListener('pointerup', () => { if (dragV) { dragV = false; document.body.style.userSelect = ''; savePrefs(); } });
    vRes.addEventListener('dblclick', () => setSidebarWidth(340, true));
    vRes.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') setSidebarWidth(state.sidebarWidth - 20, true);
      if (e.key === 'ArrowRight') setSidebarWidth(state.sidebarWidth + 20, true);
    });

    const pRes = document.getElementById('publish-resizer');
    const drawer = document.getElementById('publish-drawer');
    const main = document.getElementById('main-panel');
    let dragP = false;

    function setPubHeight(px, persist) {
      const maxH = Math.max(220, main.getBoundingClientRect().height - 200);
      state.publishHeight = Math.max(150, Math.min(maxH, Math.round(px)));
      if (!state.publishOpen) setPublishDrawerOpen(true, false);
      drawer.style.height = `${state.publishHeight}px`;
      pRes.setAttribute('aria-valuenow', String(state.publishHeight));
      if (state.activeTab === 'chart') requestAnimationFrame(drawTopicChart);
      if (persist) savePrefs();
    }

    pRes.addEventListener('pointerdown', (e) => { dragP = true; pRes.setPointerCapture(e.pointerId); document.body.style.userSelect = 'none'; });
    pRes.addEventListener('pointermove', (e) => {
      if (!dragP) return;
      const desired = main.getBoundingClientRect().bottom - e.clientY;
      if (desired > 65) setPubHeight(desired, false);
      else if (state.publishOpen) setPublishDrawerOpen(false, false);
    });
    pRes.addEventListener('pointerup', () => { if (dragP) { dragP = false; document.body.style.userSelect = ''; savePrefs(); } });
    pRes.addEventListener('dblclick', () => setPubHeight(230, true));
    pRes.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp') { e.preventDefault(); setPubHeight((state.publishHeight || 230) + 24, true); }
      if (e.key === 'ArrowDown') { e.preventDefault(); setPubHeight((state.publishHeight || 230) - 24, true); }
    });
  })();

  // ---- Events ----
  document.getElementById('nav-explorer').addEventListener('click', () => switchMainView('explorer'));
  document.getElementById('nav-dashboards').addEventListener('click', () => switchMainView('dashboards'));

  document.getElementById('pinned-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-select-topic]');
    if (btn) selectTopic(btn.getAttribute('data-select-topic'));
  });

  document.getElementById('topic-tree').addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-toggle-folder]');
    if (toggle) {
      const p = toggle.getAttribute('data-toggle-folder');
      if (state.expandedFolders.has(p)) state.expandedFolders.delete(p);
      else state.expandedFolders.add(p);
      renderTree();
      return;
    }
    const branch = e.target.closest('[data-select-branch]');
    if (branch) { selectBranch(branch.getAttribute('data-select-branch')); return; }
    const topic = e.target.closest('[data-select-topic]');
    if (topic) selectTopic(topic.getAttribute('data-select-topic'));
  });

  document.getElementById('breadcrumb-bar').addEventListener('click', (e) => {
    const topic = e.target.closest('[data-select-topic]');
    if (topic) selectTopic(topic.getAttribute('data-select-topic'));
    const branch = e.target.closest('[data-select-branch]');
    if (branch) selectBranch(branch.getAttribute('data-select-branch'));
  });

  document.getElementById('branch-tbody').addEventListener('click', (e) => {
    const topic = e.target.closest('[data-select-topic]');
    if (topic) selectTopic(topic.getAttribute('data-select-topic'));
  });

  document.getElementById('global-search').addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    renderTree();
  });

  document.getElementById('btn-clear-search').addEventListener('click', () => {
    state.searchQuery = '';
    document.getElementById('global-search').value = '';
    renderTree();
  });

  document.getElementById('btn-expand-toggle').addEventListener('click', () => {
    const btn = document.getElementById('btn-expand-toggle');
    if (state.allExpanded || state.expandedFolders.size > 0) {
      state.expandedFolders.clear();
      state.allExpanded = false;
      btn.textContent = 'Tout déplier';
    } else {
      Object.keys(state.topics).forEach(expandParents);
      state.allExpanded = true;
      btn.textContent = 'Tout replier';
    }
    renderTree();
  });

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.activeTab = btn.getAttribute('data-tab');
      document.querySelectorAll('.tab-btn').forEach((b) => {
        const active = b.getAttribute('data-tab') === state.activeTab;
        b.setAttribute('aria-selected', String(active));
        b.classList.toggle('active', active);
      });
      renderInspector();
    });
  });

  document.querySelectorAll('.theme-btn').forEach((btn) => {
    btn.addEventListener('click', () => applyTheme(btn.getAttribute('data-theme-choice'), true));
  });

  document.getElementById('btn-toggle-stream').addEventListener('click', async () => {
    const nextPaused = !state.status.paused;
    if (window.apiSetPaused) {
      const snap = await window.apiSetPaused(nextPaused);
      applySnapshot(snap, false);
    }
  });

  document.getElementById('btn-toggle-pin').addEventListener('click', async () => {
    if (state.selectionType !== 'topic' || !state.selectedPath) return;
    const bid = state.status.brokerId || state.persisted.activeBrokerId;
    if (!state.persisted.pinnedByBroker) state.persisted.pinnedByBroker = {};
    const cur = [...getPinnedList()];
    const idx = cur.indexOf(state.selectedPath);
    if (idx >= 0) cur.splice(idx, 1);
    else cur.push(state.selectedPath);
    state.persisted.pinnedByBroker[bid] = cur;
    if (window.apiSavePinned) await window.apiSavePinned(bid, cur);
    renderPinned();
    renderInspector();
    showToast(idx >= 0 ? 'Retiré des épinglés' : 'Ajouté aux épinglés');
  });

  document.getElementById('btn-copy-topic').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(state.selectedPath); } catch (_) {}
    document.getElementById('copy-topic-label').textContent = 'Copié';
    setTimeout(() => { document.getElementById('copy-topic-label').textContent = 'Copier le chemin'; }, 1400);
  });

  document.getElementById('btn-copy-payload').addEventListener('click', () => {
    navigator.clipboard?.writeText(document.getElementById('json-pre').textContent).catch(() => {});
    showToast('Contenu copié dans le presse-papiers');
  });

  document.getElementById('btn-toggle-publish').addEventListener('click', () => setPublishDrawerOpen(!state.publishOpen));
  document.getElementById('btn-toggle-pub-adv').addEventListener('click', () => {
    const box = document.getElementById('pub-adv-options');
    const hidden = box.classList.toggle('hidden');
    document.getElementById('btn-toggle-pub-adv').setAttribute('aria-expanded', String(!hidden));
  });

  document.querySelectorAll('.pub-mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.publishMode = btn.getAttribute('data-pub-mode');
      document.querySelectorAll('.pub-mode-btn').forEach((b) => {
        const active = b.getAttribute('data-pub-mode') === state.publishMode;
        b.classList.toggle('active', active);
        b.setAttribute('aria-pressed', String(active));
      });
      document.getElementById('pub-error').classList.add('hidden');
    });
  });

  document.getElementById('publish-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const targetTopic = document.getElementById('pub-topic-input').value.trim();
    const raw = document.getElementById('pub-payload').value.trim();
    const qos = Number(document.getElementById('pub-qos').value) || 0;
    const retain = document.getElementById('pub-retain').checked;
    const errEl = document.getElementById('pub-error');
    errEl.classList.add('hidden');

    if (!targetTopic) {
      errEl.textContent = 'Indiquez le chemin du topic (ex : orders/eu/created).';
      errEl.classList.remove('hidden');
      return;
    }
    if (!raw) {
      errEl.textContent = 'Saisissez un contenu avant de publier.';
      errEl.classList.remove('hidden');
      return;
    }
    if (state.publishMode === 'json') {
      try { JSON.parse(raw); } catch {
        errEl.textContent = 'Ce JSON contient une erreur de syntaxe (vérifiez les guillemets ou accolades).';
        errEl.classList.remove('hidden');
        return;
      }
    }

    try {
      const snap = await window.apiPublish(targetTopic, raw, qos, retain);
      expandParents(targetTopic);
      state.selectionType = 'topic';
      state.selectedPath = targetTopic;
      applySnapshot(snap, false);
      showToast(`Message publié sur ${targetTopic}`);
    } catch (err) {
      errEl.textContent = String(err);
      errEl.classList.remove('hidden');
    }
  });

  document.getElementById('btn-delete-retained').addEventListener('click', () => {
    if (!state.selectedPath) return;
    const targets = state.selectionType === 'branch'
      ? getBranchTopics(state.selectedPath).map(([k]) => k)
      : [state.selectedPath];
    const msg = state.selectionType === 'branch'
      ? `Cette action effacera les ${targets.length} topics sous <code class="mono" translate="no">${escapeHtml(state.selectedPath)}</code>.`
      : `Cette action retirera le message mémorisé sur <code class="mono" translate="no">${escapeHtml(state.selectedPath)}</code>.`;

    openConfirmModal('Confirmer la suppression ?', msg, async () => {
      try {
        const snap = await window.apiClearTopics(targets);
        state.selectedPath = '';
        applySnapshot(snap, false);
        showToast('Supprimé');
      } catch (err) {
        showToast(String(err));
      }
    });
  });

  document.getElementById('btn-cancel-delete').addEventListener('click', () => {
    state.pendingConfirm = null;
    document.getElementById('confirm-modal').classList.add('hidden');
  });

  document.getElementById('btn-confirm-delete').addEventListener('click', async () => {
    const fn = state.pendingConfirm;
    state.pendingConfirm = null;
    document.getElementById('confirm-modal').classList.add('hidden');
    if (fn) await fn();
  });

  // Connections Modal
  document.getElementById('btn-open-connections').addEventListener('click', openConnectionsModal);
  document.getElementById('btn-close-conn').addEventListener('click', closeConnectionsModal);
  document.getElementById('btn-cancel-conn').addEventListener('click', closeConnectionsModal);

  document.getElementById('broker-profiles-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-broker-id]');
    if (!btn) return;
    const found = (state.persisted.profiles || []).find((x) => x.id === btn.getAttribute('data-broker-id'));
    if (found) loadProfileIntoForm(found);
  });

  document.getElementById('btn-new-profile').addEventListener('click', () => {
    loadProfileIntoForm(emptyDraftProfile());
    document.getElementById('conn-name').focus();
  });

  document.getElementById('btn-delete-profile').addEventListener('click', async () => {
    if (!state.editingProfile) return;
    try {
      const updated = await window.apiDeleteProfile(state.editingProfile.id);
      if (window.apiBootstrap) {
        const snap = await window.apiBootstrap();
        applySnapshot(snap, false);
      } else {
        state.persisted = updated;
      }
      const next = (updated.profiles || [])[0] || emptyDraftProfile();
      loadProfileIntoForm(next);
      showToast('Profil supprimé');
    } catch (err) {
      showToast(String(err));
    }
  });

  document.getElementById('btn-conn-tls').addEventListener('click', () => {
    const isHidden = document.getElementById('conn-tls-body').classList.contains('hidden');
    setTlsSectionOpen(isHidden);
  });

  document.getElementById('btn-conn-adv').addEventListener('click', () => {
    const body = document.getElementById('conn-adv-body');
    const hidden = body.classList.toggle('hidden');
    document.getElementById('btn-conn-adv').setAttribute('aria-expanded', String(!hidden));
    document.getElementById('conn-adv-chevron').textContent = hidden ? 'Afficher' : 'Masquer';
  });

  document.getElementById('conn-proto').addEventListener('change', (e) => {
    const proto = e.target.value;
    const portInput = document.getElementById('conn-port');
    const curPort = portInput.value.trim();
    const defaultPorts = { mqtt: '1883', mqtts: '8883', ws: '8083', wss: '8084' };
    if (curPort === '' || Object.values(defaultPorts).includes(curPort) || curPort === '9001') {
      portInput.value = defaultPorts[proto] || '1883';
    }
    const tlsMeta = syncTlsBadge();
    if (tlsMeta.isTls) setTlsSectionOpen(true);
  });

  document.getElementById('conn-form').addEventListener('click', async (e) => {
    const pickBtn = e.target.closest('[data-pick-cert]');
    if (pickBtn) {
      const kind = pickBtn.getAttribute('data-pick-cert');
      const targetId = kind === 'ca' ? 'conn-ca-cert' : (kind === 'clientCert' ? 'conn-client-cert' : 'conn-client-key');
      try {
        const chosen = await pickCertFile(kind);
        if (chosen) {
          document.getElementById(targetId).value = chosen;
          syncTlsBadge();
        }
      } catch (err) {
        showToast(String(err));
      }
      return;
    }
    const clearBtn = e.target.closest('[data-clear-cert]');
    if (clearBtn) {
      const targetId = clearBtn.getAttribute('data-clear-cert');
      document.getElementById(targetId).value = '';
      syncTlsBadge();
    }
  });

  ['conn-ca-cert', 'conn-client-cert', 'conn-client-key'].forEach((id) => {
    document.getElementById(id).addEventListener('input', syncTlsBadge);
  });
  document.getElementById('conn-skip-tls').addEventListener('change', syncTlsBadge);

  document.getElementById('btn-test-conn').addEventListener('click', async () => {
    const btn = document.getElementById('btn-test-conn');
    const feedback = document.getElementById('conn-test-feedback');
    const profile = readProfileFromForm();
    btn.textContent = 'Test en cours…';
    btn.disabled = true;

    try {
      const res = await window.apiTestConnection(profile);
      feedback.classList.remove('hidden');
      feedback.className = `feedback-box ${res.ok ? 'feedback-ok' : 'feedback-err'}`;
      feedback.textContent = res.message;
    } catch (err) {
      feedback.classList.remove('hidden');
      feedback.className = 'feedback-box feedback-err';
      feedback.textContent = String(err);
    } finally {
      btn.textContent = 'Tester la connexion';
      btn.disabled = false;
    }
  });

  document.getElementById('conn-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('btn-submit-conn');
    const feedback = document.getElementById('conn-test-feedback');
    const profile = readProfileFromForm();
    btn.textContent = 'Connexion…';
    btn.disabled = true;

    try {
      const snap = await window.apiConnect(profile);
      state.selectedPath = '';
      state.expandedFolders.clear();
      state.didAutoExpand = false;
      applySnapshot(snap, false);
      renderTree();
      renderInspector();
      closeConnectionsModal();
      showToast(`Connecté à ${profile.name}`);
    } catch (err) {
      feedback.classList.remove('hidden');
      feedback.className = 'feedback-box feedback-err';
      feedback.textContent = String(err);
    } finally {
      btn.textContent = 'Se connecter';
      btn.disabled = false;
    }
  });

  // Dashboard & Chart Builder Events
  document.getElementById('btn-pin-to-dashboard').addEventListener('click', () => {
    openChartBuilder({ prefillTopic: state.selectedPath, showDashSelect: true });
  });
  document.getElementById('btn-add-chart').addEventListener('click', () => openChartBuilder());
  document.getElementById('btn-empty-add-chart').addEventListener('click', () => openChartBuilder());
  document.getElementById('btn-close-cb').addEventListener('click', closeChartBuilder);
  document.getElementById('btn-cancel-cb').addEventListener('click', closeChartBuilder);

  document.getElementById('btn-add-series-row').addEventListener('click', () => {
    const numericTopics = getAllNumericTopics();
    if (numericTopics.length === 0) return;
    const used = new Set(state.chartBuilder.series.map((s) => s.topic));
    const nextTopic = numericTopics.find((t) => !used.has(t)) || numericTopics[0];
    const fields = getNumericFieldsForTopic(nextTopic);
    const nextField = fields[0]?.key || '__scalar__';
    const shortName = nextTopic.split('/').pop();
    const nextColor = SERIES_COLORS[state.chartBuilder.series.length % SERIES_COLORS.length].hex;
    state.chartBuilder.series.push({
      topic: nextTopic,
      field: nextField,
      label: nextField === '__scalar__' ? shortName : `${shortName}.${nextField}`,
      color: nextColor,
      hidden: false
    });
    renderBuilderSeriesRows();
  });

  document.getElementById('cb-series-list').addEventListener('change', (e) => {
    const topicIdx = e.target.getAttribute('data-cb-topic');
    if (topicIdx !== null) {
      const i = Number(topicIdx);
      const t = e.target.value;
      const fields = getNumericFieldsForTopic(t);
      const f = fields[0]?.key || '__scalar__';
      const shortName = t.split('/').pop();
      state.chartBuilder.series[i].topic = t;
      state.chartBuilder.series[i].field = f;
      state.chartBuilder.series[i].label = f === '__scalar__' ? shortName : `${shortName}.${f}`;
      renderBuilderSeriesRows();
      return;
    }
    const fieldIdx = e.target.getAttribute('data-cb-field');
    if (fieldIdx !== null) {
      const i = Number(fieldIdx);
      const f = e.target.value;
      const shortName = state.chartBuilder.series[i].topic.split('/').pop();
      state.chartBuilder.series[i].field = f;
      state.chartBuilder.series[i].label = f === '__scalar__' ? shortName : `${shortName}.${f}`;
      renderBuilderSeriesRows();
    }
  });

  document.getElementById('cb-series-list').addEventListener('input', (e) => {
    const labelIdx = e.target.getAttribute('data-cb-label');
    if (labelIdx !== null) state.chartBuilder.series[Number(labelIdx)].label = e.target.value;
  });

  document.getElementById('cb-series-list').addEventListener('click', (e) => {
    const colorBtn = e.target.closest('[data-cb-color]');
    if (colorBtn) {
      const [idxStr, hex] = colorBtn.getAttribute('data-cb-color').split(':');
      state.chartBuilder.series[Number(idxStr)].color = hex;
      renderBuilderSeriesRows();
      return;
    }
    const removeBtn = e.target.closest('[data-cb-remove]');
    if (removeBtn) {
      state.chartBuilder.series.splice(Number(removeBtn.getAttribute('data-cb-remove')), 1);
      renderBuilderSeriesRows();
    }
  });

  document.getElementById('cb-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const errEl = document.getElementById('cb-error');
    errEl.classList.add('hidden');
    const title = document.getElementById('cb-title').value.trim();
    if (!title) {
      errEl.textContent = 'Donnez un titre clair à ce graphique.';
      errEl.classList.remove('hidden');
      return;
    }

    const bid = state.status.brokerId || state.persisted.activeBrokerId;
    const dashes = getBrokerDashboards();
    const targetDashId = document.getElementById('cb-target-dash').value || getActiveDashId();
    const dash = dashes.find((d) => d.id === targetDashId) || dashes[0];
    if (!dash) return;

    const chartPayload = {
      id: state.chartBuilder.editingChartId || `ch-${Date.now()}`,
      title,
      span: Number(document.getElementById('cb-span').value) || 1,
      height: Number(document.getElementById('cb-height').value) || 240,
      scale: document.getElementById('cb-scale').value || 'raw',
      series: state.chartBuilder.series.map((s) => ({
        ...s,
        label: s.label.trim() || s.topic.split('/').pop(),
        hidden: false
      }))
    };

    if (state.chartBuilder.editingChartId) {
      const idx = dash.charts.findIndex((c) => c.id === state.chartBuilder.editingChartId);
      if (idx >= 0) dash.charts[idx] = chartPayload;
    } else {
      dash.charts.push(chartPayload);
      if (!state.persisted.activeDashByBroker) state.persisted.activeDashByBroker = {};
      state.persisted.activeDashByBroker[bid] = dash.id;
    }

    saveDashboards();
    closeChartBuilder();
    if (state.viewMode === 'dashboards') renderDashboardsView();
    else switchMainView('dashboards');
    showToast('Graphique enregistré');
  });

  document.getElementById('dashboards-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-select-dash]');
    if (!btn) return;
    const bid = state.status.brokerId || state.persisted.activeBrokerId;
    if (!state.persisted.activeDashByBroker) state.persisted.activeDashByBroker = {};
    state.persisted.activeDashByBroker[bid] = btn.getAttribute('data-select-dash');
    saveDashboards();
    renderDashboardsView();
  });

  document.getElementById('dash-charts-grid').addEventListener('click', (e) => {
    const dash = getActiveDashboard();
    if (!dash) return;

    const toggleSeries = e.target.closest('[data-toggle-series]');
    if (toggleSeries) {
      const [cid, idxStr] = toggleSeries.getAttribute('data-toggle-series').split(':');
      const chart = dash.charts.find((c) => c.id === cid);
      if (chart && chart.series[Number(idxStr)]) {
        chart.series[Number(idxStr)].hidden = !chart.series[Number(idxStr)].hidden;
        saveDashboards();
        renderDashboardsView();
      }
      return;
    }

    const cycleH = e.target.closest('[data-cycle-height]');
    if (cycleH) {
      const chart = dash.charts.find((c) => c.id === cycleH.getAttribute('data-cycle-height'));
      if (chart) {
        const sizes = [180, 240, 320];
        chart.height = sizes[(sizes.indexOf(chart.height) + 1) % sizes.length];
        saveDashboards();
        renderDashboardsView();
      }
      return;
    }

    const spanBtn = e.target.closest('[data-toggle-span]');
    if (spanBtn) {
      const chart = dash.charts.find((c) => c.id === spanBtn.getAttribute('data-toggle-span'));
      if (chart) {
        chart.span = chart.span === 2 ? 1 : 2;
        saveDashboards();
        renderDashboardsView();
      }
      return;
    }

    const editBtn = e.target.closest('[data-edit-chart]');
    if (editBtn) {
      const chart = dash.charts.find((c) => c.id === editBtn.getAttribute('data-edit-chart'));
      if (chart) openChartBuilder({ editingChart: chart });
      return;
    }

    const removeBtn = e.target.closest('[data-remove-chart]');
    if (removeBtn) {
      const chart = dash.charts.find((c) => c.id === removeBtn.getAttribute('data-remove-chart'));
      if (!chart) return;
      openConfirmModal('Retirer ce graphique ?', `Le graphique <strong>${escapeHtml(chart.title)}</strong> sera supprimé.`, () => {
        dash.charts = dash.charts.filter((c) => c.id !== chart.id);
        saveDashboards();
        renderDashboardsView();
        showToast('Graphique retiré');
      });
    }
  });

  function openDashboardNameModal(mode) {
    state.ndMode = mode;
    const dash = getActiveDashboard();
    document.getElementById('nd-modal-title').textContent = mode === 'rename' ? 'Renommer le dashboard' : 'Nouveau dashboard';
    document.getElementById('nd-name').value = mode === 'rename' && dash ? dash.name : '';
    document.getElementById('nd-error').classList.add('hidden');
    document.getElementById('new-dashboard-modal').classList.remove('hidden');
    document.getElementById('nd-name').focus();
  }

  document.getElementById('btn-new-dashboard').addEventListener('click', () => openDashboardNameModal('create'));
  document.getElementById('btn-rename-dashboard').addEventListener('click', () => openDashboardNameModal('rename'));
  document.getElementById('btn-cancel-nd').addEventListener('click', () => document.getElementById('new-dashboard-modal').classList.add('hidden'));

  document.getElementById('nd-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('nd-name').value.trim();
    const errEl = document.getElementById('nd-error');
    if (!name) {
      errEl.textContent = 'Saisissez un nom pour le dashboard.';
      errEl.classList.remove('hidden');
      return;
    }

    const bid = state.status.brokerId || state.persisted.activeBrokerId;
    if (!state.persisted.dashboardsByBroker) state.persisted.dashboardsByBroker = {};
    if (!state.persisted.dashboardsByBroker[bid]) state.persisted.dashboardsByBroker[bid] = [];
    if (!state.persisted.activeDashByBroker) state.persisted.activeDashByBroker = {};

    if (state.ndMode === 'rename') {
      const dash = getActiveDashboard();
      if (dash) dash.name = name;
    } else {
      const created = { id: `dash-${Date.now()}`, name, charts: [] };
      state.persisted.dashboardsByBroker[bid].push(created);
      state.persisted.activeDashByBroker[bid] = created.id;
    }

    saveDashboards();
    document.getElementById('new-dashboard-modal').classList.add('hidden');
    renderDashboardsView();
  });

  document.getElementById('btn-delete-dashboard').addEventListener('click', () => {
    const dash = getActiveDashboard();
    if (!dash) return;
    openConfirmModal('Supprimer ce dashboard ?', `Le dashboard <strong>${escapeHtml(dash.name)}</strong> sera supprimé.`, () => {
      const bid = state.status.brokerId || state.persisted.activeBrokerId;
      state.persisted.dashboardsByBroker[bid] = getBrokerDashboards().filter((d) => d.id !== dash.id);
      state.persisted.activeDashByBroker[bid] = state.persisted.dashboardsByBroker[bid][0]?.id || '';
      saveDashboards();
      renderDashboardsView();
      showToast('Dashboard supprimé');
    });
  });

  // Keyboard & Window events
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (state.viewMode !== 'explorer') switchMainView('explorer');
      const s = document.getElementById('global-search');
      s.focus();
      s.select();
    } else if (e.key === 'Escape') {
      closeConnectionsModal();
      closeChartBuilder();
      document.getElementById('new-dashboard-modal').classList.add('hidden');
      document.getElementById('confirm-modal').classList.add('hidden');
    }
  });

  ['connections-modal', 'confirm-modal', 'chart-builder-modal', 'new-dashboard-modal'].forEach((id) => {
    document.getElementById(id).addEventListener('click', (e) => {
      if (e.target.id === id) document.getElementById(id).classList.add('hidden');
    });
  });

  window.addEventListener('resize', () => {
    if (state.viewMode === 'explorer' && state.activeTab === 'chart') drawTopicChart();
    if (state.viewMode === 'dashboards') drawAllDashboardCharts();
  });

  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (state.viewMode === 'explorer' && state.activeTab === 'chart') drawTopicChart();
      if (state.viewMode === 'dashboards') drawAllDashboardCharts();
    });
  }

  // Live snapshot push callback from Go backend
  window.__topiqttOnSnapshot = function (snap) {
    applySnapshot(snap, false);
  };

  // Bootstrap from Go backend
  async function bootstrap() {
    if (window.apiBootstrap) {
      try {
        const snap = await window.apiBootstrap();
        applySnapshot(snap, true);
      } catch (err) {
        showToast('Erreur d’initialisation : ' + String(err));
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
