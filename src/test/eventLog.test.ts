import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';
import { resolveOpenCodeLocations } from '../opencodePaths';
import { loadMessages, scanSessions } from '../sessionScanner';
import { mergeManySessionDatabases } from '../dbMerge';
import { exportSessionFilesBatched, truncateEventExport } from '../favoriteSessionExport';
import { SyncManager, SyncSettings } from '../syncManager';
import { addFavorite } from '../favorites';
import { addEventSession, addSqliteSession, createMachine, FakeMachine } from './fixtures';
import { spawnSync } from 'child_process';

/**
 * The current OpenCode generation persists sessions as an event log rather
 * than session/message/part rows. These tests drive the real reader, preview
 * loader, deleter and push-skip against a fake event-log database.
 */
describe('event-log sessions', () => {
  let root: string;
  let machine: FakeMachine;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'osh-events-'));
    machine = createMachine(root, 'work');

    addEventSession(machine, {
      sessionId: 'ses_evt_parent',
      title: 'Event parent session',
      directory: '/work/parent',
      updated: 1_700_000_100_000,
      messages: [{ id: 'msg_p1', role: 'user', text: 'parent says hi', created: 1_700_000_050_000 }],
    });
    addEventSession(machine, {
      sessionId: 'ses_evt_child',
      title: 'Event child session',
      directory: '/work/child',
      parentId: 'ses_evt_parent',
      updated: 1_700_000_200_000,
      messages: [
        { id: 'msg_c1', role: 'user', text: 'child question', created: 1_700_000_150_000 },
        { id: 'msg_c2', role: 'assistant', text: 'child answer', created: 1_700_000_160_000 },
      ],
    });
    // A stale legacy-table row with the same id must lose to the event log.
    addSqliteSession(machine, {
      sessionId: 'ses_evt_child',
      projectId: 'prj_stale',
      title: 'Stale legacy copy',
      directory: '/stale',
      updated: 1_600_000_000_000,
    });
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  function locations() {
    return resolveOpenCodeLocations(machine.env, 'linux');
  }

  it('lists event-log sessions with titles, counts and parent ids', () => {
    const { sessions, warnings } = scanSessions(locations());
    assert.deepStrictEqual(warnings, []);
    const byId = new Map(sessions.map((s) => [s.id, s]));

    const parent = byId.get('ses_evt_parent');
    assert.ok(parent);
    assert.strictEqual(parent.source, 'event-log');
    assert.strictEqual(parent.title, 'Event parent session');
    assert.strictEqual(parent.directory, '/work/parent');
    assert.strictEqual(parent.messageCount, 1);
    assert.strictEqual(parent.parentId, undefined);

    const child = byId.get('ses_evt_child');
    assert.ok(child);
    assert.strictEqual(child.source, 'event-log');
    assert.strictEqual(child.title, 'Event child session');
    assert.strictEqual(child.messageCount, 2);
    assert.strictEqual(child.parentId, 'ses_evt_parent');
  });

  it('prefers the event log over stale legacy rows with the same id', () => {
    const { sessions } = scanSessions(locations());
    const matches = sessions.filter((s) => s.id === 'ses_evt_child');
    assert.strictEqual(matches.length, 1);
    assert.strictEqual(matches[0].source, 'event-log');
    assert.strictEqual(matches[0].title, 'Event child session');
  });

  it('loads message text and roles from message/part events in order', () => {
    const { sessions } = scanSessions(locations());
    const child = sessions.find((s) => s.id === 'ses_evt_child');
    assert.ok(child);
    const messages = loadMessages(locations(), child);
    assert.deepStrictEqual(
      messages.map((m) => [m.role, m.text]),
      [
        ['user', 'child question'],
        ['assistant', 'child answer'],
      ]
    );
  });

  it('deletes the event rows, the sequence row and stale legacy rows, keeping siblings', async () => {
    const { deleteSession } = require('../sessionScanner');
    const { sessions } = scanSessions(locations());
    const child = sessions.find((s) => s.id === 'ses_evt_child');
    assert.ok(child);
    await deleteSession(locations(), child);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(machine.dataRoot, 'opencode.db'), { readOnly: true });
    try {
      const events = db.prepare('SELECT COUNT(*) AS n FROM event WHERE aggregate_id = ?').all('ses_evt_child')[0] as {
        n: number;
      };
      assert.strictEqual(events.n, 0, 'event rows must be gone');
      const seq = db.prepare('SELECT COUNT(*) AS n FROM event_sequence WHERE aggregate_id = ?').all('ses_evt_child')[0] as {
        n: number;
      };
      assert.strictEqual(seq.n, 0, 'sequence row must be gone');
      const legacy = db.prepare('SELECT COUNT(*) AS n FROM session WHERE id = ?').all('ses_evt_child')[0] as {
        n: number;
      };
      assert.strictEqual(legacy.n, 0, 'stale legacy row must be gone');
      const sibling = db.prepare("SELECT COUNT(*) AS n FROM event WHERE aggregate_id = 'ses_evt_parent'").all()[0] as {
        n: number;
      };
      assert.ok(sibling.n > 0, 'the parent session must survive');
    } finally {
      db.close();
    }

    const after = scanSessions(locations()).sessions.map((s) => s.id);
    assert.ok(!after.includes('ses_evt_child'));
    assert.ok(after.includes('ses_evt_parent'));
  });
});

