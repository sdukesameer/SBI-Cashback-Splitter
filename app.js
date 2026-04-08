// ─── Config ────────────────────────────────────────────────────────────────
// Get your FREE Groq key at https://console.groq.com/keys
const GROQ_API_KEY = '';

// ─── State ─────────────────────────────────────────────────────────────────
let allTransactions = { primary: [], addon: [] };

// ─── Theme ─────────────────────────────────────────────────────────────────
function initTheme() {
  const saved = localStorage.getItem('sbi-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
  updateThemeIcon(saved);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('sbi-theme', next);
  updateThemeIcon(next);
}

function updateThemeIcon(theme) {
  document.getElementById('themeBtn').textContent = theme === 'dark' ? '☀️' : '🌙';
  document.getElementById('themeBtn').title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
}

// ─── Cashback Formulas (exact Excel match) ─────────────────────────────────
// Online 5%: =IF(ISBLANK(G2),,FLOOR(ABS(B2)*0.01,1)*SIGN(B2)+FLOOR(ABS(B2)*0.04,1)*SIGN(B2))
// Offline 1%: =IF(ISBLANK(E2),,MAX(FLOOR(B2*0.01,1),0))

function calcCashback(amount, category) {
  if (category === 'excluded') return 0;
  if (category === 'online') {
    const abs = Math.abs(amount);
    const sign = amount < 0 ? -1 : 1;
    return (Math.floor(abs * 0.01) + Math.floor(abs * 0.04)) * sign;
  }
  if (category === 'offline') {
    return Math.max(Math.floor(amount * 0.01), 0);
  }
  return 0;
}

// ─── Upload ────────────────────────────────────────────────────────────────
document.getElementById('fileInput').addEventListener('change', e => {
  const f = e.target.files[0];
  if (!f) return;
  document.getElementById('fileName').textContent = '📎 ' + f.name;
  document.getElementById('fileName').classList.remove('hidden');
  setStatus('idle', `${f.name} ready — click Process to begin`);
  document.getElementById('processBtn').disabled = false;
  allTransactions = { primary: [], addon: [] };
  document.getElementById('results').classList.add('hidden');
});

const zone = document.getElementById('uploadZone');
zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag'); });
zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
zone.addEventListener('drop', e => {
  e.preventDefault(); zone.classList.remove('drag');
  const f = e.dataTransfer.files[0];
  if (f && f.name.endsWith('.pdf')) {
    document.getElementById('fileInput').files = e.dataTransfer.files;
    document.getElementById('fileName').textContent = '📎 ' + f.name;
    document.getElementById('fileName').classList.remove('hidden');
    setStatus('idle', `${f.name} ready — click Process to begin`);
    document.getElementById('processBtn').disabled = false;
    document.getElementById('results').classList.add('hidden');
  }
});

// ─── Status ────────────────────────────────────────────────────────────────
function setStatus(state, msg) {
  const dot = document.getElementById('statusDot');
  dot.className = 'status-dot' + (state === 'active' ? ' active' : state === 'done' ? ' done' : state === 'error' ? ' error' : '');
  document.getElementById('statusText').textContent = msg;
}

function showLoading(msg, sub = '') {
  document.getElementById('loadingMsg').textContent = msg;
  document.getElementById('loadingSub').textContent = sub;
  document.getElementById('loadingOverlay').classList.remove('hidden');
}
function hideLoading() { document.getElementById('loadingOverlay').classList.add('hidden'); }

// ─── PDF Parse ─────────────────────────────────────────────────────────────
async function parsePDF(file) {
  const ab = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: ab }).promise;
  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(s => s.str).join(' ') + '\n';
  }
  return text;
}

