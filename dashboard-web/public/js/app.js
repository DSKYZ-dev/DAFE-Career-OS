// ── DAFE Career OS Dashboard App ─────────────────────────────────────
const API = {
  async get(path) { const r = await fetch(path); return r.json(); },
  async post(path, data) {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return r.json();
  },
  async delete(path) {
    const r = await fetch(path, { method: 'DELETE' });
    return r.json();
  }
};

// ── Navigation ───────────────────────────────────────────────────
function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const page = document.getElementById(`page-${name}`);
  const nav = document.querySelector(`.nav-item[data-page="${name}"]`);
  if (page) page.classList.add('active');
  if (nav) nav.classList.add('active');
  const titles = { dashboard: 'Dashboard', evaluate: 'Evaluate Jobs', scan: 'Scan Portals',
    cv: 'CV & PDF', 'cover-letter': 'Cover Letters', tracker: 'Application Tracker',
    agent: 'AI Agent Chat', tools: 'System Tools', settings: 'Settings' };
  const profileName = document.getElementById('activeProfileBadge')?.textContent || '';
  const title = titles[name] || name;
  document.getElementById('pageTitle').textContent = profileName ? `👤 ${profileName} — ${title}` : title;
  refreshCurrentPage();
}

function refreshCurrentPage() {
  const active = document.querySelector('.page.active');
  if (!active) return;
  const id = active.id.replace('page-', '');
  switch (id) {
    case 'dashboard': loadDashboard(); break;
    case 'tracker': loadTracker(); break;
    case 'cv': loadCv(); break;
    case 'settings': loadSettings(); loadProfiles(); break;
    case 'scan': loadScanConfig(); loadScanHistory(); break;
    default: break;
  }
}

// ── Dashboard ────────────────────────────────────────────────────
async function loadDashboard() {
  try {
    const stats = await API.get('/api/stats');
    document.getElementById('statEvals').textContent = stats.evaluations || 0;
    document.getElementById('statPdfs').textContent = stats.pdfs || 0;
    document.getElementById('statApps').textContent = stats.applications || 0;
    document.getElementById('statPend').textContent = stats.pipelineEntries || 0;
    document.getElementById('statCos').textContent = stats.companyCount || 0;
    document.getElementById('statCv').textContent = stats.cvExists ? 'Yes' : 'No';

    // Kanban compact
    const statuses = stats.statusDistribution || {};
    const kanban = document.getElementById('kanbanCompact');
    const colors = { Evaluated: '#448aff', Applied: '#6c5ce7', Interview: '#ffab00', Offer: '#00c853', Rejected: '#ff5252', Discarded: '#6b7294', SKIP: '#6b7294', Responded: '#448aff' };
    kanban.innerHTML = Object.entries(statuses).filter(([_,v]) => v > 0).map(([k,v]) =>
      `<div class="kanban-col" style="min-width:80px"><div class="kanban-col-header" style="border-color:${colors[k]||'var(--border)'}">${k}</div><div style="font-size:24px;font-weight:700;text-align:center;padding:8px;color:${colors[k]||'var(--text)'}">${v}</div></div>`
    ).join('') || '<div class="kanban-col" style="min-width:80px"><div class="kanban-col-header">No data</div></div>';

    // Recent reports
    const reports = await API.get('/api/reports');
    const container = document.getElementById('recentReports');
    if (reports.length === 0) { container.innerHTML = '<p class="text2">No reports yet. Evaluate a job to see results here.</p>'; return; }
    container.innerHTML = '<div style="display:grid;gap:6px">' + reports.slice(0, 10).map(r =>
      `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px;background:var(--bg3);border-radius:var(--radius-sm)">
        <span>${r.name.replace('.md','')}</span>
        <span style="font-size:11px;color:var(--text3)">${new Date(r.mtime).toLocaleDateString()}</span>
      </div>`
    ).join('') + '</div>';
  } catch (e) { console.error('Dashboard load error:', e); }
}

// ── Evaluate ─────────────────────────────────────────────────────
async function runEvaluation() {
  const url = document.getElementById('evalUrl').value.trim();
  const jd = document.getElementById('evalJd').value.trim();
  if (!url && !jd) { showEvalStatus('Please provide a URL or paste a job description.', 'error'); return; }

  const results = document.getElementById('evalResults');
  const resultsBody = document.getElementById('evalResultsBody');
  const progress = document.getElementById('evalProgress');
  const fill = document.getElementById('evalProgressFill');

  results.style.display = 'none';
  progress.style.display = 'block';
  fill.style.width = '30%';
  document.getElementById('evalProgressText').textContent = 'Starting evaluation...';

  try {
    fill.style.width = '50%';
    document.getElementById('evalProgressText').textContent = 'Running AI pipeline (this may take a minute)...';
    const data = await API.post('/api/evaluate', { url, jd });
    fill.style.width = '100%';
    document.getElementById('evalProgressText').textContent = 'Complete!';

    setTimeout(() => {
      progress.style.display = 'none';
      results.style.display = 'block';

      if (data.success) {
        let html = '';
        if (data.report) {
          html += `<h4 style="margin-bottom:8px">Evaluation Report</h4><pre style="background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px;font-size:12px;max-height:400px;overflow:auto;white-space:pre-wrap">${escapeHtml(data.report.substring(0, 5000))}</pre>`;
        }
        if (data.pdf) {
          html += `<p style="margin-top:12px"><a href="/api/pdf/${data.pdf}" class="btn btn-primary" download>Download PDF CV</a></p>`;
        }
        if (data.log) {
          html += `<details style="margin-top:8px"><summary style="cursor:pointer;font-size:13px;color:var(--text3)">View Log</summary><pre style="background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px;font-size:11px;max-height:200px;overflow:auto;margin-top:4px">${escapeHtml(data.log)}</pre></details>`;
        }
        if (data.error) {
          html += `<div class="status-msg error" style="display:block;margin-top:8px">${escapeHtml(data.error)}</div>`;
        }
        resultsBody.innerHTML = html || '<p>Evaluation completed but no output was generated.</p>';
      } else {
        resultsBody.innerHTML = `<div class="status-msg error" style="display:block">Evaluation failed: ${escapeHtml(data.error || 'Unknown error')}</div>`;
      }
    }, 500);
  } catch (e) {
    progress.style.display = 'none';
    results.style.display = 'block';
    resultsBody.innerHTML = `<div class="status-msg error" style="display:block">Error: ${escapeHtml(e.message)}</div>`;
  }
}

