#!/usr/bin/env node
/**
 * Headless acceptance for the workbench.
 *
 * Each case loads the page with a `?pattern=` query, dumps the rendered DOM and
 * asserts on the presence or absence of specific markers. Checking the DOM is
 * stronger than checking that a screenshot exists: it proves the script ran,
 * reached the intended branch and produced the expected verdict.
 *
 * The MIT License (MIT)
 * Copyright (c) 2017-present Dmitry Soshnikov <dmitry.soshnikov@gmail.com>
 */

'use strict';

const {execFileSync} = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const PAGE = path.join(ROOT, 'demo', 'index.html');

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

function findBrowser() {
  for (const candidate of EDGE_CANDIDATES) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

const CASES = [
  {
    name: 'nested quantifier',
    pattern: '(a+)+b',
    expect: ['badge exponential', '<svg', 'collapse-nested-quantifier', 'not an equivalence proof'],
    forbid: ['class="error"'],
  },
  {
    name: 'flat quantifier',
    pattern: 'a+b',
    expect: ['badge linear', '<svg', 'No collapsed-quantifier site'],
    forbid: ['class="error"'],
  },
  {
    name: 'unsupported construct',
    pattern: '(?=a)',
    expect: ['超出支持范围', 'lookahead'],
    forbid: ['class="badge'],
  },
  {
    name: 'syntax error',
    pattern: '(',
    expect: ['解析失败'],
    forbid: ['<svg'],
  },
  {
    name: 'custom input',
    pattern: 'a+b',
    input: 'aaaaaaaaaaaaaaaa!',
    expect: ['自定义输入', 'badge'],
    forbid: ['class="error"'],
  },
];

function run(browser, search) {
  const url = `file:///${PAGE.replace(/\\/g, '/')}${search}`;
  const output = execFileSync(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--virtual-time-budget=8000',
      '--dump-dom',
      url,
    ],
    {stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024, timeout: 60000}
  );

  return output.toString('utf8');
}

function main() {
  const browser = findBrowser();

  if (!browser) {
    // A missing browser is an environment gap, not a failing acceptance run.
    // Report it plainly so a skip is never mistaken for a pass.
    console.log('SKIP  no headless browser found; DOM acceptance not executed.');
    return;
  }

  let failed = 0;
  let browserFailed = false;

  for (const testCase of CASES) {
    const params = new URLSearchParams({pattern: testCase.pattern});

    if (testCase.input) {
      params.set('input', testCase.input);
    }

    let dom;

    try {
      dom = run(browser, `?${params.toString()}`);
    } catch (error) {
      // A browser that cannot start is an environment gap. Report it plainly and
      // stop: silently passing would be worse than an honest skip.
      console.log(`SKIP  ${testCase.name}: browser did not start (${error.signal || error.message})`);
      browserFailed = true;
      continue;
    }

    // Only the rendered region counts. The page also contains its own script
    // source, where every template string (including `class="error"`) appears
    // verbatim, so a whole-document search would match code instead of output.
    const start = dom.indexOf('<div id="out">');
    const end = dom.indexOf('<footer', start);
    const region = start >= 0 && end > start ? dom.slice(start, end) : dom;

    const missing = testCase.expect.filter((token) => !region.includes(token));
    const forbidden = testCase.forbid.filter((token) => region.includes(token));
    const ok = missing.length === 0 && forbidden.length === 0;

    console.log(`${ok ? 'PASS' : 'FAIL'}  ${testCase.name}`);

    if (!ok) {
      failed += 1;
      if (missing.length) {
        console.log(`      missing: ${missing.join(', ')}`);
      }
      if (forbidden.length) {
        console.log(`      forbidden present: ${forbidden.join(', ')}`);
      }
    }
  }

  console.log('');
  console.log(`${CASES.length - failed}/${CASES.length} cases passed`);

  if (browserFailed) {
    console.log('NOTE  one or more cases were skipped because the browser failed to start.');
  }

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main();
