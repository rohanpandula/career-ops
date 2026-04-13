/* career-ops command center */

const API = '';
let currentView = 'dashboard';
let statesCache = null;
let reportViewFile = null;
// Active cluster filter on the pipeline view: { id, name, urls: Set<string> }
let pipelineClusterFilter = null;

// Glyph dictionary — kept in JS so <option> labels can include the symbol.
// CSS ::before handles non-select elements; selects need the glyph inline.
const STATUS_GLYPH = {
  evaluated: '◯', applied: '→', responded: '↩', interview: '◆',
  offer: '★', rejected: '✕', discarded: '—', skip: '⊘', pending: '·',
};

const STATUS_TOOLTIP = {
  evaluated: 'Evaluated — report written, pending decision',
  applied:   'Applied — application submitted',
  responded: 'Responded — company replied',
  interview: 'Interview — in interview process',
  offer:     'Offer — offer received',
  rejected:  'Rejected — rejected by company',
  discarded: 'Discarded — listing closed or you passed',
  skip:      "Skip — doesn't fit, won't apply",
  pending:   'Pending evaluation',
};

function scoreTier(scoreStr) {
  const m = (scoreStr || '').match(/([\d.]+)/);
  if (!m) return { cls: '', tip: '' };
  const n = parseFloat(m[1]);
  if (n >= 4) return { cls: 'score-high', tip: `▲ Strong fit (${n}/5) — recommended` };
  if (n >= 3) return { cls: 'score-mid',  tip: `◆ Moderate fit (${n}/5) — borderline` };
  return { cls: 'score-low', tip: `▽ Weak fit (${n}/5) — below threshold` };
}

// --- Fetch helpers ---

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function getStates() {
  if (!statesCache) statesCache = await api('/api/states');
  return statesCache;
}

// --- Routing ---

function navigate(view, extra) {
  currentView = view;
  reportViewFile = extra || null;
  document.querySelectorAll('.nav-link').forEach(l => {
    l.classList.toggle('active', l.dataset.view === view);
  });
  render();
}

document.getElementById('nav').addEventListener('click', e => {
  const link = e.target.closest('[data-view]');
  if (link) {
    e.preventDefault();
    // Clear cluster filter when navigating away from pipeline via the nav bar
    if (link.dataset.view !== 'pipeline') pipelineClusterFilter = null;
    navigate(link.dataset.view);
  }
});

// --- Render ---

async function render() {
  const app = document.getElementById('app');
  app.innerHTML = '<div class="loading"><div class="spinner"></div>Loading...</div>';

  try {
    switch (currentView) {
      case 'dashboard': app.innerHTML = await renderDashboard(); break;
      case 'pipeline': app.innerHTML = await renderPipeline(); break;
      case 'tracker': app.innerHTML = await renderTracker(); break;
      case 'reports': app.innerHTML = reportViewFile ? await renderReport(reportViewFile) : await renderReportsList(); break;
      case 'scanner': app.innerHTML = await renderScanner(); break;
      case 'settings': app.innerHTML = await renderSettings(); break;
    }
    app.querySelector(':scope > *')?.classList.add('view-enter');
    bindEvents();
  } catch (e) {
    app.innerHTML = `<div class="empty-state"><div class="empty-state-title">Error</div>${e.message}</div>`;
  }
}

function bindEvents() {
  // Sortable tables
  document.querySelectorAll('th[data-sort]').forEach(th => {
    th.addEventListener('click', () => handleSort(th));
  });

  // Inline edits (Notes) — single click. Status uses a native select below.
  document.querySelectorAll('[data-editable]').forEach(el => {
    el.addEventListener('click', () => startEdit(el));
  });

  // Pipeline refresh — re-renders the view, which re-fetches /api/pipeline.
  const refreshBtn = document.getElementById('pipeline-refresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      const icon = refreshBtn.querySelector('svg');
      if (icon) icon.classList.add('spin-once');
      refreshBtn.disabled = true;
      await render();
    });
  }

  // Default liveness filter is "live only" — apply it on first render so the
  // table reflects the default instead of showing every row until the user
  // interacts with the dropdown.
  if (document.getElementById('pipeline-liveness')) filterPipeline();
  // Default sort is fit-desc — apply so the top of the table is the highest-fit row.
  if (document.getElementById('pipeline-sort')) applyPipelineSort();

  // --- Settings view bindings ---
  const bindTagInput = (inputId, field) => {
    const el = document.getElementById(inputId);
    if (!el) return;
    el.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      const val = el.value.trim();
      if (!val) return;
      const current = await api('/api/settings');
      const list = [...(current.title_filter?.[field] || [])];
      if (!list.includes(val)) list.push(val);
      await saveSettings({ title_filter: { ...current.title_filter, [field]: list } });
      render();
    });
  };
  bindTagInput('add-positive-input', 'positive');
  bindTagInput('add-negative-input', 'negative');

  document.querySelectorAll('[data-remove-positive], [data-remove-negative]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const isPositive = btn.hasAttribute('data-remove-positive');
      const idx = parseInt(btn.dataset[isPositive ? 'removePositive' : 'removeNegative'], 10);
      const current = await api('/api/settings');
      const field = isPositive ? 'positive' : 'negative';
      const list = [...(current.title_filter?.[field] || [])];
      list.splice(idx, 1);
      await saveSettings({ title_filter: { ...current.title_filter, [field]: list } });
      render();
    });
  });

  document.querySelectorAll('[data-company-toggle]').forEach(cb => {
    cb.addEventListener('change', async () => {
      const name = cb.dataset.companyToggle;
      await saveSettings({ tracked_companies: [{ name, enabled: cb.checked }] });
    });
  });

  const bindProfileInput = (id, group, key, cast = (v) => v) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('blur', async () => {
      const val = el.value.trim();
      await saveSettings({ profile: { [group]: { [key]: cast(val) } } });
    });
  };
  bindProfileInput('comp-target-range', 'compensation', 'target_range');
  bindProfileInput('comp-minimum', 'compensation', 'minimum', (v) => v ? parseInt(v, 10) : null);
  bindProfileInput('loc-city', 'location', 'city');
  bindProfileInput('loc-tz', 'location', 'timezone');

  // Pipeline verify — streams NDJSON from /api/pipeline/verify, updating
  // the per-row liveness dot as each URL resolves.
  const verifyBtn = document.getElementById('pipeline-verify');
  if (verifyBtn) {
    verifyBtn.addEventListener('click', () => verifyVisibleUrls(verifyBtn));
  }

  // Click a row's liveness glyph → verify just that URL.
  document.querySelectorAll('.live-dot-btn').forEach(btn => {
    btn.addEventListener('click', () => verifySingleUrl(btn));
  });

  // Click "Generate CV" → spawn claude -p on the server, stream logs into
  // a modal panel. Button stays disabled while running.
  document.querySelectorAll('.generate-cv-btn').forEach(btn => {
    btn.addEventListener('click', () => generateCvFor(btn));
  });

  // Status dropdown — save on change, optimistic badge swap, revert on fail.
  document.querySelectorAll('.status-select').forEach(sel => {
    sel.addEventListener('change', async () => {
      const id = sel.dataset.id;
      const prev = sel.dataset.current;
      const next = sel.value;
      // Optimistic: update badge color classes immediately
      sel.className = `status-select badge badge-${next.toLowerCase()}`;
      try {
        await api(`/api/applications/${id}`, {
          method: 'PUT',
          body: JSON.stringify({ Status: next }),
        });
        sel.dataset.current = next;
      } catch (e) {
        sel.value = prev;
        sel.className = `status-select badge badge-${prev.toLowerCase()}`;
        alert(`Could not update status: ${e.message}`);
      }
    });
  });

  // Clickable rows
  document.querySelectorAll('tr[data-report]').forEach(tr => {
    tr.addEventListener('click', () => {
      navigate('reports', tr.dataset.report);
    });
  });

  // Dashboard cluster chips — clicking filters the pipeline view to that URL set.
  document.querySelectorAll('.cluster-chip').forEach(chip => {
    chip.addEventListener('click', async () => {
      const id = chip.dataset.clusterId;
      try {
        const data = await api('/api/clusters');
        const c = (data.clusters || []).find(x => x.id === id);
        if (!c) return;
        pipelineClusterFilter = { id: c.id, name: c.name, urls: new Set(c.urls || []) };
        navigate('pipeline');
      } catch (e) {
        console.error(e);
      }
    });
  });

  // Pipeline: clear cluster filter button
  const clearClusterBtn = document.getElementById('pipeline-cluster-clear');
  if (clearClusterBtn) {
    clearClusterBtn.addEventListener('click', () => {
      pipelineClusterFilter = null;
      render();
    });
  }

  // Pipeline gap-analysis expand-on-click for rows that have data.
  document.querySelectorAll('#pipeline-table tbody tr.has-gap').forEach(tr => {
    tr.addEventListener('click', async (e) => {
      // Don't trigger when user clicked an actual control inside the row.
      if (e.target.closest('a, button, .icon-btn, .live-dot-btn, .url-link')) return;
      const next = tr.nextElementSibling;
      if (next?.classList.contains('gap-analysis-row')) {
        next.remove();
        tr.classList.remove('expanded');
        return;
      }
      const hash = tr.dataset.urlHash;
      if (!hash) return;
      const colSpan = tr.children.length;
      const placeholder = document.createElement('tr');
      placeholder.className = 'gap-analysis-row';
      placeholder.innerHTML = `<td colspan="${colSpan}"><div class="gap-analysis-loading">Loading gap analysis...</div></td>`;
      tr.parentNode.insertBefore(placeholder, tr.nextSibling);
      tr.classList.add('expanded');
      try {
        const data = await api(`/api/gap-analysis/${hash}`);
        placeholder.querySelector('td').innerHTML = renderGapAnalysis(data);
      } catch (err) {
        placeholder.querySelector('td').innerHTML = `<div class="gap-analysis-error">${escapeHtml(err.message || 'Failed to load')}</div>`;
      }
    });
  });

  // Report sections start expanded; h2 click collapses them. Uses
  // grid-template-rows 0fr → 1fr for smooth height animation without
  // animating the `height` property (would prevent browser optimizations).
  document.querySelectorAll('.report-content h2').forEach(h2 => {
    if (h2.nextElementSibling?.classList.contains('visible')) {
      h2.classList.add('expanded');
    }
    h2.addEventListener('click', () => {
      h2.classList.toggle('expanded');
      const section = h2.nextElementSibling;
      if (section?.classList.contains('report-section')) {
        section.classList.toggle('visible');
      }
    });
  });

  // Count-up motion on metric values — only after first paint, respects reduced-motion
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduced) {
    document.querySelectorAll('.metric-value[data-count]').forEach(el => animateCount(el));
  }
}