function showEvalStatus(msg, type) {
  // Simple status display
  const results = document.getElementById('evalResults');
  const resultsBody = document.getElementById('evalResultsBody');
  results.style.display = 'block';
  resultsBody.innerHTML = `<div class="status-msg ${type}" style="display:block">${escapeHtml(msg)}</div>`;
}

// ── Scan ─────────────────────────────────────────────────────────
async function runScan() {
  const progress = document.getElementById('scanProgress');
  const fill = document.getElementById('scanProgressFill');
  const results = document.getElementById('scanResults');
  const resultsBody = document.getElementById('scanResultsBody');
  const stats = document.getElementById('scanStats');

  results.style.display = 'none';
  progress.style.display = 'block';
  fill.style.width = '20%';
  document.getElementById('scanProgressText').textContent = 'Starting scan...';
  stats.innerHTML = '';

  try {
    fill.style.width = '50%';
    document.getElementById('scanProgressText').textContent = 'Scanning 45+ portals and job boards...';
    const data = await API.post('/api/scan');
    fill.style.width = '100%';
    document.getElementById('scanProgressText').textContent = 'Complete!';

    setTimeout(() => {
      progress.style.display = 'none';
      results.style.display = 'block';

      if (data.success) {
        const s = data.stats || {};
        const lines = (data.pipeline || '').split('\n').filter(l => l.includes('|'));
        const newEntries = lines.filter(l => !l.includes('---') && !l.includes('#')).length;
        const filterInfo = s.locationFiltered !== '?'
          ? `<div style="display:flex;gap:16px;margin:8px 0;font-size:12px;color:var(--text3);flex-wrap:wrap">
               <span>🔍 Title-filtered: <strong>${s.titleFiltered}</strong></span>
               <span>📍 Location-filtered: <strong>${s.locationFiltered}</strong></span>
               <span>💰 Salary-filtered: <strong>${s.salaryFiltered}</strong></span>
               <span>✅ New offers: <strong>${s.newOffers}</strong></span>
             </div>`
          : '';
        resultsBody.innerHTML = `
          <div class="status-msg success" style="display:block">Scan complete!</div>
          ${filterInfo}
          <p style="margin-top:8px">Check the Pipeline and Tracker for new entries. Use the AI Agent to process them.</p>
          ${data.log ? `<details style="margin-top:8px"><summary style="cursor:pointer;font-size:13px;color:var(--text3)">View Log</summary><pre style="background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px;font-size:11px;max-height:200px;overflow:auto;margin-top:4px">${escapeHtml(data.log)}</pre></details>` : ''}
        `;
        stats.innerHTML = `<p>${s.newOffers > 0 ? 'Found new offers! ' : 'No new offers found. '}<button class="btn btn-sm" onclick="showPage('tracker')">View Tracker</button></p>`;
      } else {
        resultsBody.innerHTML = `<div class="status-msg error" style="display:block">Scan failed: ${escapeHtml(data.error || 'Unknown error')}</div>`;
      }
    }, 500);
  } catch (e) {
    progress.style.display = 'none';
    results.style.display = 'block';
    resultsBody.innerHTML = `<div class="status-msg error" style="display:block">Error: ${escapeHtml(e.message)}</div>`;
  }
}

async function loadScanConfig() {
  try {
    const cfg = await API.get('/api/scan-config');
    const zipInput = document.getElementById('scanZip');
    const radiusSelect = document.getElementById('scanRadius');
    const remoteCheck = document.getElementById('scanRemoteOnly');
    if (zipInput && cfg.zipcode) zipInput.value = cfg.zipcode;
    if (radiusSelect && cfg.radius) radiusSelect.value = String(cfg.radius);
    if (remoteCheck && cfg.remoteOnly !== undefined) remoteCheck.checked = cfg.remoteOnly;
  } catch (e) { console.error('Scan config load error:', e); }
}

