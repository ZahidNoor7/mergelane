// Tests for local.mjs (scripts/ci/local.sh). Run:
//   node --test --experimental-test-coverage --test-coverage-include='scripts/ci/local.mjs' \
//     scripts/ci/local.test.mjs
// No real job runs here: the runner is exercised with tiny workflows of shell commands.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  addResult,
  baseEnv,
  DEFAULT_WORKFLOW,
  describePlan,
  formatTable,
  KNOWN_ACTIONS,
  LEFTOVERS,
  listEntries,
  main,
  needsRoot,
  newEntries,
  parseGoCoverTotal,
  parseGoTest,
  parseNodeTest,
  parsePlaywright,
  parserFor,
  parseShellTests,
  parseVitest,
  parseYaml,
  planWorkflow,
  ROOT,
  runJob,
  runScript,
  selectJobs,
  SKIP_STEPS,
  stepExtraEnv,
  UsageError
} from './local.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'mergelane-local-ci-test-'))
after(() => rmSync(scratch, { recursive: true, force: true }))
let count = 0
const fresh = (name = 'dir') => {
  const dir = join(scratch, `${name}-${++count}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const CI_YML = readFileSync(DEFAULT_WORKFLOW, 'utf8')
/** This process's environment as a step sees it (without the test runner's NODE_TEST_CONTEXT). */
const STEP_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT')
)
const RELEASE_YML = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8')

describe('parseYaml', () => {
  test('reads ci.yml: its jobs, steps and multi-line commands', () => {
    const workflow = parseYaml(CI_YML)
    assert.equal(workflow.name, 'ci')
    assert.deepEqual(workflow.on, { workflow_dispatch: null })
    assert.deepEqual(workflow.permissions, { contents: 'read' })
    assert.equal(workflow.jobs['repo-checks']['timeout-minutes'], 10)
    const build = workflow.jobs.package.steps.find((step) =>
      step.name?.startsWith('Build the helper')
    )
    assert.equal(build['working-directory'], 'daemon')
    assert.match(build.run, /^version=\$\(node -p .*\ngo build .*\ngo build .*\n$/)
    const appAcceptance = workflow.jobs['app-acceptance'].steps.find((step) =>
      step.name?.startsWith('App downloads')
    )
    // A folded (>-) command is one line.
    assert.ok(!appAcceptance.run.includes('\n'))
    assert.deepEqual(workflow.jobs['daemon-acceptance'].needs, ['daemon', 'netsim'])
    const checkout = workflow.jobs.daemon.steps[0]
    assert.equal(checkout.uses, 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1')
  })

  test('reads release.yml: an empty flow mapping, quoted values, defaults and inputs', () => {
    const workflow = parseYaml(RELEASE_YML)
    assert.deepEqual(workflow.permissions, {})
    assert.equal(workflow.jobs.release.defaults.run.shell, 'bash')
    assert.equal(workflow.on.workflow_dispatch.inputs.draft.default, true)
    assert.equal(workflow.jobs.release.env.TAG, 'v${{ inputs.version }}')
  })

  test('block scalars: literal, folded and chomping', () => {
    const doc = parseYaml(
      [
        'literal: |',
        '  one',
        '',
        '  two',
        '',
        'strip: |-',
        '  a',
        'keep: |+',
        '  b',
        '',
        '',
        'folded: >',
        '  c',
        '  d',
        '',
        '  e',
        'foldstrip: >-',
        '  f',
        '    g',
        'empty: |',
        'after: 1'
      ].join('\n')
    )
    assert.equal(doc.literal, 'one\n\ntwo\n')
    assert.equal(doc.strip, 'a')
    assert.equal(doc.keep, 'b\n\n\n')
    assert.equal(doc.folded, 'c d\ne\n')
    assert.equal(doc.foldstrip, 'f   g')
    assert.equal(doc.empty, '')
    assert.equal(doc.after, 1)
  })

  test('scalars, quoting, flow collections and comments', () => {
    const doc = parseYaml(
      [
        '# a comment',
        'plain: hello world # trailing comment',
        'hash: a#b',
        'double: "a \\"b\\" \\n \\t \\\\ \\/ \\0"',
        "single: 'it''s' # comment",
        'yes: true',
        'no: false',
        'nothing: null',
        'tilde: ~',
        'number: -42',
        'seq: [a, "b", 3]',
        'emptyseq: []',
        'map: { a: 1, b: [x] }',
        'emptymap: {}',
        '"quoted key": v',
        'list:',
        '- one',
        '- two: 2',
        '  three: 3',
        '-',
        '  four: 4',
        'nested:',
        '  - - inner'
      ].join('\n')
    )
    assert.equal(doc.plain, 'hello world')
    assert.equal(doc.hash, 'a#b')
    assert.equal(doc.double, 'a "b" \n \t \\ / \0')
    assert.equal(doc.single, "it's")
    assert.equal(doc.yes, true)
    assert.equal(doc.no, false)
    assert.equal(doc.nothing, null)
    assert.equal(doc.tilde, null)
    assert.equal(doc.number, -42)
    assert.deepEqual(doc.seq, ['a', 'b', 3])
    assert.deepEqual(doc.emptyseq, [])
    assert.deepEqual(doc.map, { a: 1, b: ['x'] })
    assert.deepEqual(doc.emptymap, {})
    assert.equal(doc['quoted key'], 'v')
    assert.deepEqual(doc.list, ['one', { two: 2, three: 3 }, { four: 4 }])
    assert.deepEqual(doc.nested, [['inner']])
  })

  test('an empty document is an empty mapping', () => {
    assert.deepEqual(parseYaml('# only a comment\n\n'), {})
  })

  for (const [name, text, message] of [
    ['tab indentation', 'a:\n\tb: 1', /tabs/],
    ['an unterminated quote', 'a: "abc', /unterminated quoted/],
    ['an unknown escape', 'a: "\\q"', /unsupported escape/],
    ['text after a quoted string', "a: 'x' y", /after the quoted/],
    ['a multi-line plain scalar', 'a: one\n  two', /multi-line plain/],
    ['a duplicate key', 'a: 1\na: 2', /duplicate key/],
    ['a line that is not key: value', 'a: 1\njust text', /expected "key: value"/],
    ['a sequence item among keys', 'a:\n  b: 1\n  - c', /unexpected indentation|expected/],
    ['a key among sequence items', 'a:\n  - b\n  c: 1', /unexpected indentation/],
    ['a deeper line after a sequence', 'a:\n  - b\n      c: 1', /unexpected indentation/],
    ['an unterminated flow sequence', 'a: [b, c', /unterminated flow sequence/],
    ['an unterminated flow mapping', 'a: {b: 1', /unterminated flow mapping/],
    ['a flow mapping entry without a colon', 'a: {b}', /in a flow mapping/],
    ['a block scalar line indented less than its first', 'a: |\n    x\n   y', /less indented/],
    ['content after the document', 'a: 1\n  b: 2', /unexpected indentation|multi-line/]
  ]) {
    test(`refuses ${name}`, () => {
      assert.throws(() => parseYaml(text), message)
    })
  }
})

/** A workflow with one job whose steps are given. */
function workflowWith(steps, job = {}) {
  return { jobs: { only: { 'timeout-minutes': 5, steps, ...job } } }
}

describe('planWorkflow', () => {
  const plan = planWorkflow(parseYaml(CI_YML))

  test('runs the six jobs that need no root and leaves the three that do to local-root.sh', () => {
    assert.deepEqual(
      plan.filter((job) => job.local).map((job) => job.id),
      ['repo-checks', 'app-checks', 'app-e2e-smoke', 'package', 'daemon', 'extension-e2e']
    )
    const root = plan.filter((job) => !job.local)
    assert.deepEqual(
      root.map((job) => job.id),
      ['netsim', 'daemon-acceptance', 'app-acceptance']
    )
    for (const job of root) assert.match(job.rootReason, /local-root\.sh/)
  })

  test('no step it runs uses sudo or the simulated networks', () => {
    for (const job of plan.filter((job) => job.local)) {
      for (const step of job.steps.filter((step) => step.kind === 'run')) {
        assert.ok(!needsRoot(step.command), `${job.id}: ${step.command}`)
      }
    }
  })

  test('every rule for a step it leaves out still matches a step in ci.yml (no stale rules)', () => {
    const skipped = plan.flatMap((job) => job.steps.filter((step) => step.kind === 'skip'))
    for (const rule of SKIP_STEPS) {
      assert.ok(
        skipped.some((step) => rule.match.test(step.command)),
        `${rule.match} matches no step`
      )
    }
    const used = parseYaml(CI_YML)
    const actions = Object.values(used.jobs).flatMap((job) => job.steps.map((step) => step.uses))
    for (const rule of KNOWN_ACTIONS) {
      assert.ok(
        actions.some((uses) => uses && rule.match.test(uses)),
        `${rule.match} matches no action`
      )
    }
  })

  test("every one of ci.yml's commands in the six jobs runs here, unless a rule says why not", () => {
    // The set of commands is what keeps local.sh in step with ci.yml: the runner reads them, so a
    // step added to ci.yml runs here without any change to local.mjs.
    const workflow = parseYaml(CI_YML)
    for (const job of plan.filter((job) => job.local)) {
      const commands = workflow.jobs[job.id].steps
        .filter((step) => step.run)
        .map((step) => step.run.trim())
      const accounted = job.steps.filter((step) => step.command).map((step) => step.command)
      assert.deepEqual(accounted, commands)
      for (const step of job.steps.filter((step) => step.kind === 'skip')) assert.ok(step.reason)
    }
  })

  test("the package job's packaging test runs (in its local mode, through the environment)", () => {
    const pkg = plan.find((job) => job.id === 'package')
    assert.ok(
      pkg.steps.some((step) => step.kind === 'run' && /package-test\.sh/.test(step.command))
    )
    assert.equal(baseEnv({}, { fixtureFfmpeg: 'x' }).MERGELANE_PACKAGE_TEST_LOCAL, '1')
  })

  test('a new step in ci.yml runs without any change here', () => {
    const [job] = planWorkflow(workflowWith([{ name: 'New check', run: 'echo new' }]))
    assert.equal(job.local, true)
    assert.deepEqual(job.steps[0].shellArgs, ['-e'])
    assert.equal(job.steps[0].workingDirectory, '.')
  })

  test('a new step that needs root makes its job root-only', () => {
    for (const run of [
      'sudo route -n add 1.2.3.4 127.0.0.1',
      'bash scripts/netsim/with-netsim.sh "1:1:1:0" -- true'
    ]) {
      const [job] = planWorkflow(workflowWith([{ name: 'Root', run }]))
      assert.equal(job.local, false)
      assert.match(job.rootReason, /needs root \(Root\)/)
    }
  })

  test('shell, working directory, environment and conditions come from the step, job or workflow', () => {
    const workflow = {
      env: { A: 'workflow' },
      defaults: { run: { 'working-directory': 'wf' } },
      jobs: {
        one: {
          env: { B: 'job' },
          defaults: { run: { shell: 'bash' } },
          steps: [
            { run: 'echo a', 'working-directory': 'step', env: { C: 1 }, if: 'always()' },
            { run: 'echo b' }
          ]
        }
      }
    }
    const [job] = planWorkflow(workflow)
    assert.deepEqual(job.env, { A: 'workflow', B: 'job' })
    assert.equal(job.timeoutMinutes, 360)
    assert.equal(job.steps[0].workingDirectory, 'step')
    assert.equal(job.steps[0].condition, 'always()')
    assert.deepEqual(job.steps[0].env, { C: 1 })
    assert.equal(job.steps[0].name, 'echo a')
    assert.equal(job.steps[1].workingDirectory, 'wf')
    assert.deepEqual(job.steps[1].shellArgs, ['--noprofile', '--norc', '-eo', 'pipefail'])
  })

  for (const [name, workflow, message] of [
    ['no jobs', { jobs: {} }, /no jobs/],
    ['no jobs at all', {}, /no jobs/],
    ['an unknown action', workflowWith([{ uses: 'someone/action@v1' }]), /KNOWN_ACTIONS/],
    [
      'uses and run together',
      workflowWith([{ uses: 'actions/checkout@v1', run: 'x' }]),
      /both uses and run/
    ],
    ['neither uses nor run', workflowWith([{ name: 'empty' }]), /neither uses nor run/],
    [
      'a condition it cannot evaluate',
      workflowWith([{ run: 'x', if: "github.event_name == 'push'" }]),
      /condition/
    ],
    ['an expression in a command', workflowWith([{ run: 'echo ${{ github.sha }}' }]), /expression/],
    ['another shell', workflowWith([{ run: 'x', shell: 'pwsh' }]), /only bash/]
  ]) {
    test(`refuses a workflow with ${name}`, () => {
      assert.throws(
        () => planWorkflow(workflow),
        (error) => error instanceof UsageError && message.test(error.message)
      )
    })
  }

  test('steps without a name are named by their action or first line', () => {
    const [job] = planWorkflow(
      workflowWith([{ uses: 'actions/checkout@v1' }, { run: 'first\nsecond' }])
    )
    assert.equal(job.steps[0].name, 'actions/checkout@v1')
    assert.equal(job.steps[1].name, 'first')
    assert.equal(job.steps[0].kind, 'action')
  })
})

describe('selectJobs and describePlan', () => {
  const plan = planWorkflow(parseYaml(CI_YML))

  test('selects every local job, or the named ones in ci.yml order', () => {
    assert.equal(selectJobs(plan).length, 6)
    assert.deepEqual(
      selectJobs(plan, ['daemon', 'repo-checks']).map((job) => job.id),
      ['repo-checks', 'daemon']
    )
  })

  test('refuses an unknown job and a root-only one', () => {
    assert.throws(() => selectJobs(plan, ['nope']), /no job "nope".*repo-checks/)
    assert.throws(() => selectJobs(plan, ['netsim']), /netsim needs root/)
  })

  test('describes what runs, where, when, and why the rest does not', () => {
    const text = describePlan(
      planWorkflow(
        workflowWith([
          { run: 'echo a', 'working-directory': 'app', if: 'failure()' },
          { run: 'npm ci' }
        ])
      ).concat(plan.filter((job) => !job.local))
    )
    assert.match(text, /^only \(timeout 5 min\)$/m)
    assert.match(text, /run {3}echo a \[in app\] \[if failure\(\)\]/)
    assert.match(text, /skip {2}npm ci: not run here/)
    assert.match(text, /^netsim: needs root/m)
  })
})

describe('reading results', () => {
  test('node --test, spec and TAP reporters, with coverage of the files under test', () => {
    const spec = [
      'ℹ tests 5',
      'ℹ pass 4',
      'ℹ fail 1',
      'ℹ cancelled 0',
      'ℹ skipped 1',
      'ℹ todo 1',
      'ℹ file        | line % | branch % | funcs % | uncovered lines',
      'ℹ scripts     |        |          |         | ',
      'ℹ   notes.mjs |  99.50 |    99.15 |  100.00 | 391-392',
      'ℹ   notes.test.mjs | 100.00 | 100.00 | 100.00 | ',
      'ℹ all files   |  99.50 |    99.15 |  100.00 | ',
      'ℹ ------------------------------------------------------------',
      'ℹ end of coverage report'
    ].join('\n')
    assert.deepEqual(parseNodeTest(spec), {
      counts: { passed: 4, failed: 1, skipped: 2 },
      coverage: [{ label: 'notes.mjs', lines: 99.5 }]
    })
    assert.deepEqual(parseNodeTest('# pass 3\n# fail 0\n# cancelled 1\n').counts, {
      passed: 3,
      failed: 1,
      skipped: 0
    })
  })

  test('check-repo.test.sh', () => {
    assert.deepEqual(parseShellTests('check-repo tests: 18 passed, 0 failed').counts, {
      passed: 18,
      failed: 0,
      skipped: 0
    })
    assert.equal(parseShellTests('nothing').counts, null)
  })

  test('Playwright, where a flaky or unfinished test counts as failed', () => {
    const text =
      '  2 failed\n  1 flaky\n  3 skipped\n  1 did not run\n  1 interrupted\n  40 passed (1.2m)\n'
    assert.deepEqual(parsePlaywright(text).counts, { passed: 40, failed: 5, skipped: 3 })
    assert.equal(parsePlaywright('Error: no tests found').counts, null)
  })

  test('Vitest, from its summary line only', () => {
    const passing = ' Test Files  2 passed (2)\n      Tests  12 passed (12)\n'
    assert.deepEqual(parseVitest(passing), {
      counts: { passed: 12, failed: 0, skipped: 0 },
      coverage: []
    })
    const mixed = '      Tests  1 failed | 11 passed | 2 skipped | 1 todo (15)\n'
    assert.deepEqual(parseVitest(mixed).counts, { passed: 11, failed: 1, skipped: 3 })
    assert.equal(parseVitest(' Test Files  no tests\n').counts, null)
  })

  test('go test -v and go tool cover', () => {
    const text = [
      '=== RUN   TestA',
      '--- PASS: TestA (0.00s)',
      '    --- PASS: TestA/sub (0.00s)',
      '--- SKIP: TestB (0.00s)',
      '--- FAIL: TestC (0.00s)',
      'ok  \tgithub.com/x/a\t1.0s\tcoverage: 80.0% of statements',
      'FAIL\tgithub.com/x/b\t0.5s'
    ].join('\n')
    assert.deepEqual(parseGoTest(text).counts, {
      passed: 2,
      failed: 1,
      skipped: 1,
      packages: { ok: 1, failed: 1 }
    })
    assert.deepEqual(parseGoTest('').counts.packages, { ok: 0, failed: 0 })
    assert.deepEqual(parseGoCoverTotal('total:\t\t\t(statements)\t\t81.2%\n').coverage, [
      { label: 'Go total (statements)', lines: 81.2 }
    ])
    assert.deepEqual(parseGoCoverTotal('nothing').coverage, [])
  })

  test('the parser is chosen by the command', () => {
    assert.equal(parserFor('node --test x.test.mjs'), parseNodeTest)
    assert.equal(parserFor('bash scripts/ci/check-repo.test.sh'), parseShellTests)
    assert.equal(parserFor('npm run test:e2e:smoke'), parsePlaywright)
    assert.equal(parserFor('npx playwright test --grep @extension'), parsePlaywright)
    assert.equal(parserFor('go test -race ./...'), parseGoTest)
    assert.equal(parserFor('go tool cover -func=coverage.out | tail -1'), parseGoCoverTotal)
    assert.equal(parserFor('npm run test:unit:coverage'), parseVitest)
    assert.equal(parserFor('npx vitest run'), parseVitest)
    assert.equal(parserFor('npm run lint'), null)
  })

  test('results add up per job', () => {
    const total = { counts: null, packages: null, coverage: [] }
    addResult(total, null)
    addResult(total, {
      counts: { passed: 1, failed: 0, skipped: 2 },
      coverage: [{ label: 'a', lines: 90 }]
    })
    addResult(total, {
      counts: { passed: 3, failed: 1, skipped: 0, packages: { ok: 2, failed: 1 } },
      coverage: []
    })
    addResult(total, {
      counts: { passed: 1, failed: 0, skipped: 0, packages: { ok: 1, failed: 0 } },
      coverage: []
    })
    addResult(total, { counts: null, coverage: [{ label: 'b', lines: 50 }] })
    assert.deepEqual(total, {
      counts: { passed: 5, failed: 1, skipped: 2 },
      packages: { ok: 3, failed: 1 },
      coverage: [
        { label: 'a', lines: 90 },
        { label: 'b', lines: 50 }
      ]
    })
  })
})

describe('the ~/Downloads guard', () => {
  test('lists a folder, treats a missing one as empty, and refuses one it cannot read', () => {
    const dir = fresh('downloads')
    writeFileSync(join(dir, 'a'), '')
    assert.deepEqual([...listEntries(dir)], ['a'])
    assert.equal(listEntries(join(dir, 'missing')).size, 0)
    const locked = fresh('locked')
    chmodSync(locked, 0o000)
    try {
      assert.throws(() => listEntries(locked), /cannot list .* to guard it/)
    } finally {
      chmodSync(locked, 0o755)
    }
    assert.deepEqual(newEntries(new Set(['a']), new Set(['c', 'a', 'b'])), ['b', 'c'])
  })
})

describe('environment', () => {
  test('every step loses ELECTRON_RUN_AS_NODE and gets what CI sets', () => {
    const env = baseEnv({ ELECTRON_RUN_AS_NODE: '1', PATH: '/bin' }, { fixtureFfmpeg: '/f' })
    assert.equal('ELECTRON_RUN_AS_NODE' in env, false)
    assert.equal(
      'NODE_TEST_CONTEXT' in baseEnv({ NODE_TEST_CONTEXT: 'child' }, { fixtureFfmpeg: '' }),
      false
    )
    assert.equal(env.PATH, '/bin')
    assert.equal(env.CI, 'true')
    assert.equal(env.MERGELANE_E2E_FIXTURE_FFMPEG, '/f')
  })

  test('go test runs verbose and uncached, so its tests can be counted and really run', () => {
    assert.deepEqual(stepExtraEnv('go test ./...', {}), { GOFLAGS: '-v -count=1' })
    assert.deepEqual(stepExtraEnv('go test ./...', { GOFLAGS: '-mod=mod' }), {
      GOFLAGS: '-mod=mod -v -count=1'
    })
    assert.deepEqual(stepExtraEnv('go vet ./...', {}), {})
  })
})

/** A test file with `n` passing tests, for steps that run `node --test`. */
function passingTests(n) {
  const file = join(fresh('tests'), 'passing.test.mjs')
  const body = Array.from({ length: n }, (_, i) => `test('t${i}', () => {})`).join('\n')
  writeFileSync(file, `import { test } from 'node:test'\n${body}\n`)
  return file
}

/** A writable stand-in for a log stream. */
function memoryLog() {
  const chunks = []
  return { chunks, write: (chunk) => chunks.push(String(chunk)), text: () => chunks.join('') }
}

describe('runScript', () => {
  test('runs a script with bash in its folder and returns its output and exit code', async () => {
    const dir = fresh('run')
    const log = memoryLog()
    const result = await runScript({
      script: 'echo "in $(basename "$PWD") $X"\necho oops >&2\nexit 3',
      shellArgs: ['-e'],
      cwd: dir,
      env: { ...process.env, X: 'y' },
      timeoutMs: 10_000,
      log,
      scriptFile: join(dir, 'step.sh')
    })
    assert.equal(result.code, 3)
    assert.equal(result.timedOut, false)
    assert.match(result.output, /in run-\d+ y/)
    assert.match(result.output, /oops/)
    assert.equal(log.text(), result.output)
    assert.match(readFileSync(join(dir, 'step.sh'), 'utf8'), /exit 3/)
  })

  test('a step that runs past its time is stopped, with everything it started', async () => {
    const dir = fresh('slow')
    const result = await runScript({
      script: 'sleep 30 &\nsleep 30',
      shellArgs: ['-e'],
      cwd: dir,
      env: process.env,
      timeoutMs: 200,
      log: memoryLog(),
      scriptFile: join(dir, 'step.sh')
    })
    assert.equal(result.timedOut, true)
    assert.notEqual(result.code, 0)
  })
})

describe('runJob', () => {
  const plannedJob = (steps, extra = {}) => planWorkflow(workflowWith(steps, extra))[0]

  test('runs the steps in order, stops after a failure, then runs failure() and always() steps', async () => {
    const root = fresh('root')
    mkdirSync(join(root, 'sub'))
    const logDir = fresh('logs')
    const job = plannedJob(
      [
        { uses: 'actions/checkout@v1' },
        { run: 'npm ci' },
        { name: 'where', run: 'pwd; echo "A=$A B=$B"', 'working-directory': 'sub', env: { B: 2 } },
        { name: 'tests', run: `node --test "${passingTests(2)}"` },
        { name: 'breaks', run: 'exit 4' },
        { name: 'skipped after failure', run: 'echo never' },
        { name: 'on failure', run: 'echo cleanup', if: 'failure()' },
        { name: 'always', run: 'echo always', if: 'always()' }
      ],
      { env: { A: 1 } }
    )
    const printed = []
    const result = await runJob(job, {
      root,
      env: STEP_ENV,
      logDir,
      downloads: fresh('downloads'),
      print: (line) => printed.push(line)
    })
    assert.equal(result.status, 'FAIL')
    assert.deepEqual(result.notes, ['"breaks" exited with 4'])
    assert.deepEqual(result.counts, { passed: 2, failed: 0, skipped: 0 })
    const log = readFileSync(join(logDir, 'only.log'), 'utf8')
    assert.match(log, /\/sub\nA=1 B=2/)
    assert.match(log, /== actions\/checkout@v1: action, this checkout/)
    assert.match(log, /== npm ci: skipped, not run here/)
    assert.match(log, /== skipped after failure: not run \(success\(\)\)/)
    assert.match(log, /cleanup/)
    assert.match(log, /always/)
    assert.ok(!log.includes('never'))
    assert.ok(printed.includes('  only: breaks'))
    assert.deepEqual(readdirSync(join(logDir, 'steps')).sort(), [
      'only-3.sh',
      'only-4.sh',
      'only-5.sh',
      'only-7.sh',
      'only-8.sh'
    ])
  })

  test('a failure() step does not run when everything passed', async () => {
    const job = plannedJob([{ run: 'true' }, { run: 'echo cleanup-ran', if: 'failure()' }])
    const logDir = fresh('logs')
    const result = await runJob(job, {
      root: fresh('root'),
      env: STEP_ENV,
      logDir,
      downloads: fresh('downloads'),
      print: () => {}
    })
    assert.equal(result.status, 'PASS')
    assert.ok(!readFileSync(join(logDir, 'only.log'), 'utf8').includes('cleanup-ran\n'))
  })

  test('anything new in the guarded Downloads folder fails the job', async () => {
    const downloads = fresh('downloads')
    writeFileSync(join(downloads, 'old.txt'), '')
    const job = plannedJob([{ run: `touch "${downloads}/new.txt"` }])
    const result = await runJob(job, {
      root: fresh('root'),
      env: STEP_ENV,
      logDir: fresh('logs'),
      downloads,
      print: () => {}
    })
    assert.equal(result.status, 'FAIL')
    assert.deepEqual(result.notes, [`new in ${downloads}: new.txt`])
  })

  test('a Downloads folder that becomes unreadable fails the job', async () => {
    const downloads = fresh('downloads')
    const job = plannedJob([{ run: `chmod 000 "${downloads}"` }])
    try {
      const result = await runJob(job, {
        root: fresh('root'),
        env: process.env,
        logDir: fresh('logs'),
        downloads,
        print: () => {}
      })
      assert.equal(result.status, 'FAIL')
      assert.match(result.notes[0], /cannot list/)
    } finally {
      chmodSync(downloads, 0o755)
    }
  })

  test("a job past its timeout stops, and a step past the job's time is stopped", async () => {
    let clock = 0
    const late = await runJob(plannedJob([{ run: 'true' }], { 'timeout-minutes': 0 }), {
      root: fresh('root'),
      env: STEP_ENV,
      logDir: fresh('logs'),
      downloads: fresh('downloads'),
      print: () => {},
      now: () => clock
    })
    assert.equal(late.status, 'FAIL')
    assert.deepEqual(late.notes, ['timed out before "true"'])

    clock = 0
    const slow = await runJob(
      plannedJob([{ name: 'slow', run: 'sleep 30' }], { 'timeout-minutes': 0.004 }),
      {
        root: fresh('root'),
        env: STEP_ENV,
        logDir: fresh('logs'),
        downloads: fresh('downloads'),
        print: () => {}
      }
    )
    assert.equal(slow.status, 'FAIL')
    assert.match(slow.notes[0], /"slow" passed the job's 0.004-minute timeout/)
  })
})

describe('formatTable', () => {
  test('one row per job, root-only jobs last, then the notes', () => {
    const table = formatTable(
      [
        {
          id: 'daemon',
          status: 'PASS',
          duration: 125_000,
          counts: { passed: 10, failed: 0, skipped: 2 },
          packages: { ok: 3, failed: 0 },
          coverage: [{ label: 'Go total (statements)', lines: 81.25 }],
          notes: []
        },
        {
          id: 'app-checks',
          status: 'FAIL',
          duration: 0,
          counts: null,
          coverage: [],
          notes: ['"lint" exited with 1']
        },
        { id: 'package', status: 'NOT RUN', counts: null, coverage: [], notes: [] }
      ],
      [{ id: 'netsim', rootReason: 'needs root (x): run scripts/ci/local-root.sh' }]
    )
    const lines = table.split('\n')
    assert.match(lines[0], /^Job +Result +Time +Tests +Coverage \(lines\)$/)
    assert.match(
      table,
      /daemon +PASS +2m05s +10 passed, 0 failed, 2 skipped \(packages: 3 ok, 0 failed\) +Go total \(statements\) 81\.3%/
    )
    assert.match(table, /app-checks +FAIL +0m00s +- +-/)
    assert.match(table, /package +NOT RUN/)
    assert.match(table, /netsim +ROOT +- +needs root: scripts\/ci\/local-root\.sh/)
    assert.equal(lines.at(-1), 'app-checks: "lint" exited with 1')
  })
})

/** A repository with a workflow of shell steps, for main(). */
function fixtureRepo(jobs) {
  const root = fresh('repo')
  const workflow = join(root, 'ci.yml')
  writeFileSync(workflow, jobs)
  return { root, workflow }
}

async function runMain(args, env = process.env) {
  const out = []
  const err = []
  const code = await main(args, {
    print: (line) => out.push(line),
    error: (line) => err.push(line),
    env
  })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

const TWO_JOBS = `name: fixture
jobs:
  first:
    timeout-minutes: 1
    steps:
      - uses: actions/checkout@v1
      - name: Pass
        run: |
          node --test "$PASSING_TESTS"
          echo "electron as node: [\${ELECTRON_RUN_AS_NODE:-unset}] ci: [$CI]"
          mkdir -p daemon && touch daemon/mergelane-daemon
  second:
    timeout-minutes: 1
    steps:
      - run: exit 1
  third:
    timeout-minutes: 1
    steps:
      - run: echo third
  rooted:
    steps:
      - run: sudo true
`

describe('main', () => {
  test('--help, --list and --dry-run print without running anything', async () => {
    assert.match((await runMain(['--help'])).out, /^usage: scripts\/ci\/local\.sh/)
    const list = await runMain(['--list'])
    assert.equal(list.code, 0)
    assert.match(list.out, /^package \(timeout 30 min\)$/m)
    assert.match(list.out, /^netsim: needs root/m)
    const dry = await runMain(['--dry-run', '--job', 'daemon'])
    assert.equal(dry.code, 0)
    assert.match(dry.out, /^daemon/)
    assert.ok(!dry.out.includes('repo-checks'))
  })

  test('wrong usage and unreadable workflows exit 2', async () => {
    const bad = fixtureRepo('jobs:\n  a:\n\tsteps: []\n')
    for (const args of [
      ['--nope'],
      ['--job', 'nope'],
      ['--job', 'netsim'],
      ['--workflow', join(scratch, 'missing.yml')],
      ['--workflow', bad.workflow],
      ['--workflow', fixtureRepo('jobs:\n  a:\n    steps:\n      - uses: x/y@1\n').workflow]
    ]) {
      const result = await runMain(args)
      assert.equal(result.code, 2, args.join(' '))
      assert.match(result.err, /^local-ci: /)
      assert.match(result.err, /usage:/)
    }
  })

  test('the e2e jobs need the fixture FFmpeg, and the guarded folder must be readable', async () => {
    const missing = await runMain([
      '--job',
      'app-e2e-smoke',
      '--fixture-ffmpeg',
      join(scratch, 'no-ffmpeg')
    ])
    assert.equal(missing.code, 2)
    assert.match(missing.err, /needs a full FFmpeg/)
    const locked = fresh('locked')
    chmodSync(locked, 0o000)
    try {
      const { workflow, root } = fixtureRepo(TWO_JOBS)
      const result = await runMain([
        '--workflow',
        workflow,
        '--root',
        root,
        '--job',
        'third',
        '--downloads',
        locked
      ])
      assert.equal(result.code, 1)
      assert.match(result.err, /cannot list/)
    } finally {
      chmodSync(locked, 0o755)
    }
  })

  test('runs the jobs, stops after a failure, writes the logs and the table', async () => {
    const { workflow, root } = fixtureRepo(TWO_JOBS)
    const logs = fresh('logs')
    const result = await runMain(
      ['--workflow', workflow, '--root', root, '--logs', logs, '--downloads', fresh('downloads')],
      { ...process.env, ELECTRON_RUN_AS_NODE: '1', PASSING_TESTS: passingTests(3) }
    )
    assert.equal(result.code, 1)
    const [run] = readdirSync(logs)
    const firstLog = readFileSync(join(logs, run, 'first.log'), 'utf8')
    assert.match(firstLog, /electron as node: \[unset\] ci: \[true\]/)
    assert.match(result.out, /first +PASS +\S+ +3 passed, 0 failed, 0 skipped/)
    assert.match(result.out, /second +FAIL/)
    assert.match(result.out, /third +NOT RUN/)
    assert.match(result.out, /rooted +ROOT/)
    assert.match(result.out, /local-ci: FAIL/)
    assert.equal(
      readFileSync(join(logs, run, 'summary.txt'), 'utf8')
        .split('\n')[0]
        .startsWith('Job'),
      true
    )
    // The daemon job's build check is a leftover CI throws away with the runner.
    assert.deepEqual(LEFTOVERS, ['daemon/mergelane-daemon'])
    assert.equal(existsSync(join(root, 'daemon/mergelane-daemon')), false)
  })

  test('--keep-going runs the rest, and --job (with commas) picks jobs', async () => {
    const { workflow, root } = fixtureRepo(TWO_JOBS)
    const common = [
      '--workflow',
      workflow,
      '--root',
      root,
      '--logs',
      fresh('logs'),
      '--downloads',
      fresh('downloads')
    ]
    const env = { ...process.env, PASSING_TESTS: passingTests(1) }
    const going = await runMain([...common, '--keep-going'], env)
    assert.equal(going.code, 1)
    assert.match(going.out, /third +PASS/)
    const picked = await runMain([...common, '--job', 'first,third'], env)
    assert.equal(picked.code, 0)
    assert.match(picked.out, /local-ci: PASS/)
    assert.ok(!/^second/m.test(picked.out))
  })
})

describe('local.sh', () => {
  test('runs local.mjs with the arguments given', () => {
    const result = spawnSync('bash', [join(HERE, 'local.sh'), '--list'], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /^repo-checks/m)
  })

  test('says so when Node.js is missing', () => {
    const result = spawnSync('/bin/bash', [join(HERE, 'local.sh'), '--list'], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' }
    })
    if (existsSync('/usr/bin/node') || existsSync('/bin/node')) return
    assert.equal(result.status, 2)
    assert.match(result.stderr, /Node\.js is not on PATH/)
  })

  test('as a program, local.mjs exits with its code', () => {
    const result = spawnSync(process.execPath, [join(HERE, 'local.mjs'), '--job', 'nope'], {
      encoding: 'utf8'
    })
    assert.equal(result.status, 2)
  })
})
