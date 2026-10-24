/**
 * Backtracking VM: a flat program plus an explicit stack.
 *
 * The cost ledger is produced here, not estimated afterwards. `steps` counts
 * character and assertion decisions; `backtracks` counts rewinds to an earlier
 * choice point; `maxStack` is the deepest the choice stack ever grew. Those
 * three numbers are what separate "this regexp could be slow" from "this regexp
 * took 1.57 million decisions on 19 characters".
 *
 * The MIT License (MIT)
 * Copyright (c) 2017-present Dmitry Soshnikov <dmitry.soshnikov@gmail.com>
 */

'use strict';

const {matchesChar} = require('./charset');
const {compile, OP} = require('./compiler');

const EMPTY = [];

class StepLimitExceeded extends Error {
  constructor(limit) {
    super(`Stopped after ${limit} steps.`);
    this.name = 'StepLimitExceeded';
    // `instanceof` against a built-in subclass does not survive the babel 6
    // class transform, so the catch site matches on this code instead.
    this.code = 'BT_STEP_LIMIT';
    this.limit = limit;
  }
}

class StackLimitExceeded extends Error {
  constructor(limit) {
    super(`Backtrack stack exceeded ${limit} entries.`);
    this.name = 'StackLimitExceeded';
    this.code = 'BT_STACK_LIMIT';
    this.limit = limit;
  }
}

function isWordChar(input, index) {
  if (index < 0 || index >= input.length) {
    return false;
  }

  const code = input.charCodeAt(index);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95
  );
}

function isLineTerminator(unit) {
  return (
    unit === '\n' || unit === '\r' || unit === '\u2028' || unit === '\u2029'
  );
}

function assertHolds(kind, input, sp, flags) {
  switch (kind) {
    case '^':
      return flags.multiline
        ? sp === 0 || isLineTerminator(input[sp - 1])
        : sp === 0;
    case '$':
      return flags.multiline
        ? sp === input.length || isLineTerminator(input[sp])
        : sp === input.length;
    case '\\b':
      return isWordChar(input, sp - 1) !== isWordChar(input, sp);
    case '\\B':
      return isWordChar(input, sp - 1) === isWordChar(input, sp);
    default:
      return false;
  }
}

function compileFlags(flags) {
  return {
    ignoreCase: flags.includes('i'),
    multiline: flags.includes('m'),
    dotAll: flags.includes('s'),
  };
}

/**
 * Executes the program starting at exactly one offset.
 *
 * Returns null when every alternative is exhausted, otherwise the end offset and
 * the capture slots.
 */
function runAt(program, input, flags, start, state) {
  const instructions = program.instructions;
  const groupCount = program.groupCount;
  const slots =
    groupCount > 0 ? new Array(groupCount * 2).fill(-1) : EMPTY;
  const marks =
    program.markCount > 0 ? new Array(program.markCount).fill(-1) : EMPTY;
  const markCount = program.markCount;

  const stackPc = [];
  const stackSp = [];
  // A zero-width guard compares the current offset against the offset recorded
  // when the loop was entered. Those recorded offsets are machine state: a
  // rewind past the loop entry must restore them, or a rewound `(a*)*` keeps
  // re-entering its own empty iteration forever. Only patterns containing a
  // nullable body allocate here, so the common case pays nothing.
  const stackMarks = [];

  let pc = 0;
  let sp = start;
  let failed = false;

  // Opt-in execution trace (`BT_TRACE=1`). Kept in the shipped code because the
  // first question about any surprising ledger number is "which instructions ran".
  const tracing =
    typeof process !== 'undefined' &&
    Boolean(process.env) &&
    process.env.BT_TRACE === '1';
  let traceCount = 0;

  for (;;) {
    const inst = instructions[pc];

    if (tracing && traceCount < 400) {
      traceCount += 1;
      console.error(
        `${String(traceCount).padStart(3)} pc=${String(pc).padStart(3)} ` +
          `sp=${String(sp).padStart(2)} ${inst.op}` +
          (inst.slot != null ? ` slot=${inst.slot}` : '') +
          (inst.target != null ? ` ->${inst.target}` : '')
      );
    }

    switch (inst.op) {
      case OP.CHAR: {
        state.steps += 1;

        if (state.steps > state.maxSteps) {
          throw new StepLimitExceeded(state.maxSteps);
        }

        if (sp < input.length && matchesChar(inst.node, input[sp], flags)) {
          sp += 1;
          pc += 1;
        } else {
          failed = true;
        }

        break;
      }

      case OP.ASSERT: {
        state.steps += 1;

        if (state.steps > state.maxSteps) {
          throw new StepLimitExceeded(state.maxSteps);
        }

        if (assertHolds(inst.kind, input, sp, flags)) {
          pc += 1;
        } else {
          failed = true;
        }

        break;
      }

      case OP.SPLIT: {
        stackPc.push(inst.secondary);
        stackSp.push(sp);

        if (markCount > 0) {
          for (let i = 0; i < markCount; i += 1) {
            stackMarks.push(marks[i]);
          }
        }

        if (stackPc.length > state.maxStack) {
          state.maxStack = stackPc.length;
        }

        if (stackPc.length > state.maxStackLimit) {
          throw new StackLimitExceeded(state.maxStackLimit);
        }

        pc = inst.primary;
        break;
      }

      case OP.JMP:
        pc = inst.target;
        break;

      case OP.SAVE:
        slots[inst.slot] = sp;
        pc += 1;
        break;

      case OP.MARK:
        marks[inst.slot] = sp;
        pc += 1;
        break;

      case OP.PROGRESS:
        if (sp === marks[inst.slot]) {
          pc = inst.target;
        } else {
          pc += 1;
        }
        break;

      case OP.MATCH:
        return {
          end: sp,
          slots: groupCount > 0 ? slots.slice() : EMPTY,
        };

      default:
        throw new Error(`Unknown opcode ${inst.op}`);
    }

    if (failed) {
      if (stackPc.length === 0) {
        return null;
      }

      pc = stackPc.pop();
      sp = stackSp.pop();

      if (markCount > 0) {
        for (let i = markCount - 1; i >= 0; i -= 1) {
          marks[i] = stackMarks.pop();
        }
      }

      state.backtracks += 1;
      failed = false;
    }
  }
}