async function saveScanConfig() {
  const zipcode = document.getElementById('scanZip')?.value.trim() || '';
  const radius = parseInt(document.getElementById('scanRadius')?.value) || 50;
  const remoteOnly = document.getElementById('scanRemoteOnly')?.checked || false;
  try {
    await API.post('/api/scan-config', { zipcode, radius, remoteOnly });
    const btn = document.querySelector('.form-row .btn-sm');
    if (btn) { btn.textContent = 'Saved!'; setTimeout(() => btn.textContent = 'Save', 2000); }
  } catch (e) { alert('Error saving: ' + e.message); }
}

async function loadScanHistory() {
  try {
    const data = await API.get('/api/scan-history');
    const body = document.getElementById('scanHistoryBody');
    if (!data.entries || data.entries.length === 0) {
      body.innerHTML = '<p class="text2">No scan history yet. Run a scan to see results here.</p>'; return;
    }
    body.innerHTML = `<p style="font-size:12px;color:var(--text3);margin-bottom:8px">Total scans: ${data.total} entries</p>
      <div style="max-height:200px;overflow-y:auto">${data.entries.slice(-50).reverse().map(e =>
        `<div style="padding:4px 8px;font-size:12px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between">
          <span>${escapeHtml(e.company || e.url?.substring(0, 50))}</span>
          <span style="color:var(--text3)">${e.date || ''}</span>
        </div>`
      ).join('')}</div>`;
  } catch (e) { console.error('Scan history error:', e); }
}

// ── CV ────────────────────────────────────────────────────────────
async function loadCv() {
  try {
    const data = await API.get('/api/profile');
    document.getElementById('cvEditor').value = data.cv || '# Your CV\n\nPaste your CV in markdown format here...';
    loadPdfList();
  } catch (e) { console.error('CV load error:', e); }
}

async function saveCv() {
  const cv = document.getElementById('cvEditor').value;
  const status = document.getElementById('cvStatus');
  try {
    const result = await API.post('/api/cv', { cv });
    if (result.success) {
      status.className = 'status-msg success'; status.textContent = 'CV saved successfully!'; status.style.display = 'block';
      setTimeout(() => status.style.display = 'none', 3000);
    }
  } catch (e) {
    status.className = 'status-msg error'; status.textContent = 'Error saving CV: ' + e.message; status.style.display = 'block';
  }
}

async function generatePdf() {
  const status = document.getElementById('cvStatus');
  status.className = 'status-msg info'; status.textContent = 'Generating PDF...'; status.style.display = 'block';
  try {
    const result = await API.post('/api/generate-pdf', {});
    if (result.success && result.pdf) {
      status.className = 'status-msg success'; status.textContent = `PDF generated: ${result.pdf}`; status.style.display = 'block';
      loadPdfList();
    } else {
      status.className = 'status-msg error'; status.textContent = 'PDF generation failed. Ensure cv.md has content.'; status.style.display = 'block';
    }
  } catch (e) {
    status.className = 'status-msg error'; status.textContent = 'Error: ' + e.message; status.style.display = 'block';
  }
}

async function loadPdfList() {
  try {
    const data = await API.get('/api/pdfs');
    const container = document.getElementById('pdfList');
    if (data.length === 0) { container.innerHTML = '<p class="text2">No PDFs generated yet.</p>'; return; }
    container.innerHTML = data.map(p =>
      `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:var(--bg3);border-radius:var(--radius-sm);margin-bottom:4px">
        <span>${escapeHtml(p.name)}</span>
        <div>
          <span style="font-size:11px;color:var(--text3);margin-right:8px">${(p.size/1024).toFixed(0)} KB</span>
          <a href="/api/pdf/${p.name}" class="btn btn-sm" download>Download</a>
        </div>
      </div>`
    ).join('');
  } catch (e) { console.error('PDF list error:', e); }
}

// ── Resume Upload ────────────────────────────────────────────────
async function handleResumeUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  document.getElementById('resumeFileName').textContent = file.name;
  const status = document.getElementById('resumeUploadStatus');
  const preview = document.getElementById('resumePreview');
  const previewText = document.getElementById('resumeTextPreview');

  status.className = 'status-msg info'; status.textContent = 'Uploading...'; status.style.display = 'block';
  preview.style.display = 'none';

  try {
    const base64 = await fileToBase64(file);
    const result = await API.post('/api/resume/upload', { filename: file.name, data: base64 });
    if (result.success) {
      status.className = 'status-msg success'; status.textContent = `Uploaded! Extracted ${result.charCount} characters.`;
      status.style.display = 'block';
      previewText.textContent = result.text;
      preview.style.display = 'block';
      localStorage.setItem('resumeRawText', result.text);
    } else {
      status.className = 'status-msg error'; status.textContent = result.error || 'Upload failed';
      status.style.display = 'block';
    }
  } catch (e) {
    status.className = 'status-msg error'; status.textContent = 'Error: ' + e.message; status.style.display = 'block';
  }
}