describe('event-log push skip', () => {
  let root: string;
  let remote: string;
  let work: FakeMachine;

  const settingsFor = (machine: FakeMachine, overrides: Partial<SyncSettings> = {}): SyncSettings => ({
    remoteUrl: remote,
    branch: 'main',
    repoDir: path.join(machine.home, 'sync-repo'),
    includeSecrets: true,
    includeSessions: true,
    includeModelFavorites: true,
    includeOpencodeSkills: true,
    includeAgentsDir: true,
    redactSecrets: true,
    privateRepoAcknowledged: true,
    ...overrides,
  });

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'osh-events-push-'));
    remote = path.join(root, 'remote.git');
    spawnSync('git', ['init', '--bare', '-b', 'main', remote]);
    work = createMachine(root, 'work');

    addEventSession(work, {
      sessionId: 'ses_evt_fav',
      title: 'Favorited event session',
      directory: '/work/fav',
      updated: 1_700_000_300_000,
      messages: [{ id: 'msg_f1', role: 'user', text: 'fav says hi', created: 1_700_000_250_000 }],
    });
    // Favorites bypass the source filter's sqlite-only bulk path, so this
    // exercises the skip.
    addFavorite(resolveOpenCodeLocations(work.env, 'linux'), 'Event fav', 'ses_evt_fav');
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('exports a favorited event-log session instead of skipping it', async () => {
    const manager = new SyncManager(resolveOpenCodeLocations(work.env, 'linux'), settingsFor(work));
    const outcome = await manager.push();
    assert.strictEqual(outcome.status, 'ok');
    assert.ok(
      !outcome.messages.some((m) => m.includes('event log')),
      `no event-log skip note expected, got: ${JSON.stringify(outcome.messages)}`
    );
    const exportFile = path.join(work.home, 'sync-repo', 'data', 'favorite-sessions', 'ses_evt_fav.db');
    assert.ok(fs.existsSync(exportFile), 'the event export file must be committed');

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require('node:sqlite');
    const exported = new DatabaseSync(exportFile, { readOnly: true });
    try {
      const aggregates = exported.prepare('SELECT DISTINCT aggregate_id AS id FROM event').all();
      assert.deepStrictEqual(
        aggregates.map((r: { id: string }) => r.id),
        ['ses_evt_fav']
      );
    } finally {
      exported.close();
    }
  });

  it('round-trips an event-log session to a second machine via pull', async () => {    const other = createMachine(root, 'home');
    // The receiving machine has run OpenCode once, so its database (with
    // event tables) exists for the merge to write into.
    addEventSession(other, {
      sessionId: 'ses_home_only',
      title: 'Home session',
      directory: '/home/mine',
      updated: 1_700_000_050_000,
    });
    const otherLocations = resolveOpenCodeLocations(other.env, 'linux');
    const otherManager = new SyncManager(otherLocations, settingsFor(other));
    const outcome = await otherManager.pull();
    assert.strictEqual(outcome.status, 'ok');

    const sessions = scanSessions(otherLocations).sessions;
    const arrived = sessions.find((s) => s.id === 'ses_evt_fav');
    assert.ok(arrived, `event session must arrive via pull, got: ${sessions.map((s) => s.id)}`);
    assert.strictEqual(arrived.source, 'event-log');
    assert.strictEqual(arrived.title, 'Favorited event session');
    const messages = loadMessages(otherLocations, arrived);
    assert.deepStrictEqual(
      messages.map((m) => [m.role, m.text]),
      [['user', 'fav says hi']]
    );
  });
});