function parseTxnsFromSection(txt) {
  const results = [];
  const re = /(\d{2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{2})\s+([\w*@.()/\- ]+?)\s+([\d,]+\.\d{2})\s+([CD])\b/g;
  let m;
  while ((m = re.exec(txt)) !== null) {
    const desc = m[2].trim().replace(/\s+/g, ' ');
    const amt = parseFloat(m[3].replace(/,/g, ''));
    const isCredit = m[4] === 'C';
    if (/PAYMENT RECEIVED|CARD CASHBACK CREDIT|OTC Pymt|WWW OLACABS/i.test(desc)) continue;
    if (amt === 0) continue;
    results.push({
      date: m[1],
      description: desc,
      amount: isCredit ? -amt : amt,
      category: '',
      cashback: 0
    });
  }
  return results;
}

function extractTransactions(text) {
  const fullText = text.split(/\n/).map(l => l.trim()).filter(Boolean).join(' ');
  const sections = [];
  const sectionPattern = /(TRANSACTIONS FOR [A-Z ]+)/g;
  let sm;
  while ((sm = sectionPattern.exec(fullText)) !== null) sections.push({ name: sm[1], pos: sm.index });
  sections.push({ pos: fullText.length });

  const primary = [];
  const addon = [];

  for (let i = 0; i < sections.length - 1; i++) {
    const secText = fullText.substring(sections[i].pos, sections[i + 1].pos);
    const isAddon = /SHAHABUDDIN/i.test(sections[i].name);
    const txns = parseTxnsFromSection(secText);
    (isAddon ? addon : primary).push(...txns);
  }

  if (sections.length > 0) {
    const topTxns = parseTxnsFromSection(fullText.substring(0, sections[0].pos));
    primary.unshift(...topTxns);
  }

  return { primary, addon };
}

// ─── AI Classification ─────────────────────────────────────────────────────
async function classifyTransactions(transactions) {
  // Only send merchant names — no amounts, no personal info
  const merchants = transactions
    .filter(t => t.amount > 0)
    .map((t, i) => ({ id: i, merchant: t.description.replace(/\b\d{4,}\b/g, '').trim().substring(0, 45) }));

  const prompt = `Classify each SBI Cashback Card transaction for cashback purposes.

Rules:
- "online": Online purchases — Flipkart, Myntra, Amazon, Zepto, Blinkit, Swiggy, Zomato, Uber, Ola, RedBus, MakeMyTrip, Nykaa, CRED, RAZ*DREAMPLUG, PTM*Flipkart, streaming, any app-based order
- "offline": Physical store POS/swipe — shops, malls, medical stores, local retailers, restaurants with physical presence
- "excluded": Fuel stations, utility bills, wallet loads (Paytm/PhonePe top-up), rent (MCC 6513), insurance, jewellery, cash advance, government/tax payments, donations, Darul Uloom or similar religious/educational institutions paid via 3rd party

Respond ONLY with JSON array, no markdown:
[{"id":0,"category":"online"},...]

Transactions:
${JSON.stringify(merchants)}`;

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      max_tokens: 1000,
      temperature: 0,
      messages: [{ role: "user", content: prompt }]
    })
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Groq API error');
  const raw = data.choices?.[0]?.message?.content || '[]';
  const classifications = JSON.parse(raw.replace(/```json|```/g, '').trim());

  // Build id→category map for debits only
  const catMap = {};
  let debitIdx = 0;
  transactions.forEach((t, i) => {
    if (t.amount > 0) {
      const match = classifications.find(c => c.id === debitIdx);
      catMap[i] = match?.category || 'offline';
      debitIdx++;
    }
  });

  // Apply to all transactions; credits inherit category from matching debit
  const result = transactions.map((t, i) => {
    let category;
    if (t.amount > 0) {
      category = catMap[i] || 'offline';
    } else {
      // Find matching debit by description similarity
      const descNorm = t.description.replace(/\s+/g, '').toLowerCase();
      const match = transactions.find((d, j) => j !== i && d.amount > 0 && catMap[j] &&
        d.description.replace(/\s+/g, '').toLowerCase().substring(0, 8) === descNorm.substring(0, 8));
      category = match ? catMap[transactions.indexOf(match)] : 'offline';
    }
    return { ...t, category, cashback: calcCashback(t.amount, category) };
  });

  return result;
}

