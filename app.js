// ─── Config ────────────────────────────────────────────────────────────────
// Get your FREE Groq key at https://console.groq.com/keys
const GROQ_API_KEY = 'YOUR_GROQ_API_KEY_HERE';

// ─── State ─────────────────────────────────────────────────────────────────
// Transaction shape:
//   { date, description, amount, category, cashback, owner, fixed? }
//   owner = 'primary' | 'addon0' | 'addon1' …
//   fixed = true for CARD CASHBACK CREDIT row (not editable)
// allTransactions.primary = flat array
// allTransactions.addons  = [{ name, txns[] }]
// lastMonthCashback       = amount of "CARD CASHBACK CREDIT" found in PDF
let allTransactions = { primary: [], addons: [] };
let lastMonthCashback = 0;
let statementTotalFromPDF = 0; // parsed from PDF "Total Amount Due" for validation

// ─── Theme ─────────────────────────────────────────────────────────────────
function initTheme() {
  const saved = localStorage.getItem('sbi-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
  updateThemeIcon(saved);
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('sbi-theme', next);
  updateThemeIcon(next);
}
function updateThemeIcon(t) {
  const btn = document.getElementById('themeBtn');
  btn.textContent = t === 'dark' ? '☀️' : '🌙';
  btn.title = t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
}

// ─── Cashback Formulas (exact Excel match) ─────────────────────────────────
// Online 5%:  =IF(ISBLANK(G2),,FLOOR(ABS(B2)*0.01,1)*SIGN(B2)+FLOOR(ABS(B2)*0.04,1)*SIGN(B2))
// Offline 1%: =IF(ISBLANK(E2),,MAX(FLOOR(B2*0.01,1),0))
// Excluded:   0
function calcCashback(amount, category) {
  if (category === 'excluded' || category === 'cashback_credit') return 0;
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

// ─── Upload ─────────────────────────────────────────────────────────────────
document.getElementById('fileInput').addEventListener('change', e => {
  const f = e.target.files[0];
  if (!f) return;
  document.getElementById('fileName').textContent = '📎 ' + f.name;
  document.getElementById('fileName').classList.remove('hidden');
  setStatus('idle', `${f.name} ready — click Process to begin`);
  document.getElementById('processBtn').disabled = false;
  allTransactions = { primary: [], addons: [] };
  lastMonthCashback = 0;
  statementTotalFromPDF = 0;
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

// ─── Status ─────────────────────────────────────────────────────────────────
function setStatus(state, msg) {
  const dot = document.getElementById('statusDot');
  dot.className = 'status-dot'
    + (state === 'active' ? ' active' : state === 'done' ? ' done' : state === 'error' ? ' error' : '');
  document.getElementById('statusText').textContent = msg;
}
function showLoading(msg, sub = '') {
  document.getElementById('loadingMsg').textContent = msg;
  document.getElementById('loadingSub').textContent = sub;
  document.getElementById('loadingOverlay').classList.remove('hidden');
}
function hideLoading() { document.getElementById('loadingOverlay').classList.add('hidden'); }

// ─── PDF Parse ───────────────────────────────────────────────────────────────
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

// Parse transactions from a text block.
// Also extracts lastMonthCashback from CARD CASHBACK CREDIT lines.
function parseTxnsFromSection(txt) {
  const results = [];
  const re = /(\d{2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{2})\s+([\w*@.()/\- ]+?)\s+([\d,]+\.\d{2})\s+([CD])\b/g;
  let m;
  while ((m = re.exec(txt)) !== null) {
    const desc = m[2].trim().replace(/\s+/g, ' ');
    const amt = parseFloat(m[3].replace(/,/g, ''));
    const isCredit = m[4] === 'C';
    // Skip payment entries
    if (/PAYMENT RECEIVED|OTC Pymt/i.test(desc)) continue;
    if (amt === 0) continue;
    // Capture last-month cashback
    if (/CARD CASHBACK CREDIT/i.test(desc)) {
      if (isCredit && amt > lastMonthCashback) lastMonthCashback = amt;
      // Add as a special fixed row (informational, included in spending)
      results.push({
        date: m[1],
        description: 'CARD CASHBACK CREDIT (Last Month)',
        amount: -amt,
        category: 'cashback_credit',
        cashback: 0,
        fixed: true
      });
      continue;
    }
    // Skip OLA 1 rupee noise
    if (/WWW OLACABS/i.test(desc) && amt === 1) continue;
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

// Extract Total Amount Due from PDF text for validation
function extractTotalDue(text) {
  // SBI statement has "Total Amount Due" followed by amount
  // e.g. "16,629.00" on the statement face page
  const m = text.match(/Total Amount Due[^0-9]*?([\d,]+\.\d{2})/);
  if (m) return parseFloat(m[1].replace(/,/g, ''));
  return 0;
}

// Split PDF text into primary + N add-on sections.
// SBI order: add-ons first, primary last.
function extractTransactions(text) {
  lastMonthCashback = 0;
  const fullText = text.split(/\n/).map(l => l.trim()).filter(Boolean).join(' ');

  statementTotalFromPDF = extractTotalDue(fullText);

  // Find all "TRANSACTIONS FOR <NAME>" headers
  const sections = [];
  const pat = /TRANSACTIONS FOR ([A-Z][A-Z ]+)/g;
  let sm;
  while ((sm = pat.exec(fullText)) !== null) sections.push({ name: sm[1].trim(), pos: sm.index });
  sections.push({ pos: fullText.length });

  const parsed = [];
  for (let i = 0; i < sections.length - 1; i++) {
    const secText = fullText.substring(sections[i].pos, sections[i + 1].pos);
    parsed.push({ name: sections[i].name, txns: parseTxnsFromSection(secText) });
  }

  // Content before first header (cashback credit, top-level items) → primary
  const topTxns = sections.length > 0
    ? parseTxnsFromSection(fullText.substring(0, sections[0].pos))
    : parseTxnsFromSection(fullText);

  let primary = [];
  const addonMap = {};

  if (parsed.length === 0) {
    primary = topTxns;
  } else {
    // SBI puts primary cardholder LAST
    const pSec = parsed[parsed.length - 1];
    primary = [...topTxns, ...pSec.txns];
    for (let i = 0; i < parsed.length - 1; i++) {
      const { name, txns } = parsed[i];
      if (!addonMap[name]) addonMap[name] = [];
      addonMap[name].push(...txns);
    }
  }

  const addons = Object.entries(addonMap).map(([name, txns]) => ({ name, txns }));
  return { primary, addons };
}

// ─── AI Classification ───────────────────────────────────────────────────────
async function classifyTransactions(transactions) {
  const debits = transactions.filter(t => t.amount > 0 && !t.fixed);
  const merchants = debits.map((t, i) => ({
    id: i,
    merchant: t.description.replace(/\b\d{4,}\b/g, '').trim().substring(0, 45)
  }));

  if (!merchants.length) return transactions.map(t => ({ ...t, cashback: calcCashback(t.amount, t.category || 'offline') }));

  const prompt = `Classify each SBI Cashback Card transaction for cashback purposes.

Rules:
- "online": Flipkart, Myntra, Amazon, Zepto, Blinkit, Swiggy, Zomato, Uber, Ola (app-based rides), RedBus, MakeMyTrip, Nykaa, CRED bill pay, RAZ*DREAMPLUG, PTM*Flipkart, LENSKART, EatClub, DEVYANI (Domino's/KFC via app), streaming, any app/website purchase
- "offline": Physical POS — local shops, malls, medical stores, clothing stores, restaurants (physical), KFC/Domino's POS swipe
- "excluded": Aadhaar/UIDAI government fees, school fees/educational institutions, fuel, utilities, wallet loads, rent, insurance, donations, religious institutions (Darul Uloom etc.), Indian Bank payment, OYO if >₹2000 via UPI, Amazon Utilities (DTH/electricity)

Respond ONLY with compact JSON array, no markdown:
[{"id":0,"category":"online"},...]

Transactions:
${JSON.stringify(merchants)}`;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 1200,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Groq API error');
  const raw = data.choices?.[0]?.message?.content || '[]';
  const classifications = JSON.parse(raw.replace(/```json|```/g, '').trim());

  // Map debit index → category
  const catMap = {};
  debits.forEach((t, debitIdx) => {
    const origIdx = transactions.indexOf(t);
    const match = classifications.find(c => c.id === debitIdx);
    catMap[origIdx] = match?.category || 'offline';
  });

  // Apply: debits use AI result; credits/refunds inherit from matching debit
  return transactions.map((t, i) => {
    if (t.fixed) return { ...t }; // cashback_credit row unchanged
    let category;
    if (t.amount > 0) {
      category = catMap[i] || 'offline';
    } else {
      // Match refund to debit by first 8 chars of description
      const descNorm = t.description.replace(/\s+/g, '').toLowerCase();
      const matchIdx = transactions.findIndex((d, j) => j !== i && d.amount > 0 &&
        d.description.replace(/\s+/g, '').toLowerCase().substring(0, 8) === descNorm.substring(0, 8));
      category = matchIdx >= 0 ? (catMap[matchIdx] || 'offline') : 'offline';
    }
    return { ...t, category, cashback: calcCashback(t.amount, category) };
  });
}

// ─── Process ─────────────────────────────────────────────────────────────────
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

    if (!extracted.primary.length && !extracted.addons.length)
      throw new Error('No transactions found. Make sure this is an SBI Card monthly statement PDF.');

    showLoading('AI classifying merchants...', '🔒 Only merchant names sent — no personal data');
    setStatus('active', 'Classifying with AI...');

    const classifiedPrimary = extracted.primary.length
      ? await classifyTransactions(extracted.primary) : [];

    const classifiedAddons = await Promise.all(
      extracted.addons.map(a => a.txns.length
        ? classifyTransactions(a.txns).then(txns => ({ name: a.name, txns }))
        : Promise.resolve({ name: a.name, txns: [] }))
    );

    allTransactions.primary = classifiedPrimary;
    allTransactions.addons = classifiedAddons;

    renderAll();
    hideLoading();
    const txnCount = classifiedPrimary.filter(t => !t.fixed).length
      + classifiedAddons.reduce((s, a) => s + a.txns.length, 0);
    setStatus('done', `✓ ${txnCount} transactions classified`);
    document.getElementById('results').classList.remove('hidden');
    document.getElementById('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    hideLoading();
    setStatus('error', '✗ ' + err.message);
    console.error(err);
  }
});

// ─── Calculation Helpers ─────────────────────────────────────────────────────
// "Spending" in Excel = net of ALL transactions including the cashback credit row
// (the cashback credit is negative, so it reduces spending — matches Excel exactly)
function sheetSpending(txns) {
  return txns.reduce((s, t) => s + t.amount, 0);
}
function sheetCashback(txns) {
  return txns.filter(t => !t.fixed).reduce((s, t) => s + t.cashback, 0);
}
function sheetTotal(txns) {
  return sheetSpending(txns) - sheetCashback(txns);
}
function grossDebits(txns) {
  return txns.filter(t => t.amount > 0 && !t.fixed).reduce((s, t) => s + t.amount, 0);
}
function totalRefunds(txns) {
  return txns.filter(t => t.amount < 0 && !t.fixed).reduce((s, t) => s + Math.abs(t.amount), 0);
}

// ─── Validation ───────────────────────────────────────────────────────────────
// Bill "Total Pay" = Primary Spending + AddOn Spending = should match PDF Total Amount Due
function getBillTotalPay() {
  const pSpend = sheetSpending(allTransactions.primary);
  const aSpend = allTransactions.addons.reduce((s, a) => s + sheetSpending(a.txns), 0);
  return pSpend + aSpend;
}

// ─── Render All ───────────────────────────────────────────────────────────────
function renderAll() {
  renderSummary();
  renderTabs();
  renderBill();
  renderValidation();
}

// ─── Summary Cards ────────────────────────────────────────────────────────────
function renderSummary() {
  const p = allTransactions.primary;
  const addons = allTransactions.addons;

  const pSpend = sheetSpending(p);
  const pCb = sheetCashback(p);
  const pTotal = sheetTotal(p); // = pSpend - pCb
  const lmCb = lastMonthCashback;

  const aSpend = addons.reduce((s, a) => s + sheetSpending(a.txns), 0);
  const aCb = addons.reduce((s, a) => s + sheetCashback(a.txns), 0);

  // Bill logic (confirmed from Excel):
  // Total Pay to SBI  = pSpend + aSpend
  // Next Bill Cashback = pCb + aCb
  // "Spending" (effective) = Total Pay - Next Bill CB
  // You pay SBI       = Total Pay (pSpend + aSpend)
  // Dad pays you      = aSpend - aCb  (AddOn Total from Excel)
  // Your effective due = pSpend - pCb  (Primary Total from Excel)
  //                    = you already paid full, dad paid you back, CB comes next month
  const totalPaySBI = pSpend + aSpend;
  const nextCB = pCb + aCb;
  const addonPayYou = addons.reduce((s, a) => s + sheetTotal(a.txns), 0); // = aSpend - aCb

  document.getElementById('summaryGrid').innerHTML = `
    <div class="stat-card accent-green">
      <div class="stat-label">Primary Spending</div>
      <div class="stat-value txt-green">₹${fmt(pSpend)}</div>
      <div class="stat-sub">Net incl. refunds & last-month CB</div>
    </div>
    <div class="stat-card accent-amber">
      <div class="stat-label">Primary Cashback (next bill)</div>
      <div class="stat-value txt-amber">₹${fmt(pCb)}</div>
      <div class="stat-sub">Posted 2 days after statement date</div>
    </div>
    ${addons.map(a => {
    const sp = sheetSpending(a.txns), cb = sheetCashback(a.txns);
    return `
      <div class="stat-card accent-blue">
        <div class="stat-label">${escHtml(a.name)} Spending</div>
        <div class="stat-value txt-blue">₹${fmt(sp)}</div>
        <div class="stat-sub">Net incl. refunds</div>
      </div>
      <div class="stat-card accent-purple">
        <div class="stat-label">${escHtml(a.name)} Cashback</div>
        <div class="stat-value" style="color:var(--purple)">₹${fmt(cb)}</div>
        <div class="stat-sub">Goes to your account</div>
      </div>`;
  }).join('')}
  `;

  document.getElementById('dueBox').innerHTML = `
    <div class="due-left">
      <h3>Your SBI Bill This Month</h3>
      <div class="due-amount">₹${fmt(totalPaySBI)}</div>
      <p>Pay this to SBI · Next month CB credit: ₹${fmt(nextCB)}</p>
    </div>
    <div class="due-right">
      <div class="due-row"><label>Your spending</label><span class="mono">₹${fmt(pSpend)}</span></div>
      ${addons.map(a => `<div class="due-row"><label>${escHtml(a.name)}'s spending</label><span class="mono">₹${fmt(sheetSpending(a.txns))}</span></div>`).join('')}
      <div class="due-row separator highlight"><label>Total Pay to SBI</label><span class="mono txt-amber">₹${fmt(totalPaySBI)}</span></div>
      <div class="due-row" style="margin-top:8px"><label>${addons.map(a => escHtml(a.name)).join(' + ')} pays you</label><span class="mono txt-green">₹${fmt(addonPayYou)}</span></div>
      <div class="due-row"><label style="font-size:10px;color:var(--text3)">= their spend − their cashback (you keep CB)</label></div>
      <div class="due-row separator"><label>Your effective cost</label><span class="mono txt-blue">₹${fmt(pTotal)}</span></div>
      <div class="due-row"><label style="font-size:10px;color:var(--text3)">= your spend − your cashback (next month)</label></div>
    </div>
  `;
}

// ─── Tabs (dynamic per number of add-ons) ────────────────────────────────────
function renderTabs() {
  const tabBar = document.getElementById('tabBar');
  const tabViews = document.getElementById('tabViews');

  const tabs = [
    { id: 'primary', label: '🟢 Primary', cls: 't-primary' },
    ...allTransactions.addons.map((a, i) => ({
      id: `addon${i}`, label: `🔵 ${a.name}`, cls: 't-addon'
    })),
    { id: 'bill', label: '🟡 Bill Split', cls: 't-bill' }
  ];

  tabBar.innerHTML = tabs.map((t, i) =>
    `<button class="tab-btn ${t.cls}${i === 0 ? ' active' : ''}" id="tab-${t.id}" onclick="showTab('${t.id}')">${escHtml(t.label)}</button>`
  ).join('');

  tabViews.innerHTML = tabs.map((t, i) => {
    const hidden = i === 0 ? '' : ' hidden';
    if (t.id === 'bill')
      return `<div id="view-bill" class="tab-view${hidden}"><div id="billContent"></div></div>`;
    if (t.id === 'primary')
      return `<div id="view-primary" class="tab-view${hidden}"><div class="table-wrap"><table id="tablePrimary"></table></div></div>`;
    const idx = parseInt(t.id.replace('addon', ''));
    return `<div id="view-${t.id}" class="tab-view${hidden}"><div class="table-wrap"><table id="tableAddon${idx}"></table></div></div>`;
  }).join('');

  // Render each table
  renderTable('tablePrimary', allTransactions.primary, 'primary');
  allTransactions.addons.forEach((a, i) => renderTable(`tableAddon${i}`, a.txns, `addon${i}`));
}

// ─── Table Render ─────────────────────────────────────────────────────────────
function renderTable(tableId, txns, section) {
  const table = document.getElementById(tableId);
  if (!table) return;

  // Move-to options: where can this row go?
  const allSections = ['primary', ...allTransactions.addons.map((_, i) => `addon${i}`)];
  const otherSections = allSections.filter(s => s !== section);

  const spending = sheetSpending(txns);
  const cashback = sheetCashback(txns);
  const total = sheetTotal(txns);

  table.innerHTML = `
    <thead>
      <tr>
        <th>Date</th>
        <th>Merchant / Description</th>
        <th style="text-align:right">Amount (₹)</th>
        <th>Category</th>
        <th style="text-align:right">Cashback (₹)</th>
        <th>Move To</th>
      </tr>
    </thead>
    <tbody>
      ${txns.map((t, i) => {
    const isCbCredit = t.category === 'cashback_credit';
    return `
        <tr class="${isCbCredit ? 'cb-credit-row' : t.amount < 0 ? 'is-credit' : ''}">
          <td class="mono txt-dim" style="white-space:nowrap">${t.date}</td>
          <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(t.description)}">
            ${isCbCredit ? '<span class="badge-cb">↩ LAST MONTH CB</span>' :
        t.amount < 0 ? '<span class="badge-refund">↩ REFUND</span>' : ''}
            ${escHtml(t.description)}
          </td>
          <td style="text-align:right" class="${isCbCredit ? 'mono txt-amber fw-600' : t.amount < 0 ? 'mono txt-dim' : 'mono fw-600'}">
            ${t.amount < 0 ? '−' : ''}₹${fmt(Math.abs(t.amount))}
          </td>
          <td>
            ${isCbCredit
        ? '<span class="cat-fixed">✦ CB Credit</span>'
        : `<select class="cat-select ${t.category}" onchange="reclassifyRow('${section}', ${i}, this.value)">
                  <option value="online"   ${t.category === 'online' ? 'selected' : ''}>🌐 Online 5%</option>
                  <option value="offline"  ${t.category === 'offline' ? 'selected' : ''}>🏪 Offline 1%</option>
                  <option value="excluded" ${t.category === 'excluded' ? 'selected' : ''}>🚫 Excluded 0%</option>
                </select>`}
          </td>
          <td style="text-align:right" class="${isCbCredit ? 'mono txt-amber' : t.cashback === 0 ? 'cb-zero' : t.cashback < 0 ? 'cb-neg' : 'cb-pos'}">
            ${isCbCredit ? `−₹${fmt(Math.abs(t.amount))}` :
        t.cashback === 0 ? '—' : (t.cashback < 0 ? '−' : '+') + '₹' + fmt(Math.abs(t.cashback))}
          </td>
          <td>
            ${isCbCredit ? '' : otherSections.map(dest => {
      const destLabel = dest === 'primary' ? 'Primary' : allTransactions.addons[parseInt(dest.replace('addon', ''))]?.name || dest;
      return `<button class="move-btn" onclick="moveTransaction('${section}', ${i}, '${dest}')" title="Move to ${escHtml(destLabel)}">→ ${escHtml(destLabel)}</button>`;
    }).join('')}
          </td>
        </tr>`;
  }).join('')}
    </tbody>
    <tfoot>
      <tr class="tfoot-row">
        <td colspan="2"><strong>Totals</strong></td>
        <td style="text-align:right" class="mono fw-600">₹${fmt(spending)}</td>
        <td></td>
        <td style="text-align:right" class="mono fw-600 txt-amber">₹${fmt(cashback)}</td>
        <td></td>
      </tr>
      <tr class="tfoot-summary">
        <td colspan="6">
          <span class="tfoot-chip">Spending: <strong>₹${fmt(spending)}</strong></span>
          <span class="tfoot-chip green">Cashback: <strong>₹${fmt(cashback)}</strong></span>
          <span class="tfoot-chip blue">Net Total: <strong>₹${fmt(total)}</strong></span>
          ${section !== 'primary' ? `<span class="tfoot-chip purple">Dad pays you: <strong>₹${fmt(total)}</strong></span>` : ''}
        </td>
      </tr>
    </tfoot>
  `;
}

// ─── Bill View ────────────────────────────────────────────────────────────────
function renderBill() {
  const p = allTransactions.primary;
  const addons = allTransactions.addons;

  const pSpend = sheetSpending(p);
  const pCb = sheetCashback(p);
  const pTotal = sheetTotal(p);
  const pGross = grossDebits(p);
  const pRef = totalRefunds(p);
  const lmCb = lastMonthCashback;

  const aSpend = addons.reduce((s, a) => s + sheetSpending(a.txns), 0);
  const aCb = addons.reduce((s, a) => s + sheetCashback(a.txns), 0);
  const aTotal = addons.reduce((s, a) => s + sheetTotal(a.txns), 0);

  const totalPay = pSpend + aSpend;  // = Bill sheet "Total Pay"
  const nextCB = pCb + aCb;          // = Bill sheet "Next Bill Cashback"
  const spending = totalPay - nextCB; // = Bill sheet "Spending"

  document.getElementById('billContent').innerHTML = `

    <!-- Per-person breakdown -->
    <div class="bill-grid">

      <!-- Primary -->
      <div class="bill-card">
        <h4>🟢 Primary — MD SAMEER (You)</h4>
        <div class="bill-line"><label>Gross Debits</label><span class="mono">₹${fmt(pGross)}</span></div>
        <div class="bill-line"><label>Refunds</label><span class="mono txt-dim">−₹${fmt(pRef)}</span></div>
        ${lmCb > 0 ? `<div class="bill-line info-line"><label>Last Month CB Credit <span class="info-tag">by SBI</span></label><span class="mono txt-amber">−₹${fmt(lmCb)}</span></div>` : ''}
        <div class="bill-line separator"><label><strong>Net Spending</strong></label><span class="mono fw-600">₹${fmt(pSpend)}</span></div>
        <div class="bill-line info-line"><label>Cashback this month <span class="info-tag">next bill</span></label><span class="mono txt-amber">₹${fmt(pCb)}</span></div>
        <div class="bill-line total"><label>Your Primary Total</label><span class="mono txt-green">₹${fmt(pTotal)}</span></div>
      </div>

      <!-- Add-ons -->
      ${addons.map(a => {
    const sp = sheetSpending(a.txns), cb = sheetCashback(a.txns), tot = sheetTotal(a.txns);
    const gross = grossDebits(a.txns), ref = totalRefunds(a.txns);
    return `
        <div class="bill-card">
          <h4>🔵 Add-On — ${escHtml(a.name)}</h4>
          <div class="bill-line"><label>Gross Debits</label><span class="mono">₹${fmt(gross)}</span></div>
          <div class="bill-line"><label>Refunds</label><span class="mono txt-dim">−₹${fmt(ref)}</span></div>
          <div class="bill-line separator"><label><strong>Net Spending</strong></label><span class="mono fw-600">₹${fmt(sp)}</span></div>
          <div class="bill-line info-line"><label>Cashback earned <span class="info-tag">next bill → your account</span></label><span class="mono txt-amber">₹${fmt(cb)}</span></div>
          <div class="bill-line total"><label>${escHtml(a.name)} Pays You</label><span class="mono txt-blue">₹${fmt(tot)}</span></div>
        </div>`;
  }).join('')}
    </div>

    <!-- Master Bill Summary — exact replica of your Excel Bill sheet -->
    <div class="bill-card master-bill mt-16">
      <h4>📊 Bill Summary (matches Excel)</h4>

      <div class="bill-section-header">Primary</div>
      <div class="bill-line"><label>Spending</label><span class="mono">₹${fmt(pSpend)}</span></div>
      <div class="bill-line"><label>Cashback</label><span class="mono txt-amber">₹${fmt(pCb)}</span></div>
      <div class="bill-line separator"><label><strong>Total</strong></label><span class="mono fw-600">₹${fmt(pTotal)}</span></div>

      ${addons.map(a => {
    const sp = sheetSpending(a.txns), cb = sheetCashback(a.txns), tot = sheetTotal(a.txns);
    return `
        <div class="bill-section-header">${escHtml(a.name)}</div>
        <div class="bill-line"><label>Spending</label><span class="mono">₹${fmt(sp)}</span></div>
        <div class="bill-line"><label>Cashback</label><span class="mono txt-amber">₹${fmt(cb)}</span></div>
        <div class="bill-line separator"><label><strong>Total</strong></label><span class="mono fw-600">₹${fmt(tot)}</span></div>`;
  }).join('')}

      <div style="height:4px"></div>
      <div class="bill-line grand-total"><label>Total Pay (to SBI)</label><span class="mono txt-amber" style="font-size:18px">₹${fmt(totalPay)}</span></div>
      <div class="bill-line"><label>Next Bill Cashback</label><span class="mono txt-green">₹${fmt(nextCB)}</span></div>
      <div class="bill-line"><label>Spending (effective cost)</label><span class="mono fw-600">₹${fmt(spending)}</span></div>
    </div>

    <!-- Validation box -->
    <div id="validationBox"></div>
  `;

  renderValidation();
}

// ─── Validation ───────────────────────────────────────────────────────────────
function renderValidation() {
  const box = document.getElementById('validationBox');
  if (!box) return;
  const calculatedTotal = getBillTotalPay();
  if (!statementTotalFromPDF) {
    box.innerHTML = '';
    return;
  }
  const diff = Math.abs(calculatedTotal - statementTotalFromPDF);
  const ok = diff < 1;
  box.innerHTML = `
    <div class="validation-box ${ok ? 'ok' : 'warn'}">
      <span class="val-icon">${ok ? '✅' : '⚠️'}</span>
      <div>
        <strong>Statement Validation</strong><br>
        PDF Total Amount Due: <span class="mono">₹${fmt(statementTotalFromPDF)}</span> &nbsp;|&nbsp;
        Calculated Total Pay: <span class="mono">₹${fmt(calculatedTotal)}</span>
        ${ok
      ? ' — <span style="color:var(--green)">Match ✓</span>'
      : ` — <span style="color:var(--red)">Difference of ₹${fmt(diff)} — some transactions may be missing or misclassified.</span>`}
      </div>
    </div>
  `;
}

// ─── Interactions ─────────────────────────────────────────────────────────────
function reclassifyRow(section, idx, category) {
  const t = getTransaction(section, idx);
  if (!t || t.fixed) return;
  t.category = category;
  t.cashback = calcCashback(t.amount, category);
  renderAll();
}

// Move a transaction from one owner to another
function moveTransaction(fromSection, idx, toSection) {
  const fromArr = getTransactionArray(fromSection);
  const toArr = getTransactionArray(toSection);
  if (!fromArr || !toArr) return;
  const [moved] = fromArr.splice(idx, 1);
  toArr.push(moved);
  renderAll();
  // Switch to destination tab
  showTab(toSection);
}

function getTransactionArray(section) {
  if (section === 'primary') return allTransactions.primary;
  const idx = parseInt(section.replace('addon', ''));
  return allTransactions.addons[idx]?.txns || null;
}

function getTransaction(section, idx) {
  const arr = getTransactionArray(section);
  return arr ? arr[idx] : null;
}

function showTab(tab) {
  document.querySelectorAll('.tab-view').forEach(v => v.classList.add('hidden'));
  const view = document.getElementById('view-' + tab);
  if (view) view.classList.remove('hidden');
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById('tab-' + tab);
  if (btn) btn.classList.add('active');
}

async function reclassify() {
  if (!allTransactions.primary.length && !allTransactions.addons.length) return;
  try {
    showLoading('Re-classifying with AI...', '🔒 Only merchant names sent');
    const pTxns = allTransactions.primary.filter(t => !t.fixed);
    const cbRows = allTransactions.primary.filter(t => t.fixed);
    const classifiedP = pTxns.length ? await classifyTransactions(pTxns) : [];
    allTransactions.primary = [...cbRows, ...classifiedP];
    allTransactions.addons = await Promise.all(
      allTransactions.addons.map(a =>
        a.txns.length
          ? classifyTransactions(a.txns).then(txns => ({ name: a.name, txns }))
          : Promise.resolve(a)
      )
    );
    renderAll();
    setStatus('done', '✓ Re-classified successfully');
  } catch (e) {
    setStatus('error', '✗ Re-classify failed: ' + e.message);
  }
  hideLoading();
}

// ─── Excel Export (exact Excel replica) ──────────────────────────────────────
function downloadExcel() {
  const wb = XLSX.utils.book_new();

  function makeSheet(txns) {
    const spending = sheetSpending(txns);
    const cashback = sheetCashback(txns);
    const total = sheetTotal(txns);

    const header = ['Type', 'Amount', 'No cashback', 0, 'Swipe/Tap to pay', 0.01, 'Online Payment', 0.05];
    const dataRows = txns.map(t => {
      if (t.category === 'cashback_credit') {
        return ['Cashback', t.amount, null, 0, null, 0, null, 0];
      }
      return [
        t.description,
        t.amount,
        t.category === 'excluded' ? 'Yes' : null,
        t.category === 'excluded' ? 0 : null,
        t.category === 'offline' ? 'Yes' : null,
        t.category === 'offline' ? t.cashback : null,
        t.category === 'online' ? 'Yes' : null,
        t.category === 'online' ? t.cashback : null,
      ];
    });

    const rows = [
      header,
      ...dataRows,
      [null, spending, null, 0, null, 0, null, cashback],
      [],
      [null, null, 'Spending', null, spending],
      [null, null, 'Cashback', null, cashback],
      [null, null, 'Total', null, total],
    ];
    return XLSX.utils.aoa_to_sheet(rows);
  }

  const p = allTransactions.primary;
  const addons = allTransactions.addons;
  const pSpend = sheetSpending(p), pCb = sheetCashback(p), pTotal = sheetTotal(p);
  const aSpend = addons.reduce((s, a) => s + sheetSpending(a.txns), 0);
  const aCb = addons.reduce((s, a) => s + sheetCashback(a.txns), 0);
  const totalPay = pSpend + aSpend;
  const nextCB = pCb + aCb;

  XLSX.utils.book_append_sheet(wb, makeSheet(p), 'Primary');
  addons.forEach(a => {
    XLSX.utils.book_append_sheet(wb, makeSheet(a.txns), a.name.substring(0, 31));
  });

  // Bill sheet — exact replica
  const billRows = [
    [],
    [null, 'Primary', 'Spending', null, pSpend],
    [null, null, 'Cashback', null, pCb],
    [null, null, 'Total', null, pTotal],
    [],
    ...addons.flatMap(a => {
      const sp = sheetSpending(a.txns), cb = sheetCashback(a.txns), tot = sheetTotal(a.txns);
      return [
        [null, a.name, 'Spending', null, sp],
        [null, null, 'Cashback', null, cb],
        [null, null, 'Total', null, tot],
        [],
      ];
    }),
    [null, 'Total', 'Pay', null, totalPay],
    [null, null, 'Next Bill Cashback', null, nextCB],
    [null, null, 'Spending', null, totalPay - nextCB],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(billRows), 'Bill');

  const month = new Date().toLocaleString('en-IN', { month: 'short', year: 'numeric' }).replace(' ', '-');
  XLSX.writeFile(wb, `SBI_Cashback_${month}.xlsx`);
}

// ─── PDF Export (print-friendly HTML) ────────────────────────────────────────
function downloadPDF() {
  const p = allTransactions.primary;
  const addons = allTransactions.addons;
  const pSpend = sheetSpending(p), pCb = sheetCashback(p), pTotal = sheetTotal(p);
  const pGross = grossDebits(p), pRef = totalRefunds(p);
  const lmCb = lastMonthCashback;
  const aSpend = addons.reduce((s, a) => s + sheetSpending(a.txns), 0);
  const aCb = addons.reduce((s, a) => s + sheetCashback(a.txns), 0);
  const totalPay = pSpend + aSpend;
  const nextCB = pCb + aCb;

  function txnTable(txns) {
    return txns.map(t => {
      const isCb = t.category === 'cashback_credit';
      return `<tr${isCb ? ' class="cb-row"' : t.amount < 0 ? ' class="refund-row"' : ''}>
        <td>${t.date}</td>
        <td>${isCb ? '↩ LAST MONTH CB' : t.amount < 0 ? '↩ REFUND' : ''} ${escHtml(t.description)}</td>
        <td class="r">${t.amount < 0 ? '−' : ''}₹${fmt(Math.abs(t.amount))}</td>
        <td>${isCb ? 'CB Credit' : t.category}</td>
        <td class="r ${t.cashback > 0 ? 'pos' : t.cashback < 0 ? 'neg' : 'zero'}">
          ${isCb ? `−₹${fmt(Math.abs(t.amount))}` : t.cashback === 0 ? '—' : (t.cashback < 0 ? '−' : '+') + '₹' + fmt(Math.abs(t.cashback))}
        </td>
      </tr>`;
    }).join('');
  }

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
<title>SBI Cashback Statement</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',Arial,sans-serif;font-size:11px;color:#1a2640;padding:24px 32px}
h1{font-size:20px;font-weight:700;color:#1d6fd8;margin-bottom:2px}
.sub{font-size:10px;color:#7a90aa;margin-bottom:20px;font-family:monospace}
h2{font-size:12px;font-weight:700;color:#1d6fd8;border-bottom:2px solid #1d6fd8;padding-bottom:4px;margin:18px 0 10px;text-transform:uppercase;letter-spacing:.05em}
.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px}
.card{background:#f4f7fc;border:1px solid #d0d9ea;border-radius:7px;padding:10px 14px}
.card-label{font-size:9px;text-transform:uppercase;letter-spacing:.07em;color:#7a90aa;margin-bottom:3px}
.card-val{font-size:17px;font-weight:700;font-family:monospace}
.green{color:#059669}.blue{color:#2563eb}.amber{color:#d97706}.purple{color:#7c3aed}
.due{background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:14px 18px;margin-bottom:16px;display:flex;justify-content:space-between;align-items:flex-start;gap:24px}
.due-big{font-size:26px;font-weight:700;color:#d97706;font-family:monospace}
.due-lbl{font-size:9px;text-transform:uppercase;color:#92600a;margin-bottom:3px}
.dl{font-family:monospace}
.dl-row{display:flex;justify-content:space-between;font-size:11px;padding:3px 0;border-bottom:1px solid #fde68a}
.dl-row.tot{font-weight:700;border-top:2px solid #fde68a;border-bottom:none;padding-top:5px;margin-top:3px}
.bill-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}
.bc{background:#f4f7fc;border:1px solid #d0d9ea;border-radius:7px;padding:14px}
.bc h4{font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:#556882;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid #d0d9ea}
.bl{display:flex;justify-content:space-between;padding:4px 0;font-size:11px;border-bottom:1px solid #eaeff8;color:#4a5e7a}
.bl.tot{font-weight:700;font-size:12px;border-top:2px solid #d0d9ea;border-bottom:none;margin-top:4px;padding-top:7px;color:#1a2640}
.bl.info{color:#92600a;font-size:10px}
.bl.sep{border-bottom:1px dashed #b8c5da;padding-bottom:6px;margin-bottom:2px}
.mn{font-family:monospace}
.ms{background:#fffbeb;border:1px solid #fde68a}
.ms h4{color:#d97706;border-color:#fde68a}
.sec-hdr{font-size:9px;text-transform:uppercase;letter-spacing:.07em;color:#556882;margin:10px 0 3px;font-weight:600}
table{width:100%;border-collapse:collapse;margin-bottom:10px;font-size:10.5px}
th{background:#e8edf6;padding:6px 8px;text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:#4a5e7a;border-bottom:2px solid #d0d9ea;white-space:nowrap}
td{padding:5px 8px;border-bottom:1px solid #eaeff8;vertical-align:middle}
.r{text-align:right;font-family:monospace}
.refund-row td{color:#aaa}
.cb-row td{background:#fffbeb;color:#d97706;font-style:italic}
.pos{color:#059669;font-weight:600}.neg{color:#dc2626}.zero{color:#aaa}
.val{display:flex;align-items:center;gap:10px;background:#f0fdf4;border:1px solid #a7f3d0;border-radius:6px;padding:10px 14px;margin:12px 0;font-size:11px}
.val.warn{background:#fef2f2;border-color:#fecaca}
@media print{body{padding:12px 16px}}
</style></head><body>
<h1>SBI Cashback Card — Statement Summary</h1>
<div class="sub">Generated ${new Date().toLocaleString('en-IN', { dateStyle: 'long', timeStyle: 'short' })}</div>

<h2>Overview</h2>
<div class="cards">
  <div class="card"><div class="card-label">Primary Spending</div><div class="card-val green">₹${fmt(pSpend)}</div></div>
  <div class="card"><div class="card-label">Primary Cashback (next bill)</div><div class="card-val amber">₹${fmt(pCb)}</div></div>
  ${addons.map(a => {
    const sp = sheetSpending(a.txns), cb = sheetCashback(a.txns);
    return `<div class="card"><div class="card-label">${escHtml(a.name)} Spending</div><div class="card-val blue">₹${fmt(sp)}</div></div>
    <div class="card"><div class="card-label">${escHtml(a.name)} Cashback</div><div class="card-val purple">₹${fmt(cb)}</div></div>`;
  }).join('')}
</div>

<div class="due">
  <div><div class="due-lbl">Total Pay to SBI</div><div class="due-big">₹${fmt(totalPay)}</div><div style="font-size:10px;color:#92600a;margin-top:4px">Next month CB credit: ₹${fmt(nextCB)}</div></div>
  <div class="dl" style="min-width:240px">
    <div class="dl-row"><span>Your spending</span><span>₹${fmt(pSpend)}</span></div>
    ${addons.map(a => `<div class="dl-row"><span>${escHtml(a.name)}'s spending</span><span>₹${fmt(sheetSpending(a.txns))}</span></div>`).join('')}
    <div class="dl-row tot"><span>Total Pay to SBI</span><span class="amber">₹${fmt(totalPay)}</span></div>
    ${addons.map(a => `<div class="dl-row" style="border:none"><span>${escHtml(a.name)} pays you</span><span class="green">₹${fmt(sheetTotal(a.txns))}</span></div>`).join('')}
    <div class="dl-row" style="border:none"><span>Your effective cost</span><span class="blue">₹${fmt(pTotal)}</span></div>
  </div>
</div>

<h2>Bill Split</h2>
<div class="bill-grid">
  <div class="bc">
    <h4>Primary — MD SAMEER (You)</h4>
    <div class="bl"><label>Gross Debits</label><span class="mn">₹${fmt(pGross)}</span></div>
    <div class="bl"><label>Refunds</label><span class="mn">−₹${fmt(pRef)}</span></div>
    ${lmCb > 0 ? `<div class="bl info"><label>Last Month CB Credit (by SBI)</label><span class="mn amber">−₹${fmt(lmCb)}</span></div>` : ''}
    <div class="bl sep"><label><strong>Net Spending</strong></label><span class="mn"><strong>₹${fmt(pSpend)}</strong></span></div>
    <div class="bl info"><label>Cashback (next bill)</label><span class="mn amber">₹${fmt(pCb)}</span></div>
    <div class="bl tot"><label>Primary Total</label><span class="mn green">₹${fmt(pTotal)}</span></div>
  </div>
  ${addons.map(a => {
    const sp = sheetSpending(a.txns), cb = sheetCashback(a.txns), tot = sheetTotal(a.txns);
    const gross = grossDebits(a.txns), ref = totalRefunds(a.txns);
    return `<div class="bc">
    <h4>Add-On — ${escHtml(a.name)}</h4>
    <div class="bl"><label>Gross Debits</label><span class="mn">₹${fmt(gross)}</span></div>
    <div class="bl"><label>Refunds</label><span class="mn">−₹${fmt(ref)}</span></div>
    <div class="bl sep"><label><strong>Net Spending</strong></label><span class="mn"><strong>₹${fmt(sp)}</strong></span></div>
    <div class="bl info"><label>Cashback (next bill → your a/c)</label><span class="mn amber">₹${fmt(cb)}</span></div>
    <div class="bl tot"><label>${escHtml(a.name)} Pays You</label><span class="mn blue">₹${fmt(tot)}</span></div>
  </div>`;
  }).join('')}
</div>

<div class="bc ms" style="margin-bottom:12px">
  <h4>📊 Bill Summary (Excel Replica)</h4>
  <div class="sec-hdr">Primary</div>
  <div class="bl"><label>Spending</label><span class="mn">₹${fmt(pSpend)}</span></div>
  <div class="bl"><label>Cashback</label><span class="mn amber">₹${fmt(pCb)}</span></div>
  <div class="bl sep"><label><strong>Total</strong></label><span class="mn fw-600">₹${fmt(pTotal)}</span></div>
  ${addons.map(a => {
    const sp = sheetSpending(a.txns), cb = sheetCashback(a.txns), tot = sheetTotal(a.txns);
    return `<div class="sec-hdr">${escHtml(a.name)}</div>
  <div class="bl"><label>Spending</label><span class="mn">₹${fmt(sp)}</span></div>
  <div class="bl"><label>Cashback</label><span class="mn amber">₹${fmt(cb)}</span></div>
  <div class="bl sep"><label><strong>Total</strong></label><span class="mn fw-600">₹${fmt(tot)}</span></div>`;
  }).join('')}
  <div class="bl" style="font-size:13px;font-weight:700;padding-top:8px"><label>Total Pay</label><span class="mn amber">₹${fmt(totalPay)}</span></div>
  <div class="bl"><label>Next Bill Cashback</label><span class="mn green">₹${fmt(nextCB)}</span></div>
  <div class="bl"><label>Spending (effective)</label><span class="mn">₹${fmt(totalPay - nextCB)}</span></div>
</div>

${statementTotalFromPDF ? (() => {
    const diff = Math.abs(totalPay - statementTotalFromPDF);
    const ok = diff < 1;
    return `<div class="val${ok ? '' : ' warn'}">
  <span style="font-size:16px">${ok ? '✅' : '⚠️'}</span>
  <div><strong>Statement Validation:</strong> PDF Total Amount Due: ₹${fmt(statementTotalFromPDF)} | Calculated: ₹${fmt(totalPay)}${ok ? ' — <strong>Match ✓</strong>' : ` — Difference ₹${fmt(diff)}`}</div>
</div>`;
  })() : ''}

<h2>Primary — MD SAMEER</h2>
<table><thead><tr><th>Date</th><th>Description</th><th class="r">Amount</th><th>Category</th><th class="r">Cashback</th></tr></thead>
<tbody>${txnTable(p)}</tbody>
<tfoot><tr style="font-weight:700;background:#e8edf6"><td colspan="2">Total</td><td class="r">₹${fmt(pSpend)}</td><td></td><td class="r amber">₹${fmt(pCb)}</td></tr></tfoot>
</table>

${addons.map(a => `
<h2>${escHtml(a.name)}</h2>
<table><thead><tr><th>Date</th><th>Description</th><th class="r">Amount</th><th>Category</th><th class="r">Cashback</th></tr></thead>
<tbody>${txnTable(a.txns)}</tbody>
<tfoot><tr style="font-weight:700;background:#e8edf6"><td colspan="2">Total</td><td class="r">₹${fmt(sheetSpending(a.txns))}</td><td></td><td class="r amber">₹${fmt(sheetCashback(a.txns))}</td></tr></tfoot>
</table>`).join('')}

</body></html>`;

  const win = window.open('', '_blank');
  if (!win) { alert('Please allow popups to use PDF export.'); return; }
  win.document.write(html);
  win.document.close();
  setTimeout(() => win.print(), 600);
}

// ─── Utils ────────────────────────────────────────────────────────────────────
function fmt(n) {
  return Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Init ─────────────────────────────────────────────────────────────────────
initTheme();