function animateCount(el) {
  const target = parseFloat(el.dataset.count);
  if (!isFinite(target) || target === 0) return;
  const decimals = parseInt(el.dataset.decimal || '0', 10);
  const duration = 700;
  const start = performance.now();
  const easeOutExpo = t => t === 1 ? 1 : 1 - Math.pow(2, -10 * t);

  const tick = (now) => {
    const p = Math.min(1, (now - start) / duration);
    const v = target * easeOutExpo(p);
    el.textContent = decimals > 0 ? v.toFixed(decimals) : Math.round(v);
    if (p < 1) requestAnimationFrame(tick);
    else el.textContent = decimals > 0 ? target.toFixed(decimals) : String(Math.round(target));
  };
  requestAnimationFrame(tick);
}

// --- Dashboard ---

async function renderDashboard() {
  const [stats, scanStatus, timeseries, clustersData] = await Promise.all([
    api('/api/stats'),
    api('/api/scanner/status'),
    api('/api/stats/timeseries').catch(() => ({ discoveries: [], companyStatus: [], applications: [] })),
    api('/api/clusters').catch(() => ({ clusters: [] })),
  ]);

  let logEntries = [];
  try { logEntries = await api('/api/scanner/log'); } catch {}

  const sc = stats.statusCounts;
  const countdown = scanStatus.lastScan
    ? getCountdown(scanStatus.lastScan, scanStatus.interval)
    : 'unknown';

  const recentActivity = logEntries.slice(-10).reverse();

  const byCompany = stats.byCompany || [];
  const maxCoCount = Math.max(...byCompany.map(c => c.count), 1);

  return `<div>
    <div class="view-header">
      <h1 class="view-title">Command Center</h1>
      <p class="view-subtitle">Pipeline health at a glance</p>
    </div>

    <div class="metrics">
      <div class="metric tint-warm">
        <div class="metric-value accent" data-count="${stats.pending}">${stats.pending}</div>
        <div class="metric-label">In Queue</div>
      </div>
      <div class="metric tint-mint">
        <div class="metric-value green" data-count="${stats.pipelineLive || 0}">${stats.pipelineLive || 0}</div>
        <div class="metric-label">Verified Live</div>
      </div>
      <div class="metric">
        <div class="metric-value red" data-count="${stats.pipelineDead || 0}">${stats.pipelineDead || 0}</div>
        <div class="metric-label">Dead</div>
      </div>
      <div class="metric">
        <div class="metric-value" data-count="${stats.pipelineUnverified || 0}">${stats.pipelineUnverified || 0}</div>
        <div class="metric-label">Unverified</div>
      </div>

      <div class="feature-panel">
        <div>
          <div class="feature-title">${stats.pending} opportunities in queue</div>
          <div class="feature-body">${stats.pipelineLive || 0} verified live · ${stats.pipelineDead || 0} dead · ${stats.pipelineUnverified || 0} unverified. Head to the pipeline view to triage.</div>
        </div>
      </div>

      <div class="metric">
        <div class="metric-value blue" data-count="${sc.applied || 0}">${sc.applied || 0}</div>
        <div class="metric-label">Applied</div>
      </div>
      <div class="metric tint-butter">
        <div class="metric-value yellow" data-count="${sc.interview || 0}">${sc.interview || 0}</div>
        <div class="metric-label">Interview</div>
      </div>
      <div class="metric tint-lilac">
        <div class="metric-value lilac" data-count="${stats.avgScore || 0}" data-decimal="1">${stats.avgScore || '--'}</div>
        <div class="metric-label">Avg Score</div>
      </div>
      <div class="metric">
        <div class="metric-value countdown" data-last="${scanStatus.lastScan || ''}" data-interval="${scanStatus.interval}">${countdown}</div>
        <div class="metric-label">Next Scan</div>
      </div>
    </div>

    ${renderClusters(clustersData)}

    <div class="two-col">
      <div>
        <div class="chart-panel">
          <div class="section-label">Pipeline by Company (top 10)</div>
          ${byCompany.length > 0 ? `
          <div class="company-chart">
            ${byCompany.map(c => {
              const pct = Math.max(6, (c.count / maxCoCount) * 100);
              return `<div class="company-row">
                <span class="company-name">${escapeHtml(c.company)}</span>
                <div class="company-bar-track">
                  <div class="company-bar" style="width: ${pct}%"></div>
                </div>
                <span class="company-count">${c.count}</span>
              </div>`;
            }).join('')}
          </div>` : '<div class="empty-state">No pipeline items yet</div>'}
        </div>

        <div class="section-label">Recent Applications</div>
        ${stats.applications.length > 0 ? `
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>Date</th><th>Company</th><th>Role</th><th>Score</th><th>Status</th>
            </tr></thead>
            <tbody>
              ${stats.applications.slice(0, 10).map(a => {
                const reportFile = extractReportFile(a.Report);
                return `<tr class="clickable" ${reportFile ? `data-report="${reportFile}"` : ''}>
                  <td>${a.Date}</td>
                  <td>${a.Company}</td>
                  <td style="max-width:200px">${a.Role}</td>
                  <td>${scoreMarkup(a.Score)}</td>
                  <td>${statusBadge(a.Status)}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>` : '<div class="empty-state"><div class="empty-state-title">No applications yet</div>Evaluate a job offer to get started</div>'}
      </div>

      <div>
        <div class="section-label">Activity Feed</div>
        ${recentActivity.length > 0 ? `
        <div class="feed">
          ${recentActivity.map(e => `
            <div class="feed-item">
              <span class="feed-time">${formatTime(e.timestamp)}</span>
              <span class="feed-msg">${escapeHtml(e.message)}</span>
            </div>
          `).join('')}
        </div>` : '<div class="empty-state">No scan activity yet</div>'}
      </div>
    </div>

    ${renderTimeSeriesCharts(timeseries)}
  </div>`;
}

function renderGapAnalysis(data) {
  if (data?.error) {
    return `<div class="gap-analysis"><div class="gap-section gap-error">⚠ ${escapeHtml(data.error)}</div></div>`;
  }
  const tag = (s, cls) => `<span class="gap-tag ${cls}">${escapeHtml(s)}</span>`;
  const matches = (data.matches || []).map(s => tag(s, 'gap-match')).join('');
  const gaps = (data.gaps || []).map(s => tag(s, 'gap-gap')).join('');
  const explain = (data.must_explain || []).map(s => `<li>${escapeHtml(s)}</li>`).join('');
  const date = data.analyzedAt ? `<span class="gap-meta">analyzed ${relativeDate(data.analyzedAt)}</span>` : '';
  return `<div class="gap-analysis">
    <div class="gap-grid">
      <div class="gap-section">
        <div class="gap-label">✓ Matches in your CV (${(data.matches || []).length})</div>
        <div class="gap-tags">${matches || '<span class="gap-empty">none</span>'}</div>
      </div>
      <div class="gap-section">
        <div class="gap-label">✗ Gaps the JD asks for (${(data.gaps || []).length})</div>
        <div class="gap-tags">${gaps || '<span class="gap-empty">none</span>'}</div>
      </div>
    </div>
    ${explain ? `<div class="gap-section">
      <div class="gap-label">▸ Address in cover letter (${(data.must_explain || []).length})</div>
      <ul class="gap-explain">${explain}</ul>
    </div>` : ''}
    ${date}
  </div>`;
}

function renderClusters(data) {
  const clusters = data?.clusters || [];
  if (!clusters.length) return '';
  return `
    <div class="chart-panel cluster-panel">
      <div class="section-label">Clusters <span style="color:var(--text-muted); font-weight:400; font-size:0.72rem">semantic grouping of ${data.generatedFor || 0} live fit ≥ ${data.minScore || '3.5'} URLs — click to filter pipeline</span></div>
      <div class="cluster-grid">
        ${clusters.map(c => `
          <button class="cluster-chip" data-cluster-id="${escapeAttr(c.id)}" data-tooltip="${escapeAttr((c.sampleTitles || []).join(' · '))}">
            <span class="cluster-name">${escapeHtml(c.name)}</span>
            <span class="cluster-count">${c.count}</span>
          </button>
        `).join('')}
      </div>
    </div>`;
}

function renderTimeSeriesCharts(ts) {
  if (!ts || (!ts.discoveries?.length && !ts.companyStatus?.length)) return '';

  // -- Chart 1: discoveries per day (bar) + cumulative pending (line overlay) --
  const disc = ts.discoveries || [];
  const maxDisc = Math.max(1, ...disc.map(d => d.discovered));
  const maxCum = Math.max(1, ...disc.map(d => d.cumulativePending || 0));

  const discSvg = (() => {
    if (!disc.length) return '<div class="empty-state">No discovery history yet</div>';
    const W = 560, H = 200, PAD = { t: 16, r: 40, b: 28, l: 34 };
    const innerW = W - PAD.l - PAD.r, innerH = H - PAD.t - PAD.b;
    const step = disc.length > 1 ? innerW / (disc.length - 1) : innerW;
    const barW = Math.max(6, Math.min(28, (disc.length > 1 ? step : innerW) * 0.55));
    const x = i => PAD.l + (disc.length > 1 ? i * step : innerW / 2);
    const yBar = v => PAD.t + innerH - (v / maxDisc) * innerH;
    const yLine = v => PAD.t + innerH - (v / maxCum) * innerH;
    const linePath = disc.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${yLine(d.cumulativePending).toFixed(1)}`).join(' ');

    return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Discoveries per day">
      <!-- gridlines -->
      ${[0, 0.25, 0.5, 0.75, 1].map(f => {
        const y = PAD.t + innerH * (1 - f);
        return `<line x1="${PAD.l}" y1="${y}" x2="${W - PAD.r}" y2="${y}" class="chart-grid" />
                <text x="${PAD.l - 6}" y="${y + 3}" class="chart-axis" text-anchor="end">${Math.round(maxDisc * f)}</text>`;
      }).join('')}
      <!-- bars -->
      ${disc.map((d, i) => `
        <rect x="${(x(i) - barW / 2).toFixed(1)}" y="${yBar(d.discovered).toFixed(1)}"
              width="${barW}" height="${(innerH - (yBar(d.discovered) - PAD.t)).toFixed(1)}"
              class="chart-bar-new" rx="2">
          <title>${d.date} — ${d.discovered} new, ${d.stillPending} still pending</title>
        </rect>
      `).join('')}
      <!-- cumulative line -->
      <path d="${linePath}" class="chart-line-cum" fill="none" />
      ${disc.map((d, i) => `
        <circle cx="${x(i).toFixed(1)}" cy="${yLine(d.cumulativePending).toFixed(1)}" r="3" class="chart-line-dot">
          <title>${d.date} — ${d.cumulativePending} cumulative pending</title>
        </circle>
      `).join('')}
      <!-- x-axis labels -->
      ${disc.map((d, i) => `
        <text x="${x(i).toFixed(1)}" y="${H - 8}" class="chart-axis" text-anchor="middle">${d.date.slice(5)}</text>
      `).join('')}
    </svg>`;
  })();

  // -- Chart 2: live vs dead vs unverified per company (stacked horizontal bars) --
  const cs = ts.companyStatus || [];
  const maxTotal = Math.max(1, ...cs.map(c => c.live + c.dead + c.unverified));
  const statusRows = cs.map(c => {
    const total = c.live + c.dead + c.unverified;
    const pct = Math.max(8, (total / maxTotal) * 100);
    const liveW = total > 0 ? (c.live / total) * pct : 0;
    const deadW = total > 0 ? (c.dead / total) * pct : 0;
    const unvW = total > 0 ? (c.unverified / total) * pct : 0;
    return `
      <div class="company-status-row" title="${escapeAttr(c.company)} — ${c.live} live, ${c.dead} dead, ${c.unverified} unverified">
        <span class="company-name">${escapeHtml(c.company)}</span>
        <div class="stacked-bar">
          <div class="stacked-seg seg-live" style="width:${liveW}%"></div>
          <div class="stacked-seg seg-dead" style="width:${deadW}%"></div>
          <div class="stacked-seg seg-unv" style="width:${unvW}%"></div>
        </div>
        <span class="company-count">
          <span class="pill-live">${c.live}</span>
          ${c.dead ? `<span class="pill-dead">${c.dead}</span>` : ''}
          ${c.unverified ? `<span class="pill-unv">${c.unverified}</span>` : ''}
        </span>
      </div>`;
  }).join('');

  return `
    <div class="chart-grid-row">
      <div class="chart-panel">
        <div class="section-label">Discoveries per day</div>
        <div class="chart-legend">
          <span><i class="swatch swatch-new"></i>New URLs scanned</span>
          <span><i class="swatch swatch-cum"></i>Cumulative pending</span>
        </div>
        <div class="chart-canvas">${discSvg}</div>
      </div>
      <div class="chart-panel">
        <div class="section-label">Company status (top 15)</div>
        <div class="chart-legend">
          <span><i class="swatch swatch-live"></i>Live</span>
          <span><i class="swatch swatch-dead"></i>Dead</span>
          <span><i class="swatch swatch-unv"></i>Unverified</span>
        </div>
        ${cs.length ? `<div class="company-status-list">${statusRows}</div>` : '<div class="empty-state">No company data yet</div>'}
      </div>
    </div>`;
}

// --- Pipeline ---

async function renderPipeline() {
  const [items, scanHistory, liveness, fitScores, gapMap, dupGroups] = await Promise.all([
    api('/api/pipeline'),
    api('/api/scan-history').catch(() => []),
    api('/api/liveness').catch(() => ({})),
    api('/api/fit-scores').catch(() => ({})),
    api('/api/gap-analysis').catch(() => ({})),
    api('/api/duplicates').catch(() => []),
  ]);

  // Build url → { canonical, dupCount } so each row knows its dup state.
  const dupInfo = new Map();
  for (const g of dupGroups || []) {
    dupInfo.set(g.canonical, { isCanonical: true, canonical: g.canonical, dupCount: g.duplicates.length });
    for (const d of g.duplicates) {
      dupInfo.set(d, { isCanonical: false, canonical: g.canonical, dupCount: g.duplicates.length });
    }
  }
  const pending = items.filter(i => !i.checked);

  // url → {first_seen, portal} from scan-history.tsv (fallback for never-verified URLs)
  const seenMap = new Map();
  for (const row of scanHistory) {
    if (row.url && !seenMap.has(row.url)) {
      seenMap.set(row.url, { first_seen: row.first_seen, portal: row.portal });
    }
  }

  const companies = [...new Set(pending.map(i => i.company))].sort();

  // Build city bucket counts from live pending items — US cities only.
  // Prefer Qwen-classified cityBuckets from the liveness cache (populated
  // by city-classify.mjs); fall back to the regex categorizer only for
  // entries that haven't been classified yet.
  const cityCounts = Object.fromEntries(CITY_BUCKETS.map(b => [b.key, 0]));
  for (const item of pending) {
    const l = liveness[item.url];
    if (!l || l.live !== true) continue;
    const buckets = Array.isArray(l.cityBuckets) && l.cityBuckets.length
      ? l.cityBuckets
      : categorizeLocations(l.location || '');
    for (const k of buckets) if (k in cityCounts) cityCounts[k]++;
  }
  const cityOptions = CITY_BUCKETS
    .filter(b => cityCounts[b.key] > 0)
    .sort((a, b) => cityCounts[b.key] - cityCounts[a.key])
    .map(b => `<option value="${b.key}">${b.label} (${cityCounts[b.key]})</option>`)
    .join('');

  // Salary bucket counts
  const SALARY_BUCKETS = [
    { key: 'under-150', label: 'Under $150K',   test: (n) => n != null && n < 150000 },
    { key: '150-250',   label: '$150K–$250K',   test: (n) => n != null && n >= 150000 && n < 250000 },
    { key: '250-350',   label: '$250K–$350K',   test: (n) => n != null && n >= 250000 && n < 350000 },
    { key: 'over-350',  label: '$350K+',        test: (n) => n != null && n >= 350000 },
    { key: 'not-posted',label: 'Not posted',    test: (_, sal) => !sal },
  ];
  const salCounts = Object.fromEntries(SALARY_BUCKETS.map(b => [b.key, 0]));
  for (const item of pending) {
    const l = liveness[item.url];
    if (!l || l.live !== true) continue;
    const sal = l.salary || '';
    const max = parseSalaryMax(sal);
    for (const b of SALARY_BUCKETS) if (b.test(max, sal)) salCounts[b.key]++;
  }

  // Fit counts (based on current cache, US cities only not enforced here — just counts)
  const fitCounts = { '5': 0, '4.5': 0, '4': 0, '3': 0, '2': 0, 'scored': 0, 'unscored': 0 };
  for (const item of pending) {
    if (liveness[item.url]?.live !== true) continue;
    const s = fitScores[item.url]?.score;
    if (typeof s !== 'number') { fitCounts.unscored++; continue; }
    fitCounts.scored++;
    if (s >= 4.5) fitCounts['5']++;
    if (s >= 4.5) fitCounts['4.5']++;
    if (s >= 3.5) fitCounts['4']++;
    if (s >= 2.5) fitCounts['3']++;
    if (s >= 1.5) fitCounts['2']++;
  }

  const mkCheckbox = (id, value, label, count) =>
    `<label class="multi-opt"><input type="checkbox" value="${escapeAttr(value)}" data-group="${id}"> <span>${escapeHtml(label)}</span><span class="opt-count">(${count})</span></label>`;

  const cityCheckboxes = CITY_BUCKETS
    .filter(b => cityCounts[b.key] > 0)
    .sort((a, b) => cityCounts[b.key] - cityCounts[a.key])
    .map(b => mkCheckbox('pipeline-location', b.key, b.label, cityCounts[b.key]))
    .join('');

  const salaryCheckboxes = SALARY_BUCKETS
    .filter(b => salCounts[b.key] > 0)
    .map(b => mkCheckbox('pipeline-salary', b.key, b.label, salCounts[b.key]))
    .join('');

  const clusterBanner = pipelineClusterFilter
    ? `<div class="cluster-banner">
         <span class="cluster-banner-label">Filtering by cluster</span>
         <span class="cluster-banner-name">${escapeHtml(pipelineClusterFilter.name)}</span>
         <span class="cluster-banner-count">${pipelineClusterFilter.urls.size} URLs</span>
         <button class="cluster-banner-clear" id="pipeline-cluster-clear" type="button">✕ Clear</button>
       </div>`
    : '';

  return `<div>
    ${clusterBanner}
    <div class="view-header">
      <div>
        <h1 class="view-title">Pipeline</h1>
        <p class="view-subtitle">${pending.length} pending opportunities</p>
      </div>
      <div style="display:flex; gap:var(--space-sm); align-items:center; flex-wrap:wrap">
        <button class="btn" id="pipeline-verify" title="Check that visible URLs still host a real posting (uses Playwright)">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M2 7l3 3 7-7"/>
          </svg>
          <span class="verify-label">Verify visible</span>
        </button>
        <button class="btn" id="pipeline-refresh" title="Reload pipeline from disk">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M11.5 6A4.5 4.5 0 1 0 7 10.5"/>
            <path d="M11.5 2v4h-4"/>
          </svg>
          Refresh
        </button>
      </div>
    </div>

    <div class="filters">
      <input type="text" class="filter-input" id="pipeline-search" placeholder="Search company or role...">
      <select class="filter-input" id="pipeline-company">
        <option value="">All companies</option>
        ${companies.map(c => `<option value="${c}">${c}</option>`).join('')}
      </select>
      <select class="filter-input" id="pipeline-liveness">
        <option value="alive" selected>✓ Live only</option>
        <option value="">Any status</option>
        <option value="dead">✕ Dead only</option>
        <option value="unknown">· Unverified only</option>
      </select>
      <details class="filter-multi" id="pipeline-salary-panel" data-filter-id="pipeline-salary">
        <summary class="filter-input">Salary <span class="multi-badge" data-count>Any</span></summary>
        <div class="multi-menu">${salaryCheckboxes}<button type="button" class="multi-clear" data-clear="pipeline-salary">Clear</button></div>
      </details>
      <details class="filter-multi" id="pipeline-location-panel" data-filter-id="pipeline-location">
        <summary class="filter-input" title="US cities only — each job contributes to every city it lists">City <span class="multi-badge" data-count>Any US</span></summary>
        <div class="multi-menu">${cityCheckboxes}<button type="button" class="multi-clear" data-clear="pipeline-location">Clear</button></div>
      </details>
      <div class="filter-slider" title="Minimum Qwen fit score">
        <label for="pipeline-fit-slider">
          Fit ≥ <span id="pipeline-fit-label">Any</span>
        </label>
        <input type="range" id="pipeline-fit-slider" min="0" max="5" step="0.5" value="0">
        <span class="multi-badge" id="pipeline-fit-count">${fitCounts.scored} scored</span>
      </div>
      <select class="filter-input" id="pipeline-sort">
        <option value="fit-desc">Fit: highest first</option>
        <option value="last_seen-desc">Newest first</option>
        <option value="last_seen-asc">Oldest first</option>
        <option value="company-asc">Company A→Z</option>
        <option value="company-desc">Company Z→A</option>
        <option value="role-asc">Role A→Z</option>
        <option value="live-desc">Live first</option>
        <option value="live-asc">Dead first</option>
      </select>
      <span style="color: var(--text-muted); font-size: 0.75rem; margin-left:auto" id="pipeline-count">${pending.length} items</span>
    </div>

    <div class="table-wrap">
      <table id="pipeline-table">
        <thead><tr>
          <th style="width:28px" data-sort="live" data-tooltip="Sort by liveness (live → unverified → dead)">&nbsp;</th>
          <th data-sort="last_seen" style="width:110px" data-tooltip="When we last confirmed the URL was live. Falls back to discovery date if never verified.">Last seen</th>
          <th data-sort="company">Company</th>
          <th data-sort="role">Role</th>
          <th data-sort="fit" style="width:72px" data-tooltip="Qwen-scored fit (1-5) against your profile. Run node fit-score.mjs to populate.">Fit</th>
          <th data-sort="location" style="width:140px" data-tooltip="Location is scraped from the posting when you verify the URL">Location</th>
          <th data-sort="salary" style="width:120px" data-tooltip="Salary range (when posted)">Salary</th>
          <th>URL</th>
          <th style="width:60px" data-tooltip="Generate CV (click the document glyph in any row)">&nbsp;</th>
        </tr></thead>
        <tbody>
          ${pending.map((item, i) => {
            const live = liveness[item.url] || null;
            const seen = seenMap.get(item.url);
            const firstSeen = seen?.first_seen || '';
            const portal = seen?.portal || 'unknown source';

            // Dot state: prefer saved liveness > default to unknown.
            let dotClass = 'live-dot live-unknown';
            let dotTip = 'Click to verify just this URL';
            if (live) {
              if (live.live) {
                dotClass = 'live-dot live-alive';
                dotTip = `Live (HTTP ${live.status || '?'}) — last checked ${relativeDate(live.verified_at)}. Click to re-verify.`;
              } else {
                dotClass = 'live-dot live-dead';
                dotTip = `Dead — ${live.reason || 'unknown'} (checked ${relativeDate(live.verified_at)}). Click to re-check.`;
              }
            }

            // "Last seen" cell: prefer the live.last_seen timestamp; fall back
            // to scan-history first-seen date so users see something useful
            // even before they've run Verify.
            let cellText = '—';
            let cellTip = 'Not in scan history. Click the glyph to verify.';
            if (live?.last_seen) {
              cellText = relativeDate(live.last_seen);
              cellTip = `Last confirmed live: ${new Date(live.last_seen).toLocaleString()}`;
            } else if (firstSeen) {
              cellText = relativeDate(firstSeen);
              cellTip = `Never verified — discovered ${relativeDate(firstSeen)} via ${portal}. Click the glyph to verify.`;
            }

            const deadCls = (live && !live.live) ? ' row-dead' : '';
            // For sorting: canonical live state + a numeric timestamp
            const liveState = live ? (live.live ? 'alive' : 'dead') : 'unknown';
            const liveSortRank = live ? (live.live ? 2 : 0) : 1; // live > unknown > dead
            // Use last_seen ISO for sort; fall back to first_seen date.
            const sortIso = live?.last_seen || (firstSeen ? firstSeen + 'T00:00:00' : '');
            const sortTs = sortIso ? new Date(sortIso).getTime() : 0;

            const location = live?.location || '';
            const salary = live?.salary || '';
            const locTip = location
              ? `Scraped from posting${live?.employmentType ? ` • ${live.employmentType}` : ''}`
              : 'Verify the URL to scrape location';
            const salTip = salary ? 'Scraped from posting' : 'No salary posted (or not yet verified)';

            const fit = fitScores[item.url] || null;
            const fitNum = typeof fit?.score === 'number' ? fit.score : null;
            const fitTier = fitNum == null ? ''
              : fitNum >= 4.5 ? 'fit-5'
              : fitNum >= 3.5 ? 'fit-4'
              : fitNum >= 2.5 ? 'fit-3'
              : fitNum >= 1.5 ? 'fit-2'
              : 'fit-1';
            const fitTip = fitNum == null
              ? 'No fit score yet — run node fit-score.mjs'
              : `${fitNum.toFixed(1)}/5 — ${fit.reason || ''}`;
            const fitCell = fitNum == null
              ? '—'
              : `<span class="fit-chip ${fitTier}">${fitNum.toFixed(1)}</span>`;

            const cachedCities = Array.isArray(live?.cityBuckets) ? live.cityBuckets.join(',') : '';
            const gap = gapMap[item.url];
            const hasGap = !!(gap && (gap.matches?.length || gap.gaps?.length));
            const gapBadge = hasGap ? `<span class="gap-toggle" data-tooltip="Click to view CV gap analysis">▾</span>` : '';
            const dup = dupInfo.get(item.url);
            const dupBadge = dup
              ? (dup.isCanonical
                  ? `<span class="dup-chip dup-canonical" data-tooltip="${dup.dupCount} other URL${dup.dupCount > 1 ? 's' : ''} point to this same role">+${dup.dupCount} dup</span>`
                  : `<a href="${escapeAttr(dup.canonical)}" target="_blank" rel="noopener" class="dup-chip dup-secondary" data-tooltip="Duplicate — canonical URL: ${escapeAttr(dup.canonical)}">↗ canonical</a>`)
              : '';
            return `<tr class="${deadCls}${hasGap ? ' has-gap' : ''}" data-company="${item.company}" data-role="${item.role}" data-url="${escapeAttr(item.url)}" data-url-hash="${gap?.hash || ''}" data-live="${liveState}" data-live-rank="${liveSortRank}" data-last-seen-ts="${sortTs}" data-location="${escapeAttr(location)}" data-cities="${escapeAttr(cachedCities)}" data-salary="${escapeAttr(salary)}" data-fit="${fitNum ?? ''}">
              <td data-sort-value="${liveSortRank}"><button class="live-dot-btn" data-verify-url="${escapeAttr(item.url)}" data-tooltip="${escapeAttr(dotTip)}"><span class="${dotClass}"></span></button></td>
              <td class="first-seen" data-sort-value="${sortTs}" data-tooltip="${escapeAttr(cellTip)}">${cellText}</td>
              <td>${item.company}${gapBadge}</td>
              <td>${item.role}${dupBadge}</td>
              <td class="cell-fit" data-sort-value="${fitNum ?? -1}" data-tooltip="${escapeAttr(fitTip)}">${fitCell}</td>
              <td class="cell-location" data-sort-value="${escapeAttr(location.toLowerCase())}" data-tooltip="${escapeAttr(locTip)}">${location || '—'}</td>
              <td class="cell-salary" data-sort-value="${escapeAttr(salary.toLowerCase())}" data-tooltip="${escapeAttr(salTip)}">${salary || '—'}</td>
              <td><a class="url-link" href="${item.url}" target="_blank" rel="noopener">${truncateUrl(item.url)}</a></td>
              <td>
                <button class="icon-btn generate-cv-btn"
                        data-url="${escapeAttr(item.url)}"
                        data-company="${escapeAttr(item.company)}"
                        data-role="${escapeAttr(item.role)}"
                        data-tooltip="Generate a tailored CV and evaluation report for this JD (3–6 min)"
                        aria-label="Generate CV">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M9 1.5H3.5A1.5 1.5 0 0 0 2 3v10a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 14 13V6.5z"/>
                    <path d="M9 1.5V6.5H14"/>
                    <path d="M11.5 11H6.5"/>
                    <path d="M11.5 8.5H6.5"/>
                  </svg>
                </button>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  </div>`;
}

// --- Tracker ---

async function renderTracker() {
  const [apps, states] = await Promise.all([api('/api/applications'), getStates()]);
  const stateList = states.states.map(s => s.label);

  return `<div>
    <div class="view-header" style="display: flex; justify-content: space-between; align-items: flex-start">
      <div>
        <h1 class="view-title">Tracker</h1>
        <p class="view-subtitle">${apps.length} applications</p>
      </div>
      <a href="/api/applications/csv" class="btn" download>Export CSV</a>
    </div>

    <div class="filters">
      <input type="text" class="filter-input" id="tracker-search" placeholder="Search...">
      <select class="filter-input" id="tracker-status-filter">
        <option value="">All statuses</option>
        ${stateList.map(s => `<option value="${s}">${s}</option>`).join('')}
      </select>
    </div>

    <div class="table-wrap">
      <table id="tracker-table">
        <thead><tr>
          <th data-sort="#">#</th>
          <th data-sort="Date">Date</th>
          <th data-sort="Company">Company</th>
          <th data-sort="Role">Role</th>
          <th data-sort="Score">Score</th>
          <th data-sort="Status">Status</th>
          <th>PDF</th>
          <th>Report</th>
          <th>Notes</th>
        </tr></thead>
        <tbody>
          ${apps.map(a => {
            const reportFile = extractReportFile(a.Report);
            return `<tr>
              <td>${a['#']}</td>
              <td>${a.Date}</td>
              <td>${a.Company}</td>
              <td style="max-width:200px">${a.Role}</td>
              <td>${scoreMarkup(a.Score)}</td>
              <td>
                <select class="status-select badge badge-${(a.Status || '').toLowerCase()}" data-id="${a['#']}" data-current="${a.Status}" data-tooltip="${STATUS_TOOLTIP[(a.Status || '').toLowerCase()] || 'Change status'}">
                  ${stateList.map(s => {
                    const k = s.toLowerCase();
                    return `<option value="${s}"${k === (a.Status || '').toLowerCase() ? ' selected' : ''}>${STATUS_GLYPH[k] || '·'}  ${s}</option>`;
                  }).join('')}
                </select>
              </td>
              <td>${a.PDF}</td>
              <td>${reportFile ? `<a href="#" class="report-link" data-report="${reportFile}" style="color: var(--accent); text-decoration: none">${a.Report.replace(/[\[\]]/g, '').split('(')[0]}</a>` : a.Report}</td>
              <td style="max-width:250px">
                <span data-editable="Notes" data-id="${a['#']}" class="editable" title="Click to edit">${a.Notes || '--'}</span>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  </div>`;
}

// --- Reports List ---

async function renderReportsList() {
  const reports = await api('/api/reports');

  return `<div>
    <div class="view-header">
      <h1 class="view-title">Reports</h1>
      <p class="view-subtitle">${reports.length} evaluation reports</p>
    </div>

    ${reports.length > 0 ? `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Report</th></tr></thead>
        <tbody>
          ${reports.map(r => `
            <tr class="clickable" data-report="${r.filename}">
              <td>${r.filename}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>` : '<div class="empty-state"><div class="empty-state-title">No reports yet</div>Evaluate a job offer to generate a report</div>'}
  </div>`;
}

// --- Single Report ---

async function renderReport(filename) {
  const { content } = await api(`/api/reports/${encodeURIComponent(filename)}`);
  const html = markdownToHtml(content);

  // Extract meta from first lines
  const lines = content.split('\n');
  const meta = {};
  for (const line of lines) {
    const m = line.match(/^\*\*(.+?):\*\*\s*(.+)$/);
    if (m) meta[m[1]] = m[2];
  }

  return `<div>
    <a href="#" class="back-link" onclick="event.preventDefault(); navigate('reports');">\u2190 All Reports</a>

    ${Object.keys(meta).length > 0 ? `
    <div class="report-meta">
      ${meta.Score ? `<div class="report-meta-item"><span class="report-meta-label">Score</span><span class="report-meta-value score ${scoreClass(meta.Score)}">${meta.Score}</span></div>` : ''}
      ${meta.Date ? `<div class="report-meta-item"><span class="report-meta-label">Date</span><span class="report-meta-value">${meta.Date}</span></div>` : ''}
      ${meta.Archetype ? `<div class="report-meta-item"><span class="report-meta-label">Archetype</span><span class="report-meta-value">${meta.Archetype}</span></div>` : ''}
      ${meta.URL ? `<div class="report-meta-item"><span class="report-meta-label">URL</span><span class="report-meta-value"><a href="${meta.URL}" target="_blank" rel="noopener" style="color: var(--accent)">${truncateUrl(meta.URL)}</a></span></div>` : ''}
      ${meta.PDF ? `<div class="report-meta-item"><span class="report-meta-label">PDF</span><span class="report-meta-value">${meta.PDF}</span></div>` : ''}
    </div>` : ''}

    <div class="report-content">${html}</div>
  </div>`;
}

// --- Scanner ---

// --- Settings ---

async function renderSettings() {
  const s = await api('/api/settings');
  const comp = s.profile?.compensation || {};
  const loc = s.profile?.location || {};

  const posTags = (s.title_filter?.positive || []).map((t, i) =>
    `<span class="tag">${escapeHtml(t)}<button class="tag-x" data-remove-positive="${i}" aria-label="Remove">✕</button></span>`
  ).join('');
  const negTags = (s.title_filter?.negative || []).map((t, i) =>
    `<span class="tag">${escapeHtml(t)}<button class="tag-x" data-remove-negative="${i}" aria-label="Remove">✕</button></span>`
  ).join('');

  // Source glyphs: each data source gets a distinct shape so the badge is
  // distinguishable without color (◆ Greenhouse API, ◇ Ashby, ⊡ CD.io, ∙ legacy)
  const SOURCE_GLYPH = { greenhouse: '◆', ashby: '◇', cd: '⊡', legacy: '∙', unknown: '·' };

  const companies = (s.tracked_companies || []).map(c => {
    const glyph = SOURCE_GLYPH[c.source] || '·';
    const tip = `${c.source_label}${c.source_detail ? ' — ' + c.source_detail : ''}`;
    const muted = c.source === 'legacy' ? ' row-muted' : '';
    return `<label class="company-row${muted}">
      <input type="checkbox" data-company-toggle="${escapeAttr(c.name)}" ${c.enabled ? 'checked' : ''}>
      <div class="company-info">
        <span class="company-name">${escapeHtml(c.name)}</span>
        <span class="company-notes">${escapeHtml(c.notes || '')}</span>
      </div>
      <span class="company-source source-${c.source}" data-tooltip="${escapeAttr(tip)}">
        <span class="source-glyph">${glyph}</span>
        <span class="source-label">${escapeHtml(c.source_label)}</span>
      </span>
    </label>`;
  }).join('');

  return `<div>
    <div class="view-header">
      <div>
        <h1 class="view-title">Settings</h1>
        <p class="view-subtitle">Tune what the scanner surfaces. Changes save to portals.yml and config/profile.yml.</p>
      </div>
      <span class="settings-status" id="settings-status"></span>
    </div>

    <div class="settings-section">
      <div class="section-label">Target keywords</div>
      <p class="settings-help">Titles must contain at least one positive keyword and zero negative keywords to pass the scanner's filter.</p>

      <div class="settings-subsection">
        <div class="subsection-label">Include (positive)</div>
        <div class="tag-list" id="positive-tags">${posTags}</div>
        <div class="tag-input-row">
          <input type="text" class="filter-input" id="add-positive-input" placeholder="Add a keyword, press Enter">
        </div>
      </div>

      <div class="settings-subsection">
        <div class="subsection-label">Exclude (negative)</div>
        <div class="tag-list" id="negative-tags">${negTags}</div>
        <div class="tag-input-row">
          <input type="text" class="filter-input" id="add-negative-input" placeholder="Add a keyword, press Enter">
        </div>
      </div>
    </div>

    <div class="settings-section">
      <div class="section-label">Tracked companies</div>
      <p class="settings-help">Uncheck to stop the scanner from polling a company. Add new ones by editing portals.yml directly.</p>
      <div class="company-list">${companies}</div>
    </div>

    <div class="settings-section">
      <div class="section-label">Compensation target</div>
      <p class="settings-help">Used by evaluation reports to score offers against your target range.</p>
      <div class="settings-grid">
        <label>
          <span class="subsection-label">Target range</span>
          <input type="text" class="filter-input" id="comp-target-range" value="${escapeAttr(comp.target_range || '')}" placeholder="$250K-$350K">
        </label>
        <label>
          <span class="subsection-label">Minimum (numeric)</span>
          <input type="number" class="filter-input" id="comp-minimum" value="${comp.minimum || ''}" placeholder="200000">
        </label>
      </div>
    </div>

    <div class="settings-section">
      <div class="section-label">Location</div>
      <div class="settings-grid">
        <label>
          <span class="subsection-label">City</span>
          <input type="text" class="filter-input" id="loc-city" value="${escapeAttr(loc.city || '')}" placeholder="Los Angeles">
        </label>
        <label>
          <span class="subsection-label">Timezone</span>
          <input type="text" class="filter-input" id="loc-tz" value="${escapeAttr(loc.timezone || '')}" placeholder="PST">
        </label>
      </div>
    </div>
  </div>`;
}

async function saveSettings(payload) {
  const status = document.getElementById('settings-status');
  if (status) { status.textContent = 'saving...'; status.className = 'settings-status saving'; }
  try {
    await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    if (status) { status.textContent = '✓ saved'; status.className = 'settings-status saved'; }
    setTimeout(() => { if (status) status.textContent = ''; }, 2500);
  } catch (e) {
    if (status) { status.textContent = `✕ ${e.message}`; status.className = 'settings-status error'; }
  }
}

async function renderScanner() {
  const [status, log] = await Promise.all([
    api('/api/scanner/status'),
    api('/api/scanner/log'),
  ]);

  let cdWatches = null;
  try { cdWatches = await api('/api/scanner/cd-watches'); } catch {}

  const lastEntries = log.slice(-25).reverse();
  const lastScanTime = status.lastScan ? new Date(status.lastScan).toLocaleString() : 'never';
  const countdown = status.lastScan ? getCountdown(status.lastScan, status.interval) : '--';

  return `<div>
    <div class="view-header">
      <h1 class="view-title">Scanner Control</h1>
      <p class="view-subtitle">Automated job discovery</p>
    </div>

    <div class="metrics" style="margin-bottom: var(--space-xl)">
      <div class="metric">
        <div class="metric-value">${lastScanTime}</div>
        <div class="metric-label">Last Scan</div>
      </div>
      <div class="metric">
        <div class="metric-value countdown">${countdown}</div>
        <div class="metric-label">Next Scan</div>
      </div>
      <div class="metric">
        <div class="metric-value">${Math.round(status.interval / 3600)}h</div>
        <div class="metric-label">Interval</div>
      </div>
    </div>

    <div style="margin-bottom: var(--space-xl)">
      <button class="btn btn-accent" id="scan-now-btn" onclick="triggerScan()">Scan Now</button>
    </div>

    <div class="scanner-grid">
      <div class="panel">
        <div class="panel-header">
          <span class="panel-title">Scan Log</span>
          <span style="font-size: 0.72rem; color: var(--text-muted)">${log.length} entries</span>
        </div>
        <div class="panel-body">
          ${lastEntries.length > 0 ? `
          <div class="feed">
            ${lastEntries.map(e => `
              <div class="feed-item">
                <span class="feed-time">${formatTime(e.timestamp)}</span>
                <span class="feed-msg">${escapeHtml(e.message)}</span>
              </div>
            `).join('')}
          </div>` : '<div class="empty-state">No log entries</div>'}
        </div>
      </div>

      <div class="panel">
        <div class="panel-header">
          <span class="panel-title">ChangeDetection.io</span>
          <span style="font-size: 0.72rem; color: ${cdWatches && !cdWatches.error ? 'var(--green)' : 'var(--red)'}">
            ${cdWatches && !cdWatches.error ? 'connected' : 'offline'}
          </span>
        </div>
        <div class="panel-body">
          ${cdWatches && !cdWatches.error ? renderCdWatches(cdWatches) :
            `<div class="empty-state">${cdWatches?.error || 'Could not reach ChangeDetection.io'}<br><span style="font-size:0.72rem">http://10.0.0.100:5000</span></div>`}
        </div>
      </div>
    </div>
  </div>`;
}

function renderCdWatches(watches) {
  if (typeof watches !== 'object') return '<div class="empty-state">Unexpected response</div>';
  const entries = Object.entries(watches);
  if (entries.length === 0) return '<div class="empty-state">No watches configured</div>';

  return `<div class="feed">
    ${entries.map(([uuid, watch]) => `
      <div class="feed-item" style="grid-template-columns: 1fr">
        <div>
          <div style="font-size: 0.82rem; color: var(--text-primary)">${watch.title || watch.url || uuid}</div>
          <div style="font-size: 0.72rem; color: var(--text-muted); margin-top: 2px">
            ${watch.last_checked ? `Last checked: ${new Date(watch.last_checked * 1000).toLocaleString()}` : 'Not yet checked'}
          </div>
        </div>
      </div>
    `).join('')}
  </div>`;
}

// --- Actions ---

async function triggerScan() {
  const btn = document.getElementById('scan-now-btn');
  btn.disabled = true;
  btn.textContent = 'Scanning...';
  try {
    const result = await api('/api/scanner/run', { method: 'POST' });
    btn.textContent = result.success ? 'Done!' : 'Failed';
    setTimeout(() => render(), 2000);
  } catch (e) {
    btn.textContent = 'Error';
  }
}

// --- Inline Editing ---

function startEdit(el) {
  const field = el.dataset.editable;
  const id = el.dataset.id;
  const currentValue = el.textContent.trim();

  if (field === 'Status') {
    const states = JSON.parse(el.dataset.states);
    const select = document.createElement('select');
    select.className = 'edit-select';
    states.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s;
      if (s.toLowerCase() === currentValue.toLowerCase()) opt.selected = true;
      select.appendChild(opt);
    });
    el.replaceWith(select);
    select.focus();

    const save = async () => {
      const newVal = select.value;
      try {
        await api(`/api/applications/${id}`, {
          method: 'PUT',
          body: JSON.stringify({ [field]: newVal }),
        });
      } catch {}
      render();
    };

    select.addEventListener('change', save);
    select.addEventListener('blur', save);
  } else {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'edit-input';
    input.value = currentValue === '--' ? '' : currentValue;
    el.replaceWith(input);
    input.focus();
    input.select();

    const save = async () => {
      const newVal = input.value;
      try {
        await api(`/api/applications/${id}`, {
          method: 'PUT',
          body: JSON.stringify({ [field]: newVal }),
        });
      } catch {}
      render();
    };

    input.addEventListener('blur', save);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') save();
      if (e.key === 'Escape') render();
    });
  }
}

// --- Table Sorting ---

let sortState = {};

function handleSort(th) {
  const table = th.closest('table');
  const key = th.dataset.sort;
  const tbody = table.querySelector('tbody');
  const rows = [...tbody.querySelectorAll('tr')];

  const dir = sortState[key] === 'asc' ? 'desc' : 'asc';
  sortState = { [key]: dir };

  table.querySelectorAll('th').forEach(t => {
    t.classList.remove('sorted-asc', 'sorted-desc');
  });
  th.classList.add(`sorted-${dir}`);

  const colIdx = [...th.parentElement.children].indexOf(th);
  sortRows(tbody, rows, colIdx, dir);
}

// Pulled out of handleSort so programmatic sorts (dropdown) can reuse it.
// Prefers `data-sort-value` on the cell for numeric/typed sorts (timestamps,
// ranks) — falls back to visible textContent.
function sortRows(tbody, rows, colIdx, dir) {
  rows.sort((a, b) => {
    const aCell = a.children[colIdx];
    const bCell = b.children[colIdx];
    const aSV = aCell?.dataset.sortValue;
    const bSV = bCell?.dataset.sortValue;
    if (aSV !== undefined && bSV !== undefined) {
      const aN = parseFloat(aSV);
      const bN = parseFloat(bSV);
      if (!isNaN(aN) && !isNaN(bN)) return dir === 'asc' ? aN - bN : bN - aN;
      return dir === 'asc' ? String(aSV).localeCompare(bSV) : String(bSV).localeCompare(aSV);
    }
    const aVal = aCell?.textContent.trim() || '';
    const bVal = bCell?.textContent.trim() || '';
    const aNum = parseFloat(aVal);
    const bNum = parseFloat(bVal);
    if (!isNaN(aNum) && !isNaN(bNum)) {
      return dir === 'asc' ? aNum - bNum : bNum - aNum;
    }
    return dir === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
  });
  rows.forEach(r => tbody.appendChild(r));
}

// Apply the pipeline sort dropdown. Maps option value ("last_seen-desc")
// to the corresponding column index + direction.
function applyPipelineSort() {
  const val = document.getElementById('pipeline-sort')?.value;
  if (!val) return;
  const [key, dir] = val.split('-');
  const table = document.getElementById('pipeline-table');
  if (!table) return;
  const th = table.querySelector(`th[data-sort="${key}"]`);
  if (!th) return;
  const tbody = table.querySelector('tbody');
  const rows = [...tbody.querySelectorAll('tr')];
  const colIdx = [...th.parentElement.children].indexOf(th);
  table.querySelectorAll('th').forEach(t => t.classList.remove('sorted-asc', 'sorted-desc'));
  th.classList.add(`sorted-${dir}`);
  sortRows(tbody, rows, colIdx, dir);
}

// --- Filtering ---

const PIPELINE_FILTER_IDS = ['pipeline-search', 'pipeline-company', 'pipeline-liveness', 'pipeline-fit-slider'];
const PIPELINE_FILTER_GROUPS = ['pipeline-salary', 'pipeline-location'];

document.getElementById('app').addEventListener('input', e => {
  if (PIPELINE_FILTER_IDS.includes(e.target.id)) filterPipeline();
  if (['tracker-search', 'tracker-status-filter'].includes(e.target.id)) filterTracker();
});

document.getElementById('app').addEventListener('change', e => {
  if (PIPELINE_FILTER_IDS.includes(e.target.id)) filterPipeline();
  if (e.target.type === 'checkbox' && PIPELINE_FILTER_GROUPS.includes(e.target.dataset.group)) filterPipeline();
  if (e.target.id === 'pipeline-sort') applyPipelineSort();
  if (e.target.id === 'tracker-status-filter') filterTracker();
});

// Clear-button handler for multi-select filters.
document.getElementById('app').addEventListener('click', e => {
  const btn = e.target.closest('.multi-clear');
  if (!btn) return;
  const group = btn.dataset.clear;
  document.querySelectorAll(`input[data-group="${group}"]`).forEach(cb => { cb.checked = false; });
  filterPipeline();
});

// Parse the max end of a salary range string. Returns a number in full
// dollars (not thousands) or null if unparseable.
// Examples: "$120K–$155K" -> 155000, "$120,000–$155,000" -> 155000,
//           "$250K+" -> 250000, "$100/hour" -> null (hourly, not annual)
function parseSalaryMax(s) {
  if (!s) return null;
  const str = String(s).replace(/,/g, '');
  // Hourly / weekly / monthly — skip, since our buckets are annual
  if (/\/\s*(hour|day|week|month)|per\s+(hour|day|week|month)/i.test(str)) return null;
  // Grab all numeric tokens with optional K suffix
  const tokens = [...str.matchAll(/\$?\s*(\d+(?:\.\d+)?)(\s*[Kk])?/g)];
  if (tokens.length === 0) return null;
  const nums = tokens.map(m => {
    const n = parseFloat(m[1]);
    return m[2] ? n * 1000 : n;
  }).filter(n => n > 1000); // filter out incidental small numbers like "3"
  if (nums.length === 0) return null;
  return Math.max(...nums);
}

// City buckets — US-only. A single job can match multiple buckets when
// the posting lists several cities (Google typically does "San Francisco;
// Chicago; New York; Los Angeles").
const CITY_BUCKETS = [
  { key: 'remote',   label: 'Remote',        patterns: [/\bremote\b/i, /telecommute/i, /\banywhere\b/i, /work from home/i] },
  { key: 'la',       label: 'Los Angeles',   patterns: [/los angeles/i, /\bl\.?a\.?\b/i, /culver city/i, /santa monica/i, /playa vista/i, /\bvenice\b/i, /burbank/i, /glendale/i, /pasadena/i] },
  { key: 'bay',      label: 'SF Bay Area',   patterns: [/san francisco/i, /bay area/i, /palo alto/i, /mountain view/i, /sunnyvale/i, /san jose/i, /menlo park/i, /cupertino/i, /oakland/i, /berkeley/i, /redwood city/i, /san mateo/i, /fremont/i, /santa clara/i, /san bruno/i, /emeryville/i] },
  { key: 'nyc',      label: 'New York',      patterns: [/new york/i, /\bnyc\b/i, /manhattan/i, /brooklyn/i, /queens/i] },
  { key: 'seattle',  label: 'Seattle',       patterns: [/seattle/i, /bellevue/i, /redmond/i, /kirkland/i] },
  { key: 'boston',   label: 'Boston',        patterns: [/boston/i, /cambridge, ma/i, /somerville/i] },
  { key: 'austin',   label: 'Austin',        patterns: [/austin/i] },
  { key: 'chicago',  label: 'Chicago',       patterns: [/chicago/i, /, il\b/i] },
  { key: 'denver',   label: 'Denver',        patterns: [/denver/i, /boulder/i] },
  { key: 'dc',       label: 'DC',            patterns: [/washington[,\s]*d\.?c\.?|washington, dc/i, /arlington, va/i, /reston/i, /mclean, va/i] },
  { key: 'atlanta',  label: 'Atlanta',       patterns: [/atlanta/i] },
  { key: 'miami',    label: 'Miami',         patterns: [/miami/i, /fort lauderdale/i] },
  { key: 'portland', label: 'Portland',      patterns: [/portland/i] },
  { key: 'other-us', label: 'Other US',      patterns: [/united states|\busa\b/i, /, ca\b/i, /, wa\b/i, /, ny\b/i, /, ma\b/i, /, tx\b/i, /, il\b/i, /, co\b/i, /, or\b/i, /, ga\b/i, /, fl\b/i, /, va\b/i, /, md\b/i, /, dc\b/i] },
];

// Return ALL city buckets a location string matches. Google-style
// "San Francisco; Chicago; New York" splits into one segment per city
// and unions the bucket hits.
function categorizeLocations(loc) {
  if (!loc) return [];
  const segments = String(loc).split(/[;/•]|\s{2,}/).map(s => s.trim()).filter(Boolean);
  const hits = new Set();
  for (const seg of segments.length ? segments : [loc]) {
    for (const b of CITY_BUCKETS) {
      if (b.patterns.some(re => re.test(seg))) hits.add(b.key);
    }
  }
  return [...hits];
}

// Legacy single-bucket helper (kept for callers that expect one answer)
function categorizeLocation(loc) {
  const hits = categorizeLocations(loc);
  if (!hits.length) return 'intl'; // no US match → international
  // Priority: specific > other-us
  const priority = ['remote','la','bay','nyc','seattle','boston','austin','chicago','denver','dc','atlanta','miami','portland','other-us'];
  return priority.find(k => hits.includes(k)) || 'intl';
}

function computeCityCounts(rows) {
  const counts = Object.fromEntries(CITY_BUCKETS.map(b => [b.key, 0]));
  for (const row of rows) {
    const loc = row.dataset?.location || row.location || '';
    const hits = categorizeLocations(loc);
    for (const h of hits) counts[h]++;
  }
  return counts;
}

function getCheckedValues(groupId) {
  return [...document.querySelectorAll(`input[data-group="${groupId}"]:checked`)].map(cb => cb.value);
}

function filterPipeline() {
  const search = (document.getElementById('pipeline-search')?.value || '').toLowerCase();
  const company = document.getElementById('pipeline-company')?.value || '';
  const live = document.getElementById('pipeline-liveness')?.value || '';
  const salaries = getCheckedValues('pipeline-salary');
  const locations = getCheckedValues('pipeline-location');
  const fitMin = parseFloat(document.getElementById('pipeline-fit-slider')?.value || '0');
  const rows = document.querySelectorAll('#pipeline-table tbody tr');
  let visible = 0;

  // Update badge text to reflect selection counts
  const salBadge = document.querySelector('#pipeline-salary-panel [data-count]');
  if (salBadge) salBadge.textContent = salaries.length ? `${salaries.length} selected` : 'Any';
  const locBadge = document.querySelector('#pipeline-location-panel [data-count]');
  if (locBadge) locBadge.textContent = locations.length ? `${locations.length} selected` : 'Any US';
  const fitLabel = document.getElementById('pipeline-fit-label');
  if (fitLabel) fitLabel.textContent = fitMin > 0 ? `${fitMin.toFixed(1)}` : 'Any';

  function matchSalary(rowSalary) {
    if (!salaries.length) return true;
    const max = parseSalaryMax(rowSalary);
    return salaries.some(s => {
      if (s === 'not-posted') return !rowSalary;
      if (max == null) return false;
      if (s === 'under-150') return max < 150000;
      if (s === '150-250')   return max >= 150000 && max < 250000;
      if (s === '250-350')   return max >= 250000 && max < 350000;
      if (s === 'over-350')  return max >= 350000;
      return false;
    });
  }

  rows.forEach(row => {
    const rowCompany = row.dataset.company || '';
    const rowRole = row.dataset.role || '';
    const rowLive = row.dataset.live || 'unknown';
    const rowSalary = row.dataset.salary || '';
    const rowLocation = row.dataset.location || '';
    const rowFit = row.dataset.fit || '';

    const matchSearch = !search || rowCompany.toLowerCase().includes(search) || rowRole.toLowerCase().includes(search);
    const matchCompany = !company || rowCompany === company;
    const matchLive = !live || rowLive === live;
    const rowUrl = row.dataset.url || '';
    const matchCluster = !pipelineClusterFilter || pipelineClusterFilter.urls.has(rowUrl);

    const rowFitNum = rowFit === '' ? null : parseFloat(rowFit);
    const matchFit = fitMin === 0 || (rowFitNum != null && rowFitNum >= fitMin);

    const cachedCities = (row.dataset.cities || '').split(',').filter(Boolean);
    const rowCities = cachedCities.length ? cachedCities : categorizeLocations(rowLocation);
    const matchLocation = !locations.length || locations.some(l => rowCities.includes(l));

    const show = matchSearch && matchCompany && matchLive && matchSalary(rowSalary) && matchLocation && matchFit && matchCluster;
    row.style.display = show ? '' : 'none';
    // When cities are selected, jobs that list only a selected city rank
    // above jobs where selected cities are one of several.
    if (locations.length) {
      const intersects = rowCities.filter(c => locations.includes(c)).length;
      const primary = rowCities.length === 1 && intersects === 1 ? 0
                    : intersects > 0 && rowCities[0] && locations.includes(rowCities[0]) ? 1
                    : intersects > 0 ? 2
                    : 3;
      row.dataset.citySortKey = String(primary);
    } else {
      row.dataset.citySortKey = '';
    }
    if (show) visible++;
  });

  // If any city filters are active, reorder so selected cities surface first.
  if (locations.length) {
    const tbody = document.querySelector('#pipeline-table tbody');
    if (tbody) {
      const rowsArr = [...tbody.querySelectorAll('tr')];
      rowsArr.sort((a, b) => {
        const aKey = parseInt(a.dataset.citySortKey || '9', 10);
        const bKey = parseInt(b.dataset.citySortKey || '9', 10);
        return aKey - bKey;
      });
      rowsArr.forEach(r => tbody.appendChild(r));
    }
  }

  const countEl = document.getElementById('pipeline-count');
  if (countEl) countEl.textContent = `${visible} items`;
}

function filterTracker() {
  const search = (document.getElementById('tracker-search')?.value || '').toLowerCase();
  const status = (document.getElementById('tracker-status-filter')?.value || '').toLowerCase();
  const rows = document.querySelectorAll('#tracker-table tbody tr');

  rows.forEach(row => {
    const text = row.textContent.toLowerCase();
    const rowStatus = row.querySelector('.badge')?.textContent.trim().toLowerCase() || '';
    const matchSearch = !search || text.includes(search);
    const matchStatus = !status || rowStatus === status;
    row.style.display = matchSearch && matchStatus ? '' : 'none';
  });
}

// --- Report link handler ---

document.getElementById('app').addEventListener('click', e => {
  const link = e.target.closest('.report-link');
  if (link) {
    e.preventDefault();
    navigate('reports', link.dataset.report);
  }
});

// --- Helpers ---

function statusBadge(status) {
  const s = (status || 'pending').toLowerCase().replace(/\s+/g, '-');
  const tip = STATUS_TOOLTIP[s] || 'Status';
  return `<span class="badge badge-${s}" data-tooltip="${escapeAttr(tip)}">${status || 'Pending'}</span>`;
}

function scoreClass(scoreStr) {
  return scoreTier(scoreStr).cls;
}

function scoreMarkup(scoreStr) {
  const { cls, tip } = scoreTier(scoreStr);
  if (!cls) return `<span class="score">${scoreStr || '—'}</span>`;
  return `<span class="score ${cls}" data-tooltip="${escapeAttr(tip)}">${scoreStr}</span>`;
}

// Relative time — accepts either "2026-04-11" (date only, assumes local
// midnight) or full ISO "2026-04-12T17:00:00.000Z". Resolves to
// "just now" / "3m ago" / "5h ago" / "2d ago" / etc.
function relativeDate(iso) {
  if (!iso) return '';
  const input = iso.length === 10 ? iso + 'T00:00:00' : iso;
  const then = new Date(input).getTime();
  if (isNaN(then)) return iso;
  const diff = Date.now() - then;
  if (diff < 0) return 'in the future';
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  if (days < 60) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function extractReportFile(reportStr) {
  if (!reportStr) return null;
  const m = reportStr.match(/\[.*?\]\(reports\/(.+?)\)/);
  return m ? m[1] : null;
}

function truncateUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 40 ? u.pathname.slice(0, 37) + '...' : u.pathname;
    return u.hostname + path;
  } catch { return url; }
}

function formatTime(ts) {
  try {
    const d = new Date(ts);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
           d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  } catch { return ts; }
}

function getCountdown(lastScan, interval) {
  const next = new Date(lastScan).getTime() + interval * 1000;
  const diff = next - Date.now();
  if (diff <= 0) return 'due now';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function escapeAttr(str) {
  return String(str).replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// CV generation — spawns claude -p on the server, streams stdout into a
// modal. On success, replaces the row button with links to the generated
// report + PDF, and the Tracker view will show the new row (merge-tracker
// is called server-side).
async function generateCvFor(btn) {
  const url = btn.dataset.url;
  const company = btn.dataset.company;
  const role = btn.dataset.role;

  if (!confirm(`Generate a tailored CV for:\n\n${company} — ${role}\n\nThis runs Claude in the background (3–6 minutes). Continue?`)) {
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Generating...';

  // Open modal
  const modal = openCvModal(company, role);

  let reportName = null;
  let pdfName = null;
  let hadError = false;

  try {
    const res = await fetch('/api/pipeline/generate-cv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, company, role }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'failed' }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }

        if (msg.type === 'start') {
          modal.appendLog(`▸ Started — report number ${msg.reportNum}`, 'info');
        } else if (msg.type === 'log') {
          modal.appendLog(msg.line);
        } else if (msg.type === 'stderr') {
          modal.appendLog(`⚠ ${msg.line}`, 'warn');
        } else if (msg.type === 'done') {
          reportName = msg.report;
          pdfName = msg.pdf;
          modal.appendLog(`▸ Done — report ${msg.reportNum}`, 'ok');
          modal.setStatus('complete');
        } else if (msg.type === 'error') {
          hadError = true;
          modal.appendLog(`✕ ${msg.error}`, 'err');
          modal.setStatus('failed');
        }
      }
    }
  } catch (e) {
    hadError = true;
    modal.appendLog(`✕ ${e.message}`, 'err');
    modal.setStatus('failed');
  }

  // Update the button with links or restore it
  if (!hadError && reportName) {
    btn.outerHTML = `
      <div style="display:flex; gap:4px; align-items:center">
        <a class="icon-btn" href="#" onclick="event.preventDefault(); navigate('reports', '${reportName}')" data-tooltip="Open report" aria-label="Open report">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 1.5H3.5A1.5 1.5 0 0 0 2 3v10a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 14 13V6.5z"/><path d="M9 1.5V6.5H14"/><path d="M4.5 9h7M4.5 11.5h7"/></svg>
        </a>
        ${pdfName ? `<a class="icon-btn" href="/api/output/${encodeURIComponent(pdfName)}" target="_blank" data-tooltip="Open PDF" aria-label="Open PDF">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v8m0 0l-3-3m3 3l3-3M2.5 11.5v1A1.5 1.5 0 0 0 4 14h8a1.5 1.5 0 0 0 1.5-1.5v-1"/></svg>
        </a>` : ''}
      </div>
    `;
    modal.setFooter(reportName, pdfName);
  } else {
    btn.disabled = false;
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 1.5H3.5A1.5 1.5 0 0 0 2 3v10a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 14 13V6.5z"/><path d="M9 1.5V6.5H14"/><path d="M11.5 11H6.5M11.5 8.5H6.5"/></svg>`;
  }
}

function openCvModal(company, role) {
  const overlay = document.createElement('div');
  overlay.className = 'cv-modal-overlay';
  overlay.innerHTML = `
    <div class="cv-modal">
      <div class="cv-modal-header">
        <div>
          <div class="cv-modal-title">${escapeHtml(company || 'Unknown')} — ${escapeHtml(role || 'role')}</div>
          <div class="cv-modal-status" data-status="running">Running</div>
        </div>
        <button class="cv-modal-close" aria-label="Close">✕</button>
      </div>
      <pre class="cv-modal-log"></pre>
      <div class="cv-modal-footer"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  const log = overlay.querySelector('.cv-modal-log');
  const statusEl = overlay.querySelector('.cv-modal-status');
  const footer = overlay.querySelector('.cv-modal-footer');

  overlay.querySelector('.cv-modal-close').addEventListener('click', () => {
    overlay.remove();
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  return {
    appendLog(line, level = '') {
      const row = document.createElement('div');
      row.className = `cv-log-line ${level}`;
      row.textContent = line;
      log.appendChild(row);
      log.scrollTop = log.scrollHeight;
    },
    setStatus(s) {
      statusEl.dataset.status = s;
      statusEl.textContent = s === 'complete' ? 'Complete' : s === 'failed' ? 'Failed' : 'Running';
    },
    setFooter(reportName, pdfName) {
      footer.innerHTML = `
        <a class="btn" href="#" onclick="event.preventDefault(); window.closeCvModal(); navigate('reports', '${reportName}')">Open report</a>
        ${pdfName ? `<a class="btn" href="/api/output/${encodeURIComponent(pdfName)}" target="_blank">Open PDF</a>` : ''}
        <button class="btn" onclick="this.closest('.cv-modal-overlay').remove()">Close</button>
      `;
    },
  };
}
window.closeCvModal = () => document.querySelector('.cv-modal-overlay')?.remove();

// Single-row verify — kicks the same streaming endpoint with a single URL
// and updates the clicked row's dot + "Last seen" cell with the result.
async function verifySingleUrl(btn) {
  const url = btn.dataset.verifyUrl;
  if (!url) return;
  const row = btn.closest('tr');
  const dot = row?.querySelector('.live-dot');
  const seenCell = row?.querySelector('.first-seen');
  if (dot) dot.className = 'live-dot live-checking';
  btn.disabled = true;
  try {
    const res = await fetch('/api/pipeline/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: [url] }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === 'result' && dot) {
          dot.className = `live-dot ${msg.live ? 'live-alive' : 'live-dead'}`;
          const tip = msg.live
            ? `Live (HTTP ${msg.status}). Just now. Click to re-verify.`
            : `Dead. ${msg.reason || 'unknown'} (just now). Click to re-check.`;
          btn.setAttribute('data-tooltip', tip);
          if (msg.live) row?.classList.remove('row-dead');
          else row?.classList.add('row-dead');
          if (row) {
            row.dataset.live = msg.live ? 'alive' : 'dead';
            row.dataset.liveRank = msg.live ? '2' : '0';
            const liveCell = row.querySelector('td[data-sort-value]');
            if (liveCell) liveCell.dataset.sortValue = msg.live ? '2' : '0';
            // Populate newly-scraped location and salary in the row
            const locCell = row.querySelector('.cell-location');
            const salCell = row.querySelector('.cell-salary');
            if (msg.location && locCell) {
              locCell.textContent = msg.location;
              locCell.dataset.sortValue = msg.location.toLowerCase();
              row.dataset.location = msg.location;
            }
            if (msg.salary && salCell) {
              salCell.textContent = msg.salary;
              salCell.dataset.sortValue = msg.salary.toLowerCase();
              row.dataset.salary = msg.salary;
            }
          }
          if (seenCell) {
            if (msg.live) {
              seenCell.textContent = 'just now';
              seenCell.setAttribute('data-tooltip', `Last confirmed live: ${new Date().toLocaleString()}`);
            } else {
              seenCell.setAttribute('data-tooltip', `Dead as of ${new Date().toLocaleString()}. ${msg.reason || 'unknown'}`);
            }
          }
          // Re-apply the current liveness filter so the row hides/shows
          // immediately if the user is viewing "live only" or "dead only".
          filterPipeline();
        } else if (msg.type === 'error') {
          throw new Error(msg.error);
        }
      }
    }
  } catch (e) {
    if (dot) dot.className = 'live-dot live-unknown';
    btn.setAttribute('data-tooltip', `Verify failed: ${e.message.slice(0, 60)}`);
  } finally {
    btn.disabled = false;
  }
}

async function verifyVisibleUrls(btn) {
  // Gather the currently-visible pipeline rows (respects active filters)
  const visibleRows = [...document.querySelectorAll('#pipeline-table tbody tr')]
    .filter(tr => tr.style.display !== 'none');
  const urls = visibleRows.map(tr => tr.dataset.url).filter(Boolean);
  if (urls.length === 0) return;

  const targetUrls = new Set(urls);
  const total = targetUrls.size;

  // Mark all targeted rows as "checking"
  visibleRows.forEach(tr => {
    if (targetUrls.has(tr.dataset.url)) {
      const dot = tr.querySelector('.live-dot');
      if (dot) {
        dot.className = 'live-dot live-checking';
        dot.title = 'Checking...';
      }
    }
  });

  const origLabel = btn.querySelector('.verify-label')?.textContent || 'Verify visible';
  btn.disabled = true;
  const labelEl = btn.querySelector('.verify-label');
  if (labelEl) labelEl.textContent = `Checking 0/${total}`;

  let done = 0;
  let live = 0;
  let dead = 0;
  let engine = '';

  try {
    const res = await fetch('/api/pipeline/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: [...targetUrls] }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'failed' }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;

        let msg;
        try { msg = JSON.parse(line); } catch { continue; }

        if (msg.type === 'engine') {
          engine = msg.via;
          // Show which engine is running (useful for debug + confidence)
          if (labelEl) labelEl.textContent = `${engine} • 0/${total}`;
        } else if (msg.type === 'batch') {
          if (labelEl) labelEl.textContent = `batch ${msg.index}/${msg.of} • ${done}/${total}`;
        } else if (msg.type === 'result') {
          done = msg.done;
          if (msg.live) live++; else dead++;

          const row = [...document.querySelectorAll('#pipeline-table tbody tr')]
            .find(tr => tr.dataset.url === msg.url);
          if (row) {
            const dot = row.querySelector('.live-dot');
            const seenCell = row.querySelector('.first-seen');
            if (dot) {
              dot.className = `live-dot ${msg.live ? 'live-alive' : 'live-dead'}`;
            }
            const btn2 = row.querySelector('.live-dot-btn');
            if (btn2) {
              btn2.setAttribute('data-tooltip', msg.live
                ? `Live (HTTP ${msg.status}). Just now. Click to re-verify.`
                : `Dead. ${msg.reason || 'unknown'} (just now). Click to re-check.`);
            }
            if (seenCell && msg.live) {
              seenCell.textContent = 'just now';
              seenCell.setAttribute('data-tooltip', `Last confirmed live: ${new Date().toLocaleString()}`);
            }
            if (msg.live) row.classList.remove('row-dead');
            else row.classList.add('row-dead');
            // Keep the row's data-live in sync so filters / sorts react.
            row.dataset.live = msg.live ? 'alive' : 'dead';
            row.dataset.liveRank = msg.live ? '2' : '0';
            const liveCell = row.querySelector('td[data-sort-value]');
            if (liveCell) liveCell.dataset.sortValue = msg.live ? '2' : '0';
            // Populate newly-scraped location and salary in the row
            const locCell = row.querySelector('.cell-location');
            const salCell = row.querySelector('.cell-salary');
            if (msg.location && locCell) {
              locCell.textContent = msg.location;
              locCell.dataset.sortValue = msg.location.toLowerCase();
              row.dataset.location = msg.location;
            }
            if (msg.salary && salCell) {
              salCell.textContent = msg.salary;
              salCell.dataset.sortValue = msg.salary.toLowerCase();
              row.dataset.salary = msg.salary;
            }
            // Prune in real time: if the user is filtered to "Live only" and
            // this row just flipped to dead, hide it now. Same for the inverse.
            filterPipeline();
          }

          if (labelEl) labelEl.textContent = `${engine || 'checking'} • ${done}/${total}`;
        } else if (msg.type === 'error') {
          throw new Error(msg.error);
        }
      }
    }

    if (labelEl) labelEl.textContent = `${live} live • ${dead} dead`;
    // Re-apply filter so "Live only" / "Dead only" respect the fresh state.
    filterPipeline();
    setTimeout(() => { if (labelEl) labelEl.textContent = origLabel; }, 6000);
  } catch (e) {
    if (labelEl) labelEl.textContent = `Error: ${e.message.slice(0, 30)}`;
    setTimeout(() => { if (labelEl) labelEl.textContent = origLabel; }, 6000);
  } finally {
    btn.disabled = false;
  }
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Minimal markdown to HTML
function markdownToHtml(md) {
  let html = '';
  let inTable = false;
  let inSection = false;
  const lines = md.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Headings — wrap each h2 section in a 2-level container so CSS can
    // animate grid-template-rows 0fr → 1fr without clipping animating content.
    if (line.startsWith('# ')) {
      if (inSection) { html += '</div></div>'; inSection = false; }
      html += `<h1>${processInline(line.slice(2))}</h1>`;
      continue;
    }
    if (line.startsWith('## ')) {
      if (inSection) { html += '</div></div>'; }
      html += `<h2>${processInline(line.slice(3))}</h2><div class="report-section visible"><div class="section-inner">`;
      inSection = true;
      continue;
    }
    if (line.startsWith('### ')) {
      html += `<h3>${processInline(line.slice(4))}</h3>`;
      continue;
    }

    // HR
    if (line.match(/^-{3,}$/)) {
      html += '<hr>';
      continue;
    }

    // Table
    if (line.startsWith('|')) {
      if (!inTable) { html += '<table>'; inTable = true; }
      if (line.match(/^\|[\s-|]+\|$/)) continue; // separator row
      const cells = line.split('|').map(c => c.trim()).filter(Boolean);
      const tag = !html.includes('<tbody>') && inTable && !line.includes('---') ? 'th' : 'td';
      if (tag === 'th') html += '<thead>';
      html += '<tr>' + cells.map(c => `<${tag}>${processInline(c)}</${tag}>`).join('') + '</tr>';
      if (tag === 'th') html += '</thead><tbody>';
      continue;
    } else if (inTable) {
      html += '</tbody></table>';
      inTable = false;
    }

    // Empty line
    if (!line.trim()) {
      continue;
    }

    // Paragraph
    html += `<p>${processInline(line)}</p>`;
  }

  if (inTable) html += '</tbody></table>';
  if (inSection) html += '</div></div>';

  return html;
}

function processInline(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code style="background:var(--bg-elevated);padding:1px 4px;border-radius:2px;font-size:0.85em">$1</code>')
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank" rel="noopener" style="color:var(--accent)">$1</a>');
}

// --- Countdown timer ---

setInterval(() => {
  document.querySelectorAll('.countdown').forEach(el => {
    const last = el.dataset.last;
    const interval = parseInt(el.dataset.interval, 10);
    if (last && interval) {
      el.textContent = getCountdown(last, interval);
    }
  });
}, 60000);

// --- Tooltip dispatcher ---
// One floating element, delegates mouseover/focusin on [data-tooltip].
// No delay, respects reduced-motion, clamps to viewport.
(function installTooltips() {
  const tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.setAttribute('role', 'tooltip');
  tip.setAttribute('aria-hidden', 'true');
  document.body.appendChild(tip);

  let hideTimer = null;

  function show(target) {
    const text = target.getAttribute('data-tooltip');
    if (!text) return;
    clearTimeout(hideTimer);
    tip.textContent = text;
    tip.classList.add('visible');

    const rect = target.getBoundingClientRect();
    // Show above by default, flip below if near top
    const above = rect.top > 50;
    const tRect = tip.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - tRect.width / 2;
    let top = above ? rect.top - tRect.height - 8 : rect.bottom + 8;
    // Clamp horizontally
    left = Math.max(8, Math.min(left, window.innerWidth - tRect.width - 8));
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    tip.dataset.placement = above ? 'top' : 'bottom';
  }

  function hide() {
    // Small delay so moving between two adjacent tooltip targets doesn't flicker
    hideTimer = setTimeout(() => tip.classList.remove('visible'), 40);
  }

  document.addEventListener('mouseover', (e) => {
    const t = e.target.closest('[data-tooltip]');
    if (t) show(t);
  });
  document.addEventListener('mouseout', (e) => {
    if (e.target.closest('[data-tooltip]')) hide();
  });
  document.addEventListener('focusin', (e) => {
    if (e.target.matches('[data-tooltip]')) show(e.target);
  });
  document.addEventListener('focusout', (e) => {
    if (e.target.matches('[data-tooltip]')) hide();
  });
  // Hide when scrolling so tooltip doesn't orphan from target
  document.addEventListener('scroll', () => tip.classList.remove('visible'), true);
})();

// --- Auth indicator in nav ---

async function renderAuthIndicator() {
  const el = document.getElementById('nav-auth');
  if (!el) return;
  try {
    const { authed, lan } = await api('/api/auth-status');
    if (lan) {
      el.innerHTML = `<span class="auth-pill auth-pill-lan" title="Your device is on the local network — signed in automatically">LAN</span>`;
    } else if (authed) {
      el.innerHTML = `<button class="auth-pill auth-pill-signout" id="logout-btn" title="Sign out">Sign out</button>`;
      document.getElementById('logout-btn').addEventListener('click', async () => {
        await fetch('/api/logout', { method: 'POST' });
        location.href = '/login';
      });
    }
  } catch {}
}

// --- Theme toggle ---

function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || 'light';
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('theme', next); } catch {}
}

document.getElementById('theme-toggle')?.addEventListener('click', toggleTheme);

// --- Init ---

// Make navigate global for onclick handlers
window.navigate = navigate;
window.triggerScan = triggerScan;

renderAuthIndicator();
render();