async function generateCvFromResume() {
  const text = document.getElementById('resumeTextPreview').textContent || localStorage.getItem('resumeRawText') || '';
  const status = document.getElementById('resumeUploadStatus');
  if (!text) { status.className = 'status-msg error'; status.textContent = 'No resume text available. Upload a resume first.'; status.style.display = 'block'; return; }

  status.className = 'status-msg info'; status.textContent = 'Generating CV...'; status.style.display = 'block';
  try {
    const result = await API.post('/api/resume/generate-cv', { text });
    if (result.success) {
      document.getElementById('cvEditor').value = result.cvMd;
      status.className = 'status-msg success'; status.textContent = 'CV generated from resume! Edit below and click Save.';
      status.style.display = 'block';
    } else {
      status.className = 'status-msg error'; status.textContent = result.error || 'Generation failed';
      status.style.display = 'block';
    }
  } catch (e) {
    status.className = 'status-msg error'; status.textContent = 'Error: ' + e.message; status.style.display = 'block';
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ── Onboarding ───────────────────────────────────────────────────
async function checkOnboarding() {
  try {
    const status = await API.get('/api/profiles/onboarding-status');
    if (status.needsOnboarding) {
      document.getElementById('onboardingModal').style.display = 'flex';
    }
  } catch (e) { /* silent - onboarding check is best-effort */ }
}

function handleOnboardingResume(event) {
  const file = event.target.files[0];
  if (!file) return;
  document.getElementById('onbResumeName').textContent = file.name;
  // Store for later upload with onboarding submission
  fileToBase64(file).then(b64 => {
    window._onboardingResumeData = { filename: file.name, data: b64 };
  });
}

async function submitOnboarding() {
  const fields = ['Name','Email','Location','TargetRoles','Skills','Experience','Education','Salary','Uniqueness'];
  const required = ['Name', 'Email', 'Location', 'TargetRoles'];
  const data = {};
  let missing = [];

  fields.forEach(f => {
    const el = document.getElementById('onb' + f);
    data[f.toLowerCase()] = el ? el.value.trim() : '';
  });

  required.forEach(f => {
    const key = f.toLowerCase();
    if (!data[key]) missing.push(f);
  });

  const status = document.getElementById('onboardingStatus');
  if (missing.length) {
    status.className = 'status-msg error'; status.textContent = 'Please fill in: ' + missing.join(', ');
    status.style.display = 'block';
    return;
  }

  status.className = 'status-msg info'; status.textContent = 'Saving profile...'; status.style.display = 'block';

  try {
    // Submit onboarding data
    const result = await API.post('/api/profiles/onboarding', {
      name: data.name, email: data.email, location: data.location,
      targetRoles: data.targetroles, skills: data.skills,
      experience: data.experience, education: data.education,
      salaryTarget: data.salary, uniqueness: data.uniqueness
    });

    if (result.success) {
      // If resume was uploaded, send it
      if (window._onboardingResumeData) {
        await API.post('/api/resume/upload', window._onboardingResumeData);
        await API.post('/api/resume/generate-cv', { questions: data });
        window._onboardingResumeData = null;
      }
      status.className = 'status-msg success'; status.textContent = 'Profile saved! Redirecting to focuses...';
      status.style.display = 'block';
      setTimeout(() => {
        document.getElementById('onboardingModal').style.display = 'none';
        showPage('settings');
        loadProfiles();
      }, 1000);
    } else {
      status.className = 'status-msg error'; status.textContent = result.error || 'Save failed';
      status.style.display = 'block';
    }
  } catch (e) {
    status.className = 'status-msg error'; status.textContent = 'Error: ' + e.message; status.style.display = 'block';
  }
}

// ── Cover Letter ──────────────────────────────────────────────────
async function generateCoverLetter() {
  const company = document.getElementById('clCompany').value.trim();
  const role = document.getElementById('clRole').value.trim();
  const jd = document.getElementById('clJd').value.trim();
  if (!jd) { alert('Please paste a job description.'); return; }

  const results = document.getElementById('clResults');
  const body = document.getElementById('clResultsBody');
  results.style.display = 'block';
  body.innerHTML = '<div class="progress-bar-container" style="display:block"><div class="progress-bar"><div class="progress-fill" style="width:60%"></div></div><div class="progress-text">Generating cover letter...</div></div>';

  try {
    const data = await API.post('/api/cover-letter', { jd, company, role });
    if (data.success) {
      body.innerHTML = `<div style="white-space:pre-wrap;font-size:13px;line-height:1.7">${escapeHtml(data.content)}</div>`;
    } else {
      body.innerHTML = `<div class="status-msg error" style="display:block">Generation failed: ${escapeHtml(data.error || 'Unknown error')}</div>`;
    }
  } catch (e) {
    body.innerHTML = `<div class="status-msg error" style="display:block">Error: ${escapeHtml(e.message)}</div>`;
  }
}

function copyCoverLetter() {
  const text = document.getElementById('clResultsBody').textContent;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.querySelector('#clResults .btn-sm');
    btn.textContent = 'Copied!';
    setTimeout(() => btn.textContent = 'Copy', 2000);
  });
}