// ─── Process ───────────────────────────────────────────────────────────────
document.getElementById('processBtn').addEventListener('click', async () => {
  const file = document.getElementById('fileInput').files[0];
  if (!file) return;
  try {
    showLoading('Parsing PDF...', 'Extracting text from statement');
    setStatus('active', 'Reading PDF...');
    const pdfText = await parsePDF(file);

    showLoading('Extracting transactions...', 'Identifying debits and credits');
    setStatus('active', 'Extracting transactions...');
    const extracted = extractTransactions(pdfText);

    if (!extracted.primary.length && !extracted.addon.length)
      throw new Error('No transactions found. Make sure this is an SBI Card monthly statement PDF.');

    showLoading('AI classifying merchants...', '🔒 Only merchant names sent — no personal data');
    setStatus('active', 'Classifying with AI...');

    const [p, a] = await Promise.all([
      extracted.primary.length ? classifyTransactions(extracted.primary) : Promise.resolve([]),
      extracted.addon.length  ? classifyTransactions(extracted.addon)   : Promise.resolve([])
    ]);

    allTransactions.primary = p;
    allTransactions.addon = a;
    renderAll();
    hideLoading();
    setStatus('done', `✓ Done — ${p.length + a.length} transactions classified`);
    document.getElementById('results').classList.remove('hidden');
    document.getElementById('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    hideLoading();
    setStatus('error', '✗ ' + err.message);
    console.error(err);
  }
});

// ─── Calc helpers ──────────────────────────────────────────────────────────
function netAmount(txns) {
  // Net: debits + credits (credits are negative, so this correctly subtracts refunds)
  return txns.reduce((s, t) => s + t.amount, 0);
}

function netCashback(txns) {
  // Net cashback: sum of all (positive cashback on debits + negative cashback on refunds = 0 net for returns)
  return txns.reduce((s, t) => s + t.cashback, 0);
}

function grossSpend(txns) {
  return txns.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0);
}

// ─── Render All ────────────────────────────────────────────────────────────
function renderAll() {
  renderSummary();
  renderTable('tablePrimary', allTransactions.primary, 'primary');
  renderTable('tableAddon', allTransactions.addon, 'addon');
  renderBill();
}

function renderSummary() {
  const p = allTransactions.primary;
  const a = allTransactions.addon;

  const pNet = netAmount(p);          // your net spend (after refunds)
  const pCb  = netCashback(p);        // your net cashback (after refund deductions)
  const aNet = netAmount(a);          // dad's net spend
  const aCb  = netCashback(a);        // dad's net cashback

  // Bill logic:
  // You pay: your full net spend (cashback comes next month, not deducted now)
  //        + dad's net spend MINUS dad's cashback (you keep dad's cashback, so dad pays less to you)
  // Your due to SBI = pNet + aNet (total statement net)
  // Dad pays you   = aNet - aCb  (his spend minus his cashback which you absorb)
  // You effectively pay = pNet + aCb (your spend + you absorb dad's cashback next month)

  const dadPayYou = Math.max(aNet - aCb, 0);
  const yourDue   = pNet + aNet; // total you owe SBI this month
  const yourPart  = pNet;        // your own transactions

  document.getElementById('summaryGrid').innerHTML = `
    <div class="stat-card accent-green">
      <div class="stat-label">Your Net Spend</div>
      <div class="stat-value txt-green">₹${fmt(pNet)}</div>
      <div class="stat-sub">After refunds · Cashback next month</div>
    </div>
    <div class="stat-card accent-amber">
      <div class="stat-label">Your Cashback (next bill)</div>
      <div class="stat-value txt-amber">₹${fmt(pCb)}</div>
      <div class="stat-sub">Posted after statement date</div>
    </div>
    <div class="stat-card accent-blue">
      <div class="stat-label">Dad's Net Spend</div>
      <div class="stat-value txt-blue">₹${fmt(aNet)}</div>
      <div class="stat-sub">After refunds</div>
    </div>
    <div class="stat-card accent-purple">
      <div class="stat-label">Dad's Cashback (you keep)</div>
      <div class="stat-value" style="color:var(--purple)">₹${fmt(aCb)}</div>
      <div class="stat-sub">Deducted from what dad pays you</div>
    </div>
  `;

  // Due box
  document.getElementById('dueBox').innerHTML = `
    <div class="due-left">
      <h3>Your SBI Bill Due</h3>
      <div class="due-amount">₹${fmt(yourDue)}</div>
      <p>Pay this to SBI · Your cashback (₹${fmt(pCb)}) credited next month</p>
    </div>
    <div class="due-right">
      <div class="due-row"><label>Your transactions</label><span class="mono">₹${fmt(pNet)}</span></div>
      <div class="due-row"><label>Dad's transactions</label><span class="mono">₹${fmt(aNet)}</span></div>
      <div class="due-row separator highlight"><label>Total you pay SBI</label><span class="mono txt-amber">₹${fmt(yourDue)}</span></div>
      <div class="due-row" style="margin-top:8px"><label>Dad pays you</label><span class="mono txt-green">₹${fmt(dadPayYou)}</span></div>
      <div class="due-row"><label style="font-size:10px;color:var(--text3)">= Dad's spend (₹${fmt(aNet)}) − his cashback (₹${fmt(aCb)})</label></div>
    </div>
  `;
}