describe('child-session sync gate', () => {
  let root: string;
  let remote: string;
  let work: FakeMachine;

  const settingsFor = (machine: FakeMachine, overrides: Partial<SyncSettings> = {}): SyncSettings => ({
    remoteUrl: remote,
    branch: 'main',
    repoDir: path.join(machine.home, 'sync-repo'),
    includeSecrets: true,
    includeSessions: true,
    includeModelFavorites: true,
    includeOpencodeSkills: true,
    includeAgentsDir: true,
    redactSecrets: true,
    privateRepoAcknowledged: true,
    ...overrides,
  });

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'osh-kidgate-'));
    remote = path.join(root, 'remote.git');
    spawnSync('git', ['init', '--bare', '-b', 'main', remote]);
    work = createMachine(root, 'work');

    addSqliteSession(work, {
      sessionId: 'ses_gate_parent',
      projectId: 'prj_a',
      title: 'Gate parent',
      directory: '/work/parent',
      updated: 1_700_000_100_000,
      messages: [{ id: 'msg_gp', role: 'user', text: 'parent text', created: 1_700_000_100_000 }],
    });
    addSqliteSession(work, {
      sessionId: 'ses_gate_child',
      projectId: 'prj_a',
      title: 'Gate child',
      directory: '/work/child',
      updated: 1_700_000_200_000,
      parentId: 'ses_gate_parent',
      messages: [{ id: 'msg_gc', role: 'user', text: 'child text', created: 1_700_000_200_000 }],
    });
    const locations = resolveOpenCodeLocations(work.env, 'linux');
    addFavorite(locations, 'Gate parent', 'ses_gate_parent');
    addFavorite(locations, 'Gate child', 'ses_gate_child');
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('syncs children by default', async () => {
    const manager = new SyncManager(resolveOpenCodeLocations(work.env, 'linux'), settingsFor(work));
    const outcome = await manager.push();
    assert.strictEqual(outcome.status, 'ok');
    const dir = path.join(work.home, 'sync-repo', 'data', 'favorite-sessions');
    assert.ok(fs.existsSync(path.join(dir, 'ses_gate_parent.db')), 'parent must sync');
    assert.ok(fs.existsSync(path.join(dir, 'ses_gate_child.db')), 'child must sync when the gate is on');
  });

  it('keeps children local while parents sync when the gate is off', async () => {
    // Self-contained on a fresh remote: sharing the first test's remote
    // would pull the child's export file in, hiding whether THIS push
    // exported it.
    const soloRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'osh-kidgate-solo-'));
    try {
      const soloRemote = path.join(soloRoot, 'remote.git');
      spawnSync('git', ['init', '--bare', '-b', 'main', soloRemote]);
      const solo = createMachine(soloRoot, 'solo');
      addSqliteSession(solo, {
        sessionId: 'ses_solo_parent',
        projectId: 'prj_a',
        title: 'Solo parent',
        directory: '/work/parent',
        updated: 1_700_000_100_000,
        messages: [{ id: 'msg_sp', role: 'user', text: 'parent text', created: 1_700_000_100_000 }],
      });
      addSqliteSession(solo, {
        sessionId: 'ses_solo_child',
        projectId: 'prj_a',
        title: 'Solo child',
        directory: '/work/child',
        updated: 1_700_000_200_000,
        parentId: 'ses_solo_parent',
        messages: [{ id: 'msg_sc', role: 'user', text: 'child text', created: 1_700_000_200_000 }],
      });
      const soloLocations = resolveOpenCodeLocations(solo.env, 'linux');
      addFavorite(soloLocations, 'Solo parent', 'ses_solo_parent');
      addFavorite(soloLocations, 'Solo child', 'ses_solo_child');

      const soloSettings: SyncSettings = {
        remoteUrl: soloRemote,
        branch: 'main',
        repoDir: path.join(solo.home, 'sync-repo'),
        includeSecrets: true,
        includeSessions: true,
        includeModelFavorites: false,
        includeOpencodeSkills: false,
        includeAgentsDir: false,
        redactSecrets: true,
        privateRepoAcknowledged: true,
        includeChildSessions: false,
      };
      const outcome = await new SyncManager(soloLocations, soloSettings).push();
      assert.strictEqual(outcome.status, 'ok');
      const dir = path.join(solo.home, 'sync-repo', 'data', 'favorite-sessions');
      assert.ok(fs.existsSync(path.join(dir, 'ses_solo_parent.db')), 'parent must still sync');
      assert.ok(!fs.existsSync(path.join(dir, 'ses_solo_child.db')), 'child must stay local');
      assert.ok(
        outcome.messages.some((m) => m.includes('includeChildSessions is off')),
        `expected the child-gate note, got: ${JSON.stringify(outcome.messages)}`
      );
    } finally {
      fs.rmSync(soloRoot, { recursive: true, force: true });
    }
  });
});