// ── Tracker ──────────────────────────────────────────────────────
async function loadTracker() {
  try {
    const data = await API.get('/api/tracker');
    const entries = data.entries || [];

    // Kanban board
    const kanban = document.getElementById('kanbanBoard');
    const statusOrder = ['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer', 'Rejected', 'Discarded', 'SKIP'];
    const statusGroups = {};
    entries.forEach(e => {
      const s = e.status || 'Evaluated';
      if (!statusGroups[s]) statusGroups[s] = [];
      statusGroups[s].push(e);
    });

    kanban.innerHTML = statusOrder.map(s => {
      const items = statusGroups[s] || [];
      const badges = { Evaluated: 'info', Applied: 'primary', Interview: 'warning', Offer: 'success',
        Rejected: 'danger', Discarded: 'text3', SKIP: 'text3', Responded: 'info' };
      return `<div class="kanban-col">
        <div class="kanban-col-header" style="border-color:var(--${badges[s]||'border'})">${s} (${items.length})</div>
        ${items.slice(0, 8).map(e =>
          `<div class="kanban-card-item">
            <div class="item-title">${escapeHtml(e.company)}</div>
            <div class="item-sub">${escapeHtml(e.role)} · ${e.score || '--'}</div>
          </div>`
        ).join('')}
        ${items.length > 8 ? `<div style="font-size:11px;color:var(--text3);text-align:center;padding:4px">+${items.length - 8} more</div>` : ''}
      </div>`;
    }).join('');

    // Table
    const table = document.getElementById('trackerTable');
    if (entries.length === 0) {
      table.innerHTML = '<p class="text2">No applications tracked yet. Evaluate a job to start building your tracker.</p>';
      return;
    }
    table.innerHTML = `<table>
      <thead><tr><th>#</th><th>Date</th><th>Company</th><th>Role</th><th>Score</th><th>Status</th><th>PDF</th><th>Notes</th></tr></thead>
      <tbody>${entries.map(e =>
        `<tr>
          <td>${escapeHtml(e.num)}</td>
          <td>${escapeHtml(e.date)}</td>
          <td><strong>${escapeHtml(e.company)}</strong></td>
          <td>${escapeHtml(e.role)}</td>
          <td>${e.score || '--'}</td>
          <td><span class="status-badge status-${e.status || 'Evaluated'}">${e.status || 'Evaluated'}</span></td>
          <td>${e.pdf || ''}</td>
          <td style="font-size:12px;color:var(--text3);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml((e.notes || '').substring(0, 50))}</td>
        </tr>`
      ).join('')}</tbody>
    </table>`;
  } catch (e) { console.error('Tracker load error:', e); }
}

function refreshTracker() { loadTracker(); }

// ── Agent Chat ───────────────────────────────────────────────────
async function sendChat() {
  const input = document.getElementById('chatInput');
  const msg = input.value.trim();
  if (!msg) return;

  const messages = document.getElementById('chatMessages');
  // Add user message
  messages.innerHTML += `<div class="chat-msg user"><div class="msg-content">${escapeHtml(msg)}</div></div>`;
  input.value = '';
  messages.scrollTop = messages.scrollHeight;

  // Add loading indicator
  const loadingId = 'loading-' + Date.now();
  messages.innerHTML += `<div class="chat-msg assistant" id="${loadingId}"><div class="msg-content"><em>Thinking...</em></div></div>`;
  messages.scrollTop = messages.scrollHeight;

  try {
    const data = await API.post('/api/agent/chat', { message: msg });
    document.getElementById(loadingId).outerHTML =
      `<div class="chat-msg assistant"><div class="msg-content" style="white-space:pre-wrap">${escapeHtml(data.response || (data.success ? '(no output)' : 'Error: ' + (data.error || 'Unknown')))}</div></div>`;
  } catch (e) {
    document.getElementById(loadingId).outerHTML =
      `<div class="chat-msg assistant"><div class="msg-content" style="color:var(--danger)">Error: ${escapeHtml(e.message)}</div></div>`;
  }
  messages.scrollTop = messages.scrollHeight;
}

// ── Tools ────────────────────────────────────────────────────────
async function runTool(name) {
  const output = document.getElementById('toolOutput');
  const labels = { doctor: 'System Doctor', verify: 'Pipeline Verification', normalize: 'Status Normalization',
    dedup: 'Tracker Dedup', merge: 'Tracker Merge', patterns: 'Pattern Analysis',
    reposts: 'Repost Detection', 'sync-check': 'Sync Check', followup: 'Follow-up Cadence' };
  output.innerHTML = `<div class="progress-bar-container"><div class="progress-bar"><div class="progress-fill" style="width:50%"></div></div><div class="progress-text">Running ${labels[name] || name}...</div></div>`;

  try {
    const data = await API.post('/api/run-script', { script: name });
    const success = data.success;
    output.innerHTML = `
      <div class="status-msg ${success ? 'success' : 'error'}" style="display:block">${success ? 'Completed' : 'Failed'} (exit code ${data.code})</div>
      <pre>${escapeHtml(data.stdout || '')}${data.stderr ? '\n\nSTDERR:\n' + escapeHtml(data.stderr) : ''}</pre>
    `;
  } catch (e) {
    output.innerHTML = `<div class="status-msg error" style="display:block">Error: ${escapeHtml(e.message)}</div>`;
  }
}

// ── Settings ─────────────────────────────────────────────────────
async function loadSettings() {
  try {
    const data = await API.get('/api/profile');
    document.getElementById('profileEditor').value = data.profile ? yamlStringify(data.profile) : '# No profile configured';
    const env = await API.get('/api/env');
    document.getElementById('envStatus').innerHTML = Object.entries(env).map(([k,v]) =>
      `<div style="display:flex;justify-content:space-between;padding:6px 10px;background:var(--bg3);border-radius:var(--radius-sm);margin-bottom:4px">
        <span>${k}</span>
        <span style="color:${v.includes('***') ? 'var(--success)' : 'var(--text3)'}">${v}</span>
      </div>`
    ).join('');
    loadModels();
    loadProviders();
  } catch (e) { console.error('Settings load error:', e); }
}