function toCaptures(slots, groupCount, input) {
  const captures = [];

  for (let i = 0; i < groupCount; i += 1) {
    const from = slots[i * 2];
    const to = slots[i * 2 + 1];

    captures.push(
      from < 0 || to < 0
        ? null
        : {start: from, end: to, value: input.slice(from, to)}
    );
  }

  return captures;
}

function isAnchored(ast, flags) {
  if (flags.multiline || ast.body.type !== 'Alternative') {
    return false;
  }

  const first = ast.body.expressions[0];

  return (
    ast.body.expressions.length > 0 &&
    first.type === 'Assertion' &&
    first.kind === '^'
  );
}

/**
 * Runs a regexp AST against a string with `RegExp#exec` search semantics.
 */
function exec(ast, input, options = {}) {
  const program = compile(ast);
  const flags = compileFlags(ast.flags || '');

  const state = {
    steps: 0,
    backtracks: 0,
    maxStack: 0,
    maxSteps: options.maxSteps == null ? 200000 : options.maxSteps,
    maxStackLimit: options.maxStack == null ? 100000 : options.maxStack,
  };

  const anchored = isAnchored(ast, flags);
  // Search semantics retry every start offset, which folds the cost of a
  // failed scan into the cost of the pattern itself. Cost analysis usually wants
  // one attempt: `anchorAtStart` runs from offset 0 only, matching what a
  // single anchored evaluation would pay.
  const singleAttempt = options.anchorAtStart === true;

  try {
    for (let start = 0; start <= input.length; start += 1) {
      if ((anchored || singleAttempt) && start > 0) {
        break;
      }

      const result = runAt(program, input, flags, start, state);

      if (result) {
        return {
          matched: true,
          value: input.slice(start, result.end),
          index: start,
          end: result.end,
          captures: toCaptures(result.slots, program.groupCount, input),
          ledger: {
            steps: state.steps,
            backtracks: state.backtracks,
            maxStack: state.maxStack,
          },
          truncated: null,
        };
      }
    }
  } catch (error) {
    if (
      error &&
      (error.code === 'BT_STEP_LIMIT' || error.code === 'BT_STACK_LIMIT')
    ) {
      return {
        matched: null,
        value: null,
        index: -1,
        end: -1,
        captures: [],
        ledger: {
          steps: state.steps,
          backtracks: state.backtracks,
          maxStack: state.maxStack,
        },
        truncated: error.name,
        limit: error.limit,
      };
    }

    throw error;
  }

  return {
    matched: false,
    value: null,
    index: -1,
    end: -1,
    captures: [],
    ledger: {
      steps: state.steps,
      backtracks: state.backtracks,
      maxStack: state.maxStack,
    },
    truncated: null,
  };
}

module.exports = {
  exec,
  runAt,
  compileFlags,
  StepLimitExceeded,
  StackLimitExceeded,
};