function renderTable(tableId, txns, section) {
  const table = document.getElementById(tableId);
  table.innerHTML = `
    <thead><tr>
      <th>Date</th>
      <th>Merchant / Description</th>
      <th style="text-align:right">Amount (₹)</th>
      <th>Category</th>
      <th style="text-align:right">Cashback (₹)</th>
    </tr></thead>
    <tbody>
      ${txns.map((t, i) => `
        <tr class="${t.amount < 0 ? 'is-credit' : ''}">
          <td class="mono txt-dim" style="white-space:nowrap">${t.date}</td>
          <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(t.description)}">
            ${t.amount < 0 ? '<span style="font-size:10px;color:var(--text3);margin-right:4px">↩ REFUND</span>' : ''}${escHtml(t.description)}
          </td>
          <td style="text-align:right" class="${t.amount < 0 ? 'mono txt-dim' : 'mono fw-600'}">${t.amount < 0 ? '−' : ''}₹${fmt(Math.abs(t.amount))}</td>
          <td>
            <select class="cat-select ${t.category}" onchange="reclassifyRow('${section}', ${i}, this.value)">
              <option value="online"   ${t.category === 'online'   ? 'selected' : ''}>🌐 Online 5%</option>
              <option value="offline"  ${t.category === 'offline'  ? 'selected' : ''}>🏪 Offline 1%</option>
              <option value="excluded" ${t.category === 'excluded' ? 'selected' : ''}>🚫 Excluded</option>
            </select>
          </td>
          <td style="text-align:right" class="${t.cashback === 0 ? 'cb-zero' : t.cashback < 0 ? 'cb-neg' : 'cb-pos'}">
            ${t.cashback === 0 ? '—' : (t.cashback < 0 ? '−' : '+') + '₹' + fmt(Math.abs(t.cashback))}
          </td>
        </tr>
      `).join('')}
    </tbody>
  `;
}

function renderBill() {
  const p = allTransactions.primary;
  const a = allTransactions.addon;
  const pNet = netAmount(p);
  const pCb  = netCashback(p);
  const aNet = netAmount(a);
  const aCb  = netCashback(a);
  const pGross = grossSpend(p);
  const aGross = grossSpend(a);

  document.getElementById('billContent').innerHTML = `
    <div class="bill-grid">
      <div class="bill-card">
        <h4>Primary — MD SAMEER (You)</h4>
        <div class="bill-line"><label>Gross Spending</label><span class="mono">₹${fmt(pGross)}</span></div>
        <div class="bill-line"><label>Refunds / Credits</label><span class="mono txt-dim">−₹${fmt(pGross - pNet)}</span></div>
        <div class="bill-line"><label>Net Spend</label><span class="mono fw-600">₹${fmt(pNet)}</span></div>
        <div class="bill-line"><label>Cashback earned (next bill)</label><span class="mono txt-amber">₹${fmt(pCb)}</span></div>
        <div class="bill-line total"><label>You pay SBI (your share)</label><span class="mono txt-green">₹${fmt(pNet)}</span></div>
      </div>
      <div class="bill-card">
        <h4>Add-On — SHAHABUDDIN (Dad)</h4>
        <div class="bill-line"><label>Gross Spending</label><span class="mono">₹${fmt(aGross)}</span></div>
        <div class="bill-line"><label>Refunds / Credits</label><span class="mono txt-dim">−₹${fmt(aGross - aNet)}</span></div>
        <div class="bill-line"><label>Net Spend</label><span class="mono fw-600">₹${fmt(aNet)}</span></div>
        <div class="bill-line"><label>Cashback earned (you keep)</label><span class="mono txt-amber">−₹${fmt(aCb)}</span></div>
        <div class="bill-line total"><label>Dad pays you</label><span class="mono txt-blue">₹${fmt(Math.max(aNet - aCb, 0))}</span></div>
      </div>
    </div>
    <div class="bill-card mt-16" style="background:var(--amber-bg);border-color:var(--amber-border)">
      <h4 style="color:var(--amber)">Total Bill — What You Pay SBI</h4>
      <div class="bill-line"><label>Your net spend</label><span class="mono">₹${fmt(pNet)}</span></div>
      <div class="bill-line"><label>Dad's net spend</label><span class="mono">₹${fmt(aNet)}</span></div>
      <div class="bill-line total"><label>Total statement due (pay this to SBI)</label><span class="mono txt-amber" style="font-size:18px">₹${fmt(pNet + aNet)}</span></div>
      <div class="bill-line" style="margin-top:8px"><label>Next month cashback credit</label><span class="mono txt-green">₹${fmt(pCb + aCb)}</span></div>
      <div class="bill-line"><label>Next month effective cost</label><span class="mono">₹${fmt(pNet + aNet - pCb - aCb)}</span></div>
    </div>
  `;
}