async function loadProviders() {
  const container = document.getElementById('providersList');
  try {
    const [providers, models] = await Promise.all([
      API.get('/api/providers'),
      API.get('/api/models')
    ]);
    document.getElementById('providerCount').textContent = providers.connected > 0 ? `(${providers.connected} connected)` : '(setup guide)';

    const cards = (models.knownFree || []).map(m => {
      const connected = m.available;
      const setupSteps = {
        'Google AI Studio': [
          { text: 'Go to aistudio.google.com', url: 'https://aistudio.google.com' },
          { text: 'Sign in with your Google account', url: '' },
          { text: 'Click "Get API Key" → Create → copy the key', url: '' },
          { text: 'In OpenCode terminal: run /connect, select Google, paste key', url: '' },
        ],
        'Groq': [
          { text: 'Go to console.groq.com', url: 'https://console.groq.com' },
          { text: 'Sign up (email/Google/GitHub)', url: '' },
          { text: 'Go to API Keys → Create API Key → copy', url: '' },
          { text: 'In OpenCode terminal: run /connect, select Groq, paste key', url: '' },
        ],
        'Cerebras': [
          { text: 'Go to cloud.cerebras.ai', url: 'https://cloud.cerebras.ai' },
          { text: 'Sign up → Create API Key → copy', url: '' },
          { text: 'In OpenCode terminal: run /connect, select Cerebras, paste key', url: '' },
        ],
      };
      const steps = setupSteps[m.provider] || [];

      return `<div style="display:flex;justify-content:space-between;align-items:flex-start;padding:12px;background:var(--bg3);border-radius:var(--radius-sm);border-left:3px solid ${connected ? 'var(--success)' : 'var(--text3)'}">
        <div style="flex:1">
          <div style="font-weight:600;margin-bottom:2px">${m.id}</div>
          <div style="color:var(--text2);font-size:13px">${m.provider} · ${m.tier} · ${m.best}</div>
          ${!connected ? `<details style="margin-top:8px"><summary style="cursor:pointer;color:var(--accent);font-size:13px">Setup guide</summary>
            <ol style="margin:8px 0 0 16px;padding:0;font-size:13px;color:var(--text2)">
              ${steps.map(s => s.url ? `<li><a href="${s.url}" target="_blank" style="color:var(--accent)">${s.text}</a></li>` : `<li>${s.text}</li>`).join('')}
            </ol>
          </details>` : `<div style="color:var(--success);font-size:12px;margin-top:4px">✓ Available in model dropdown</div>`}
        </div>
        <button class="btn btn-sm" onclick="document.getElementById('modelSelect').value='${m.id}';saveModel()" style="white-space:nowrap;margin-left:8px">Use This</button>
      </div>`;
    });

    if (cards.length) {
      container.innerHTML = cards.join('');
    } else {
      container.innerHTML = '<div style="color:var(--text2);text-align:center;padding:12px">Loading provider info...</div>';
    }
  } catch (e) {
    container.innerHTML = `<div class="status-msg error" style="display:block">${escapeHtml(e.message)}</div>`;
  }
}

async function saveProfile() {
  const yaml = document.getElementById('profileEditor').value;
  const status = document.getElementById('profileYamlStatus');
  try {
    const result = await API.post('/api/profile', { yaml });
    if (result.success) {
      status.className = 'status-msg success'; status.textContent = 'Profile saved!'; status.style.display = 'block';
      setTimeout(() => status.style.display = 'none', 3000);
    }
  } catch (e) {
    status.className = 'status-msg error'; status.textContent = 'Error: ' + e.message; status.style.display = 'block';
  }
}

async function loadModels() {
  const output = document.getElementById('modelsOutput');
  const select = document.getElementById('modelSelect');
  output.textContent = 'Checking available models...';
  try {
    const data = await API.get('/api/models');
    const allModels = (data.list || []);
    const googleCount = (data.googleModels || []).length;

    let html = '';
    if (googleCount > 0) html += `\nGoogle AI Studio: ${googleCount} models available ✓\n`;
    html += data.output || '';
    output.textContent = html || 'No model information available.';

    if (allModels.length || (data.ollamaModels && data.ollamaModels.length) || (data.ollamaCloudModels && data.ollamaCloudModels.length)) {
      const google = allModels.filter(m => m.startsWith('google/'));
      const ollama = data.ollamaModels || [];
      const ollamaCloud = data.ollamaCloudModels || [];
      let options = '<option value="">Default (gemini-2.5-flash)</option>';
      if (google.length) {
        options += '<optgroup label="Google Gemini (connected)">' +
          google.map(m => `<option value="${m}">${m.replace('google/', '')}</option>`).join('') +
          '</optgroup>';
      }
      if (ollama.length) {
        options += '<optgroup label="Ollama (local)">' +
          ollama.map(m => `<option value="${m}">${m.replace('ollama/', '')}</option>`).join('') +
          '</optgroup>';
      }
      if (ollamaCloud.length) {
        options += '<optgroup label="Ollama Cloud">' +
          ollamaCloud.map(m => `<option value="${m}">${m.replace('ollama-cloud/', '')}</option>`).join('') +
          '</optgroup>';
      }
      if (!google.length && !ollama.length && !ollamaCloud.length) {
        options = '<option value="">No models available</option>';
      }
      select.innerHTML = options;
      const pref = await API.get('/api/model');
      if (pref.model && (pref.model.startsWith('google/') || pref.model.startsWith('ollama/'))) {
        select.value = pref.model;
      }
    }
  } catch (e) {
    output.textContent = 'Error: ' + e.message;
  }
}

