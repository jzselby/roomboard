# Room & Board Clearance Sofa Monitor

Checks the [Room & Board clearance sofas page](https://www.roomandboard.com/clearance/living/sofas-and-loveseats) every 10 minutes, scrapes each product's stock/availability status, and emails you a summary.

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Install Playwright's Chromium browser
npx playwright install chromium

# 3. Copy and fill in your email config
cp .env.example .env
# Edit .env with your Gmail address and App Password
# (Create one at: myaccount.google.com > Security > 2-Step Verification > App passwords)
```

## Usage

```bash
# Run continuously (checks every 10 minutes)
npm start

# Run a single check
npm run check
```

## Email Format

Each email includes a table with:
- **Product name** (linked to the product page)
- **Price** (sale + original)
- **Stock status** (quantity available, add-to-cart state, stock badges)