describe('event export/merge units', () => {
  let root: string;
  let machine: FakeMachine;
  let dbPath: string;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'osh-events-unit-'));
    machine = createMachine(root, 'work');
    dbPath = path.join(machine.dataRoot, 'opencode.db');

    addEventSession(machine, {
      sessionId: 'ses_unit_a',
      title: 'Unit A',
      directory: '/work/a',
      updated: 1_700_000_100_000,
      messages: [{ id: 'msg_ua', role: 'user', text: 'unit a says hi', created: 1_700_000_050_000 }],
    });
    addEventSession(machine, {
      sessionId: 'ses_unit_b',
      title: 'Unit B',
      directory: '/work/b',
      updated: 1_700_000_200_000,
      messages: [{ id: 'msg_ub', role: 'user', text: 'unit b says hi', created: 1_700_000_150_000 }],
    });
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('exports only the requested aggregate, and fails unknown ids without a file', async () => {
    const outA = path.join(root, 'a.db');
    const results = await exportSessionFilesBatched(dbPath, [
      { sessionId: 'ses_unit_a', outputPath: outA, format: 'event' },
      { sessionId: 'ses_nope', outputPath: path.join(root, 'nope.db'), format: 'event' },
    ]);
    assert.strictEqual(results.length, 2);
    assert.ok(results[0].ok && results[0].rows > 0);
    assert.ok(!results[1].ok);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require('node:sqlite');
    const exported = new DatabaseSync(outA, { readOnly: true });
    try {
      const aggregates = exported.prepare('SELECT DISTINCT aggregate_id AS id FROM event').all();
      assert.deepStrictEqual(
        aggregates.map((r: { id: string }) => r.id),
        ['ses_unit_a']
      );
    } finally {
      exported.close();
    }
    assert.ok(!fs.existsSync(path.join(root, 'nope.db')), 'a failed export must leave no file behind');
  });

  it('merges event rows into another database, idempotently, leaving legacy rows alone', async () => {
    const other = createMachine(root, 'home');
    const target = path.join(other.dataRoot, 'opencode.db');
    addEventSession(other, {
      sessionId: 'ses_home_only',
      title: 'Home',
      directory: '/home',
      updated: 1_700_000_010_000,
    });
    addSqliteSession(other, {
      sessionId: 'ses_legacy_home',
      projectId: 'prj_a',
      title: 'Legacy home',
      directory: '/home/legacy',
      updated: 1_700_000_010_000,
    });

    const outA = path.join(root, 'merge-a.db');
    const exported = await exportSessionFilesBatched(dbPath, [{ sessionId: 'ses_unit_a', outputPath: outA, format: 'event' }]);
    assert.ok(exported[0].ok);

    const first = mergeManySessionDatabases(target, [outA]);
    assert.ok(first !== null && (first[0]?.changed ?? 0) > 0, 'first merge must bring rows');

    const { sessions } = scanSessions(resolveOpenCodeLocations(other.env, 'linux'));
    const arrived = sessions.find((s) => s.id === 'ses_unit_a');
    assert.ok(arrived, 'merged event session must list');
    assert.strictEqual(arrived!.title, 'Unit A');

    const second = mergeManySessionDatabases(target, [outA]);
    assert.ok(second !== null && second[0].changed === 0, 're-merging must be a no-op');

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require('node:sqlite');
    const check = new DatabaseSync(target, { readOnly: true });
    try {
      const legacy = check.prepare("SELECT COUNT(*) AS n FROM session WHERE id = 'ses_legacy_home'").all()[0] as {
        n: number;
      };
      assert.strictEqual(legacy.n, 1, 'legacy rows must be untouched by the event merge');
    } finally {
      check.close();
    }
  });

  it('merges gracefully into a database without event tables', () => {    const legacy = createMachine(root, 'legacy');
    addSqliteSession(legacy, {
      sessionId: 'ses_old',
      projectId: 'prj_a',
      title: 'Old',
      directory: '/old',
      updated: 1_700_000_010_000,
    });
    const target = path.join(legacy.dataRoot, 'opencode.db');
    const outA = path.join(root, 'merge-a2.db');
    return exportSessionFilesBatched(dbPath, [{ sessionId: 'ses_unit_a', outputPath: outA, format: 'event' }]).then(
      (exported) => {
        assert.ok(exported[0].ok);
        const results = mergeManySessionDatabases(target, [outA]);
        assert.ok(results !== null, 'merge must not fail');
        assert.strictEqual(results[0].changed, 0, 'nothing merges where no event tables exist');
        const { sessions } = scanSessions(resolveOpenCodeLocations(legacy.env, 'linux'));
        assert.deepStrictEqual(sessions.map((s) => s.id), ['ses_old']);
      }
    );
  });
});

