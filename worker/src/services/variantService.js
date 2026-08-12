/**
 * Named transform variants — reusable, named resize presets scoped to a
 * project (e.g. 'thumbnail', 'card', 'hero'). Delivery via
 * /img/v/:variant/... resolves the preset here rather than encoding raw
 * dimensions in the URL, which also lets a project restrict delivery to an
 * allowlist of named variants (strict_transforms).
 */

const { query } = require('../db');

const MODES = ['fit', 'fill', 'auto', 'force'];
const FORMATS = ['auto', 'webp', 'avif', 'jpeg', 'png'];
const MAX_DIMENSION = 8192;
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,59}$/i;

// Built-in presets. Usable even when a project has stored none, so a fresh
// project can serve sensible sizes immediately. A stored variant of the same
// name always overrides the built-in.
const BUILTIN_VARIANTS = Object.freeze({
  thumbnail: { name: 'thumbnail', mode: 'fit', width: 200, height: 200, format: 'auto', quality: null, builtin: true },
  card: { name: 'card', mode: 'fill', width: 600, height: 400, format: 'auto', quality: null, builtin: true },
  hero: { name: 'hero', mode: 'fit', width: 1600, height: 0, format: 'auto', quality: null, builtin: true },
});

function validationError(message) {
  const err = new Error(message);
  err.status = 400;
  err.code = 'INVALID_VARIANT';
  return err;
}

/**
 * Validate + normalize a variant definition from user input. Throws a 400 on
 * any invalid field. `quality`, when present, is clamped to 1..100.
 */
function normalizeVariant(input = {}) {
  const name = String(input.name || '').trim();
  if (!NAME_RE.test(name)) {
    throw validationError('Variant name must be 1-60 chars: letters, digits, hyphen, underscore');
  }

  const mode = String(input.mode || '').trim();
  if (!MODES.includes(mode)) {
    throw validationError(`Invalid mode. Use: ${MODES.join(', ')}`);
  }

  const width = Number(input.width);
  const height = Number(input.height);
  if (!Number.isInteger(width) || width < 0 || width > MAX_DIMENSION) {
    throw validationError(`width must be an integer 0..${MAX_DIMENSION}`);
  }
  if (!Number.isInteger(height) || height < 0 || height > MAX_DIMENSION) {
    throw validationError(`height must be an integer 0..${MAX_DIMENSION}`);
  }
  if (width === 0 && height === 0) {
    throw validationError('width and height cannot both be zero');
  }

  let format = input.format === undefined || input.format === null || input.format === ''
    ? 'auto'
    : String(input.format);
  if (!FORMATS.includes(format)) {
    throw validationError(`Invalid format. Use: ${FORMATS.join(', ')}`);
  }

  let quality = null;
  if (input.quality !== undefined && input.quality !== null && input.quality !== '') {
    const q = Number(input.quality);
    if (!Number.isInteger(q) || q < 1 || q > 100) {
      throw validationError('quality must be an integer 1..100');
    }
    quality = q;
  }

  return { name, mode, width, height, format, quality };
}

function rowToVariant(row) {
  return {
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    mode: row.mode,
    width: row.width,
    height: row.height,
    format: row.format || 'auto',
    quality: row.quality === null || row.quality === undefined ? null : Number(row.quality),
    created_at: row.created_at,
    updated_at: row.updated_at,
    builtin: false,
  };
}

/** All stored variants for a project, newest first. */
async function listVariants(projectId) {
  const { rows } = await query(
    `SELECT id, project_id, name, mode, width, height, format, quality, created_at, updated_at
     FROM named_variants WHERE project_id = $1 ORDER BY name ASC`,
    [projectId]
  );
  return rows.map(rowToVariant);
}

/** Create (or upsert by name) a named variant for a project. */
async function createVariant(projectId, input) {
  const v = normalizeVariant(input);
  const { rows } = await query(
    `INSERT INTO named_variants (project_id, name, mode, width, height, format, quality)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (project_id, name) DO UPDATE SET
       mode = EXCLUDED.mode, width = EXCLUDED.width, height = EXCLUDED.height,
       format = EXCLUDED.format, quality = EXCLUDED.quality, updated_at = NOW()
     RETURNING id, project_id, name, mode, width, height, format, quality, created_at, updated_at`,
    [projectId, v.name, v.mode, v.width, v.height, v.format, v.quality]
  );
  return rowToVariant(rows[0]);
}

/** Delete a named variant by name. Returns true if a row was removed. */
async function deleteVariant(projectId, name) {
  const { rowCount } = await query(
    'DELETE FROM named_variants WHERE project_id = $1 AND name = $2',
    [projectId, name]
  );
  return rowCount > 0;
}

/**
 * Resolve a variant name to its transform spec for a project. A stored
 * variant wins; otherwise a built-in default with the same name is used.
 * Returns null when neither exists.
 */
async function resolveVariant(projectId, name) {
  const key = String(name || '').toLowerCase();
  try {
    const { rows } = await query(
      `SELECT id, project_id, name, mode, width, height, format, quality, created_at, updated_at
       FROM named_variants WHERE project_id = $1 AND name = $2 LIMIT 1`,
      [projectId, name]
    );
    if (rows.length > 0) return rowToVariant(rows[0]);
  } catch {
    // A malformed/unknown project id (e.g. not a uuid for a nonexistent file)
    // still resolves the built-in preset rather than erroring the request.
  }
  if (BUILTIN_VARIANTS[key]) return { ...BUILTIN_VARIANTS[key], project_id: projectId };
  return null;
}

/**
 * Create the three sensible built-in variants (thumbnail/card/hero) as stored
 * rows for a project. Idempotent via the name upsert.
 */
async function seedDefaults(projectId) {
  const created = [];
  for (const key of Object.keys(BUILTIN_VARIANTS)) {
    const { name, mode, width, height, format, quality } = BUILTIN_VARIANTS[key];
    created.push(await createVariant(projectId, { name, mode, width, height, format, quality }));
  }
  return created;
}

module.exports = {
  MODES,
  FORMATS,
  MAX_DIMENSION,
  BUILTIN_VARIANTS,
  normalizeVariant,
  listVariants,
  createVariant,
  deleteVariant,
  resolveVariant,
  seedDefaults,
};
