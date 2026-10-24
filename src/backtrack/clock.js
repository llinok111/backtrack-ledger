/**
 * Monotonic clock shared by the Node and browser builds.
 *
 * `performance.now()` exists in every supported runtime (Node 16+ and all modern
 * browsers), which avoids branching on `process` and keeps the bundled demo
 * working from `file://`.
 *
 * The MIT License (MIT)
 * Copyright (c) 2017-present Dmitry Soshnikov <dmitry.soshnikov@gmail.com>
 */

'use strict';

function now() {
  return performance.now();
}

module.exports = {now};
