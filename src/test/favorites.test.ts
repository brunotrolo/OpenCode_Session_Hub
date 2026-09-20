import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { after, before, describe, it } from 'node:test';
import { addFavorite, FAVORITES_FILE_NAME, loadFavorites, removeFavorite } from '../favorites';
import { resolveOpenCodeLocations } from '../opencodePaths';

describe('favorite sessions', () => {
  let root: string;
  let locations: ReturnType<typeof resolveOpenCodeLocations>;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'osh-favorites-'));
    locations = resolveOpenCodeLocations({ HOME: root }, 'linux');
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('starts empty when no favorites file exists yet', () => {
    assert.deepStrictEqual(loadFavorites(locations), []);
  });

  it('adds a favorite with a label and session id', () => {
    const favorite = addFavorite(locations, 'Sessao de Desenvolvimento de HTML Hello World', 'ses_f4a55ea3effeDnzTiAaKbI0X92');
    assert.strictEqual(favorite.label, 'Sessao de Desenvolvimento de HTML Hello World');
    assert.strictEqual(favorite.sessionId, 'ses_f4a55ea3effeDnzTiAaKbI0X92');
    assert.ok(favorite.id);
    assert.ok(favorite.createdAt > 0);

    const favorites = loadFavorites(locations);
    assert.strictEqual(favorites.length, 1);
    assert.strictEqual(favorites[0].sessionId, 'ses_f4a55ea3effeDnzTiAaKbI0X92');
  });

  it('persists to a plain JSON file under the OpenCode config directory', () => {
    const filePath = path.join(locations.configRoot, FAVORITES_FILE_NAME);
    assert.ok(fs.existsSync(filePath));
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.ok(Array.isArray(raw));
    assert.strictEqual(raw[0].sessionId, 'ses_f4a55ea3effeDnzTiAaKbI0X92');
  });

  it('rejects an empty session id instead of saving a useless bookmark', () => {
    assert.throws(() => addFavorite(locations, 'no id', '   '));
  });

  it('falls back to the session id as the label when none is given', () => {
    const favorite = addFavorite(locations, '', 'ses_noLabelGiven123');
    assert.strictEqual(favorite.label, 'ses_noLabelGiven123');
  });

  it('lists newest favorites first', () => {
    const favorites = loadFavorites(locations);
    assert.ok(favorites[0].createdAt >= favorites[favorites.length - 1].createdAt);
  });

  it('removes a favorite by its bookmark id, not by session id', () => {
    const before = loadFavorites(locations);
    const target = before.find((f) => f.sessionId === 'ses_noLabelGiven123')!;

    removeFavorite(locations, target.id);

    const after = loadFavorites(locations);
    assert.strictEqual(after.length, before.length - 1);
    assert.ok(!after.some((f) => f.id === target.id));
    // The other favorite, added earlier, must survive untouched.
    assert.ok(after.some((f) => f.sessionId === 'ses_f4a55ea3effeDnzTiAaKbI0X92'));
  });

  it('removing an unknown id is a no-op rather than an error', () => {
    const before = loadFavorites(locations);
    removeFavorite(locations, 'does-not-exist');
    assert.deepStrictEqual(loadFavorites(locations), before);
  });

  it('ignores a corrupt favorites file instead of throwing', () => {
    fs.writeFileSync(path.join(locations.configRoot, FAVORITES_FILE_NAME), '{ not valid json', 'utf8');
    assert.deepStrictEqual(loadFavorites(locations), []);
  });
});
