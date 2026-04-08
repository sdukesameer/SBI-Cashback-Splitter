# SBI Cashback Card — Statement Splitter

A local HTML tool that parses your **SBI Cashback Card** monthly PDF statement, splits transactions between the primary and add-on cardholder, classifies each transaction using AI, and calculates the exact cashback and bill split — matching the official SBI cashback formula.

---

## Features

- **PDF parser** — reads your SBI statement directly in the browser (no upload to any server)
- **AI classification** — sends only merchant names to Groq (Llama 3.3 70B, free) to classify as Online / Offline / Excluded
- **Exact cashback formula** — matches the Excel formula SBI uses:
  - Online 5%: `FLOOR(ABS(amount)×0.01, 1) + FLOOR(ABS(amount)×0.04, 1)` × sign
  - Offline 1%: `MAX(FLOOR(amount×0.01, 1), 0)`
  - Excluded: `0`
- **Refund netting** — returns cancel out the original purchase and its cashback (net = 0)
- **Bill splitter** — separates primary vs add-on spend, shows exactly what dad pays you and what you owe SBI
- **Manual override** — change any transaction's category with a dropdown
- **Excel export** — downloads a workbook matching your existing 3-sheet format (Primary / Add On / Bill)
- **Dark / Light mode** — toggle in top-right, persists across sessions
- **Privacy** — only merchant names (truncated) leave your browser; no card numbers, account numbers, or personal names sent to AI

---

## Bill Logic

```
Your SBI Bill Due  =  Your net spend  +  Dad's net spend
                   (cashback is credited NEXT month, not deducted now)

Dad Pays You       =  Dad's net spend  −  Dad's cashback
                   (you absorb dad's cashback since it posts to your account)

Net effective cost =  Total bill  −  All cashback (realised next month)
```

**Why doesn't your cashback reduce this month's bill?**
SBI posts cashback within 2 working days _after_ the statement date. It applies to _next_ month's bill. So this month you pay the full amount — your cashback is a credit that reduces the following bill.

---

## Cashback Rules (SBI Cashback Card)

| Category | Rate | Examples |
|---|---|---|
| **Online** | **5%** | Flipkart, Myntra, Amazon, Zepto, Blinkit, Swiggy, Zomato, Uber, Ola, RedBus, MakeMyTrip, Nykaa, CRED, streaming |
| **Offline** | **1%** | Physical stores, malls, medical shops, restaurants (POS swipe) |
| **Excluded** | **0%** | Fuel, utilities, wallet loads (>₹1000), rent (MCC 6513), insurance, jewellery, cash advance, government, donations, education via 3rd-party apps |

> The 5% is computed as 4% floored + 1% floored separately, which matches SBI's actual calculation (can differ by ₹1 from a straight 5% floor).

---

## Setup

### 1. Get a Free Groq API Key

1. Go to [console.groq.com/keys](https://console.groq.com/keys)
2. Sign up / log in (free, no credit card)
3. Click **Create API Key** → copy the key

### 2. Add the key to `app.js`

Open `app.js` and replace line 3:

```js
const GROQ_API_KEY = 'gsk_your_actual_key_here';
```

### 3. Open the tool

Just open `index.html` in any modern browser — no server, no install, no build step.

```
Double-click index.html  →  works immediately
```

---

## Usage

1. **Upload** your SBI Cashback Card PDF (drag & drop or click)
2. Click **Parse & Classify Transactions**
3. Review the AI-classified transactions — override any with the dropdown
4. Check the **Bill Split** tab for the exact amounts
5. Click **Download Excel** to save in your existing format

---

## File Structure

```
sbi-cashback-splitter/
├── index.html      ← App shell + structure
├── styles.css      ← All styling, dark/light themes, layout
├── app.js          ← All logic: PDF parse, AI classify, cashback calc, Excel export
└── README.md       ← This file
```

---

## Privacy

| What | Sent to AI? |
|---|---|
| Card number | ❌ Never |
| Account number | ❌ Never |
| Your name / dad's name | ❌ Never |
| Transaction amounts | ❌ Never |
| Merchant names (truncated to 45 chars) | ✅ Yes — needed for classification |

The PDF never leaves your browser. Only a list of merchant name strings (e.g. `"Flipkart"`, `"ZEPTO MARKETPLACE"`) is sent to Groq's API.

---

## Troubleshooting

**"No transactions found"**
→ Make sure it's the SBI Cashback Card monthly PDF (not a mini-statement or app screenshot).

**AI classification wrong**
→ Use the dropdown on each row to manually correct Online / Offline / Excluded. Changes update the totals instantly.

**Groq API error**
→ Check your API key in `app.js`. Make sure it starts with `gsk_`. Get one free at [console.groq.com](https://console.groq.com/keys).

**Cashback amount slightly different from statement**
→ SBI posts cashback within 2 working days after statement date. The tool calculates expected cashback per the card's formula — the actual posted amount may differ by ±₹1 per transaction due to rounding.

---

## Built with

- [PDF.js](https://mozilla.github.io/pdf.js/) — in-browser PDF parsing
- [SheetJS (xlsx)](https://sheetjs.com/) — Excel file generation
- [Groq API](https://groq.com/) — free Llama 3.3 70B inference for merchant classification
- Vanilla HTML / CSS / JS — no frameworks, no build step

---

*Made for personal use with SBI Cashback Card (XXXX XXXX XXXX XX06)*