async function saveModel() {
  const select = document.getElementById('modelSelect');
  const status = document.getElementById('modelStatus');
  const model = select.value;
  try {
    if (model) {
      await API.post('/api/model', { model });
    } else {
      await API.post('/api/model', { model: '' });
    }
    status.className = 'status-msg success';
    status.textContent = model ? `Model set to: ${model}` : 'Using default model';
    status.style.display = 'block';
    setTimeout(() => status.style.display = 'none', 3000);
  } catch (e) {
    status.className = 'status-msg error';
    status.textContent = 'Error: ' + e.message;
    status.style.display = 'block';
  }
}

// ── Profile & Focus Management ──────────────────────────────────
async function loadProfiles() {
  try {
    const data = await API.get('/api/profiles');
    const sel = document.getElementById('profileSelect');
    const activeLabel = document.getElementById('activeProfileLabel');
    const badge = document.getElementById('activeProfileBadge');
    
    sel.innerHTML = data.profiles.map(p =>
      `<option value="${escapeHtml(p.name)}" ${p.active ? 'selected' : ''}>${escapeHtml(p.name)}${p.active ? ' (active)' : ''}</option>`
    ).join('');
    
    if (activeLabel) activeLabel.textContent = data.active;
    if (badge) badge.textContent = data.active;
    
    // Populate copy-from dropdown
    const copySel = document.getElementById('copyProfileSelect');
    if (copySel) {
      const currentVal = copySel.value;
      copySel.innerHTML = '<option value="">Copy from...</option>' +
        data.profiles.filter(p => p.name !== data.active).map(p =>
          `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`
        ).join('');
      if (currentVal) copySel.value = currentVal;
    }
    
    loadFocuses();
  } catch (e) { console.error('Profiles load error:', e); }
}

async function switchProfile() {
  const name = document.getElementById('profileSelect').value;
  const status = document.getElementById('profileStatus');
  if (!name) return;
  try {
    status.className = 'status-msg info'; status.textContent = 'Switching to ' + name + '...'; status.style.display = 'block';
    const result = await API.post('/api/profiles/switch', { name });
    if (result.success) {
      status.className = 'status-msg success'; status.textContent = 'Switched to ' + name + '. Portals.yml rebuilt with ' + (result.focuses?.focusLabels?.join(' & ') || 'selected focuses') + '.';
      status.style.display = 'block';
      loadProfiles();
      loadFocuses();
    }
  } catch (e) {
    status.className = 'status-msg error'; status.textContent = 'Error: ' + e.message; status.style.display = 'block';
  }
}

async function createProfile() {
  const name = document.getElementById('newProfileName').value.trim();
  const status = document.getElementById('profileStatus');
  const copyFrom = document.getElementById('copyProfileSelect')?.value;
  if (!name) { status.className = 'status-msg error'; status.textContent = 'Enter a profile name.'; status.style.display = 'block'; return; }
  try {
    const result = await API.post('/api/profiles', { name, copyFrom });
    if (result.success) {
      status.className = 'status-msg success'; status.textContent = 'Profile "' + name + '" created!';
      status.style.display = 'block';
      document.getElementById('newProfileName').value = '';
      loadProfiles();
      // Auto-switch to new profile
      await API.post('/api/profiles/switch', { name });
      loadProfiles();
      loadFocuses();
      document.getElementById('activeProfileBadge').textContent = name;
      // Check if new profile needs onboarding (no copyFrom means blank slate)
      if (!copyFrom) {
        setTimeout(() => {
          document.getElementById('onboardingModal').style.display = 'flex';
        }, 500);
      }
    }
  } catch (e) {
    status.className = 'status-msg error'; status.textContent = 'Error: ' + e.message; status.style.display = 'block';
  }
}

async function deleteProfile() {
  const name = document.getElementById('profileSelect').value;
  const status = document.getElementById('profileStatus');
  if (!name) return;
  if (!confirm('Delete profile "' + name + '"? This cannot be undone.')) return;
  try {
    const result = await API.delete('/api/profiles/' + encodeURIComponent(name));
    if (result.success) {
      status.className = 'status-msg success'; status.textContent = 'Profile "' + name + '" deleted.';
      status.style.display = 'block';
      loadProfiles();
      loadFocuses();
    }
  } catch (e) {
    status.className = 'status-msg error'; status.textContent = 'Error: ' + e.message; status.style.display = 'block';
  }
}