describe('event export truncation', () => {
  it('drops the oldest messages first and keeps creation, latest state and the budget', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osh-trunc-'));
    try {
      const machine = createMachine(dir, 'work');
      const messages = Array.from({ length: 100 }, (_, i) => ({
        id: `msg_t${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        text: `message number ${i} with padding `.repeat(100),
        created: 1_700_000_000_000 + i,
      }));
      addEventSession(machine, {
        sessionId: 'ses_trunc',
        title: 'Trunc me',
        directory: '/work/trunc',
        updated: 1_700_000_100_000,
        messages,
      });

      const dbPath = path.join(machine.dataRoot, 'opencode.db');
      const outPath = path.join(dir, 'trunc.db');
      const exported = await exportSessionFilesBatched(dbPath, [
        { sessionId: 'ses_trunc', outputPath: outPath, format: 'event' },
      ]);
      assert.ok(exported[0].ok);

      const fullBytes = fs.statSync(outPath).size;
      const budget = Math.floor(fullBytes / 2);
      const result = await truncateEventExport(outPath, budget);
      assert.ok(result.ok, result.error ?? 'truncate failed');
      assert.ok(result.droppedMessages > 0, 'oldest messages must go');
      assert.ok(result.keptMessages > 0, 'newest messages must stay');
      assert.ok(
        fs.statSync(outPath).size <= budget,
        `truncated file must fit the budget (${fs.statSync(outPath).size} > ${budget})`
      );

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { DatabaseSync } = require('node:sqlite');
      const check = new DatabaseSync(outPath, { readOnly: true });
      try {
        const types = check.prepare('SELECT DISTINCT type AS t FROM event').all().map((r: { t: string }) => r.t);
        assert.ok(types.includes('session.created.1'), 'creation event must survive');
        assert.ok(types.includes('session.updated.1'), 'latest session state must survive');
        const texts = check
          .prepare("SELECT data FROM event WHERE type = 'message.part.updated.1' ORDER BY seq")
          .all()
          .map((r: { data: string }) => JSON.parse(String(r.data)).part.text as string);
        assert.ok(
          texts[texts.length - 1].includes('message number 99'),
          'the newest message must survive truncation'
        );
        assert.ok(
          !texts.some((t: string) => t.includes('message number 0')),
          'the oldest message must be gone'
        );
      } finally {
        check.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