// ─── Interactions ──────────────────────────────────────────────────────────
function reclassifyRow(section, idx, category) {
  const t = allTransactions[section][idx];
  t.category = category;
  t.cashback = calcCashback(t.amount, category);
  // Update select styling without full re-render
  renderAll();
}

function showTab(tab) {
  document.querySelectorAll('.tab-view').forEach(v => v.classList.add('hidden'));
  document.getElementById('view-' + tab).classList.remove('hidden');
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById('tab-' + tab);
  btn.classList.add('active');
}

async function reclassify() {
  if (!allTransactions.primary.length && !allTransactions.addon.length) return;
  try {
    showLoading('Re-classifying with AI...', '🔒 Only merchant names sent');
    const [p, a] = await Promise.all([
      allTransactions.primary.length ? classifyTransactions(allTransactions.primary) : Promise.resolve([]),
      allTransactions.addon.length   ? classifyTransactions(allTransactions.addon)   : Promise.resolve([])
    ]);
    allTransactions.primary = p;
    allTransactions.addon = a;
    renderAll();
    setStatus('done', '✓ Re-classified successfully');
  } catch(e) { setStatus('error', '✗ Re-classify failed: ' + e.message); }
  hideLoading();
}

function downloadExcel() {
  const wb = XLSX.utils.book_new();

  function makeSheet(txns) {
    const net = netAmount(txns);
    const cb  = netCashback(txns);
    const rows = [
      ['Type', 'Amount', 'No cashback', 0, 'Swipe/Tap to pay', 0.01, 'Online Payment', 0.05],
      ...txns.map(t => [
        t.description, t.amount,
        t.category === 'excluded' ? 'Yes' : null, t.category === 'excluded' ? 0 : null,
        t.category === 'offline'  ? 'Yes' : null, t.category === 'offline'  ? t.cashback : null,
        t.category === 'online'   ? 'Yes' : null, t.category === 'online'   ? t.cashback : null,
      ]),
      [null, net, null, 0, null, 0, null, cb],
      [],
      [null, null, 'Spending', null, net],
      [null, null, 'Cashback', null, cb],
      [null, null, 'Total',    null, net - cb],
    ];
    return XLSX.utils.aoa_to_sheet(rows);
  }

  const p = allTransactions.primary;
  const a = allTransactions.addon;
  const pNet = netAmount(p), pCb = netCashback(p);
  const aNet = netAmount(a), aCb = netCashback(a);

  XLSX.utils.book_append_sheet(wb, makeSheet(p), 'Primary');
  XLSX.utils.book_append_sheet(wb, makeSheet(a), 'Add On');

  const billRows = [
    [],
    [null, 'Primary',  'Spending', null, pNet],
    [null, null,       'Cashback', null, pCb],
    [null, null,       'Total',    null, pNet],
    [],
    [null, 'Add On',   'Spending', null, aNet],
    [null, null,       'Cashback', null, aCb],
    [null, null,       'Dad Pays', null, Math.max(aNet - aCb, 0)],
    [],
    [null, 'Total',    'Pay to SBI',         null, pNet + aNet],
    [null, null,       'Next Bill Cashback',  null, pCb + aCb],
    [null, null,       'Net effective spend', null, pNet + aNet - pCb - aCb],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(billRows), 'Bill');

  const month = new Date().toLocaleString('en-IN', { month: 'short', year: 'numeric' }).replace(' ', '-');
  XLSX.writeFile(wb, `SBI_Cashback_${month}.xlsx`);
}

// ─── Utils ─────────────────────────────────────────────────────────────────
function fmt(n) {
  return Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Init ──────────────────────────────────────────────────────────────────
initTheme();