async function loadFocuses() {
  try {
    const data = await API.get('/api/profiles/focuses');
    const container = document.getElementById('focusCards');
    const status = document.getElementById('focusStatus');
    const selected = data.selected || [];
    
    // Update profile name in focus section header
    const header = document.getElementById('focusProfileName');
    if (header) header.textContent = data.profile;
    
    if (!data.available || data.available.length === 0) {
      container.innerHTML = '<p class="text2">No focus areas defined.</p>';
      return;
    }
    
    container.innerHTML = data.available.map(f => {
      const isSelected = selected.includes(f.id);
      const disabled = !isSelected && selected.length >= 5;
      return `<div class="focus-card ${isSelected ? 'focus-selected' : ''} ${disabled ? 'focus-disabled' : ''}"
                  onclick="${disabled ? '' : "toggleFocus('" + f.id + "')"}"
                  title="${disabled ? 'Max 5 focuses (deselect one first)' : f.description}">
        <div class="focus-icon">${f.icon}</div>
        <div class="focus-info">
          <div class="focus-label">${escapeHtml(f.label)}</div>
          <div class="focus-desc">${escapeHtml(f.description)}</div>
        </div>
        <div class="focus-check">${isSelected ? '✓' : ''}</div>
      </div>`;
    }).join('');
    
    if (status) {
      if (selected.length === 0) {
        status.className = 'status-msg info'; status.textContent = 'Select 1-5 focus areas above.'; status.style.display = 'block';
      } else {
        status.style.display = 'none';
      }
    }
  } catch (e) { console.error('Focuses load error:', e); }
}

function toggleFocus(id) {
  return saveFocusesToggle(id);
}

let _focusToggleQueue = [];

async function saveFocusesToggle(focusId) {
  try {
    const data = await API.get('/api/profiles/focuses');
    let selected = data.selected || [];
    
    if (selected.includes(focusId)) {
      selected = selected.filter(id => id !== focusId);
    } else {
      if (selected.length >= 5) {
        document.getElementById('focusStatus').className = 'status-msg error';
        document.getElementById('focusStatus').textContent = 'Max 5 focuses allowed. Deselect one first.';
        document.getElementById('focusStatus').style.display = 'block';
        return;
      }
      selected.push(focusId);
    }
    
    const result = await API.post('/api/profiles/focuses', { focusIds: selected });
    if (result.success) {
      loadFocuses();
    }
  } catch (e) { console.error('Focus toggle error:', e); }
}

async function applyProfile() {
  const status = document.getElementById('profileYamlStatus');
  status.className = 'status-msg info'; status.textContent = 'Applying profile...'; status.style.display = 'block';
  try {
    const result = await API.post('/api/profiles/apply', {});
    if (result.success) {
      status.className = 'status-msg success'; status.textContent = 'Profile applied! CV, focuses, and portal config synced.';
      status.style.display = 'block';
      loadProfiles();
      loadFocuses();
      const badge = document.getElementById('activeProfileBadge');
      if (badge) badge.textContent = result.active;
    } else {
      status.className = 'status-msg error'; status.textContent = result.error || 'Apply failed';
      status.style.display = 'block';
    }
  } catch (e) {
    status.className = 'status-msg error'; status.textContent = 'Error: ' + e.message; status.style.display = 'block';
  }
}

async function saveFocuses() {
  const container = document.getElementById('focusCards');
  const cards = container.querySelectorAll('.focus-card');
  const selectedIds = [];
  const data = await API.get('/api/profiles/focuses');
  const available = data.available || [];
  
  cards.forEach((card, i) => {
    if (card.classList.contains('focus-selected') && available[i]) {
      selectedIds.push(available[i].id);
    }
  });
  
  if (selectedIds.length === 0) {
    document.getElementById('focusStatus').className = 'status-msg error';
    document.getElementById('focusStatus').textContent = 'Select at least one focus.';
    document.getElementById('focusStatus').style.display = 'block';
    return;
  }
  
  try {
    const result = await API.post('/api/profiles/focuses', { focusIds: selectedIds });
    if (result.success) {
      document.getElementById('focusStatus').className = 'status-msg success';
      document.getElementById('focusStatus').textContent = 'Focuses saved! Scanner will now search for: ' + (result.focusLabels || selectedIds).join(' & ');
      document.getElementById('focusStatus').style.display = 'block';
      loadFocuses();
    }
  } catch (e) {
    document.getElementById('focusStatus').className = 'status-msg error';
    document.getElementById('focusStatus').textContent = 'Error: ' + e.message;
    document.getElementById('focusStatus').style.display = 'block';
  }
}

// ── Utility ──────────────────────────────────────────────────────
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function yamlStringify(obj, indent = 0) {
  if (typeof obj !== 'object' || obj === null) return String(obj);
  const pad = '  '.repeat(indent);
  let result = '';
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]\n';
    obj.forEach(item => {
      if (typeof item === 'object' && item !== null) {
        result += `${pad}- ${Object.keys(item)[0]}: ${Object.values(item)[0]}\n`;
        for (const [k,v] of Object.entries(item).slice(1)) {
          result += `${pad}  ${k}: ${v}\n`;
        }
      } else {
        result += `${pad}- ${item}\n`;
      }
    });
  } else {
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'object' && value !== null) {
        result += `${pad}${key}:\n`;
        result += yamlStringify(value, indent + 1);
      } else {
        result += `${pad}${key}: ${value}\n`;
      }
    }
  }
  return result;
}

// ── Init ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadDashboard();
  // Check if active profile needs onboarding (delayed to let dashboard load first)
  setTimeout(checkOnboarding, 500);
});
