// ─── State ─────────────────────────────────────────────────────────────────
let allTransactions = { primary: [], addons: [] }; // addons = [{name, txns}]
let lastMonthCashback = 0; // parsed from "CARD CASHBACK CREDIT" in statement

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
// Online 5%:  FLOOR(ABS(amount)×0.01,1)*SIGN + FLOOR(ABS(amount)×0.04,1)*SIGN
// Offline 1%: MAX(FLOOR(amount×0.01,1), 0)
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

// ─── Upload ────────────────────────────────────────────────────────────────
document.getElementById('fileInput').addEventListener('change', e => {
  const f = e.target.files[0];
  if (!f) return;
  document.getElementById('fileName').textContent = '📎 ' + f.name;
  document.getElementById('fileName').classList.remove('hidden');
  setStatus('idle', `${f.name} ready — click Process to begin`);
  document.getElementById('processBtn').disabled = false;
  allTransactions = { primary: [], addons: [] };
  lastMonthCashback = 0;
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

// parseTxnsFromSection: extracts transactions from a text block.
// Side-effect: captures lastMonthCashback from CARD CASHBACK CREDIT lines.
function parseTxnsFromSection(txt) {
  const results = [];
  const re = /(\d{2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{2})\s+([\w*@.()/\- ]+?)\s+([\d,]+\.\d{2})\s+([CD])\b/g;
  let m;
  while ((m = re.exec(txt)) !== null) {
    const desc = m[2].trim().replace(/\s+/g, ' ');
    const amt = parseFloat(m[3].replace(/,/g, ''));
    const isCredit = m[4] === 'C';
    if (/PAYMENT RECEIVED|OTC Pymt|WWW OLACABS/i.test(desc)) continue;
    if (amt === 0) continue;

    // Capture last-month cashback credit (posted by SBI after prev statement)
    if (/CARD CASHBACK CREDIT/i.test(desc)) {
      if (isCredit && amt > lastMonthCashback) lastMonthCashback = amt;
      continue; // don't add to regular transactions
    }

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

// extractTransactions: splits full PDF text into primary + N add-ons.
// Strategy: find "TRANSACTIONS FOR <NAME>" headers; everything before the
// FIRST header is also primary (top of statement). Each named section after
// the first is an add-on keyed by the cardholder name in the header.
// The LAST "TRANSACTIONS FOR" section in SBI statements is always the primary
// card (confirmed: "MD SAMEER" appears last). So we reverse-assign:
//   - last section  → primary
//   - all others    → add-ons
function extractTransactions(text) {
  lastMonthCashback = 0;
  const fullText = text.split(/\n/).map(l => l.trim()).filter(Boolean).join(' ');

  // Find all section headers
  const sections = [];
  const sectionPattern = /TRANSACTIONS FOR ([A-Z][A-Z ]+)/g;
  let sm;
  while ((sm = sectionPattern.exec(fullText)) !== null) {
    sections.push({ name: sm[1].trim(), pos: sm.index });
  }
  sections.push({ pos: fullText.length }); // sentinel

  // Parse each named section
  const parsed = [];
  for (let i = 0; i < sections.length - 1; i++) {
    const secText = fullText.substring(sections[i].pos, sections[i + 1].pos);
    parsed.push({ name: sections[i].name, txns: parseTxnsFromSection(secText) });
  }

  // Also parse anything before the first header (belongs to primary)
  const topTxns = sections.length > 0
    ? parseTxnsFromSection(fullText.substring(0, sections[0].pos))
    : parseTxnsFromSection(fullText);

  let primary = [];
  const addonMap = {}; // name → txns[]

  if (parsed.length === 0) {
    // No section headers found — treat everything as primary
    primary = topTxns;
  } else {
    // Last parsed section = primary cardholder (SBI statement order)
    const primarySection = parsed[parsed.length - 1];
    primary = [...topTxns, ...primarySection.txns];

    // All preceding sections = add-ons
    for (let i = 0; i < parsed.length - 1; i++) {
      const { name, txns } = parsed[i];
      if (!addonMap[name]) addonMap[name] = [];
      addonMap[name].push(...txns);
    }
  }

  const addons = Object.entries(addonMap).map(([name, txns]) => ({ name, txns }));
  return { primary, addons };
}

// ─── AI Classification (via Netlify proxy) ─────────────────────────────────
async function classifyTransactions(transactions) {
  // Filter to debits only for classification (credits/refunds inherit category)
  const debits = transactions.filter(t => t.amount > 0);
  const merchants = debits.map((t, i) => ({
    id: i,
    merchant: t.description.replace(/\b\d{4,}\b/g, '').trim().substring(0, 45)
  }));

  const prompt = `Classify each SBI Cashback Card transaction for cashback purposes.

Rules:
- "online": Online purchases — Flipkart, Myntra, Amazon, Zepto, Blinkit, Swiggy, Zomato, Uber, Ola, RedBus, MakeMyTrip, Nykaa, CRED, RAZ*DREAMPLUG, PTM*Flipkart, streaming, any app-based order
- "offline": Physical store POS/swipe — shops, malls, medical stores, local retailers, restaurants with physical presence
- "excluded": Fuel stations, utility bills, wallet loads (Paytm/PhonePe top-up), rent (MCC 6513), insurance, jewellery, cash advance, government/tax payments, donations, religious/educational institutions paid via 3rd party

Respond ONLY with JSON array, no markdown:
[{"id":0,"category":"online"},...]

Transactions:
${JSON.stringify(merchants)}`;

  // Call our Netlify proxy — API key never touches the browser
  const res = await fetch('/api/classify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 1000,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Classification API error');

  const raw = data.choices?.[0]?.message?.content || '[]';
  const classifications = JSON.parse(raw.replace(/```json|```/g, '').trim());

  // Build index→category map for debits
  const catMap = {};
  debits.forEach((t, debitIdx) => {
    const origIdx = transactions.indexOf(t);
    const match = classifications.find(c => c.id === debitIdx);
    catMap[origIdx] = match?.category || 'offline';
  });

  // Apply to all transactions; credits inherit from nearest matching debit
  return transactions.map((t, i) => {
    let category;
    if (t.amount > 0) {
      category = catMap[i] || 'offline';
    } else {
      // Match refund to a debit by description prefix
      const descNorm = t.description.replace(/\s+/g, '').toLowerCase();
      const match = transactions.find((d, j) => j !== i && d.amount > 0 && catMap[j] &&
        d.description.replace(/\s+/g, '').toLowerCase().substring(0, 8) === descNorm.substring(0, 8));
      category = match ? catMap[transactions.indexOf(match)] : 'offline';
    }
    return { ...t, category, cashback: calcCashback(t.amount, category) };
  });
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

    if (!extracted.primary.length && !extracted.addons.length)
      throw new Error('No transactions found. Make sure this is an SBI Card monthly statement PDF.');

    showLoading('AI classifying merchants...', '🔒 Only merchant names sent — no personal data');
    setStatus('active', 'Classifying with AI...');

    const classifiedPrimary = extracted.primary.length
      ? await classifyTransactions(extracted.primary)
      : [];

    const classifiedAddons = await Promise.all(
      extracted.addons.map(a =>
        a.txns.length
          ? classifyTransactions(a.txns).then(txns => ({ name: a.name, txns }))
          : Promise.resolve({ name: a.name, txns: [] })
      )
    );

    // Prepend last-month cashback as a fixed, non-editable credit row at top of primary
    if (lastMonthCashback > 0) {
      classifiedPrimary.unshift({
        date: '—',
        description: 'CARD CASHBACK CREDIT (Last Month)',
        amount: -lastMonthCashback,
        category: 'cashback_credit',
        cashback: 0,
        fixed: true
      });
    }

    allTransactions.primary = classifiedPrimary;
    allTransactions.addons = classifiedAddons;

    renderAll();
    hideLoading();
    const total = classifiedPrimary.filter(t => t.category !== 'cashback_credit').length
      + classifiedAddons.reduce((s, a) => s + a.txns.length, 0);
    setStatus('done', `✓ Done — ${total} transactions classified`);
    document.getElementById('results').classList.remove('hidden');
    document.getElementById('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    hideLoading();
    setStatus('error', '✗ ' + err.message);
    console.error(err);
  }
});

// ─── Calc helpers ──────────────────────────────────────────────────────────
// Exclude the cashback_credit row from spend/cashback calculations — it's
// informational only. SBI already accounts for it in the actual bill amount.
function netAmount(txns) {
  return txns
    .filter(t => t.category !== 'cashback_credit')
    .reduce((s, t) => s + t.amount, 0);
}

function netCashback(txns) {
  return txns
    .filter(t => t.category !== 'cashback_credit')
    .reduce((s, t) => s + t.cashback, 0);
}

function grossSpend(txns) {
  return txns
    .filter(t => t.amount > 0 && t.category !== 'cashback_credit')
    .reduce((s, t) => s + t.amount, 0);
}

function totalRefunds(txns) {
  return txns
    .filter(t => t.amount < 0 && t.category !== 'cashback_credit')
    .reduce((s, t) => s + Math.abs(t.amount), 0);
}

// ─── Render All ────────────────────────────────────────────────────────────
function renderAll() {
  renderTabs();   // builds tab bar + table views dynamically
  renderSummary();
  renderBill();
}

// ─── Tabs (dynamic) ────────────────────────────────────────────────────────
function renderTabs() {
  const tabBar = document.getElementById('tabBar');
  const tabViews = document.getElementById('tabViews');

  const tabs = [
    { id: 'primary', label: '🟢 Primary', cls: 't-primary' },
    ...allTransactions.addons.map((a, i) => ({
      id: `addon${i}`,
      label: `🔵 ${a.name}`,
      cls: 't-addon'
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

  renderTable('tablePrimary', allTransactions.primary, 'primary');
  allTransactions.addons.forEach((a, i) => {
    renderTable(`tableAddon${i}`, a.txns, `addon${i}`);
  });
}

// ─── Summary Cards ─────────────────────────────────────────────────────────
function renderSummary() {
  const p = allTransactions.primary;
  const pNet = netAmount(p);
  const pCb = netCashback(p);

  const addons = allTransactions.addons;
  const aNet = addons.reduce((s, a) => s + netAmount(a.txns), 0);
  const aCb = addons.reduce((s, a) => s + netCashback(a.txns), 0);

  // Total bill = primary net + all addon nets (lastMonthCashback is already
  // a credit in SBI's system; it reduces the actual amount SBI charges but
  // we show the gross statement total here for clarity)
  const totalDue = pNet + aNet;
  const addonPayYou = Math.max(aNet - aCb, 0);

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
    ${addons.map(a => {
    const net = netAmount(a.txns);
    const cb = netCashback(a.txns);
    return `
      <div class="stat-card accent-blue">
        <div class="stat-label">${escHtml(a.name)} Net Spend</div>
        <div class="stat-value txt-blue">₹${fmt(net)}</div>
        <div class="stat-sub">After refunds</div>
      </div>
      <div class="stat-card accent-purple">
        <div class="stat-label">${escHtml(a.name)} Cashback</div>
        <div class="stat-value" style="color:var(--purple)">₹${fmt(cb)}</div>
        <div class="stat-sub">Deducted from what they pay you</div>
      </div>`;
  }).join('')}
  `;

  document.getElementById('dueBox').innerHTML = `
    <div class="due-left">
      <h3>Your SBI Bill Due</h3>
      <div class="due-amount">₹${fmt(totalDue)}</div>
      <p>Pay this to SBI · Your cashback (₹${fmt(pCb)}) credited next month</p>
    </div>
    <div class="due-right">
      <div class="due-row"><label>Your transactions</label><span class="mono">₹${fmt(pNet)}</span></div>
      ${addons.map(a => {
    const net = netAmount(a.txns);
    return `<div class="due-row"><label>${escHtml(a.name)}'s transactions</label><span class="mono">₹${fmt(net)}</span></div>`;
  }).join('')}
      <div class="due-row separator highlight"><label>Total you pay SBI</label><span class="mono txt-amber">₹${fmt(totalDue)}</span></div>
      <div class="due-row" style="margin-top:8px"><label>Add-on(s) pay you</label><span class="mono txt-green">₹${fmt(addonPayYou)}</span></div>
      <div class="due-row"><label style="font-size:10px;color:var(--text3)">= Add-on spend (₹${fmt(aNet)}) − their cashback (₹${fmt(aCb)})</label></div>
    </div>
  `;
}

// ─── Table Render ──────────────────────────────────────────────────────────
function renderTable(tableId, txns, section) {
  const table = document.getElementById(tableId);
  if (!table) return;
  table.innerHTML = `
    <thead><tr>
      <th>Date</th>
      <th>Merchant / Description</th>
      <th style="text-align:right">Amount (₹)</th>
      <th>Category</th>
      <th style="text-align:right">Cashback (₹)</th>
    </tr></thead>
    <tbody>
      ${txns.map((t, i) => {
    const isCbCredit = t.category === 'cashback_credit';
    return `
        <tr class="${isCbCredit ? 'cb-credit-row' : t.amount < 0 ? 'is-credit' : ''}">
          <td class="mono txt-dim" style="white-space:nowrap">${t.date}</td>
          <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(t.description)}">
            ${isCbCredit
        ? '<span class="badge-cb">↩ LAST MONTH CB</span>'
        : t.amount < 0 ? '<span style="font-size:10px;color:var(--text3);margin-right:4px">↩ REFUND</span>' : ''}
            ${escHtml(t.description)}
          </td>
          <td style="text-align:right" class="${isCbCredit ? 'mono txt-amber fw-600' : t.amount < 0 ? 'mono txt-dim' : 'mono fw-600'}">
            ${t.amount < 0 ? '−' : ''}₹${fmt(Math.abs(t.amount))}
          </td>
          <td>
            ${isCbCredit
        ? '<span class="cat-fixed">✦ Cashback Credit</span>'
        : `<select class="cat-select ${t.category}" onchange="reclassifyRow('${section}', ${i}, this.value)">
                  <option value="online"   ${t.category === 'online' ? 'selected' : ''}>🌐 Online 5%</option>
                  <option value="offline"  ${t.category === 'offline' ? 'selected' : ''}>🏪 Offline 1%</option>
                  <option value="excluded" ${t.category === 'excluded' ? 'selected' : ''}>🚫 Excluded</option>
                </select>`
      }
          </td>
          <td style="text-align:right" class="${isCbCredit ? 'txt-amber mono' : t.cashback === 0 ? 'cb-zero' : t.cashback < 0 ? 'cb-neg' : 'cb-pos'}">
            ${isCbCredit ? `−₹${fmt(Math.abs(t.amount))}` :
        t.cashback === 0 ? '—' : (t.cashback < 0 ? '−' : '+') + '₹' + fmt(Math.abs(t.cashback))}
          </td>
        </tr>`;
  }).join('')}
    </tbody>
  `;
}

// ─── Bill View ─────────────────────────────────────────────────────────────
function renderBill() {
  const p = allTransactions.primary;
  const addons = allTransactions.addons;
  const pGross = grossSpend(p);
  const pRef = totalRefunds(p);
  const pNet = netAmount(p);   // = pGross - pRef
  const pCb = netCashback(p);
  const lmCb = lastMonthCashback;

  // ── Primary card ──────────────────────────────────────────────────────────
  // Bill logic for primary:
  //   Gross spend           e.g. ₹9,855
  //   − Refunds             e.g. −₹1,308
  //   = Net spend           e.g. ₹8,547   ← what you owe SBI for YOUR txns
  //   Last month CB credit  e.g. −₹269    ← informational (SBI credits separately)
  //   Cashback next bill    e.g. ₹411     ← informational
  //   You pay SBI (share)   = Net spend   ← always pNet; SBI handles CB credits
  //
  // NOTE: "You pay SBI (your share)" = pNet, NOT pNet − lmCb.
  // The lastMonthCashback is shown purely informational — SBI already applies
  // that credit to your account; it does NOT change what you owe this cycle.

  const aNet = addons.reduce((s, a) => s + netAmount(a.txns), 0);
  const aCb = addons.reduce((s, a) => s + netCashback(a.txns), 0);
  const totalDue = pNet + aNet;

  document.getElementById('billContent').innerHTML = `
    <div class="bill-grid">

      <!-- Primary -->
      <div class="bill-card">
        <h4>Primary — MD SAMEER (You)</h4>
        <div class="bill-line"><label>Gross Spending</label><span class="mono">₹${fmt(pGross)}</span></div>
        <div class="bill-line"><label>Refunds / Credits</label><span class="mono txt-dim">−₹${fmt(pRef)}</span></div>
        <div class="bill-line separator"><label>Net Spend</label><span class="mono fw-600">₹${fmt(pNet)}</span></div>
        ${lmCb > 0 ? `
        <div class="bill-line info-line">
          <label>Last month cashback credit <span class="info-tag">by SBI</span></label>
          <span class="mono txt-amber">−₹${fmt(lmCb)}</span>
        </div>` : ''}
        <div class="bill-line info-line">
          <label>Cashback earned (next bill) <span class="info-tag">next month</span></label>
          <span class="mono txt-amber">₹${fmt(pCb)}</span>
        </div>
        <div class="bill-line total"><label>You pay SBI (your share)</label><span class="mono txt-green">₹${fmt(pNet)}</span></div>
      </div>

      <!-- Add-ons -->
      ${addons.map(a => {
    const net = netAmount(a.txns);
    const cb = netCashback(a.txns);
    const gross = grossSpend(a.txns);
    const ref = totalRefunds(a.txns);
    return `
        <div class="bill-card">
          <h4>Add-On — ${escHtml(a.name)}</h4>
          <div class="bill-line"><label>Gross Spending</label><span class="mono">₹${fmt(gross)}</span></div>
          <div class="bill-line"><label>Refunds / Credits</label><span class="mono txt-dim">−₹${fmt(ref)}</span></div>
          <div class="bill-line separator"><label>Net Spend</label><span class="mono fw-600">₹${fmt(net)}</span></div>
          <div class="bill-line info-line">
            <label>Cashback earned (deducted from due) <span class="info-tag">next month</span></label>
            <span class="mono txt-amber">−₹${fmt(cb)}</span>
          </div>
          <div class="bill-line total"><label>They pay you</label><span class="mono txt-blue">₹${fmt(Math.max(net - cb, 0))}</span></div>
        </div>`;
  }).join('')}

    </div>

    <!-- Total bill box -->
    <div class="bill-card mt-16 total-bill-box">
      <h4>Total Bill — What You Pay SBI</h4>
      <div class="bill-line"><label>Your net spend</label><span class="mono">₹${fmt(pNet)}</span></div>
      ${addons.map(a => `
        <div class="bill-line"><label>${escHtml(a.name)}'s net spend</label><span class="mono">₹${fmt(netAmount(a.txns))}</span></div>
      `).join('')}
      <div class="bill-line total"><label>Total statement due (pay this to SBI)</label><span class="mono txt-amber" style="font-size:18px">₹${fmt(totalDue)}</span></div>
      <div class="bill-line" style="margin-top:8px"><label>Next month cashback credit</label><span class="mono txt-green">₹${fmt(pCb + aCb)}</span></div>
    </div>
  `;
}

// ─── Interactions ──────────────────────────────────────────────────────────
function reclassifyRow(section, idx, category) {
  if (section === 'primary') {
    const t = allTransactions.primary[idx];
    if (t.fixed) return; // don't allow editing cashback_credit row
    t.category = category;
    t.cashback = calcCashback(t.amount, category);
  } else {
    const addonIdx = parseInt(section.replace('addon', ''));
    const t = allTransactions.addons[addonIdx].txns[idx];
    t.category = category;
    t.cashback = calcCashback(t.amount, category);
  }
  renderAll();
}

function showTab(tab) {
  document.querySelectorAll('.tab-view').forEach(v => v.classList.add('hidden'));
  document.getElementById('view-' + tab).classList.remove('hidden');
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
}

async function reclassify() {
  if (!allTransactions.primary.length && !allTransactions.addons.length) return;
  try {
    showLoading('Re-classifying with AI...', '🔒 Only merchant names sent');

    // Strip fixed cashback_credit row before re-classifying
    const cbRow = allTransactions.primary.find(t => t.category === 'cashback_credit');
    const pTxns = allTransactions.primary.filter(t => t.category !== 'cashback_credit');
    const classifiedP = pTxns.length ? await classifyTransactions(pTxns) : [];
    allTransactions.primary = cbRow ? [cbRow, ...classifiedP] : classifiedP;

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

// ─── Excel Export ──────────────────────────────────────────────────────────
function downloadExcel() {
  const wb = XLSX.utils.book_new();

  function makeSheet(txns, isAddon = false) {
    const net = netAmount(txns);
    const cb = netCashback(txns);
    const rows = [
      ['Type', 'Amount', 'No cashback', 0, 'Swipe/Tap to pay', 0.01, 'Online Payment', 0.05],
      ...txns
        .filter(t => t.category !== 'cashback_credit')
        .map(t => [
          t.description, t.amount,
          t.category === 'excluded' ? 'Yes' : null, t.category === 'excluded' ? 0 : null,
          t.category === 'offline' ? 'Yes' : null, t.category === 'offline' ? t.cashback : null,
          t.category === 'online' ? 'Yes' : null, t.category === 'online' ? t.cashback : null,
        ]),
      [null, net, null, 0, null, 0, null, cb],
      [],
      [null, null, 'Spending', null, net],
      [null, null, 'Cashback', null, cb],
      [null, null, 'Total', null, net - cb],
    ];
    return XLSX.utils.aoa_to_sheet(rows);
  }

  const p = allTransactions.primary;
  const addons = allTransactions.addons;
  const pNet = netAmount(p), pCb = netCashback(p);
  const aNet = addons.reduce((s, a) => s + netAmount(a.txns), 0);
  const aCb = addons.reduce((s, a) => s + netCashback(a.txns), 0);

  XLSX.utils.book_append_sheet(wb, makeSheet(p), 'Primary');
  addons.forEach(a => {
    XLSX.utils.book_append_sheet(wb, makeSheet(a.txns, true), a.name.substring(0, 31));
  });

  const billRows = [
    [],
    [null, 'Primary', 'Spending', null, pNet],
    [null, null, 'Cashback', null, pCb],
    [null, null, 'Net', null, pNet],
    ...(lastMonthCashback > 0 ? [[null, null, 'Last Month CB Credit', null, -lastMonthCashback]] : []),
    [],
    ...addons.flatMap(a => {
      const net = netAmount(a.txns), cb = netCashback(a.txns);
      return [
        [null, a.name, 'Spending', null, netAmount(a.txns)],
        [null, null, 'Cashback', null, netCashback(a.txns)],
        [null, null, 'They Pay You', null, Math.max(net - cb, 0)],
        []
      ];
    }),
    [null, 'Total', 'Pay to SBI', null, pNet + aNet],
    [null, null, 'Next Bill Cashback', null, pCb + aCb],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(billRows), 'Bill');

  const month = new Date().toLocaleString('en-IN', { month: 'short', year: 'numeric' }).replace(' ', '-');
  XLSX.writeFile(wb, `SBI_Cashback_${month}.xlsx`);
}

// ─── PDF Export ────────────────────────────────────────────────────────────
function downloadPDF() {
  const p = allTransactions.primary;
  const addons = allTransactions.addons;
  const pGross = grossSpend(p);
  const pRef = totalRefunds(p);
  const pNet = netAmount(p);
  const pCb = netCashback(p);
  const lmCb = lastMonthCashback;
  const aNet = addons.reduce((s, a) => s + netAmount(a.txns), 0);
  const aCb = addons.reduce((s, a) => s + netCashback(a.txns), 0);
  const totalDue = pNet + aNet;

  function txnRows(txns) {
    return txns.map(t => {
      if (t.category === 'cashback_credit') {
        return `<tr class="cb-credit">
          <td>—</td>
          <td>↩ LAST MONTH CASHBACK CREDIT</td>
          <td class="r" style="color:#d97706">−₹${fmt(Math.abs(t.amount))}</td>
          <td style="color:#d97706">Cashback Credit</td>
          <td class="r" style="color:#d97706">−₹${fmt(Math.abs(t.amount))}</td>
        </tr>`;
      }
      return `<tr class="${t.amount < 0 ? 'credit-row' : ''}">
        <td>${t.date}</td>
        <td>${escHtml(t.description)}</td>
        <td class="r">${t.amount < 0 ? '−' : ''}₹${fmt(Math.abs(t.amount))}</td>
        <td>${t.category}</td>
        <td class="r ${t.cashback > 0 ? 'pos' : t.cashback < 0 ? 'neg' : 'zero'}">
          ${t.cashback === 0 ? '—' : (t.cashback < 0 ? '−' : '+') + '₹' + fmt(Math.abs(t.cashback))}
        </td>
      </tr>`;
    }).join('');
  }

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <title>SBI Cashback Statement</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 11px; color: #1a2640; background: #fff; padding: 28px 32px; }
    h1 { font-size: 18px; font-weight: 700; color: #1d6fd8; margin-bottom: 2px; }
    .subtitle { font-size: 10px; color: #7a90aa; margin-bottom: 20px; font-family: monospace; }
    h2 { font-size: 13px; font-weight: 700; color: #1d6fd8; border-bottom: 2px solid #1d6fd8; padding-bottom: 5px; margin: 22px 0 10px; text-transform: uppercase; letter-spacing: .05em; }
    h3 { font-size: 10px; color: #556882; text-transform: uppercase; letter-spacing: .07em; margin: 14px 0 5px; }

    /* Summary cards */
    .cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 18px; }
    .card { background: #f4f7fc; border: 1px solid #d0d9ea; border-radius: 7px; padding: 10px 14px; }
    .card-label { font-size: 9px; text-transform: uppercase; letter-spacing: .07em; color: #7a90aa; margin-bottom: 3px; }
    .card-val { font-size: 17px; font-weight: 700; font-family: monospace; }
    .green { color: #059669; } .blue { color: #2563eb; } .amber { color: #d97706; } .purple { color: #7c3aed; }

    /* Due box */
    .due-box { background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 14px 18px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center; gap: 20px; }
    .due-big { font-size: 28px; font-weight: 700; color: #d97706; font-family: monospace; }
    .due-sub { font-size: 10px; color: #92600a; margin-top: 2px; }
    .due-label { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: #92600a; margin-bottom: 3px; }
    .due-lines { min-width: 260px; }
    .due-line { display: flex; justify-content: space-between; font-size: 11px; padding: 3px 0; border-bottom: 1px solid #fde68a; }
    .due-line.total-line { font-weight: 700; font-size: 12px; border-bottom: none; border-top: 2px solid #fde68a; padding-top: 6px; margin-top: 4px; }

    /* Tables */
    table { width: 100%; border-collapse: collapse; margin-bottom: 12px; font-size: 10.5px; }
    th { background: #e8edf6; padding: 6px 8px; text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: .06em; color: #4a5e7a; border-bottom: 2px solid #d0d9ea; white-space: nowrap; }
    td { padding: 5px 8px; border-bottom: 1px solid #eaeff8; vertical-align: middle; }
    tr:last-child td { border-bottom: none; }
    .r { text-align: right; font-family: monospace; }
    tr.credit-row td { color: #999; }
    tr.cb-credit td { background: #fffbeb; }
    .pos { color: #059669; font-weight: 600; }
    .neg { color: #dc2626; }
    .zero { color: #aaa; }

    /* Bill cards */
    .bill-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 14px; }
    .bill-card { background: #f4f7fc; border: 1px solid #d0d9ea; border-radius: 8px; padding: 14px 18px; }
    .bill-card h4 { font-size: 9px; text-transform: uppercase; letter-spacing: .08em; color: #556882; margin-bottom: 10px; padding-bottom: 7px; border-bottom: 1px solid #d0d9ea; }
    .bill-line { display: flex; justify-content: space-between; padding: 4px 0; font-size: 11px; border-bottom: 1px solid #eaeff8; }
    .bill-line:last-child { border-bottom: none; }
    .bill-line.total { font-weight: 700; font-size: 13px; border-top: 2px solid #d0d9ea; border-bottom: none; margin-top: 5px; padding-top: 8px; }
    .bill-line.info { color: #92600a; }
    .info-tag { font-size: 8px; background: #fde68a; color: #92600a; border-radius: 3px; padding: 1px 4px; margin-left: 4px; vertical-align: middle; }
    .total-bill { background: #fffbeb; border: 1px solid #fde68a; }
    .mn { font-family: monospace; }

    @media print {
      body { padding: 12px 16px; }
      .page-break { page-break-before: always; }
    }
  </style>
</head>
<body>

<h1>SBI Cashback Card — Statement Summary</h1>
<div class="subtitle">Generated ${new Date().toLocaleString('en-IN', { dateStyle: 'long', timeStyle: 'short' })}</div>

<h2>Overview</h2>
<div class="cards">
  <div class="card"><div class="card-label">Your Net Spend</div><div class="card-val green">₹${fmt(pNet)}</div></div>
  <div class="card"><div class="card-label">Your Cashback (next bill)</div><div class="card-val amber">₹${fmt(pCb)}</div></div>
  ${addons.map(a => {
    const net = netAmount(a.txns), cb = netCashback(a.txns);
    return `
  <div class="card"><div class="card-label">${escHtml(a.name)} Net Spend</div><div class="card-val blue">₹${fmt(net)}</div></div>
  <div class="card"><div class="card-label">${escHtml(a.name)} Cashback</div><div class="card-val purple">₹${fmt(cb)}</div></div>`;
  }).join('')}
</div>

<div class="due-box">
  <div>
    <div class="due-label">Your SBI Bill Due</div>
    <div class="due-big">₹${fmt(totalDue)}</div>
    <div class="due-sub">Cashback ₹${fmt(pCb)} credited next month</div>
  </div>
  <div class="due-lines">
    <div class="due-line"><span>Your transactions</span><span class="mn">₹${fmt(pNet)}</span></div>
    ${addons.map(a => `<div class="due-line"><span>${escHtml(a.name)}'s transactions</span><span class="mn">₹${fmt(netAmount(a.txns))}</span></div>`).join('')}
    <div class="due-line total-line"><span>Total due to SBI</span><span class="mn amber">₹${fmt(totalDue)}</span></div>
    <div class="due-line" style="border:none;margin-top:4px"><span>Add-on(s) pay you</span><span class="mn green">₹${fmt(Math.max(aNet - aCb, 0))}</span></div>
  </div>
</div>

<h2>Bill Split</h2>
<div class="bill-grid">
  <div class="bill-card">
    <h4>Primary — MD SAMEER (You)</h4>
    <div class="bill-line"><label>Gross Spending</label><span class="mn">₹${fmt(pGross)}</span></div>
    <div class="bill-line"><label>Refunds</label><span class="mn">−₹${fmt(pRef)}</span></div>
    <div class="bill-line"><label><strong>Net Spend</strong></label><span class="mn"><strong>₹${fmt(pNet)}</strong></span></div>
    ${lmCb > 0 ? `<div class="bill-line info"><label>Last month CB credit <span class="info-tag">by SBI</span></label><span class="mn amber">−₹${fmt(lmCb)}</span></div>` : ''}
    <div class="bill-line info"><label>Cashback earned (next bill) <span class="info-tag">next month</span></label><span class="mn amber">₹${fmt(pCb)}</span></div>
    <div class="bill-line total"><label>You pay SBI (your share)</label><span class="mn green">₹${fmt(pNet)}</span></div>
  </div>
  ${addons.map(a => {
    const net = netAmount(a.txns), cb = netCashback(a.txns), gross = grossSpend(a.txns), ref = totalRefunds(a.txns);
    return `
  <div class="bill-card">
    <h4>Add-On — ${escHtml(a.name)}</h4>
    <div class="bill-line"><label>Gross Spending</label><span class="mn">₹${fmt(gross)}</span></div>
    <div class="bill-line"><label>Refunds</label><span class="mn">−₹${fmt(ref)}</span></div>
    <div class="bill-line"><label><strong>Net Spend</strong></label><span class="mn"><strong>₹${fmt(net)}</strong></span></div>
    <div class="bill-line info"><label>Cashback earned (deducted from due) <span class="info-tag">next month</span></label><span class="mn amber">−₹${fmt(cb)}</span></div>
    <div class="bill-line total"><label>They pay you</label><span class="mn blue">₹${fmt(Math.max(net - cb, 0))}</span></div>
  </div>`;
  }).join('')}
</div>

<div class="bill-card total-bill">
  <h4>Total Bill — What You Pay SBI</h4>
  <div class="bill-line"><label>Your net spend</label><span class="mn">₹${fmt(pNet)}</span></div>
  ${addons.map(a => `<div class="bill-line"><label>${escHtml(a.name)}'s net spend</label><span class="mn">₹${fmt(netAmount(a.txns))}</span></div>`).join('')}
  <div class="bill-line total"><label>Total statement due (pay this to SBI)</label><span class="mn amber" style="font-size:16px">₹${fmt(totalDue)}</span></div>
  <div class="bill-line" style="margin-top:6px;border:none"><label>Next month cashback credit</label><span class="mn green">₹${fmt(pCb + aCb)}</span></div>
</div>

<h2>Primary Transactions — MD SAMEER</h2>
<table>
  <thead><tr>
    <th>Date</th><th>Merchant / Description</th><th class="r">Amount</th><th>Category</th><th class="r">Cashback</th>
  </tr></thead>
  <tbody>${txnRows(p)}</tbody>
</table>

${addons.map(a => `
<h2>Add-On Transactions — ${escHtml(a.name)}</h2>
<table>
  <thead><tr>
    <th>Date</th><th>Merchant / Description</th><th class="r">Amount</th><th>Category</th><th class="r">Cashback</th>
  </tr></thead>
  <tbody>${txnRows(a.txns)}</tbody>
</table>
`).join('')}

</body>
</html>`;

  const win = window.open('', '_blank');
  if (!win) { alert('Please allow popups for this page to use PDF export.'); return; }
  win.document.write(html);
  win.document.close();
  setTimeout(() => win.print(), 500);
}

// ─── Utils ─────────────────────────────────────────────────────────────────
function fmt(n) {
  return Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Init ──────────────────────────────────────────────────────────────────
initTheme();
