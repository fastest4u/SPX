#!/usr/bin/env node
/**
 * Real-time polling script for Agency Booking Bidding List
 * Usage: node poll-bidding.js [interval_seconds]
 * Default interval: 30 seconds
 */

const fs = require('fs');
const path = require('path');

const URL = "https://logistics.myagencyservice.in.th/api/line_haul/agency/booking/bidding/list";
const INTERVAL_SEC = parseInt(process.argv[2]) || 30;
const INTERVAL_MS = INTERVAL_SEC * 1000;

const HEADERS = {
  "accept": "application/json, text/plain, */*",
  "accept-language": "th,en;q=0.9",
  "app": "Agency Portal",
  "content-type": "application/json;charset=UTF-8",
  "device-id": "YOUR_DEVICE_ID_HERE",
  "priority": "u=1, i",
  "sec-ch-ua": "\"Google Chrome\";v=\"147\", \"Not.A/Brand\";v=\"8\", \"Chromium\";v=\"147\"",
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": "\"macOS\"",
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
  "cookie": "YOUR_COOKIE_HERE",
  "Referer": "https://logistics.myagencyservice.in.th/"
};

const BODY = {
  pageno: 1,
  count: 100,
  request_tab_pending_confirmation: true,
  request_ctime_start: 1776358800
};

// ANSI colors
const C = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m'
};

let lastData = null;
let lastHash = null;
let requestCount = 0;
let errorCount = 0;

function formatTime(date = new Date()) {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h |= 0;
  }
  return h;
}

function getRecordCount(data) {
  if (Array.isArray(data)) return data.length;
  if (data && Array.isArray(data.data)) return data.data.length;
  if (data && Array.isArray(data.records)) return data.records.length;
  if (data && Array.isArray(data.list)) return data.list.length;
  if (data && Array.isArray(data.result)) return data.result.length;
  if (data && data.total !== undefined) return data.total;
  return null;
}

async function fetchData() {
  const startTime = Date.now();
  requestCount++;
  const reqNum = requestCount;

  process.stdout.write(`${C.dim}[${formatTime()}] #${reqNum} Requesting...${C.reset} `);

  try {
    const response = await fetch(URL, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify(BODY)
    });

    const latency = Date.now() - startTime;

    if (!response.ok) {
      errorCount++;
      console.log(`${C.red}HTTP ${response.status} (${latency}ms)${C.reset}`);
      const text = await response.text();
      console.log(`  ${C.red}Error body:${C.reset} ${text.slice(0, 200)}`);
      return;
    }

    const data = await response.json();
    const jsonStr = JSON.stringify(data);
    const currentHash = hashString(jsonStr);
    const recordCount = getRecordCount(data);

    const isNew = lastHash !== null && currentHash !== lastHash;
    const isFirst = lastHash === null;

    let statusStr = `${C.green}OK${C.reset} (${latency}ms)`;
    if (isFirst) statusStr += ` ${C.cyan}[first]${C.reset}`;
    else if (isNew) statusStr += ` ${C.yellow}[CHANGED]${C.reset}`;
    else statusStr += ` [same]`;

    const countStr = recordCount !== null ? `records=${recordCount}` : 'records=?';
    console.log(`${statusStr} ${C.dim}${countStr}${C.reset}`);

    // Save to file if changed or first request
    if (isFirst || isNew) {
      saveData(data, isNew, reqNum);
    }

    lastData = data;
    lastHash = currentHash;

    // Print summary of first record if available and changed
    if (isNew && data && typeof data === 'object') {
      printDiffSummary(data);
    }

  } catch (err) {
    errorCount++;
    const latency = Date.now() - startTime;
    console.log(`${C.red}ERROR (${latency}ms)${C.reset}`);
    console.log(`  ${C.red}${err.message}${C.reset}`);
  }
}

function saveData(data, isNew, reqNum) {
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const prefix = isNew ? 'changed' : 'init';
  const filename = `${prefix}_${timestamp}_req${reqNum}.json`;
  const filepath = path.join(dataDir, filename);

  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));

  if (isNew) {
    console.log(`  ${C.magenta}Saved to: data/${filename}${C.reset}`);
  }
}

function printDiffSummary(data) {
  // Try to extract useful info from common response shapes
  const records = data.data || data.records || data.list || data.result || (Array.isArray(data) ? data : []);
  if (records.length > 0) {
    const first = records[0];
    const keys = Object.keys(first).slice(0, 5);
    console.log(`  ${C.dim}First record keys:${C.reset} ${keys.join(', ')}...`);
    if (first.id || first.booking_id || first.request_id || first._id) {
      console.log(`  ${C.dim}ID:${C.reset} ${first.id || first.booking_id || first.request_id || first._id}`);
    }
  }
}

function printHeader() {
  console.log(`${C.bright}Agency Booking Bidding List - Real-time Polling${C.reset}`);
  console.log(`${C.dim}URL:${C.reset} ${URL}`);
  console.log(`${C.dim}Interval:${C.reset} ${INTERVAL_SEC}s (${INTERVAL_MS}ms)`);
  console.log(`${C.dim}Started:${C.reset} ${formatTime()}`);
  console.log(`${C.dim}Press Ctrl+C to stop${C.reset}`);
  console.log('');
}

function printFooter() {
  console.log('');
  console.log(`${C.bright}Polling stopped${C.reset}`);
  console.log(`${C.dim}Total requests:${C.reset} ${requestCount}`);
  console.log(`${C.dim}Errors:${C.reset} ${errorCount}`);
  console.log(`${C.dim}Stopped:${C.reset} ${formatTime()}`);
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  printFooter();
  process.exit(0);
});

process.on('SIGTERM', () => {
  printFooter();
  process.exit(0);
});

// Main
printHeader();
fetchData(); // First request immediately
setInterval(fetchData, INTERVAL_MS);
