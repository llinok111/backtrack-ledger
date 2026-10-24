/**
 * Public API for the backtrack insurance layer.
 *
 * Everything here is additive: the upstream `regexp-tree` API is untouched, and
 * `regexpTree.backtrack` simply exposes this module.
 *
 * The MIT License (MIT)
 * Copyright (c) 2017-present Dmitry Soshnikov <dmitry.soshnikov@gmail.com>
 */

'use strict';

const {exec} = require('./vm');
const {compile} = require('./compiler');
const {analyze, assertSupported, UnsupportedPatternError} = require('./analyze');
const {ledger} = require('./ledger');
const {attack} = require('./attack');
const {rewrite, verify} = require('./rewrite');

module.exports = {
  exec,
  compile,
  analyze,
  assertSupported,
  ledger,
  attack,
  rewrite,
  verify,
  UnsupportedPatternError,
};
